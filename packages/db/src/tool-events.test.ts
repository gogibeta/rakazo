import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installToolEventStore,
  listToolEventsForRun,
  pruneToolEvents,
  recordToolEvent,
  toolEventRetentionDays,
} from "./tool-events.js";

function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  let uniqueFailures = 0;
  let createError: Error | undefined;
  return {
    rows,
    failNextCreatesWithUniqueViolation(count: number) {
      uniqueFailures = count;
    },
    failCreatesWith(error: Error | undefined) {
      createError = error;
    },
    toolEvent: {
      findFirst: vi.fn(async () =>
        rows.length ? { seq: Math.max(...rows.map((row) => row.seq as number)) } : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (createError) throw createError;
        if (uniqueFailures > 0) {
          uniqueFailures -= 1;
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        rows.push(data);
        return data;
      }),
      findMany: vi.fn(async () => [...rows].sort((a, b) => (a.seq as number) - (b.seq as number))),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

let sink: ReturnType<typeof createTestSink>;
let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
  store = fakeStore();
  installToolEventStore(store as never);
});

afterEach(() => installToolEventStore(undefined));

const call = {
  spaceId: "space-1",
  threadId: "thread-1",
  runId: "run-1",
  botId: "bot-1",
  toolName: "web_fetch",
  connectorKind: "web",
  argsHash: "a".repeat(64),
  status: "succeeded" as const,
};

describe("recordToolEvent", () => {
  it("writes the call with the run's first sequence and its outcome", async () => {
    await recordToolEvent({
      ...call,
      argsSummary: { url: "https://example.test/page" },
      effectId: "effect-1",
      resultBytes: 42,
      durationMs: 7,
    });
    expect(store.rows).toEqual([
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        botId: "bot-1",
        seq: 1,
        toolName: "web_fetch",
        kind: "normal",
        status: "succeeded",
        effectId: "effect-1",
        resultBytes: 42,
        durationMs: 7,
        argsSummary: { url: "https://example.test/page" },
      }),
    ]);
  });

  it("continues the run's sequence from its highest existing event", async () => {
    await recordToolEvent(call);
    await recordToolEvent({ ...call, toolName: "read_history", kind: "recall" });
    expect(store.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(store.rows[1]).toMatchObject({ toolName: "read_history", kind: "recall" });
  });

  it("applies the audit metadata rules to the argument summary", async () => {
    await recordToolEvent({
      ...call,
      argsSummary: {
        url: "https://example.test",
        password: "hunter2",
        note: "x".repeat(500),
        count: 3,
        missing: undefined,
      },
    });
    const summary = store.rows[0]?.argsSummary as Record<string, unknown>;
    expect(summary).not.toHaveProperty("password");
    expect(summary).not.toHaveProperty("missing");
    expect(summary.count).toBe(3);
    expect((summary.note as string).length).toBe(200);
  });

  it("retries a sequence clash instead of losing or duplicating the event", async () => {
    store.failNextCreatesWithUniqueViolation(1);
    await recordToolEvent(call);
    expect(store.rows).toHaveLength(1);
    expect(store.toolEvent.create).toHaveBeenCalledTimes(2);
  });

  it("never throws when the write fails, and logs the event instead", async () => {
    store.failCreatesWith(new Error("database is gone"));
    await expect(recordToolEvent(call)).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(0);
    expect(sink.events.some((event) => event.message === "tool.event.write_failed")).toBe(true);
  });

  it("does nothing until a store is installed", async () => {
    installToolEventStore(undefined);
    await expect(recordToolEvent(call)).resolves.toBeUndefined();
  });
});

describe("listToolEventsForRun", () => {
  it("returns the run's events in dispatch order", async () => {
    await recordToolEvent(call);
    await recordToolEvent(call);
    const events = await listToolEventsForRun(store as never, "run-1");
    expect(events.map((event) => (event as { seq: number }).seq)).toEqual([1, 2]);
    expect(store.toolEvent.findMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
      orderBy: { seq: "asc" },
    });
  });
});

describe("retention", () => {
  it("defaults to 180 days and honors a configured value", () => {
    expect(toolEventRetentionDays({})).toBe(180);
    expect(toolEventRetentionDays({ TOOL_EVENT_RETENTION_DAYS: "30" })).toBe(30);
  });

  it("prunes events older than the retention window", async () => {
    const now = new Date("2026-12-17T00:00:00.000Z");
    await pruneToolEvents(store as never, 180, now);
    expect(store.toolEvent.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-06-20T00:00:00.000Z") } },
    });
  });
});
