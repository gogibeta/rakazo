import { installAuditEventStore } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logLoopGuardStop,
  logToolRefusal,
  recordLoopGuardStopAudit,
} from "./tool-completion-audit.js";
import { refusal } from "./tool-refusal.js";

const target = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  trigger: "bot_message",
};

function capture() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink;
}

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("tool refusal log", () => {
  it("logs a refused call by its code, with the run it happened in", () => {
    const sink = capture();
    const refused = refusal("run_not_owner_started", 'No bot named "Chief". Ask the owner.');
    expect(refused).toEqual({ error: 'No bot named "Chief". Ask the owner.' });
    expect(logToolRefusal(target, "update_bot", refused)).toEqual({
      code: "run_not_owner_started",
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "agent.tool.refused",
        "run.id": "run-1",
        "run.trigger": "bot_message",
        tool: "update_bot",
        "tool.refusal": "run_not_owner_started",
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("Chief");
  });

  it("logs nothing for an error that carries no code", () => {
    const sink = capture();
    expect(logToolRefusal(target, "crm_search", { error: "upstream said: private" })).toBe(
      undefined,
    );
    expect(logToolRefusal(target, "update_bot", { terminate: true })).toBeUndefined();
    expect(sink.events).toEqual([]);
  });
});

describe("loop guard stop log", () => {
  it("names the tool, the count and the refusal it kept getting", () => {
    const sink = capture();
    logLoopGuardStop(target, {
      tool: "update_bot",
      reason: "repeated_calls",
      count: 6,
      failures: 5,
      refusal: { code: "run_not_owner_started", target: "crm_update" },
    });
    logLoopGuardStop(target, {
      tool: "computer_act",
      reason: "over_limit_actions",
      count: 4,
      failures: 0,
    });
    logLoopGuardStop(target, {
      tool: "list_files",
      reason: "repeated_calls_windowed",
      count: 8,
      failures: 7,
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "run.loop_guard_stopped",
        "run.id": "run-1",
        tool: "update_bot",
        "loop.reason": "repeated_calls",
        "loop.count": 6,
        "loop.failures": 5,
        "tool.target": "crm_update",
        "tool.refusal": "run_not_owner_started",
      }),
      expect.not.objectContaining({ "tool.refusal": expect.anything() }),
      expect.objectContaining({
        tool: "list_files",
        "loop.reason": "repeated_calls_windowed",
        "loop.count": 8,
        "loop.failures": 7,
      }),
    ]);
  });
});

describe("loop guard stop audit", () => {
  it("writes one audit row naming the guard, the tool and the counts, never the args", async () => {
    const auditRows: Array<Record<string, unknown>> = [];
    installAuditEventStore({
      space: { findUnique: vi.fn(async () => ({ organizationId: "org-1", name: "Space" })) },
      auditEvent: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          auditRows.push(...data);
          return { count: data.length };
        }),
      },
    } as unknown as Parameters<typeof installAuditEventStore>[0]);
    try {
      await recordLoopGuardStopAudit(
        { ...target, botLabel: "Assistant" },
        {
          tool: "list_files",
          reason: "repeated_calls_windowed",
          count: 8,
          failures: 7,
          argsHash: "a".repeat(64),
        },
      );
      expect(auditRows).toEqual([
        expect.objectContaining({
          action: "run.loop_guard_stop",
          actorType: "bot",
          actorId: "bot-1",
          actorLabel: "Assistant",
          runId: "run-1",
          threadId: "thread-1",
          targetType: "tool",
          targetId: "list_files",
          metadata: {
            tool: "list_files",
            reason: "repeated_calls_windowed",
            count: 8,
            failures: 7,
            argsHash: "a".repeat(64),
          },
        }),
      ]);
      expect(JSON.stringify(auditRows)).not.toContain("downloads");
    } finally {
      installAuditEventStore(undefined);
    }
  });
});
