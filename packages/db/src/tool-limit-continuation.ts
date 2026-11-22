import { getLogger } from "@rakazo/logging";
import type { Prisma } from "./client.js";

/**
 * The prompt a run carries when it continues work the tool-call fuse cut short. The progress
 * note is appended after it, so the resumed turn knows what was already done and what remains
 * instead of spending its first calls rediscovering state.
 */
export const TOOL_LIMIT_CONTINUATION_PROMPT =
  "Continue the work from the previous turn. It stopped only because it reached this turn's tool-call limit, not because the task was finished.";

/** The row the executor writes when it hands a cut-short run to a fresh one. */
export interface ToolLimitContinuation {
  runId: string;
  taskId: string;
}

/**
 * Create the run that carries on from a turn the tool-call fuse stopped.
 *
 * Why a new run rather than a longer fuse: the fuse exists to bound one turn's cost, and raising
 * it only moves the wall. A continuation keeps each turn bounded while letting a task of any
 * length finish on its own, which is what the owner asked for — today a build that needs more
 * than the fuse silently stops mid-step and waits for a human to type "continue".
 *
 * The new run is a `resume` (not `user`): nobody typed anything, and the transcript should say so.
 * The model pin is copied from the run that stopped, so a continuation does not silently change
 * which provider serves the thread mid-task.
 *
 * The continuation is also linked into its run's chain (`continuesRunId`, `chainRootTaskId`). A
 * fuse can split one task across many runs, and today nothing records that they belong together,
 * so a view has to guess a box per task. The chain root is copied verbatim from the run that
 * stopped rather than derived, so a chain that has already been continued twice keeps the first
 * task's id and never re-roots itself midway.
 *
 * Returns null when a continuation must not be created: the thread already has a live run (two
 * would fight over the same computer), or the stopped run is no longer running (it was cancelled
 * or taken over while the turn was ending).
 */
export async function createToolLimitContinuation(
  tx: Prisma.TransactionClient,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    taskId: string;
    chainRootTaskId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  },
  progress: string,
): Promise<ToolLimitContinuation | null> {
  const live = await tx.run.findFirst({
    where: {
      threadId: run.threadId,
      botId: run.botId,
      id: { not: run.id },
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    select: { id: true },
  });
  if (live) return null;

  const prompt = progress.trim()
    ? `${TOOL_LIMIT_CONTINUATION_PROMPT}\n\nProgress so far, from the turn that stopped:\n${progress.trim()}`
    : TOOL_LIMIT_CONTINUATION_PROMPT;

  const task = await tx.task.create({
    data: {
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      userId: run.userId,
      prompt,
      status: "queued",
    },
    select: { id: true },
  });
  // A continuation keeps serving the thread from the same model. Losing the pin mid-task would
  // silently hand the rest of the work to whichever provider a fresh pick landed on.
  const pin =
    run.modelProvider && run.modelId
      ? {
          modelProvider: run.modelProvider,
          modelId: run.modelId,
          thinkingLevel: run.thinkingLevel ?? null,
          modelPinned: true,
        }
      : {};
  const next = await tx.run.create({
    data: {
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      taskId: task.id,
      userId: run.userId,
      status: "queued",
      trigger: "resume",
      // The predecessor is the run that stopped, and the chain root is whatever it says it is —
      // its own task id for a first continuation, the original task for any later one.
      continuesRunId: run.id,
      chainRootTaskId: run.chainRootTaskId ?? run.taskId,
      ...pin,
    },
    select: { id: true, taskId: true },
  });
  return { runId: next.id, taskId: next.taskId };
}

/**
 * Record that a turn was cut short and queue its continuation, in one transaction so a crash
 * between the two cannot leave a stopped run with no successor or a successor nobody runs.
 *
 * Returns the new run's id, or null when no continuation was made. Never throws for the ordinary
 * "no continuation" cases: a thread that already moved on is not an error, and the run that
 * stopped must still be able to finalize.
 */
export async function handOffToolLimitContinuation(
  tx: Prisma.TransactionClient,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    taskId: string;
    chainRootTaskId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  },
  progress: string,
): Promise<string | null> {
  const created = await createToolLimitContinuation(tx, run, progress);
  if (!created) {
    getLogger().info("run.tool_limit.no_continuation", { "run.id": run.id });
    return null;
  }
  getLogger().info("run.tool_limit.continued", {
    "run.id": run.id,
    "run.continuation": created.runId,
  });
  return created.runId;
}
