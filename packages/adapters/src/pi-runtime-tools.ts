import type { Agent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunBudgetCrossing,
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolCompletion,
  AgentToolExecutionResult,
  ConnectorTool,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { batchActions, humanizeToolName, redactSecrets } from "@rakazo/core";
import { MAX_APPROVAL_DETAIL_LENGTH } from "./approval-ask.js";
import {
  isInternalTermination,
  isTerminatingReplyResult,
  isToolPauseResult,
} from "./approval-effect.js";
import {
  connectionIdArgument,
  credentialArgument,
  loginFieldLabelsArgument,
  oneTimeCodeArgument,
} from "./bot-secrets.js";
import { FIND_TOOL, findTools, partitionTools, USE_TOOL } from "./builtin-tool-bridge.js";
import { shortenToolResultText } from "./context-selection.js";
import type { PiAgentRuntimeOptions } from "./pi-runtime.js";
import { COMPUTER_MODE_TOOLS } from "./pi-runtime-computer-mode.js";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";
import {
  clipToolResultContent,
  clipToolResultText,
  TOOL_RESULT_TEXT_LIMIT,
} from "./pi-runtime-limits.js";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import { executeSubagent } from "./pi-runtime-subagent.js";
import { parametersFor, prepareFleetArguments } from "./pi-runtime-tool-parameters.js";
import { recordPiTelemetryContent, withPiTelemetrySpan } from "./pi-telemetry.js";
import { VERBATIM_TOOL_RESULTS } from "./runtime-context.js";
import { SCHEDULE_TOOL_NAMES } from "./schedule-tools.js";
import type { FinishedShellCommand } from "./shell-command-stream.js";
import { textContentArg } from "./tool-text.js";
import { isVerbatimMcpResult } from "./verbatim-mcp-result.js";
import { positiveIntegerArg } from "./workspace-file-tools.js";

export type RunBudgetBound = AgentRunBudgetCrossing["bound"];

/**
 * One composite budget per run: the tool-call fuse plus token and cost bounds,
 * metered from the same per-call usage the runtime already records. Process-local:
 * continueRun on another worker starts at zero.
 */
export interface ToolCallBudget {
  toolCalls: { used: number; limit: number };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Hard token bound, over input + output tokens. 0 means unlimited. */
  tokenLimit: number;
  /** Soft token bound: crossing it earns the model a one-time wrap-up note. 0 means none. */
  tokenSoftLimit: number;
  /** Hard cost bound in USD. 0 means unlimited. */
  costLimitUsd: number;
  /**
   * Whether the token and cost bounds stop the run (RUN_BUDGET_ENFORCE). The
   * tool-call fuse predates the switch and always enforces when its limit is set.
   */
  enforce: boolean;
  /** The first hard bound crossed under enforcement; the fuse plumbing stops the run on it. */
  exceeded: RunBudgetBound | null;
  /** The first hard token/cost crossing while measuring only: audited, never stops the run. */
  wouldExceed: AgentRunBudgetCrossing | null;
  softNotified: boolean;
  inFlight: number;
}
const toolCallBudgetsByRun = new Map<string, ToolCallBudget>();

// Pi forwards these names to OpenAI Responses, whose function-name contract is
// ^[a-zA-Z0-9_-]+$ with a maximum length of 64 characters.
const AGENT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_AGENT_TOOL_NAME_LENGTH = 64;
const FALLBACK_AGENT_TOOL_NAME = "connector_tool";

/** Optional self-host fuse. Unset, empty, or 0 means unlimited (default). */
export function maxToolCallsPerTurn(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_TOOL_CALLS_PER_TURN?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function positiveBudgetNumber(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Whether the token and cost bounds stop runs or only measure them. Default off. */
export function runBudgetEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RUN_BUDGET_ENFORCE?.trim().toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}

export interface RunBudgetLimits {
  toolCallLimit: number;
  tokenLimit: number;
  tokenSoftLimit: number;
  costLimitUsd: number;
  enforce: boolean;
}

/**
 * The budget limits for one run, from deployment env only. Unset, empty, or
 * invalid values mean unlimited, matching the tool-call fuse. Routine runs use
 * their tighter token bound when one is set: an unattended runaway is pure
 * waste. The soft bound defaults to 80% of the hard bound and never exceeds it.
 */
export function runBudgetLimits(
  env: NodeJS.ProcessEnv = process.env,
  options?: { routine?: boolean },
): RunBudgetLimits {
  const routineHard = options?.routine
    ? Math.floor(positiveBudgetNumber(env.ROUTINE_RUN_TOKEN_BUDGET_HARD))
    : 0;
  const tokenLimit =
    routineHard > 0 ? routineHard : Math.floor(positiveBudgetNumber(env.RUN_TOKEN_BUDGET_HARD));
  const explicitSoft = Math.floor(positiveBudgetNumber(env.RUN_TOKEN_BUDGET_SOFT));
  let tokenSoftLimit = explicitSoft > 0 ? explicitSoft : Math.floor(tokenLimit * 0.8);
  if (tokenLimit <= 0) tokenSoftLimit = 0;
  else if (tokenSoftLimit > tokenLimit) tokenSoftLimit = tokenLimit;
  return {
    toolCallLimit: maxToolCallsPerTurn(env),
    tokenLimit,
    tokenSoftLimit,
    costLimitUsd: positiveBudgetNumber(env.RUN_COST_BUDGET_USD_HARD),
    enforce: runBudgetEnforced(env),
  };
}

function applyRunBudgetLimits(budget: ToolCallBudget, limits: RunBudgetLimits): void {
  budget.toolCalls.limit = limits.toolCallLimit;
  budget.tokenLimit = limits.tokenLimit;
  budget.tokenSoftLimit = limits.tokenSoftLimit;
  budget.costLimitUsd = limits.costLimitUsd;
  budget.enforce = limits.enforce;
}

/**
 * Accumulate one model call's usage into the run budget: the same numbers the
 * usage stream persists as usage records, with unknown (null) amounts counting
 * as zero. Returns the first hard token/cost crossing, or null. Under
 * enforcement the crossing also sets `exceeded`, which the fuse plumbing turns
 * into a stop; while measuring only it is kept in `wouldExceed` instead and the
 * run continues. Cache tokens are not in the token bound (input + output only);
 * their spend is still bounded, through the reported cost.
 */
export function recordRunUsage(
  budget: ToolCallBudget,
  usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
  },
): AgentRunBudgetCrossing | null {
  budget.inputTokens += usage.inputTokens ?? 0;
  budget.outputTokens += usage.outputTokens ?? 0;
  budget.costUsd += usage.costUsd ?? 0;
  if (budget.exceeded || budget.wouldExceed) return null;
  const totalTokens = budget.inputTokens + budget.outputTokens;
  const crossing: AgentRunBudgetCrossing | null =
    budget.tokenLimit > 0 && totalTokens >= budget.tokenLimit
      ? { bound: "tokens", used: totalTokens, limit: budget.tokenLimit, enforced: budget.enforce }
      : budget.costLimitUsd > 0 && budget.costUsd >= budget.costLimitUsd
        ? {
            bound: "cost",
            used: budget.costUsd,
            limit: budget.costLimitUsd,
            enforced: budget.enforce,
          }
        : null;
  if (!crossing) return null;
  if (crossing.enforced) budget.exceeded = crossing.bound;
  else budget.wouldExceed = crossing;
  return crossing;
}

/**
 * The one-time wrap-up note for a run that crossed its soft token bound, or
 * null. Handing the note out marks it notified, so later attempts do not repeat
 * it. Measuring-only runs never see the note: it exists to change behavior.
 */
export function runBudgetNoteFor(budget: ToolCallBudget): string | null {
  if (!budget.enforce || budget.softNotified || budget.exceeded) return null;
  if (budget.tokenSoftLimit <= 0) return null;
  const totalTokens = budget.inputTokens + budget.outputTokens;
  if (totalTokens < budget.tokenSoftLimit) return null;
  budget.softNotified = true;
  return `You are near this run's token budget (${totalTokens} of ${budget.tokenLimit} tokens used). Finish the current step and summarize what you have.`;
}

/** Fire the run's budget-crossing callback, if any. Never throws: the crossing already happened. */
export function notifyRunBudgetExceeded(
  request: AgentRunRequest,
  crossing: AgentRunBudgetCrossing,
): void {
  try {
    void Promise.resolve(request.onRunBudgetExceeded?.(crossing)).catch(() => undefined);
  } catch {
    /* A broken audit sink must not break the run. */
  }
}

export function toAgentTools(toolDefs: readonly ConnectorTool[], host: ToolHost): AgentTool[] {
  const { listed, deferred } = partitionTools(toolDefs);
  const tools = namedAgentTools(listed).map(({ tool, name }) =>
    toAgentTool(tool, host, name, { deferred }),
  );
  if (!deferred.length) return tools;
  const runnable = new Map(
    [...tools, ...deferred.map((tool) => toAgentTool(tool, host, tool.name, { viaUseTool: true }))]
      .filter((tool) => tool.name !== FIND_TOOL && tool.name !== USE_TOOL)
      .map((tool) => [tool.name, tool]),
  );
  return tools.map((tool) =>
    tool.name === USE_TOOL ? useToolAgentTool(tool, runnable, host) : tool,
  );
}

/**
 * Unwraps to the real tool before anything else, so its gate, approvals, checkpoint, audit
 * and activity all name that tool exactly as a direct call would.
 */
function useToolAgentTool(
  wrapper: AgentTool,
  runnable: ReadonlyMap<string, AgentTool>,
  host: ToolHost,
): AgentTool {
  return {
    ...wrapper,
    // Deferred schedule and memory tools must not race a sibling call.
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { name, arguments: args } = params as { name: string; arguments?: unknown };
      const tool = runnable.get(name);
      if (!tool) {
        host.queue.push({
          type: "tool",
          name: USE_TOOL,
          args: params as Record<string, unknown>,
          executionId: JSON.stringify(["pi-tool", host.agentNamespace ?? "main", toolCallId]),
          response: host.modelResponses,
        });
        throw new Error(`${name} is not available. Use a name find_tool lists.`);
      }
      const prepared = tool.prepareArguments?.(args ?? {}) ?? args ?? {};
      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: toolCallId,
        name,
        arguments: prepared as never,
      });
      return tool.execute(toolCallId, validated, signal, onUpdate);
    },
  };
}

/** Each tool's definition under the name the model calls it, as toAgentTools exposes it. */
export function agentToolDefinitions(toolDefs: readonly ConnectorTool[]) {
  const { listed, deferred } = partitionTools(toolDefs);
  return new Map([
    ...deferred.map((tool) => [tool.name, tool] as const),
    ...namedAgentTools(listed).map(({ tool, name }) => [name, tool] as const),
  ]);
}

/** Shared canonical mapping for checkpoint validation and runtime exposure. */
export function namedAgentTools(toolDefs: readonly ConnectorTool[]) {
  // Registration order is incidental. Canonicalize before allocating collision suffixes
  // so both provider-visible names and JSON schema serialization stay stable.
  const canonicalJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonicalJson(item)]),
      );
    }
    return value;
  };
  const ordered = toolDefs
    .map((tool) => ({
      tool: {
        ...tool,
        inputSchema: canonicalJson(tool.inputSchema) as Record<string, unknown>,
      },
      key: JSON.stringify(canonicalJson(tool)),
    }))
    .sort((a, b) =>
      a.tool.name < b.tool.name
        ? -1
        : a.tool.name > b.tool.name
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    )
    .map(({ tool }) => tool);
  const names = normalizeAgentToolNames(ordered);
  return ordered.map((tool, index) => ({ tool, name: names[index]! }));
}

/**
 * Normalize connector names only at the boundary where they are exposed to Pi.
 * Connector execution continues to use the original name captured by toAgentTool.
 */
export function normalizeAgentToolName(name: string): string {
  if (isProviderSafeAgentToolName(name)) return name;
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || FALLBACK_AGENT_TOOL_NAME).slice(0, MAX_AGENT_TOOL_NAME_LENGTH);
}

const ACTIVITY_DETAIL_LIMIT = 90;

const MAX_STEP_ACTIONS = 3;
const STEP_ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What a call's steps show: the actions a batch runs, else the tool's label. Empty when neither
 * applies, so callers fall back to the tool name.
 */
export function connectorStepNames(tool: ConnectorTool | undefined, args: unknown): string[] {
  const actions = batchStepActions(tool, args);
  if (actions.length > 0) return actions;
  return tool?.label ? [tool.label] : [];
}

/** The model writes these names, so show only a few that look like tool names. */
function batchStepActions(tool: ConnectorTool | undefined, args: unknown): string[] {
  if (!tool?.batch) return [];
  const { actions, complete } = batchActions(tool.batch, args);
  if (!complete || actions.length > MAX_STEP_ACTIONS) return [];
  if (!actions.every((action) => STEP_ACTION_NAME.test(action))) return [];
  return actions.map(humanizeToolName);
}

/** One human-readable line describing a tool call, shown live in the thread. */
export function describeToolActivity(
  toolName: string,
  args: unknown,
  findTool?: (name: string) => ConnectorTool | undefined,
): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === USE_TOOL)
    return describeToolActivity(String(record.name), record.arguments, findTool);
  const tool = findTool?.(toolName);
  const actions = batchStepActions(tool, args);
  if (actions.length > 0) return `Using ${actions.join(", ")}`;
  if (tool?.label) return tool.label;
  if (toolName === FIND_TOOL) return "Finding a tool";
  const detail = (value: unknown): string => {
    const text = sanitizeSensitiveText(String(value ?? ""))
      .replaceAll(/\s+/g, " ")
      .trim();
    return clipToolResultText(text, ACTIVITY_DETAIL_LIMIT);
  };
  if (toolName === "shell") return `Running: ${detail(record.command)}`;
  if (toolName === "user_computer_shell")
    return `Running on your computer: ${detail(record.command)}`;
  if (toolName === "user_computer_observe") return `Looking at ${detail(record.app)}`;
  if (toolName === "user_computer_act") return `Using ${detail(record.app)}`;
  if (toolName === "read_file") return `Reading ${detail(record.path)}`;
  if (toolName === "write_file") return `Writing ${detail(record.path)}`;
  if (toolName === "list_files") return `Listing ${detail(record.path ?? ".")}`;
  if (toolName === "attach_file") return `Attaching ${detail(record.path)}`;
  if (toolName === "open_path") return `Opening ${detail(record.path)}`;
  if (toolName === "render_plot") return "Rendering a chart";
  if (toolName === "save_page") {
    return record.help === true ? "Reading the page kit reference" : "Writing the page code";
  }
  if (toolName === "add_mcp_server") return `Connecting MCP server: ${detail(record.name)}`;
  if (toolName === "computer_observe") return "Looking at the screen";
  if (toolName === "browser_navigate")
    return `Opening page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "browser_snapshot") return "Reading the page";
  if (toolName === "browser_act") return "Using the page";
  if (toolName === "computer_act") return "Operating the computer";
  if (toolName === "run_subagent") return `Delegating to helper: ${detail(record.name)}`;
  if (toolName === "create_space") return `Creating space: ${detail(record.name)}`;
  if (toolName === "list_fleet") return "Checking your bots";
  if (toolName === "create_group") return `Creating group: ${detail(record.name)}`;
  if (toolName === "update_group")
    return `Updating group: ${detail(record.group_name ?? record.name)}`;
  if (toolName === "organize_bot") return "Organizing the sidebar";
  if (toolName === "set_child_instructions") return "Rewriting a bot's instructions";
  if (toolName === "set_child_bot_model") return "Setting a bot's model";
  if (toolName === "create_child_routine") return `Scheduling routine: ${detail(record.name)}`;
  if (toolName === "remember") return "Saving a note to memory";
  if (toolName === "save_shared_memory") return `Saving shared memory: ${detail(record.path)}`;
  if (toolName === "web_search") return `Searching the web: ${detail(record.query)}`;
  if (toolName === "web_fetch") return `Reading page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "service_search") return `Finding a service: ${detail(record.query)}`;
  if (toolName === "service_call") return `Using service: ${detail(record.service)}`;
  if (toolName === "decide") return "Asking the decision model";
  if (toolName === "document_parse") return `Reading document: ${detail(record.path)}`;
  if (toolName === "document_extract") return `Extracting fields: ${detail(record.path)}`;
  if (toolName === "document_classify") return `Classifying document: ${detail(record.path)}`;
  if (toolName === "document_split") return `Splitting document: ${detail(record.path)}`;
  if (toolName === "document_locate") return `Locating text: ${detail(record.path)}`;
  if (toolName === "skill_read")
    return record.file
      ? `Reading ${detail(record.file)} from ${detail(record.name)}`
      : `Reading skill: ${detail(record.name)}`;
  if (toolName === "skill_create") return `Creating skill: ${detail(record.name ?? "skill")}`;
  if (toolName === "skill_update")
    return `Updating skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "skill_delete")
    return `Deleting skill: ${detail(record.name ?? record.skillId)}`;
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return `Using ${toolName}`;
}

/**
 * Existing valid names are reserved first so sanitizing a connector cannot
 * rename or shadow a builtin tool with the same valid name.
 */
export function normalizeAgentToolNames(tools: readonly ConnectorTool[]): string[] {
  const reservedValidNames = new Set(
    tools.filter((tool) => isProviderSafeAgentToolName(tool.name)).map((tool) => tool.name),
  );
  const usedNames = new Set<string>();

  return tools.map((tool) => {
    const base = normalizeAgentToolName(tool.name);
    const originalIsValid = isProviderSafeAgentToolName(tool.name);
    let candidate = base;

    if (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, stableToolNameHash(tool.name));
    }

    let suffix = 2;
    while (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, `${stableToolNameHash(tool.name)}_${suffix}`);
      suffix += 1;
    }

    usedNames.add(candidate);
    return candidate;
  });
}

function isProviderSafeAgentToolName(name: string): boolean {
  return AGENT_TOOL_NAME_PATTERN.test(name) && name.length <= MAX_AGENT_TOOL_NAME_LENGTH;
}

function withToolNameSuffix(base: string, suffix: string): string {
  const suffixWithSeparator = `_${suffix}`;
  const prefixLength = Math.max(1, MAX_AGENT_TOOL_NAME_LENGTH - suffixWithSeparator.length);
  return `${base.slice(0, prefixLength)}${suffixWithSeparator}`;
}

function stableToolNameHash(name: string): string {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Missing label/purpose must fail rather than filling Code/otp placeholders.
 * `credential` and `replace` must survive: the executor stores a submitted
 * value only when `credential` is present. Top-level destination fields and a
 * JSON string credential are folded into `credential` so they are not dropped.
 */
export function prepareRequestSecretArguments(raw: Record<string, unknown>) {
  const label = raw.label == null ? "" : String(raw.label);
  const purpose = raw.purpose == null ? "" : String(raw.purpose);
  if (!label.trim() || !purpose.trim()) {
    throw new Error(
      `request_secret requires a non-empty label and purpose (received: ${
        Object.keys(raw).sort().join(", ") || "no arguments"
      })`,
    );
  }
  const credential = credentialArgument(raw);
  const connectionId = connectionIdArgument(raw.connectionId);
  return {
    label,
    purpose,
    ...(connectionId ? { connectionId } : {}),
    ...(credential !== undefined ? { credential } : {}),
    ...(raw.oneTimeCode !== undefined ? { oneTimeCode: oneTimeCodeArgument(raw.oneTimeCode) } : {}),
    ...(raw.replace === true ? { replace: true } : {}),
    ...(raw.fields != null ? { fields: loginFieldLabelsArgument(raw.fields) } : {}),
  };
}

function toAgentTool(
  tool: ConnectorTool,
  host: ToolHost,
  exposedName: string,
  { deferred = [], viaUseTool = false }: { deferred?: ConnectorTool[]; viaUseTool?: boolean } = {},
): AgentTool {
  return {
    name: exposedName,
    label: tool.name,
    description: tool.description,
    // Pi runs a turn's tool calls concurrently by default, so a batch that
    // creates a routine and lists routines can read the list before the row
    // exists. Pi runs the whole batch in order when any call in it is
    // sequential. Remember also needs this to avoid competing revision writes, and request_secret
    // so a sibling request cannot start after one pauses for its card and share its answer.
    ...(SCHEDULE_TOOL_NAMES.has(tool.name) ||
    tool.name === "remember" ||
    tool.name === "request_secret"
      ? { executionMode: "sequential" as const }
      : {}),
    parameters: parametersFor(tool),
    prepareArguments: (args: unknown) => {
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (tool.name === "remember") {
        return {
          content: String(raw.content ?? ""),
          ...(typeof raw.old_text === "string" && raw.old_text ? { old_text: raw.old_text } : {}),
        };
      }
      if (tool.name === "request_takeover") {
        return { reason: String(raw.reason ?? "I need you on the screen.") };
      }
      if (tool.name === "ask_user") {
        const options = Array.isArray(raw.options) ? raw.options.map(String) : raw.options;
        // The content the user is deciding about, shown on the card under the question;
        // redacted and capped here so recorded arguments never hold the raw value. A
        // non-string value is dropped, not passed through: Pi coerces numbers and
        // booleans to strings only after this point, past redaction, and a rejected
        // object would echo its raw value in the validation error the model sees.
        return {
          question: String(raw.question ?? "What should I use?"),
          ...(typeof raw.detail === "string" && raw.detail
            ? { detail: redactedAskUserDetail(raw.detail, host.request.secrets) }
            : {}),
          // Keep a missing/invalid options value as-is so schema minItems can reject it;
          // coercing to [] would look like a valid empty list upstream.
          options,
        };
      }
      if (tool.name === "request_secret") {
        return prepareRequestSecretArguments(raw);
      }
      if (tool.name === "write_file") {
        return {
          path: String(raw.path ?? "notes/result.txt"),
          content: textContentArg(raw.content, ""),
        };
      }
      if (tool.name === "computer_act") {
        return {
          actions: Array.isArray(raw.actions) ? raw.actions : [],
          observe: raw.observe === undefined ? true : Boolean(raw.observe),
          settle_ms: Number(raw.settle_ms ?? 350),
        };
      }
      if (tool.name === "list_files") return { path: String(raw.path ?? "") };
      if (tool.name === "read_file") {
        const offset = positiveIntegerArg(raw.offset);
        const limit = positiveIntegerArg(raw.limit);
        return {
          path: String(raw.path ?? ""),
          // Values that are not positive integers are dropped so one bad
          // argument cannot fail the read; the executor revalidates.
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        };
      }
      if (tool.name === "open_path") {
        return { path: String(raw.path ?? "") };
      }
      if (tool.name === "launch_app") {
        return {
          application: String(raw.application ?? ""),
          uri: raw.uri ? String(raw.uri) : "",
        };
      }
      if (tool.name === "shell" || tool.name === "user_computer_shell") {
        return {
          command: String(raw.command ?? ""),
          // The executor chooses the default: the bot's folder, or the user's home.
          ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
        };
      }
      if (tool.name === "run_subagent") {
        return {
          name: String(raw.name ?? "helper"),
          task: String(raw.task ?? ""),
          instructions: raw.instructions ? String(raw.instructions) : "",
          model_provider: raw.model_provider ? String(raw.model_provider) : "",
          model_id: raw.model_id ? String(raw.model_id) : "",
          ...(raw.background === true ? { background: true } : {}),
        };
      }
      if (tool.name === "spawn_bot") {
        return {
          name: String(raw.name ?? ""),
          description: raw.description ? String(raw.description) : "",
          instructions: raw.instructions ? String(raw.instructions) : "",
          prompt: raw.prompt ? String(raw.prompt) : "",
          // Left out means Team; an empty string would fail the mode's enum.
          ...(raw.computer_mode ? { computer_mode: String(raw.computer_mode) } : {}),
        };
      }
      if (tool.name === "update_bot" || FLEET_TOOL_NAMES.some((name) => name === tool.name)) {
        return prepareFleetArguments(tool.name, raw);
      }
      if (tool.name === "create_space") {
        return { name: String(raw.name ?? "") };
      }
      if (tool.name === "archive_bot") {
        return {
          confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
          bot_id: raw.bot_id ? String(raw.bot_id) : raw.botId ? String(raw.botId) : "",
        };
      }
      return raw as never;
    },
    execute: async (toolCallId, params): Promise<AgentToolResult<unknown>> =>
      withPiTelemetrySpan(
        "pi.agent.tool",
        {
          "pi.agent.tool.name": tool.name,
        },
        async (span) => {
          host.signal.throwIfAborted();
          if (
            host.computerModeAllowed &&
            COMPUTER_MODE_TOOLS.has(tool.name) &&
            (host.depth !== 0 || !host.computerModeAllowed())
          )
            throw new Error("Enter top-level computer mode before using computer tools");
          const args = (params ?? {}) as Record<string, unknown>;
          const keepToolResultWhole = (name: string, callArgs: Record<string, unknown>) =>
            VERBATIM_TOOL_RESULTS.has(name) ||
            isVerbatimMcpResult(name, callArgs, host.request.verbatimMcpServers);
          recordPiTelemetryContent(span, "pi.agent.tool.arguments", args);
          const rawCallId =
            toolCallId || `${host.request.runId}:${tool.name}:${host.toolCallSeq.value++}`;
          // Backend idempotency includes the agent namespace; Pi wire IDs remain untouched.
          const executionId = JSON.stringify(["pi-tool", host.agentNamespace ?? "main", rawCallId]);
          // A sequential tail cannot start after its preceding call pauses.
          // This makes the saved sequential tail safe to resolve on resume.
          if (host.pausePending)
            return { content: [], details: { skipped: true }, terminate: true };
          if (host.depth === 0) await host.captureCheckpoint?.(rawCallId, executionId);
          if (host.pausePending)
            return { content: [], details: { skipped: true }, terminate: true };
          if (!beginToolCall(host)) {
            return {
              content: [{ type: "text", text: "Skipped: tool-call limit reached." }],
              details: { skipped: true },
            };
          }
          host.queue.push({
            type: "tool",
            name: tool.name,
            args,
            executionId,
            response: host.modelResponses,
            ...(viaUseTool ? { viaUseTool } : {}),
          });
          const startedAt = Date.now();
          let result: unknown;
          let failure: unknown;
          try {
            result = await (async () => {
              if (tool.name === "request_takeover") {
                host.pausePending = true;
                host.queue.push({
                  type: "takeover",
                  ...(host.request.onCheckpoint ? { executionId } : {}),
                  reason: String(args.reason ?? "I need you on the screen."),
                });
                return {
                  content: [{ type: "text", text: "Takeover requested." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === "ask_user") {
                const options = Array.isArray(args.options)
                  ? args.options.map((option) => String(option).trim())
                  : [];
                if (
                  options.length < 2 ||
                  options.length > 4 ||
                  options.some((option) => option.length === 0 || option.length > 80) ||
                  new Set(options).size !== options.length
                ) {
                  throw new Error("ask_user requires two to four unique, non-empty options");
                }
                host.pausePending = true;
                host.queue.push({
                  type: "ask",
                  ...(host.request.onCheckpoint ? { executionId } : {}),
                  text: String(args.question ?? "What should I use?"),
                  ...(typeof args.detail === "string" && args.detail
                    ? { detail: args.detail }
                    : {}),
                  actions: options.map((label, index) => ({
                    id: `choice-${index + 1}`,
                    label,
                  })),
                });
                return {
                  content: [{ type: "text", text: "Waiting for the user's choice." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === "request_secret") {
                if (host.request.executeTool) {
                  const result = await host.request.executeTool(tool.name, args, executionId);
                  if (isAgentToolExecutionResult(result)) {
                    if (isToolPauseResult(result)) host.pausePending = true;
                    return result;
                  }
                  return {
                    content: [
                      {
                        type: "text",
                        text: serializeToolResult(
                          result,
                          host.request.contextStrategy,
                          tool.name,
                          args,
                        ),
                      },
                    ],
                    details: result,
                  };
                }
                host.pausePending = true;
                return {
                  content: [{ type: "text", text: "Protected input requested." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === FIND_TOOL) {
                // Outside computer mode, screen tools are reached by entering it, not by search.
                const findable =
                  host.computerModeAllowed && (host.depth !== 0 || !host.computerModeAllowed())
                    ? deferred.filter((candidate) => !COMPUTER_MODE_TOOLS.has(candidate.name))
                    : deferred;
                const found = findTools(findable, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(found) }],
                  details: found,
                };
              }
              // A background helper is its own run, which the executor starts like any tool effect.
              if (tool.name === "run_subagent" && args.background !== true) {
                const result = await executeSubagent(host, executionId, args);
                return {
                  content: [{ type: "text", text: result }],
                  details: { result },
                };
              }
              if (host.request.executeTool) {
                const result = await host.request.executeTool(
                  tool.name,
                  args,
                  executionId,
                  tool.route,
                  {
                    onShellStillRunning: (completion) => {
                      host.pendingShells.push(completion);
                    },
                  },
                );
                if (isAgentToolExecutionResult(result)) {
                  if (isToolPauseResult(result)) host.pausePending = true;
                  return keepToolResultWhole(tool.name, args)
                    ? result
                    : boundAgentToolResult(result);
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: serializeToolResult(
                        result,
                        host.request.contextStrategy,
                        tool.name,
                        args,
                        host.request.verbatimMcpServers,
                      ),
                    },
                  ],
                  details: result,
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `${tool.name} is unavailable without an executor.`,
                  },
                ],
                details: { error: "no executor" },
              };
            })();
            if (keepToolResultWhole(tool.name, args)) return result as AgentToolResult<unknown>;
            return boundAgentToolResult(result as AgentToolResult<unknown>);
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            // Pi only terminates a parallel batch when every result terminates.
            // A single paused or turn-ending call must stop the turn before another
            // model request, or the next assistant message replaces its final reply.
            if (host.pausePending || isTerminatingReplyResult(result)) host.abortTurn?.();
            const details = (
              result as AgentToolResult<{ error?: unknown; isError?: unknown }> | undefined
            )?.details;
            const failed =
              failure !== undefined || details?.error != null || details?.isError === true;
            span?.setAttributes({ "pi.agent.tool.success": !failed });
            recordPiTelemetryContent(span, "pi.agent.tool.result", result);
            if (failed) span?.setStatus({ status: "error" });
            endToolCall(host);
            const completion: AgentToolCompletion = {
              name: tool.name,
              executionId,
              durationMs: Math.max(0, Date.now() - startedAt),
              ...(result === undefined ? {} : { result }),
              ...(failure === undefined ? {} : { error: failure }),
              ...(host.pausePending ? { paused: true } : {}),
            };
            try {
              void Promise.resolve(host.request.onToolCompleted?.(completion)).catch(
                () => undefined,
              );
            } catch {
              // Audit hooks are best effort and must never change tool behavior.
            }
          }
        },
      ),
  };
}

function isAgentToolExecutionResult(result: unknown): result is AgentToolExecutionResult {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { kind?: unknown }).kind !== "agent_tool_result" ||
    (((result as { terminate?: unknown }).terminate === true || isToolPauseResult(result)) &&
      !isInternalTermination(result)) ||
    !("content" in result)
  ) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.every(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item as { type?: unknown }).type === "text" ||
          (item as { type?: unknown }).type === "image"),
    )
  );
}

export function serializeToolResult(
  result: unknown,
  strategy: AgentRunRequest["contextStrategy"],
  name: string,
  args: Record<string, unknown>,
  verbatimMcpServers?: AgentRunRequest["verbatimMcpServers"],
) {
  try {
    const text = JSON.stringify(result);
    if (!text) return "ok";
    // skill-tools.ts already bounds skill content; the context budget selector may still shorten it.
    if (
      text.length <= TOOL_RESULT_TEXT_LIMIT ||
      VERBATIM_TOOL_RESULTS.has(name) ||
      isVerbatimMcpResult(name, args, verbatimMcpServers)
    )
      return text;
    return (strategy ?? DEFAULT_CONTEXT_STRATEGY) === "current"
      ? clipToolResultText(text)
      : shortenToolResultText(text, TOOL_RESULT_TEXT_LIMIT, { name, arguments: args });
  } catch {
    return "ok";
  }
}

function boundAgentToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: clipToolResultContent(result.content),
  };
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}

export interface EventQueue {
  push(event: AgentRuntimeEvent): void;
  fail(error: Error): void;
  close(): void;
  iterate(): AsyncIterable<AgentRuntimeEvent>;
}

export interface ToolHost {
  context?: Partial<AdapterContext>;
  modelFetch?: typeof globalThis.fetch;
  onContextDecision?: PiAgentRuntimeOptions["onContextDecision"];
  modelCallObserver?: ModelCallObserver;
  queue: EventQueue;
  request: AgentRunRequest;
  activeModel: RuntimeModelTarget;
  computerModeAllowed?: () => boolean;
  models: Models;
  model: Model<Api>;
  apiKey: string | undefined;
  nestedAgents: Set<Agent>;
  subagentGate: { acquire(): Promise<void>; release(): void };
  toolCallBudget: ToolCallBudget;
  /** Shared fallback uniqueness when the model omits toolCallId (nested hosts reuse this). */
  toolCallSeq: { value: number };
  abortTurn(): void;
  signal: AbortSignal;
  depth: number;
  agentNamespace?: string;
  pausePending: boolean;
  captureCheckpoint?: (toolCallId: string, executionId: string) => Promise<void>;
  /** Shell commands that returned output and are still running. */
  pendingShells: Array<Promise<FinishedShellCommand>>;
  /** Model responses started by the main agent. Helpers reset it, so each of their calls counts. */
  modelResponses?: number;
}

function formatBudgetUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** The user-visible stop message for a spent budget, naming the bound that was hit. */
export function toolCallBudgetExceededMessage(budget: ToolCallBudget) {
  switch (budget.exceeded) {
    case "tokens": {
      const used = budget.inputTokens + budget.outputTokens;
      return `I stopped after reaching this run's limit of ${budget.tokenLimit} tokens (${used} used). Send another message to continue.`;
    }
    case "cost":
      return `I stopped after reaching this run's cost limit of ${formatBudgetUsd(budget.costLimitUsd)} (${formatBudgetUsd(budget.costUsd)} used). Send another message to continue.`;
    default:
      return `I stopped after reaching the limit of ${budget.toolCalls.limit} tool calls in this turn. Send another message to continue.`;
  }
}

/**
 * The ask card's detail is the one tool argument the product keeps outside the tool call
 * itself: on the card, in the turn checkpoint and in the recorded session. Redact and cap
 * it once, at the argument boundary, so every downstream copy holds the safe value.
 */
export function redactedAskUserDetail(
  detail: string,
  secrets: readonly string[] | undefined,
): string {
  const redacted = redactSecrets(detail, secrets ?? []);
  // A draft within the schema's maxLength is kept as redacted, unchanged. Only a
  // longer one (redaction can expand a short secret past the limit) is cut, one
  // unit below the limit so the appended ellipsis stays within it, stepping back
  // over a surrogate pair the cut would split.
  if (redacted.length <= MAX_APPROVAL_DETAIL_LENGTH) return redacted;
  let capped = redacted.slice(0, MAX_APPROVAL_DETAIL_LENGTH - 1);
  const last = capped.charCodeAt(capped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) capped = capped.slice(0, -1);
  return `${capped}…`;
}

/** The arguments an ask_user call carries: directly, or nested in a use_tool wrapper
 * (the wrapper's own normalizer unwraps them, but the streamed message records the
 * nested object verbatim). */
function askUserScrubTarget(call: {
  name?: string;
  arguments?: unknown;
}): Record<string, unknown> | undefined {
  // A provider can stream malformed arguments (a bare string or number); argument
  // preparation rejects those later, so there is nothing to scrub here.
  const args = asObject(call.arguments);
  if (call.name === "ask_user") return args;
  if (call.name !== USE_TOOL || args?.name !== "ask_user") return undefined;
  return asObject(args.arguments);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Redacts the ask card's detail in a streamed assistant message, in place, so the session
 * transcript, the turn checkpoint and later provider payloads never hold the raw value. */
export function redactAskUserDetailInMessage(
  message: { role: string; content?: unknown },
  secrets: readonly string[] | undefined,
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    const call = part as { type?: string; name?: string; arguments?: unknown };
    if (call?.type !== "toolCall") continue;
    // A use_tool wrapper can carry ask_user's arguments as a bare string, which argument
    // preparation rejects but the message keeps; redact it whole so no kept copy holds a raw
    // secret. (Unparseable direct arguments reach here as {} plus the parser's argumentsError.)
    const wrapper = call.name === USE_TOOL ? asObject(call.arguments) : undefined;
    if (wrapper?.name === "ask_user" && typeof wrapper.arguments === "string") {
      wrapper.arguments = redactSecrets(wrapper.arguments, secrets ?? []);
    }
    const args = askUserScrubTarget(call);
    if (!args) continue;
    if (typeof args.detail === "string") {
      if (args.detail) args.detail = redactedAskUserDetail(args.detail, secrets);
    } else if ("detail" in args) {
      // A non-string detail never reaches the card (the argument normalizer drops
      // it); drop it here too, so no kept copy holds the raw value.
      delete args.detail;
    }
  }
}

export function toolCallBudgetFor(runId: string, options?: { routine?: boolean }): ToolCallBudget {
  const limits = runBudgetLimits(process.env, options);
  const existing = toolCallBudgetsByRun.get(runId);
  if (existing) {
    existing.inFlight = 0;
    applyRunBudgetLimits(existing, limits);
    return existing;
  }
  const budget: ToolCallBudget = {
    toolCalls: { used: 0, limit: limits.toolCallLimit },
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    tokenLimit: limits.tokenLimit,
    tokenSoftLimit: limits.tokenSoftLimit,
    costLimitUsd: limits.costLimitUsd,
    enforce: limits.enforce,
    exceeded: null,
    wouldExceed: null,
    softNotified: false,
    inFlight: 0,
  };
  // A budget with no bound configured is not kept in the map: nothing can
  // cross, and the usage records already hold its totals. Kept budgets persist
  // across a pause/resume of the same run, counts included.
  if (limits.toolCallLimit > 0 || limits.tokenLimit > 0 || limits.costLimitUsd > 0) {
    toolCallBudgetsByRun.set(runId, budget);
  }
  return budget;
}

export function releaseToolCallBudget(runId: string, keepForResume: boolean) {
  if (!keepForResume) toolCallBudgetsByRun.delete(runId);
}

export function maybeAbortToolCallBudget(host: ToolHost) {
  if (host.toolCallBudget.exceeded && host.toolCallBudget.inFlight === 0) {
    host.abortTurn();
  }
}

function beginToolCall(host: ToolHost): boolean {
  const budget = host.toolCallBudget;
  if (budget.exceeded) {
    maybeAbortToolCallBudget(host);
    return false;
  }
  budget.toolCalls.used += 1;
  if (budget.toolCalls.limit <= 0) return true;
  if (budget.toolCalls.used <= budget.toolCalls.limit) {
    budget.inFlight += 1;
    return true;
  }
  budget.exceeded = "tool_calls";
  host.queue.push({
    type: "progress",
    text: `Stopped: more than ${budget.toolCalls.limit} tool calls in one turn.`,
  });
  notifyRunBudgetExceeded(host.request, {
    bound: "tool_calls",
    used: budget.toolCalls.used,
    limit: budget.toolCalls.limit,
    enforced: true,
  });
  maybeAbortToolCallBudget(host);
  return false;
}

function endToolCall(host: ToolHost) {
  host.toolCallBudget.inFlight = Math.max(0, host.toolCallBudget.inFlight - 1);
  maybeAbortToolCallBudget(host);
}

export function createGate(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (active >= max) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

export function createQueue(): EventQueue {
  const items: AgentRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: Error | undefined;
  return {
    push(event) {
      items.push(event);
      wake?.();
    },
    fail(error) {
      failure = error;
      closed = true;
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *iterate() {
      while (true) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
