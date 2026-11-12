import type { AgentRunRequest, SemanticMemoryResponse } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({
    computerId: input.computerId,
    botId: input.botId,
    runId: input.runId,
    fence: 7,
  }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

const MODEL_ID = "deepseek/deepseek-v4-flash-0731";

type RecallResult = SemanticMemoryResponse<Array<{ memory: string }>>;

interface ThreadFixture {
  summary: string | null;
  compactedUpToSeq: number | null;
  /** Thread messages in ascending seq order; the last one is the current turn. */
  messages: Array<Record<string, unknown>>;
}

function threadMessages(firstSeq: number, count: number): ThreadFixture["messages"] {
  return Array.from({ length: count }, (_, index) => {
    const seq = firstSeq + index;
    const current = index === count - 1;
    return {
      id: `m-${seq}`,
      threadId: "thread-1",
      seq,
      role: "user",
      runId: current ? "run-1" : "run-0",
      blocks: [
        { kind: "text", text: current ? "current question" : `message ${seq}` },
      ] as MessageBlock[],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
      steeringMessages: [] as Array<{ id: string }>,
    };
  });
}

async function runOnce(fixture: ThreadFixture, recall: () => Promise<RecallResult>) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: null,
    leaseFence: 0,
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const bot = {
    id: "bot-1",
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    computerId: "computer-1",
    computerSwitching: false,
    memoryScope: null,
    computer: { id: "computer-1", scope: "dedicated" },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: {
      findUnique: vi.fn(async () => ({ id: "member-1" })),
      findMany: vi.fn(async () => [{ userId: "user-1" }]),
    },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: {
          id: run.botId,
          name: "Boris",
          color: "blue",
          avatarSet: "default",
          notifyOnFinish: true,
        },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: { findMany: vi.fn(async () => []) },
    bot: {
      findUnique: vi.fn(async () => bot),
      findUniqueOrThrow: vi.fn(async () => bot),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "thread-1",
        groupId: null,
        historyCompactionSummary: fixture.summary,
        historyCompactedUpToSeq: fixture.compactedUpToSeq,
        historyCompactionGeneration: 0,
        nextMessageSeq: (fixture.messages.at(-1)?.seq as number) + 1,
      })),
    },
    message: {
      // History loads newest first; the current-turn image lookup shares this mock and
      // finds no image blocks in the text-only fixture.
      findMany: vi.fn(async (args: { take?: number }) => {
        const newestFirst = [...fixture.messages].sort(
          (a, b) => (b.seq as number) - (a.seq as number),
        );
        return typeof args?.take === "number" ? newestFirst.slice(0, args.take) : newestFirst;
      }),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "Look again" })) },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: MODEL_ID,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      releaseScreen: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () => ({
        provider: { recall: vi.fn(recall) },
        defaultScope: "isolated",
      }),
    },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      claimSteering: vi.fn(async () => []),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    secretStore: { load: async () => "fake-key" },
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return request;
}

describe("recalled memory and the cacheable history prefix", () => {
  it("keeps history byte-identical when only the recall result changes", async () => {
    const fixture: ThreadFixture = {
      summary: "Earlier discussion, compacted",
      compactedUpToSeq: 100,
      messages: threadMessages(101, 10),
    };
    const first = await runOnce(fixture, async () => ({
      ok: true,
      value: [{ memory: "alpha fact" }],
    }));
    const second = await runOnce(fixture, async () => ({
      ok: true,
      value: [{ memory: "beta fact" }],
    }));

    // The compacted summary still heads history; the per-run recall block no longer does.
    expect(first.history[0]?.content).toContain("<compacted_thread_summary>");
    expect(JSON.stringify(second.history)).toBe(JSON.stringify(first.history));
    expect(JSON.stringify(first.history)).not.toContain("recalled_memory");
    // Each run's recall arrives with its own current message instead.
    expect(first.prompt).toContain("alpha fact");
    expect(second.prompt).toContain("beta fact");
    expect(first.instructions).toContain(
      "Compacted summaries appear only in conversation history, and recalled memory appears with the current message.",
    );
  });

  it("keeps the same history window whether recall succeeds or fails", async () => {
    // No usable local summary, so the run slices raw history to the window; the
    // window must come from configuration alone, not from this run's recall outcome.
    const fixture: ThreadFixture = {
      summary: null,
      compactedUpToSeq: 100,
      messages: threadMessages(1, 120),
    };
    const succeeded = await runOnce(fixture, async () => ({
      ok: true,
      value: [{ memory: "alpha fact" }],
    }));
    const failed = await runOnce(fixture, async () => ({ ok: false, error: "recall down" }));

    expect(succeeded.history).toHaveLength(50);
    expect(failed.history).toHaveLength(50);
    expect(JSON.stringify(failed.history)).toBe(JSON.stringify(succeeded.history));
    expect(succeeded.history[0]?.content).toBe("message 71");
    expect(succeeded.prompt).toContain("alpha fact");
    expect(failed.prompt).not.toContain("alpha fact");
  });
});
