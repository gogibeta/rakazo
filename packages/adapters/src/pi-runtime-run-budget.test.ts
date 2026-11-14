import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AgentRunBudgetCrossing,
  AgentRunRequest,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import type { ToolCallBudget } from "./pi-runtime-tools.js";
import {
  recordRunUsage,
  releaseToolCallBudget,
  runBudgetEnforced,
  runBudgetLimits,
  runBudgetNoteFor,
  toolCallBudgetExceededMessage,
  toolCallBudgetFor,
} from "./pi-runtime-tools.js";

const primary = model("provider-a", "primary", 32_768);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    // Every scripted call reports the same usage: 4 input + 2 output tokens, no cost.
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

type ScriptedCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function toolCalls(target: Model<"openai-completions">, calls: ScriptedCall[]) {
  const response = message(target, calls, "toolUse");
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  calls.forEach((call, index) => {
    result.push({
      type: "toolcall_start",
      contentIndex: index,
      partial: { ...response, content: [] },
    });
    result.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: response });
  });
  result.push({ type: "done", reason: "toolUse", message: response });
  result.end(response);
  return result;
}

function reply(target: Model<"openai-completions">, text: string) {
  const response = message(target, [{ type: "text", text }], "stop");
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  result.push({ type: "text_delta", contentIndex: 0, delta: text, partial: response });
  result.push({ type: "done", reason: "stop", message: response });
  result.end(response);
  return result;
}

const tools: AgentRunRequest["tools"] = [
  {
    name: "list_files",
    description: "List files in this bot's home",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    readOnly: true,
  },
];

function request(
  executeTool: AgentRunRequest["executeTool"],
  overrides?: Partial<AgentRunRequest>,
): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run-budget",
    prompt: "Look around",
    instructions: "Use tools when useful.",
    history: [],
    tools,
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-key" },
    executeTool,
    ...overrides,
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

const texts = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : []));

const BUDGET_ENV_KEYS = [
  "MAX_TOOL_CALLS_PER_TURN",
  "RUN_TOKEN_BUDGET_HARD",
  "RUN_TOKEN_BUDGET_SOFT",
  "RUN_COST_BUDGET_USD_HARD",
  "ROUTINE_RUN_TOKEN_BUDGET_HARD",
  "RUN_BUDGET_ENFORCE",
] as const;
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(`${primary.provider}/${primary.id}`, primary as never);
  providerState.stream.mockReset();
  for (const key of BUDGET_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of BUDGET_ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("runBudgetLimits", () => {
  it("treats unset, empty, and invalid values as unlimited with enforcement off", () => {
    expect(runBudgetLimits({})).toEqual({
      toolCallLimit: 0,
      tokenLimit: 0,
      tokenSoftLimit: 0,
      costLimitUsd: 0,
      enforce: false,
    });
    expect(
      runBudgetLimits({ RUN_TOKEN_BUDGET_HARD: "abc", RUN_COST_BUDGET_USD_HARD: "-2" }),
    ).toEqual({
      toolCallLimit: 0,
      tokenLimit: 0,
      tokenSoftLimit: 0,
      costLimitUsd: 0,
      enforce: false,
    });
  });

  it("defaults the soft bound to 80% of the hard bound and clamps it to the hard bound", () => {
    expect(runBudgetLimits({ RUN_TOKEN_BUDGET_HARD: "1000" }).tokenSoftLimit).toBe(800);
    expect(
      runBudgetLimits({ RUN_TOKEN_BUDGET_HARD: "1000", RUN_TOKEN_BUDGET_SOFT: "250" })
        .tokenSoftLimit,
    ).toBe(250);
    expect(
      runBudgetLimits({ RUN_TOKEN_BUDGET_HARD: "1000", RUN_TOKEN_BUDGET_SOFT: "5000" })
        .tokenSoftLimit,
    ).toBe(1000);
    // A soft bound without a hard bound has nothing to be relative to.
    expect(runBudgetLimits({ RUN_TOKEN_BUDGET_SOFT: "250" }).tokenSoftLimit).toBe(0);
  });

  it("lets routine runs use their tighter token bound when one is set", () => {
    const env = { RUN_TOKEN_BUDGET_HARD: "1000", ROUTINE_RUN_TOKEN_BUDGET_HARD: "250" };
    expect(runBudgetLimits(env, { routine: true }).tokenLimit).toBe(250);
    expect(runBudgetLimits(env, { routine: true }).tokenSoftLimit).toBe(200);
    expect(runBudgetLimits(env).tokenLimit).toBe(1000);
    expect(runBudgetLimits(env, { routine: false }).tokenLimit).toBe(1000);
  });

  it("parses the cost bound and the enforce switch", () => {
    expect(runBudgetLimits({ RUN_COST_BUDGET_USD_HARD: "1.5" }).costLimitUsd).toBe(1.5);
    expect(runBudgetEnforced({})).toBe(false);
    expect(runBudgetEnforced({ RUN_BUDGET_ENFORCE: "off" })).toBe(false);
    expect(runBudgetEnforced({ RUN_BUDGET_ENFORCE: "on" })).toBe(true);
    expect(runBudgetEnforced({ RUN_BUDGET_ENFORCE: " TRUE " })).toBe(true);
  });
});

function budgetWith(overrides: Partial<ToolCallBudget>): ToolCallBudget {
  return {
    toolCalls: { used: 0, limit: 0 },
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    tokenLimit: 0,
    tokenSoftLimit: 0,
    costLimitUsd: 0,
    enforce: false,
    exceeded: null,
    wouldExceed: null,
    softNotified: false,
    inFlight: 0,
    ...overrides,
  };
}

describe("recordRunUsage", () => {
  it("accumulates tokens and cost, counting unknown amounts as zero", () => {
    const budget = budgetWith({});
    expect(recordRunUsage(budget, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 })).toBeNull();
    expect(
      recordRunUsage(budget, { inputTokens: null, outputTokens: null, costUsd: null }),
    ).toBeNull();
    expect(budget.inputTokens).toBe(10);
    expect(budget.outputTokens).toBe(5);
    expect(budget.costUsd).toBe(0.25);
  });

  it("reports the first token crossing once, without stopping a measuring-only run", () => {
    const budget = budgetWith({ tokenLimit: 100, tokenSoftLimit: 80 });
    expect(recordRunUsage(budget, { inputTokens: 60, outputTokens: 30, costUsd: null })).toBeNull();
    const crossing = recordRunUsage(budget, { inputTokens: 10, outputTokens: 5, costUsd: null });
    expect(crossing).toEqual({ bound: "tokens", used: 105, limit: 100, enforced: false });
    expect(budget.exceeded).toBeNull();
    expect(budget.wouldExceed).toEqual(crossing);
    // Later calls keep accumulating but never re-report the crossing.
    expect(recordRunUsage(budget, { inputTokens: 500, outputTokens: 0, costUsd: null })).toBeNull();
    expect(budget.inputTokens).toBe(570);
  });

  it("sets exceeded under enforcement, and for the cost bound", () => {
    const tokens = budgetWith({ tokenLimit: 10, enforce: true });
    expect(recordRunUsage(tokens, { inputTokens: 9, outputTokens: 2, costUsd: null })).toEqual({
      bound: "tokens",
      used: 11,
      limit: 10,
      enforced: true,
    });
    expect(tokens.exceeded).toBe("tokens");

    const cost = budgetWith({ costLimitUsd: 0.5, enforce: true });
    expect(recordRunUsage(cost, { inputTokens: 1, outputTokens: 1, costUsd: 0.75 })).toEqual({
      bound: "cost",
      used: 0.75,
      limit: 0.5,
      enforced: true,
    });
    expect(cost.exceeded).toBe("cost");
  });
});

describe("runBudgetNoteFor", () => {
  it("hands out the wrap-up note once, only under enforcement past the soft bound", () => {
    const budget = budgetWith({ tokenLimit: 100, tokenSoftLimit: 80, enforce: true });
    expect(runBudgetNoteFor(budget)).toBeNull();
    budget.inputTokens = 85;
    const note = runBudgetNoteFor(budget);
    expect(note).toContain("near this run's token budget (85 of 100 tokens used)");
    expect(runBudgetNoteFor(budget)).toBeNull();

    const measuring = budgetWith({ tokenLimit: 100, tokenSoftLimit: 80, enforce: false });
    measuring.inputTokens = 85;
    expect(runBudgetNoteFor(measuring)).toBeNull();
  });
});

describe("toolCallBudgetExceededMessage", () => {
  it("names the bound that was hit", () => {
    expect(toolCallBudgetExceededMessage(budgetWith({ exceeded: "tool_calls" }))).toContain(
      "tool calls in this turn",
    );
    const tokens = budgetWith({ exceeded: "tokens", tokenLimit: 100 });
    tokens.inputTokens = 90;
    tokens.outputTokens = 15;
    expect(toolCallBudgetExceededMessage(tokens)).toBe(
      "I stopped after reaching this run's limit of 100 tokens (105 used). Send another message to continue.",
    );
    const cost = budgetWith({ exceeded: "cost", costLimitUsd: 0.5 });
    cost.costUsd = 0.75;
    expect(toolCallBudgetExceededMessage(cost)).toBe(
      "I stopped after reaching this run's cost limit of $0.50 ($0.75 used). Send another message to continue.",
    );
  });
});

describe("toolCallBudgetFor", () => {
  it("keeps a bounded run's budget across calls until release, counts included", () => {
    process.env.RUN_TOKEN_BUDGET_HARD = "1000";
    const first = toolCallBudgetFor("run-tracked");
    recordRunUsage(first, { inputTokens: 3, outputTokens: 2, costUsd: null });
    expect(toolCallBudgetFor("run-tracked")).toBe(first);
    expect(first.inputTokens).toBe(3);
    releaseToolCallBudget("run-tracked", false);
    expect(toolCallBudgetFor("run-tracked")).not.toBe(first);
    releaseToolCallBudget("run-tracked", false);
  });

  it("does not keep a budget with no bound configured; metering still works on the object", () => {
    const first = toolCallBudgetFor("run-unbounded");
    recordRunUsage(first, { inputTokens: 3, outputTokens: 2, costUsd: null });
    expect(first.inputTokens).toBe(3);
    expect(toolCallBudgetFor("run-unbounded")).not.toBe(first);
  });

  it("resolves routine limits from the run kind", () => {
    process.env.RUN_TOKEN_BUDGET_HARD = "1000";
    process.env.ROUTINE_RUN_TOKEN_BUDGET_HARD = "250";
    expect(toolCallBudgetFor("run-interactive").tokenLimit).toBe(1000);
    expect(toolCallBudgetFor("run-routine", { routine: true }).tokenLimit).toBe(250);
    releaseToolCallBudget("run-interactive", false);
    releaseToolCallBudget("run-routine", false);
  });
});

describe("run budgets in the runtime", () => {
  const twoToolTurnsThenReply = () => {
    providerState.stream
      .mockImplementationOnce(() =>
        toolCalls(primary, [
          { type: "toolCall", id: "call-1", name: "list_files", arguments: { path: "" } },
        ]),
      )
      .mockImplementationOnce(() =>
        toolCalls(primary, [
          { type: "toolCall", id: "call-2", name: "list_files", arguments: { path: "" } },
        ]),
      )
      .mockImplementation(() => reply(primary, "All done."));
  };

  it("stops the run at the token bound when enforcement is on", async () => {
    process.env.RUN_TOKEN_BUDGET_HARD = "10";
    process.env.RUN_BUDGET_ENFORCE = "on";
    const crossings: AgentRunBudgetCrossing[] = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    twoToolTurnsThenReply();
    const events = await run(
      request(executeTool, {
        onRunBudgetExceeded: (crossing) => {
          crossings.push(crossing);
        },
      }),
    );
    // Two calls at 6 tokens each cross the 10-token bound on the second call;
    // its tool call never executes and no third model call happens.
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(crossings).toEqual([{ bound: "tokens", used: 12, limit: 10, enforced: true }]);
    expect(texts(events)).toEqual([
      "I stopped after reaching this run's limit of 10 tokens (12 used). Send another message to continue.",
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I stopped after reaching this run's limit of 10 tokens (12 used). Send another message to continue.",
    });
  });

  it("measures and reports the crossing without stopping the run when enforcement is off", async () => {
    process.env.RUN_TOKEN_BUDGET_HARD = "10";
    const crossings: AgentRunBudgetCrossing[] = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    twoToolTurnsThenReply();
    const events = await run(
      request(executeTool, {
        onRunBudgetExceeded: (crossing) => {
          crossings.push(crossing);
        },
      }),
    );
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(crossings).toEqual([{ bound: "tokens", used: 12, limit: 10, enforced: false }]);
    expect(texts(events)).toEqual(["All done."]);
    expect(events.at(-1)).toEqual({ type: "done", text: "All done." });
  });

  it("reports the tool-call fuse crossing through the same callback", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "1";
    const crossings: AgentRunBudgetCrossing[] = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    providerState.stream.mockImplementationOnce(() =>
      toolCalls(primary, [
        { type: "toolCall", id: "call-1", name: "list_files", arguments: { path: "" } },
        { type: "toolCall", id: "call-2", name: "list_files", arguments: { path: "" } },
      ]),
    );
    const events = await run(
      request(executeTool, {
        onRunBudgetExceeded: (crossing) => {
          crossings.push(crossing);
        },
      }),
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(crossings).toEqual([{ bound: "tool_calls", used: 2, limit: 1, enforced: true }]);
    expect(texts(events)).toEqual([
      "I stopped after reaching the limit of 1 tool calls in this turn. Send another message to continue.",
    ]);
  });

  it("stamps the wrap-up note onto the first attempt past the soft bound, once", async () => {
    process.env.RUN_TOKEN_BUDGET_HARD = "100";
    process.env.RUN_BUDGET_ENFORCE = "on";
    const executeTool = vi.fn(async () => ({ ok: true }));
    // 6 tokens per call: the soft bound (80) is crossed by the 14th call, so the
    // 15th attempt is the first whose context carries the note; the 16th does not.
    let calls = 0;
    providerState.stream.mockImplementation(() => {
      calls += 1;
      return calls <= 15
        ? toolCalls(primary, [
            { type: "toolCall", id: `call-${calls}`, name: "list_files", arguments: { path: "" } },
          ])
        : reply(primary, "Wrapped up.");
    });
    const events = await run(request(executeTool));
    expect(providerState.stream).toHaveBeenCalledTimes(16);
    const contexts = providerState.stream.mock.calls.map(
      (call) => (call[1] as { messages: Array<{ sections?: Record<string, string> }> }).messages[0],
    );
    expect(contexts[13]?.sections?.rakazoRunBudget).toBeUndefined();
    expect(contexts[14]?.sections?.rakazoRunBudget).toContain(
      "near this run's token budget (84 of 100 tokens used)",
    );
    expect(contexts[15]?.sections?.rakazoRunBudget).toBeUndefined();
    expect(texts(events)).toEqual(["Wrapped up."]);
  });
});
