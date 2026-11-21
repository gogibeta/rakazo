import { getLogger } from "@rakazo/logging";
import { createRetentionPruner } from "./security-events.js";

/** A run that will not move again: finished, failed, or cancelled. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];

/** Rows a retention pass reads at a time; a run's own rows are removed with it by cascade. */
const BATCH = 500;

/**
 * Default window for a finished run and the task and attempts that belong to it. Long on
 * purpose: these rows are what a person reads when they scroll back through a bot's history, so
 * the window only has to be short enough that a perpetual thread cannot grow without bound.
 */
export const RUN_RETENTION_DAYS = 180;

export interface RunRetentionDb {
  run: {
    findMany(input: {
      where: { status: { in: string[] }; updatedAt: { lt: Date } };
      select: { id: true; taskId: true };
      take: number;
      orderBy: { updatedAt: "asc" };
    }): Promise<Array<{ id: string; taskId: string }>>;
    deleteMany(input: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
  task: {
    deleteMany(input: {
      where: { id: { in: string[] }; runs: { none: Record<string, never> } };
    }): Promise<{ count: number }>;
  };
}

/**
 * Deletes finished runs older than `retentionDays`, and the tasks that no longer have a run.
 *
 * Order matters: a `Run` cascades to its `Attempt`, `ToolEvent`, `ExternalEffect` and
 * `SteeringMessage` rows, so deleting the run is enough for those. A `Task` is only removed once
 * nothing points at it — a task whose runs are all gone, which is the state a run deletion leaves
 * behind. `UsageRecord` is never touched: it is financial history by policy, independent of
 * message clearing or bot deletion (`usage.ts`), so it is not an oversight here.
 *
 * Bounded per pass: the reconciler runs this on a tick, so one pass removes at most `BATCH` runs
 * and the next pass takes the rest. That keeps a first run on a large backlog from holding one
 * transaction open.
 */
export async function pruneTerminalRuns(
  db: RunRetentionDb,
  retentionDays: number,
  now = new Date(),
): Promise<{ runs: number; tasks: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await db.run.findMany({
    where: { status: { in: TERMINAL_RUN_STATUSES }, updatedAt: { lt: cutoff } },
    select: { id: true, taskId: true },
    take: BATCH,
    orderBy: { updatedAt: "asc" },
  });
  if (expired.length === 0) return { runs: 0, tasks: 0 };
  const ids = expired.map((run) => run.id);
  const taskIds = [...new Set(expired.map((run) => run.taskId))];
  const { count: runs } = await db.run.deleteMany({ where: { id: { in: ids } } });
  // `runs: { none: {} }` re-checks at delete time, so a task a new run attached to between the
  // read above and here is left alone.
  const { count: tasks } = await db.task.deleteMany({
    where: { id: { in: taskIds }, runs: { none: {} } },
  });
  return { runs, tasks };
}

export function createRunRetentionPruner(
  db: RunRetentionDb,
  retentionDays = RUN_RETENTION_DAYS,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  return createRetentionPruner(
    "run.retention",
    async (at) => {
      const { runs, tasks } = await pruneTerminalRuns(db, retentionDays, at);
      if (tasks > 0) {
        getLogger().info("run.retention.tasks_pruned", { "run.retention.tasks": tasks });
      }
      return runs;
    },
    options,
  );
}
