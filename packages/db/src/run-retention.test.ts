import { describe, expect, it, vi } from "vitest";
import type { RunRetentionDb } from "./run-retention.js";
import { pruneTerminalRuns, RUN_RETENTION_DAYS } from "./run-retention.js";

const NOW = new Date("2026-11-21T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A run store that records what was asked of it and answers from a fixed set of rows. */
function store(runs: Array<{ id: string; taskId: string }>, taskRuns: Record<string, number> = {}) {
  const deletedRunIds: string[][] = [];
  const deletedTaskIds: string[][] = [];
  const db: RunRetentionDb = {
    run: {
      findMany: vi.fn(async () => runs),
      deleteMany: vi.fn(async ({ where }) => {
        deletedRunIds.push(where.id.in);
        return { count: where.id.in.length };
      }),
    },
    task: {
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        deletedTaskIds.push(where.id.in);
        // The real query also requires `runs: { none: {} }`; mirror that here so a task with a
        // surviving run is not reported as removed.
        const gone = where.id.in.filter((id) => (taskRuns[id] ?? 0) === 0);
        return { count: gone.length };
      }),
    },
  };
  return { db, deletedRunIds, deletedTaskIds };
}

describe("pruning finished runs", () => {
  it("deletes the runs a pass found and the tasks they leave behind", async () => {
    const { db, deletedRunIds, deletedTaskIds } = store([
      { id: "run_1", taskId: "task_a" },
      { id: "run_2", taskId: "task_a" },
    ]);

    const result = await pruneTerminalRuns(db, RUN_RETENTION_DAYS, NOW);

    expect(result).toEqual({ runs: 2, tasks: 1 });
    expect(deletedRunIds).toEqual([["run_1", "run_2"]]);
    // One task id even though two runs named it.
    expect(deletedTaskIds).toEqual([["task_a"]]);
  });

  it("asks only for runs that are finished and past the window", async () => {
    const { db } = store([]);

    await pruneTerminalRuns(db, 180, NOW);

    expect(db.run.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["completed", "failed", "cancelled"] },
        updatedAt: { lt: daysAgo(180) },
      },
      select: { id: true, taskId: true },
      take: 500,
      orderBy: { updatedAt: "asc" },
    });
  });

  it("does nothing at all when no run is old enough", async () => {
    const { db, deletedRunIds } = store([]);

    const result = await pruneTerminalRuns(db, 180, NOW);

    expect(result).toEqual({ runs: 0, tasks: 0 });
    expect(deletedRunIds).toEqual([]);
    expect(db.task.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves a task alone while a run still points at it", async () => {
    const { db, deletedTaskIds } = store([{ id: "run_1", taskId: "task_busy" }], {
      task_busy: 1,
    });

    const result = await pruneTerminalRuns(db, 180, NOW);

    expect(result).toEqual({ runs: 1, tasks: 0 });
    // Asked about, but the store answers that a run still holds it.
    expect(deletedTaskIds).toEqual([["task_busy"]]);
  });

  it("makes the database re-check that no run holds the task", async () => {
    const { db } = store([{ id: "run_1", taskId: "task_a" }]);

    await pruneTerminalRuns(db, 180, NOW);

    // The guard has to be in the query, not only in the answer: a run may be attached to the task
    // between the read and the delete, and only the database can see that.
    expect(db.task.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["task_a"] }, runs: { none: {} } },
    });
  });

  it("honours the window it is given, not only the default", async () => {
    const { db } = store([]);

    await pruneTerminalRuns(db, 30, NOW);

    expect(db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: { lt: daysAgo(30) } }),
      }),
    );
  });

  it("takes one bounded batch per pass so a backlog is drained over ticks", async () => {
    const { db } = store([]);

    await pruneTerminalRuns(db, 180, NOW);

    expect(db.run.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });

  it("never touches usage records", async () => {
    const { db } = store([{ id: "run_1", taskId: "task_a" }]);

    await pruneTerminalRuns(db, 180, NOW);

    // The store has no usage table at all: if the pruner reached for one it would throw here.
    expect(Object.keys(db).sort()).toEqual(["run", "task"]);
  });
});
