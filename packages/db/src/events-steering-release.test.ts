import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finalizeRun } from "./events.js";

/**
 * Steering a run claimed is released when that run fails, so the work it was asking for still
 * gets done. Releasing only `runId` left the claim timestamp behind, and claiming requires it to
 * be null — so the released row was counted as pending (creating a continuation run) and then
 * invisible to that run when it tried to claim it. Steering sent during a run that died, a
 * provider at capacity for instance, was silently dropped.
 */
function failedRunTx(sourceSeq: number | null) {
  const tx = {
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
      findUniqueOrThrow: vi.fn(async () => ({
        sourceMessage: sourceSeq === null ? null : { seq: sourceSeq },
      })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "run-next" })),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "task-next" })),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: {
      create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    steeringMessage: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    message: { findFirst: vi.fn(async () => null) },
    bot: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma };
}

const FAILED = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-died",
  taskId: "task-1",
  attemptId: "attempt-1",
  leaseOwner: "worker-1",
  leaseFence: 1,
  outcome: "failed" as const,
  error: "Model 'DeepSeek-V4.1-Flash' is at capacity",
};

/** The release a failed run performs on steering it had claimed. */
function releaseCall(tx: { steeringMessage: { updateMany: ReturnType<typeof vi.fn> } }) {
  // `createPendingSteeringRun` also writes `runId: null` (attaching pending rows to the new run),
  // so match on the claim timestamp, which only the release clears.
  return tx.steeringMessage.updateMany.mock.calls.find(([arg]) => {
    const data = (arg as { data?: Record<string, unknown> }).data;
    return data?.runId === null && "claimedAt" in (data ?? {});
  })?.[0] as { where: unknown; data: Record<string, unknown> } | undefined;
}

describe("releasing steering when a run fails", () => {
  it("clears the claim so the next run can pick the message up again", async () => {
    const { tx, prisma } = failedRunTx(3);

    await finalizeRun(prisma, FAILED);

    const release = releaseCall(tx);
    expect(release?.data).toEqual({ runId: null, claimedAt: null });
  });

  it("releases only steering newer than the run's source message", async () => {
    const { tx, prisma } = failedRunTx(3);

    await finalizeRun(prisma, FAILED);

    // Steering at or before the source was already answered by the run it created.
    expect(releaseCall(tx)?.where).toEqual({
      runId: "run-died",
      message: { seq: { gt: 3 } },
    });
  });

  it("releases everything the run claimed when it had no source message", async () => {
    const { tx, prisma } = failedRunTx(null);

    await finalizeRun(prisma, FAILED);

    expect(releaseCall(tx)?.where).toEqual({ runId: "run-died", message: undefined });
  });

  it("leaves a completed run's claimed steering alone", async () => {
    const { tx, prisma } = failedRunTx(3);
    const { error: _error, ...base } = FAILED;

    await finalizeRun(prisma, { ...base, outcome: "completed", blocks: [] });

    // Only a failure owes the steering another run; a reply answered it.
    expect(releaseCall(tx)).toBeUndefined();
  });
});
