import { describe, expect, it, vi } from "vitest";
import {
  createToolLimitContinuation,
  handOffToolLimitContinuation,
  TOOL_LIMIT_CONTINUATION_PROMPT,
} from "./tool-limit-continuation.js";

const RUN = {
  id: "run_stopped",
  spaceId: "space_1",
  threadId: "thread_1",
  botId: "bot_1",
  userId: "user_1",
  taskId: "task_stopped",
  modelProvider: "deepseek",
  modelId: "deepseek-chat",
  thinkingLevel: "medium",
};

/** A transaction that records what was created and answers with fixed ids. */
function tx(options: { liveRun?: string; noPin?: boolean } = {}) {
  const tasks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const client = {
    run: {
      findFirst: vi.fn(async () => (options.liveRun ? { id: options.liveRun } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        runs.push(data);
        return { id: "run_next", taskId: "task_next" };
      }),
    },
    task: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        tasks.push(data);
        return { id: "task_next" };
      }),
    },
  };
  return { client, tasks, runs };
}

describe("continuing a turn the tool-call fuse stopped", () => {
  it("queues a resume run that carries the progress note", async () => {
    const { client, tasks, runs } = tx();

    const created = await createToolLimitContinuation(
      client as never,
      RUN,
      "Cloned the repo and ran the build.",
    );

    expect(created).toEqual({ runId: "run_next", taskId: "task_next" });
    expect(tasks[0]).toMatchObject({
      spaceId: "space_1",
      botId: "bot_1",
      threadId: "thread_1",
      userId: "user_1",
      status: "queued",
    });
    expect(String(tasks[0]?.prompt)).toContain(TOOL_LIMIT_CONTINUATION_PROMPT);
    expect(String(tasks[0]?.prompt)).toContain("Cloned the repo and ran the build.");
    expect(runs[0]).toMatchObject({
      trigger: "resume",
      status: "queued",
      taskId: "task_next",
    });
  });

  it("says the stop was the fuse, not a finished task", async () => {
    const { client, tasks } = tx();

    await createToolLimitContinuation(client as never, RUN, "");

    // Without this the model reads the stop as "the work is done".
    expect(String(tasks[0]?.prompt)).toContain("not because the task was finished");
  });

  it("keeps serving the thread from the same model", async () => {
    const { client, runs } = tx();

    await createToolLimitContinuation(client as never, RUN, "x");

    expect(runs[0]).toMatchObject({
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
      thinkingLevel: "medium",
      modelPinned: true,
    });
  });

  it("leaves the model unpinned when the stopped run had none", async () => {
    const { client, runs } = tx();

    await createToolLimitContinuation(
      client as never,
      { ...RUN, modelProvider: null, modelId: null },
      "x",
    );

    expect(runs[0]).not.toHaveProperty("modelProvider");
    expect(runs[0]).not.toHaveProperty("modelPinned");
  });

  it("makes no continuation while another run holds the thread", async () => {
    const { client, runs } = tx({ liveRun: "run_live" });

    const created = await createToolLimitContinuation(client as never, RUN, "x");

    // Two runs on one thread would fight over the same computer.
    expect(created).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it("does not count itself as the live run it is replacing", async () => {
    const { client } = tx();

    await createToolLimitContinuation(client as never, RUN, "x");

    expect(client.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "run_stopped" } }),
      }),
    );
  });

  it("trims a progress note that is only whitespace", async () => {
    const { client, tasks } = tx();

    await createToolLimitContinuation(client as never, RUN, "   \n\t ");

    expect(String(tasks[0]?.prompt)).toBe(TOOL_LIMIT_CONTINUATION_PROMPT);
  });
});

describe("the chain a continuation belongs to", () => {
  it("links the continuation to the run that stopped", async () => {
    const { client, runs } = tx();

    await createToolLimitContinuation(client as never, RUN, "x");

    expect(runs[0]).toMatchObject({ continuesRunId: "run_stopped" });
  });

  it("roots a first continuation at the stopped run's own task", async () => {
    const { client, runs } = tx();

    await createToolLimitContinuation(client as never, RUN, "x");

    // RUN has no chainRootTaskId yet, so this is the run that started the chain.
    expect(runs[0]).toMatchObject({ chainRootTaskId: "task_stopped" });
  });

  it("keeps the original root when the chain is continued again", async () => {
    const { client, runs } = tx();

    // A run already inside a chain: it keeps the first task as root, not its own mid-chain task.
    await createToolLimitContinuation(
      client as never,
      { ...RUN, taskId: "task_second", chainRootTaskId: "task_first" },
      "x",
    );

    expect(runs[0]).toMatchObject({
      chainRootTaskId: "task_first",
      continuesRunId: "run_stopped",
    });
  });

  it("roots at the run's own task when its root is explicitly null", async () => {
    const { client, runs } = tx();

    // Null is not "unknown": it is a run that was never continued, so it starts a chain.
    await createToolLimitContinuation(client as never, { ...RUN, chainRootTaskId: null }, "x");

    expect(runs[0]).toMatchObject({ chainRootTaskId: "task_stopped" });
  });
});

describe("handing off a stopped turn", () => {
  it("reports the new run it queued", async () => {
    const { client } = tx();

    const runId = await handOffToolLimitContinuation(client as never, RUN, "progress");

    expect(runId).toBe("run_next");
  });

  it("reports nothing when the thread already moved on", async () => {
    const { client } = tx({ liveRun: "run_live" });

    const runId = await handOffToolLimitContinuation(client as never, RUN, "progress");

    expect(runId).toBeNull();
  });
});
