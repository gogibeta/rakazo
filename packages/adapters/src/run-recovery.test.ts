import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findRunRecoveryBlockers } from "./run-recovery.js";

describe("run recovery blockers", () => {
  it("lets a background helper start while the bot's own turn holds the computer", async () => {
    const now = new Date();
    // A live turn's own lease, not a takeover hold.
    const expiresAt = new Date(now.getTime() + 60_000);
    const prisma = {
      computerExecutionLease: {
        findMany: vi.fn(async () => [
          { computerId: "computer", botId: "bot", runId: "chat-turn", expiresAt },
        ]),
      },
    } as unknown as PrismaClient;
    const run = (id: string, trigger: string) => ({
      id,
      botId: "bot",
      trigger,
      bot: { computerId: "computer" },
    });
    const blockers = await findRunRecoveryBlockers(
      prisma,
      [run("next-turn", "user"), run("helper", "helper")],
      now,
    );
    expect([...blockers]).toEqual([["next-turn", "chat-turn"]]);
  });

  it("does not block a run for another bot's lease on the shared computer", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const prisma = {
      computerExecutionLease: {
        findMany: vi.fn(async () => [
          { computerId: "computer", botId: "other-bot", runId: "other-turn", expiresAt },
        ]),
      },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const waiting = {
      id: "waiting-turn",
      botId: "bot",
      trigger: "user",
      bot: { computerId: "computer" },
    };
    // Execution leases are per bot: another bot's live lease on the shared
    // team computer never blocks this bot's run — bots drive distinct
    // screens, and a delegating run may be waiting on that other bot's run.
    const blockers = await findRunRecoveryBlockers(prisma, [waiting], now);
    expect([...blockers]).toEqual([]);
  });
});
