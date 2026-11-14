import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem } from "./row-security.js";
import {
  installToolEventStore,
  listToolEventsForRun,
  pruneToolEvents,
  recordToolEvent,
} from "./tool-events.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

// The unit tests cover the writer against a fake store; this suite covers the
// path production actually takes: the composed client from createDb (row
// security, content encryption, text sanitization) installed as the store,
// exactly as the API and worker composition roots install it, writing to a
// migrated database where row-level security is enforced.
describePostgres("tool events (PostgreSQL)", () => {
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let sink: ReturnType<typeof createTestSink>;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let runId: string;
  let provisioned = false;

  beforeAll(async () => {
    sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      installToolEventStore(undefined);
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    ));
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "record tool events", status: "running" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    runId = run.id;
    provisioned = true;
    installToolEventStore(prisma);
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.space.deleteMany({ where: { id: spaceId } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("records a dispatched tool call through the installed store", async () => {
    await recordToolEvent({
      spaceId,
      threadId,
      runId,
      botId,
      toolName: "web_fetch",
      connectorKind: "web",
      argsHash: "a".repeat(64),
      argsSummary: { url: "https://example.test/page" },
      status: "succeeded",
      resultBytes: 42,
      durationMs: 7,
    });

    const failures = sink.events.filter((event) => event.message === "tool.event.write_failed");
    expect(failures, JSON.stringify(failures)).toEqual([]);

    const events = await runAsSystem("read tool events (test)", () =>
      listToolEventsForRun(prisma, runId),
    );
    expect(events).toEqual([
      expect.objectContaining({
        spaceId,
        threadId,
        runId,
        botId,
        seq: 1,
        toolName: "web_fetch",
        connectorKind: "web",
        argsHash: "a".repeat(64),
        argsSummary: { url: "https://example.test/page" },
        kind: "normal",
        status: "succeeded",
        effectId: null,
        resultBytes: 42,
        durationMs: 7,
      }),
    ]);
  });

  it("continues the run's sequence and keeps the recall kind", async () => {
    await recordToolEvent({
      spaceId,
      threadId,
      runId,
      botId,
      toolName: "read_history",
      argsHash: "b".repeat(64),
      kind: "recall",
      status: "succeeded",
    });

    const events = await runAsSystem("read tool events (test)", () =>
      listToolEventsForRun(prisma, runId),
    );
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ toolName: "read_history", kind: "recall" });
  });

  it("keeps fresh events through the retention pruner", async () => {
    const removed = await runAsSystem("prune tool events (test)", () =>
      pruneToolEvents(prisma, 180, new Date()),
    );
    expect(removed).toBe(0);
    const events = await runAsSystem("read tool events (test)", () =>
      listToolEventsForRun(prisma, runId),
    );
    expect(events).toHaveLength(2);
  });
});
