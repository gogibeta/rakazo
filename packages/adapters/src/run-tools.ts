import { createHash } from "node:crypto";
import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import {
  BACKGROUND_HELPER_TRIGGER,
  connectorKindFromToolName,
  redactSecrets,
  toolResultTaintsRun,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { ToolEventStatus } from "@rakazo/db";
import { recordToolEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isTerminatingReplyResult, isToolPauseResult } from "./approval-effect.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import { noteComputerTaskStep } from "./run-progress.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import {
  BACKGROUND_HELPER_TOOL_NAMES,
  BUILTIN_AGENT_TOOL_NAMES,
  PAGE_BROWSER_TOOL_NAMES,
} from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { emailTools } from "./run-tools-email.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { hostTools } from "./run-tools-host.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { walletTools } from "./run-tools-wallets.js";
import { strategicInitiativeToolAllowed } from "./strategic-initiative.js";
import { logToolRefusal } from "./tool-completion-audit.js";
import { refusal, refusalCode } from "./tool-refusal.js";
import { argumentGiven } from "./update-bot-patch.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(pageTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(walletTools),
  ...Object.entries(hostTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...Object.entries(emailTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** History and memory search calls: recorded as recall traffic, never as content. */
const RECALL_TOOL_NAMES = new Set(["search_history", "read_history", "recall_memory"]);

/** Gate refusal codes that are decisions against the call, not pre-gate turn-aways. */
const GATE_DENIAL_CODES = new Set([
  "approval_denied",
  "action_denied_repeat",
  "spending_limit",
  "purchase_needs_approval_unattended",
  "wallet_needs_approval_unattended",
  "host_restart_needs_approval_unattended",
  "fetch_needs_approval_unattended",
  "helper_cannot_ask_approval",
]);

/** sha256 of the canonical arguments — the canonicalization the loop guard hashes with. */
function toolArgsHash(args: Record<string, unknown>): string {
  let canonical: string;
  try {
    canonical = stableJsonValue(args);
  } catch {
    canonical = '"rakazo:unserializable-args"';
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * A scalar-only projection of the arguments for the tool-event record: nested
 * values are dropped, and strings pass through the run's secret redaction. The
 * writer applies the audit metadata rules on top. Never the raw arguments.
 */
function toolArgsSummary(
  ctx: RunContext,
  args: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const summary: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") summary[key] = redactSecrets(value, ctx.secrets);
    else if (typeof value === "number" || typeof value === "boolean" || value === null)
      summary[key] = value;
  }
  return summary;
}

function resultByteSize(result: unknown): number | null {
  try {
    const json = JSON.stringify(result);
    return json === undefined ? null : new TextEncoder().encode(json).length;
  } catch {
    return null;
  }
}

/** How a gate result ended the call: a pause, a decision against it, a turn-away, or a settled replay. */
function gateResultStatus(result: unknown): ToolEventStatus {
  if (isToolPauseResult(result)) return "paused";
  const code = refusalCode(result);
  if (code) return GATE_DENIAL_CODES.has(code) ? "denied" : "refused";
  return isToolError(result) ? "failed" : "succeeded";
}

/** Record one dispatch outcome in the run's tool events. A record, never a gate: the write cannot fail the call. */
async function recordDispatchToolEvent(
  ctx: RunContext,
  fields: {
    toolName: string;
    args: Record<string, unknown>;
    status: ToolEventStatus;
    startedAt: number;
    effectId?: string;
    result?: unknown;
  },
): Promise<void> {
  try {
    await recordToolEvent({
      spaceId: ctx.run.spaceId,
      threadId: ctx.thread.id,
      runId: ctx.runId,
      botId: ctx.bot.id,
      toolName: fields.toolName,
      connectorKind: connectorKindFromToolName(
        fields.toolName,
        (ctx.tools.connectedPlugins ?? []).map((plugin) => plugin.provider),
      ),
      argsHash: toolArgsHash(fields.args),
      argsSummary: toolArgsSummary(ctx, fields.args),
      kind: RECALL_TOOL_NAMES.has(fields.toolName) ? "recall" : "normal",
      status: fields.status,
      effectId: fields.effectId ?? null,
      resultBytes: fields.result === undefined ? null : resultByteSize(fields.result),
      durationMs: Math.max(0, Date.now() - fields.startedAt),
    });
  } catch (error) {
    getLogger().warn("tool event recording failed", {
      "error.detail": error instanceof Error ? error.message : "unknown",
      tool: fields.toolName,
    });
  }
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  // A bot naming itself in bot_id means its own settings. Dropping it here sends the call down
  // the own path everywhere: preparation, the stored approval, the handler and the check below.
  if (
    name === "update_bot" &&
    typeof args.bot_id === "string" &&
    args.bot_id.trim() === ctx.bot.id
  ) {
    const { bot_id: _self, ...own } = args;
    args = own;
  }
  try {
    return await dispatchTool(ctx, name, args, executionId, observer);
  } finally {
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  const startedAt = Date.now();
  // A call turned away before its tool runs is logged by its refusal code. `target` is the
  // connector tool a catalog call resolved to.
  const logRefusal = <T>(refused: T, target?: string): T => {
    const logged = logToolRefusal(
      {
        spaceId: ctx.run.spaceId,
        threadId: ctx.thread.id,
        botId: ctx.bot.id,
        runId: ctx.runId,
        trigger: ctx.run.trigger,
      },
      name,
      refused,
      ctx.secrets,
      target === name ? undefined : target,
    );
    if (logged) {
      ctx.state.toolRefusals ??= new Map();
      ctx.state.toolRefusals.set(executionId, logged);
    }
    return refused;
  };
  // A pre-gate turn-away is also a tool event, with the name the call carried here.
  const refuse = async <T>(refused: T, target?: string): Promise<T> => {
    logRefusal(refused, target);
    await recordDispatchToolEvent(ctx, {
      toolName: target ?? name,
      args,
      status: "refused",
      startedAt,
    });
    return refused;
  };
  if (!strategicInitiativeToolAllowed(name, ctx.run)) {
    return refuse(
      refusal(
        "daily_check_in_tool_not_allowed",
        "Daily check-ins can only ask or message the user.",
      ),
    );
  }
  if (ctx.state.handedOff) {
    return refuse(
      refusal(
        "stage_handed_off",
        "This stage was handed off. End the turn without more tool calls.",
      ),
    );
  }
  if (ctx.tools.disabled.has(name)) {
    return refuse(refusal("tool_disabled", "This tool is disabled for this bot."));
  }
  // Only offered tools reach the model, but a runtime can still emit any name, and a connector
  // tool named like a local one still runs the local handler.
  if (
    ctx.run.trigger === BACKGROUND_HELPER_TRIGGER &&
    (BUILTIN_AGENT_TOOL_NAMES.has(name) || TOOL_HANDLERS.has(name)) &&
    !BACKGROUND_HELPER_TOOL_NAMES.has(name)
  ) {
    return refuse(
      refusal(
        "helper_tool_unavailable",
        `${name} is not available to a background helper. Don't retry; say in your result what the bot should do.`,
      ),
    );
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return refuse(
      refusal("page_browser_unavailable", "Page browser is unavailable on this computer."),
    );
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return refuse(refusal("model_cannot_see_images", MODEL_CANNOT_SEE_MESSAGE));
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return refuse(request);
  // A catalog call resolves to a connector tool after the checks above; one named like a local
  // tool (message_agent, cloud_agent_*, ...) would otherwise run that local handler instead.
  if (request.catalogRemapped && toolHandler(request.name) !== connectorTool) {
    return refuse(
      refusal("connector_name_conflict", "Connector tool name conflicts with a built-in tool"),
      request.name,
    );
  }
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refuse(refused, request.name);
  noteComputerTaskStep(ctx.state.reply, request.name);
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) {
    logRefusal(gate.result, request.name);
    const status = gateResultStatus(gate.result);
    await recordDispatchToolEvent(ctx, {
      toolName: request.name,
      args: request.args,
      status,
      startedAt,
      effectId: gate.effectId,
      result: status === "succeeded" || status === "failed" ? gate.result : undefined,
    });
    return gate.result;
  }
  if (!gate.call.applied) {
    try {
      const result = await toolHandler(gate.call.name)(ctx, gate.call);
      await recordDispatchToolEvent(ctx, {
        toolName: gate.call.name,
        args: gate.call.args,
        status: isToolError(result) ? "failed" : "succeeded",
        startedAt,
        result,
      });
      return result;
    } catch (error) {
      await recordDispatchToolEvent(ctx, {
        toolName: gate.call.name,
        args: gate.call.args,
        status: "failed",
        startedAt,
      });
      throw error;
    }
  }
  let outcome: "success" | "failure" = "failure";
  let result: unknown;
  try {
    result = await toolHandler(gate.call.name)(ctx, gate.call);
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
    });
    await recordDispatchToolEvent(ctx, {
      toolName: gate.call.name,
      args: gate.call.args,
      status: outcome === "success" ? "succeeded" : "failed",
      startedAt,
      effectId: gate.call.applied.effect.id,
      result,
    });
  }
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  return isTerminatingReplyResult(result);
}
