import { runContinueJob } from "@rakazo/adapter-kit";
import { TOOL_LIMIT_CONTINUATION_PROMPT } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handOffIfToolLimitStopped } from "./executor.js";
import { releaseToolCallBudget, toolCallBudgetFor } from "./pi-runtime-tools.js";

/**
 * Item 42's auto-continue: a run the tool-call fuse stopped is handed to a
 * fresh continuation run instead of sitting stopped until a human types
 * "continue". PR #127 deleted this path wholesale, which is the regression
 * these tests exist to catch — if the hand-off is removed from the executor,
 * the import above stops resolving and this file fails to compile.
 */

const RUN = {
  id: "run-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  userId: "user-1",
  modelProvider: "anthropic",
  modelId: "claude-test",
  thinkingLevel: null,
};

type ContinuationTx = {
  run: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  task: { create: ReturnType<typeof vi.fn> };
};

/** The transaction `createToolLimitContinuation` needs, in memory. */
function txStub(live: { id: string } | null = null): ContinuationTx {
  return {
    run: {
      findFirst: vi.fn(async () => live),
      create: vi.fn(async () => ({ id: "cont-run-1", taskId: "task-1" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
  };
}

type Ctx = Parameters<typeof handOffIfToolLimitStopped>[0];

function ctxFor(
  tx: ContinuationTx,
  progress = "",
): {
  ctx: Ctx;
  $transaction: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn(async () => {});
  const $transaction = vi.fn(async (cb: (t: ContinuationTx) => Promise<string | null>) => cb(tx));
  const ctx = {
    runId: RUN.id,
    run: RUN,
    deps: { prisma: { $transaction }, jobs: { enqueue } },
    state: { reply: { assistantTurnText: progress } },
  } as unknown as Ctx;
  return { ctx, $transaction, enqueue };
}

/** Push the run's budget past its tool-call limit, the way the fuse would. */
function blowFuse(runId: string): void {
  const budget = toolCallBudgetFor(runId);
  budget.toolCalls.used = 25;
  budget.toolCalls.limit = 20;
  budget.exceeded = "tool_calls";
}

describe("tool-limit continuation hand-off (item 42 guard)", () => {
  const originalMax = process.env.MAX_TOOL_CALLS_PER_TURN;

  beforeAll(() => {
    // A positive limit is what makes the budget persist in the run map at all.
    process.env.MAX_TOOL_CALLS_PER_TURN = "20";
  });
  afterAll(() => {
    if (originalMax === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
    else process.env.MAX_TOOL_CALLS_PER_TURN = originalMax;
    releaseToolCallBudget(RUN.id, false);
  });
  afterEach(() => {
    releaseToolCallBudget(RUN.id, false);
  });

  it("hands a stopped run to a continuation and queues the resume", async () => {
    blowFuse(RUN.id);
    const tx = txStub();
    const { ctx, $transaction, enqueue } = ctxFor(tx, "did three of five steps");

    await handOffIfToolLimitStopped(ctx);

    expect($transaction).toHaveBeenCalledTimes(1);
    // The continuation carries the standard prompt plus the stopped turn's progress,
    // so the resumed turn does not rediscover state it already had.
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: expect.stringContaining(TOOL_LIMIT_CONTINUATION_PROMPT),
        }),
      }),
    );
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: expect.stringContaining("did three of five steps"),
        }),
      }),
    );
    // A continuation resumes the same thread under the same model pin.
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: RUN.threadId,
          botId: RUN.botId,
          taskId: "task-1",
          status: "queued",
          trigger: "resume",
          modelProvider: RUN.modelProvider,
          modelId: RUN.modelId,
          modelPinned: true,
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("cont-run-1"));
  });

  it("does nothing when the fuse did not blow", async () => {
    const budget = toolCallBudgetFor(RUN.id);
    budget.exceeded = null;
    const tx = txStub();
    const { ctx, $transaction, enqueue } = ctxFor(tx);

    await handOffIfToolLimitStopped(ctx);

    expect($transaction).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not continue when the thread already has a live run", async () => {
    blowFuse(RUN.id);
    const tx = txStub({ id: "live-run" });
    const { ctx, enqueue } = ctxFor(tx);

    await handOffIfToolLimitStopped(ctx);

    // Two runs would fight over the same computer, so no continuation is made.
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("lets the run finalize when creating the continuation fails", async () => {
    blowFuse(RUN.id);
    const enqueue = vi.fn(async () => {});
    const ctx = {
      runId: RUN.id,
      run: RUN,
      deps: {
        prisma: {
          $transaction: vi.fn(async () => {
            throw new Error("db down");
          }),
        },
        jobs: { enqueue },
      },
      state: { reply: { assistantTurnText: "" } },
    } as unknown as Ctx;

    // Best effort: a failed continuation must not stop the run from completing.
    await expect(handOffIfToolLimitStopped(ctx)).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
