import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  installToolEventStore,
  listToolEventsForRun,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";

vi.mock("./run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-tool-gate.js")>()),
  // The approval gate is covered by its own tests; here it always lets the call through,
  // so the tool event dispatchTool records is the only behavior under test.
  gateToolCall: vi.fn(async (_ctx: unknown, request: { name: string; args: unknown }) => ({
    call: {
      name: request.name,
      args: request.args,
      executionId: "call-1",
      observer: undefined,
      connectorCall: { tool: request.name, args: request.args, executionId: "call-1" },
      effectKey: `effect-${request.name}`,
      applied: { effect: { id: `effect-${request.name}` } },
      nextApprovedTool: undefined,
      bypassApproval: false,
      claimedEffect: false,
      persistEffectResult: async () => true,
      finish: async (result: unknown) => result,
      claimOrReturn: async () => undefined,
    },
  })),
  auditToolCall: vi.fn(async () => undefined),
}));

import { applyTool } from "./run-tools.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

// Drives a tool call through the same dispatch path a real run uses (applyTool ->
// dispatchTool -> recordDispatchToolEvent) with the real tool event store installed,
// the way the API and worker composition roots install it. The fake-store unit tests
// cannot see a write that only fails against the real database.
describePostgres("dispatch tool events (PostgreSQL)", () => {
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
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
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
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
    installToolEventStore(db.prisma);
  });

  afterAll(async () => {
    installToolEventStore(undefined);
    try {
      if (db && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.space.deleteMany({ where: { id: spaceId } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      if (db) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  it("writes a tool_events row for a dispatched call", async () => {
    const ctx = {
      deps: {
        prisma: {
          bot: { findUnique: async () => null },
          user: {
            findUniqueOrThrow: async () => ({
              timezone: "UTC" as string | null,
              marketingEmailOptOutAt: null,
            }),
          },
        },
      },
      run: { userId, spaceId },
      bot: { id: botId },
      thread: { id: threadId },
      source: { ownerStartedRun: true },
      runId,
      state: { tainted: true, handedOff: false, ownerSettingsRefused: false },
      trust: {
        loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
        receivedOutsideMessage: async () => false,
      },
      tools: {
        disabled: new Set<string>(),
        approvedReplays: createApprovedEffectReplayQueue([]),
        connector: new Map(),
      },
      context: { signal: new AbortController().signal },
      secrets: [],
    };

    await expect(applyTool(ctx as never, "update_preferences", {}, "call-1")).resolves.toEqual({
      timezone: "UTC",
      marketingEmails: true,
    });

    const failures = sink.events.filter((event) => event.message === "tool.event.write_failed");
    expect(failures, JSON.stringify(failures)).toEqual([]);

    const events = await runAsSystem("read tool events (test)", () =>
      listToolEventsForRun(db.prisma, runId),
    );
    expect(events).toEqual([
      expect.objectContaining({
        spaceId,
        threadId,
        runId,
        botId,
        seq: 1,
        toolName: "update_preferences",
        status: "succeeded",
        effectId: "effect-update_preferences",
        // sha256 of the canonical empty argument object.
        argsHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      }),
    ]);
  });
});
