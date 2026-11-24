import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { FRESH_CONTEXT_EXCLUDED_TOOLS } from "./pi-runtime-subagent.js";

/**
 * EGM-1: a clean-room reviewer run. The item's definition of done asks for two things proved
 * separately — a fresh-context run's assembled context holds the supplied document and nothing
 * of the parent thread's messages or memory documents, and a normal run is unchanged.
 *
 * These tests drive the real `PiAgentRuntime.run()` path (as `pi-runtime-helper-framing.test.ts`
 * does), so the context is assembled by production code rather than by a hand-built host. What
 * the reviewer was given is read off the fake Agent: its system prompt, its first user message,
 * and the tools it holds.
 */

type FakeTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

const seen = vi.hoisted(() => ({
  reviewer: { systemPrompt: "", prompt: "", toolNames: [] as string[] },
  ambiguous: { systemPrompt: "", prompt: "", toolNames: [] as string[] },
  normal: { systemPrompt: "", prompt: "", toolNames: [] as string[] },
  refusal: "",
  resultForParent: undefined as unknown,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: FakeTool[];
    private readonly systemPrompt: string;
    private readonly isReviewer: boolean;
    constructor(options: { initialState: { tools: FakeTool[]; systemPrompt: string } }) {
      this.tools = options.initialState.tools;
      this.systemPrompt = options.initialState.systemPrompt;
      this.isReviewer = this.systemPrompt.includes("clean-room reviewer");
    }
    subscribe() {}
    async prompt(text: string) {
      const delegate = this.tools.find((tool) => tool.name === "run_subagent");
      if (delegate) {
        // The parent bot spawns a clean-room reviewer and then an ordinary helper.
        await delegate.execute("call-fresh", {
          name: "reviewer",
          fresh_context: true,
          document: DESIGN,
        });
        await delegate.execute("call-normal", { name: "scout", task: "count the files" });
        // A reviewer given BOTH a task and a document must read the document. This is the case
        // that tells the two apart: with only a document supplied, ignoring the task field and
        // honouring it look identical.
        await delegate.execute("call-ambiguous", {
          name: "second-reviewer",
          fresh_context: true,
          task: "summarise the parent's work so far",
          document: DESIGN,
        });
        // A reviewer with nothing to read must be refused, not run empty.
        const empty = (await delegate.execute("call-empty", {
          name: "reviewer",
          fresh_context: true,
        })) as { content?: Array<{ text?: string }> };
        seen.refusal = (empty.content ?? []).map((part) => part.text ?? "").join("");
        return;
      }
      // A helper: record exactly what it was handed, then answer.
      const slot = this.systemPrompt.includes('named "second-reviewer"')
        ? seen.ambiguous
        : this.isReviewer
          ? seen.reviewer
          : seen.normal;
      slot.systemPrompt = this.systemPrompt;
      slot.prompt = text;
      slot.toolNames = this.tools.map((tool) => tool.name);
      this.state.messages = [
        { role: "assistant", content: [{ type: "text", text: "Findings: none." }] },
      ];
    }
    async waitForIdle() {}
    abort() {}
  },
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "plain-model" ? { provider: "test", id: modelId, reasoning: false } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const DESIGN = [
  "# Design: move the retention pruner to a queue job",
  "",
  "Problem: the hourly cron prunes rows the worker may still be reading.",
  "Approach: enqueue a job per space and let the worker hold the lease.",
  "Risks: a stalled job leaves rows unpruned; the reconciler must repair it.",
  "Open question: should a pruned run keep its events?",
].join("\n");

describe("a clean-room reviewer run", () => {
  beforeEach(async () => {
    seen.reviewer = { systemPrompt: "", prompt: "", toolNames: [] };
    seen.ambiguous = { systemPrompt: "", prompt: "", toolNames: [] };
    seen.normal = { systemPrompt: "", prompt: "", toolNames: [] };
    seen.refusal = "";
    seen.resultForParent = undefined;
    for await (const _event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "hello",
        instructions: "",
        history: [],
        tools: builtinAgentTools,
        model: { provider: "test", id: "plain-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      } as never,
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // drain
    }
  });

  it("reads the supplied document and none of the parent thread's messages", () => {
    // The document reaches the reviewer…
    expect(seen.reviewer.prompt).toContain(DESIGN);
    // …and no earlier message rides along with it.
    expect(seen.reviewer.prompt).not.toContain("count the files");
    expect(seen.reviewer.prompt).not.toContain("hello");
  });

  it("is told it has no memory of earlier work, and is not framed as the parent's helper", () => {
    expect(seen.reviewer.systemPrompt).toContain('You are a clean-room reviewer named "reviewer".');
    expect(seen.reviewer.systemPrompt).toContain("You have no earlier conversation");
    // The ordinary helper framing would tell it its task came from the parent bot; a reviewer
    // is not told that, because that framing is what makes it read for consistency with work
    // it was supposed to be blind to.
    expect(seen.reviewer.systemPrompt).not.toContain("Your task comes from the parent bot");
  });

  it("cannot reach the bot's own memory or history with a tool", () => {
    expect(seen.reviewer.toolNames.length).toBeGreaterThan(0);
    // Iterate the deny-list itself rather than naming a few of its members: a name added there
    // must fail here if it ever reaches a reviewer, and a name deleted there must not leave this
    // test asserting something nobody enforces.
    expect(FRESH_CONTEXT_EXCLUDED_TOOLS.size).toBeGreaterThan(6);
    for (const name of FRESH_CONTEXT_EXCLUDED_TOOLS) {
      expect(seen.reviewer.toolNames).not.toContain(name);
    }
    // The three that do not sound like history, pinned by name: they were the leaks.
    for (const name of ["remember", "schedule_list", "read_email"]) {
      expect(FRESH_CONTEXT_EXCLUDED_TOOLS.has(name)).toBe(true);
      expect(seen.reviewer.toolNames).not.toContain(name);
    }
    // The tools that read the workspace stay: the document may name files to open.
    expect(seen.reviewer.toolNames.some((name) => name === "read_file" || name === "shell")).toBe(
      true,
    );
  });

  it("leaves a normal helper exactly as it was", () => {
    expect(seen.normal.prompt).toBe(
      "Task from the parent bot (not from the user):\ncount the files",
    );
    expect(seen.normal.systemPrompt).toContain('You are a Rakazo subagent named "scout".');
    expect(seen.normal.systemPrompt).toContain(
      "Your task comes from the parent bot, not from the human user",
    );
    // A normal helper keeps the tools it had; the exclusion is a fresh-context one only.
    expect(seen.normal.toolNames).toContain("search_history");
  });

  it("reads its document even when the caller also passed a task", () => {
    // `seen.ambiguous` is the run that got both fields. It must hold the document and not the
    // task: a reviewer that quietly prefers `task` would be reading a summary of the very work
    // it was spawned to review blind.
    expect(seen.ambiguous.prompt).toContain(DESIGN);
    expect(seen.ambiguous.prompt).not.toContain("summarise the parent's work so far");
  });

  it("refuses a reviewer spawned without a document, and does not spend a slot on it", () => {
    // A reviewer with nothing to read would have to invent its context, so the spawn is
    // refused rather than run empty. `refused` is read off the tool's own answer.
    expect(seen.refusal).toContain("needs a document");
  });
});
