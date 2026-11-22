import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { consumeRunEvents, createProgressHeartbeat } from "./run-turn.js";

const requeued = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./run-lifecycle.js", async (actual) => ({
  ...(await actual<typeof import("./run-lifecycle.js")>()),
  requeueComputerRun: requeued,
}));

// Stop marks the run cancelled in the database, possibly from another server.
async function context(row: { status: string }, options: { scripted?: boolean } = {}) {
  const findUnique = vi.fn(async () => ({
    ...row,
    leaseOwner: "worker-1",
    leaseFence: 1,
    checkpoint: null as string | null,
  }));
  const deps = {
    prisma: {
      message: { findMany: async () => [] },
      run: { updateMany: async () => ({ count: 1 }), findUnique },
      thread: {
        findUniqueOrThrow: async () => ({
          nextMessageSeq: 0,
          historyCompactedUpToSeq: null,
        }),
      },
    },
    events: { append: vi.fn(), finalizeRun: vi.fn() },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: "message",
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: 0 },
      computerUse: {},
      toolCallStreak: {},
      toolCallWindow: [],
      toolResults: new Map(),
      overLimitActionCalls: 0,
    },
    abortController: new AbortController(),
    context: { signal: new AbortController().signal },
    computer: {
      lazy: { throwIfFailed: () => {} },
      checkpoint: { flush: vi.fn() },
    },
    tools: { approvedReplays: { assertDrained: () => {} }, connector: new Map() },
    source: {},
    secrets: [],
    scripted: options.scripted ?? true,
  } as unknown as RunContext;
  return { ctx, findUnique };
}

/** A call that streams nothing until it finishes, or until the run's signal aborts it. */
function quietCall(ctx: RunContext, ms: number) {
  return new Promise<"finished" | "aborted">((resolve) => {
    const timer = setTimeout(() => resolve("finished"), ms);
    ctx.abortController.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve("aborted");
    });
  });
}

describe("consumeRunEvents and Stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a quiet model call within two seconds of Stop", async () => {
    const row = { status: "running" };
    const { ctx } = await context(row);
    let outcome: string | undefined;
    let stoppedAt = 0;
    let endedAfterMs = 0;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      row.status = "cancelled";
      stoppedAt = Date.now();
      outcome = await quietCall(ctx, 60_000);
      endedAfterMs = Date.now() - stoppedAt;
      yield { type: "text", text: "late reply" };
      yield { type: "done", text: "late reply" };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toBe("aborted");
    expect(endedAfterMs).toBeLessThanOrEqual(2_000);
    await expect(consumed).resolves.toBe(true);
    expect(ctx.state.reply.assembled).toBe("");
  });

  it("aborts a long tool and takes no tool call after Stop", async () => {
    const row = { status: "running" };
    const { ctx } = await context(row);
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      // The runtime runs a tool between events; nothing streams while it works.
      yield { type: "text", text: "Checking." };
      row.status = "cancelled";
      await quietCall(ctx, 60_000);
      yield {
        type: "tool",
        name: "next_tool",
        args: {},
        executionId: "call-2",
      };
      yield { type: "done", text: "" };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.abortController.signal.aborted).toBe(true);
    await expect(consumed).resolves.toBe(true);
    expect(JSON.stringify(appended.mock.calls)).not.toContain("next_tool");
  });

  it("leaves a quiet call alone while the run is still running, and stops checking after", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    let outcome: string | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      outcome = await quietCall(ctx, 5_000);
      yield { type: "text", text: "Done." };
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(consumed).resolves.toBe(false);
    expect(outcome).toBe("finished");
    expect(ctx.abortController.signal.aborted).toBe(false);
    // At most one read a second, shared with the per-event check.
    const reads = findUnique.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findUnique.mock.calls.length).toBe(reads);
  });

  it("reports what a long step is still doing instead of leaving the working line frozen", async () => {
    const { ctx } = await context({ status: "running" }, { scripted: false });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.start("shell", { command: "pnpm build" });
    await vi.advanceTimersByTimeAsync(180_000);
    await heartbeat.tick();

    const beats = appended.mock.calls
      .map((call) => call[0] as { type: string; payload?: { text?: string; activity?: boolean } })
      .filter((event) => event.type === "thread.progress" && event.payload?.activity === true);
    // Three minutes against a two-minute threshold: one beat, then none until the five-minute gap.
    expect(beats).toHaveLength(1);
    expect(beats[0]?.payload?.text).toBe("Running: pnpm build · 3m 00s");
  });

  it("beats again only after the gap, so a long step keeps reporting", async () => {
    const { ctx } = await context({ status: "running" }, { scripted: false });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.start("shell", { command: "pnpm build" });
    for (let elapsed = 0; elapsed <= 12 * 60_000; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      await heartbeat.tick();
    }
    const beats = appended.mock.calls
      .map((call) => call[0] as { type: string; payload?: { text?: string } })
      .filter((event) => event.type === "thread.progress");
    // 2m, 7m and 12m: the first at the threshold, then one per five-minute gap.
    expect(beats.map((beat) => beat.payload?.text)).toEqual([
      "Running: pnpm build · 2m 00s",
      "Running: pnpm build · 7m 00s",
      "Running: pnpm build · 12m 00s",
    ]);
  });

  it("says nothing about a step that finishes before the threshold", async () => {
    const { ctx } = await context({ status: "running" });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.start("shell", { command: "true" });
    await vi.advanceTimersByTimeAsync(30_000);
    await heartbeat.tick();
    heartbeat.end();
    // The turn moves on: nothing more is due for the step that just finished.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await heartbeat.tick();

    const beats = appended.mock.calls
      .map((call) => call[0] as { type: string; payload?: { activity?: boolean } })
      .filter((event) => event.type === "thread.progress" && event.payload?.activity === true);
    expect(beats).toHaveLength(0);
  });

  it("reports a long model call with no tool in flight", async () => {
    const { ctx } = await context({ status: "running" }, { scripted: false });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    // A reasoning call: nothing streams, and no tool is running, so nothing can be named.
    heartbeat.awaitingModel();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await heartbeat.tick();

    const beats = appended.mock.calls
      .map((call) => call[0] as { type: string; payload?: { text?: string; activity?: boolean } })
      .filter((event) => event.type === "thread.progress" && event.payload?.activity === true);
    expect(beats).toHaveLength(1);
    expect(beats[0]?.payload?.text).toBe("Thinking · 4m 00s");
  });

  it("stops reporting the model call once it answers", async () => {
    const { ctx } = await context({ status: "running" }, { scripted: false });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.awaitingModel();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await heartbeat.tick();
    expect(appended).toHaveBeenCalledTimes(1);
    // The answer arrives: the step is over, so the silence is no longer being spent on it.
    heartbeat.end();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await heartbeat.tick();
    expect(appended).toHaveBeenCalledTimes(1);
  });

  it("says nothing on a run whose live view is not the person's", async () => {
    // Scripted runs (e2e) and background work have no live working line to fill, and every other
    // live publisher holds back on them. A beat here would overwrite a label a spec reads.
    const { ctx } = await context({ status: "running" });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.start("shell", { command: "pnpm build" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await heartbeat.tick();
    expect(appended).not.toHaveBeenCalled();
  });

  it("stops beating once the turn is over", async () => {
    const { ctx } = await context({ status: "running" });
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    const heartbeat = createProgressHeartbeat(ctx);
    heartbeat.start("shell", { command: "pnpm build" });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    heartbeat.stop();
    await heartbeat.tick();
    expect(appended).not.toHaveBeenCalled();
  });

  it("stops checking when the runtime fails", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      throw new Error("model failed");
    }
    const consumed = consumeRunEvents(ctx, runtime());
    const settled = expect(consumed).rejects.toThrow("model failed");
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    const reads = findUnique.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findUnique.mock.calls.length).toBe(reads);
  });
  it("ignores a lease read that resolves after the run ended", async () => {
    const row = { status: "running" };
    const { ctx, findUnique } = await context(row);
    let finishRead: (() => void) | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      // The timer's read is now in flight; it answers only after the run has finished.
      findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = () =>
              resolve({
                status: "cancelled",
                leaseOwner: "worker-1",
                leaseFence: 1,
                checkpoint: null,
              });
          }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finishRead).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(consumed).resolves.toBe(false);
    // The final screen release runs on this signal after the turn; a late read must not cancel it.
    finishRead?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
  it("ignores a late lease read that finds a released takeover hold", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    (ctx.computer as { heldForTakeover?: boolean }).heldForTakeover = true;
    requeued.mockClear();
    let finishRead: (() => void) | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = () =>
              resolve({
                status: "running",
                leaseOwner: "worker-1",
                leaseFence: 1,
                checkpoint: "takeover",
              });
          }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finishRead).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(consumed).resolves.toBe(false);
    finishRead?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(requeued).not.toHaveBeenCalled();
    expect(ctx.state.lease.valid).toBe(true);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
  it("does not abort when a takeover requeue finishes after the turn ended", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    (ctx.computer as { heldForTakeover?: boolean }).heldForTakeover = true;
    let finishRequeue: (() => void) | undefined;
    requeued.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequeue = resolve;
        }),
    );
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      // The read answers while the turn is live; the requeue it starts outlives the turn.
      findUnique.mockResolvedValueOnce({
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: 1,
        checkpoint: "takeover",
      });
      await quietCall(ctx, 1_000);
      expect(finishRequeue).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(consumed).resolves.toBe(false);
    finishRequeue?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
});
