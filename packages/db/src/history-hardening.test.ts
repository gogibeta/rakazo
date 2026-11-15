import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { pruneTransientEvents, sendUserMessage, TRANSIENT_EVENT_RETENTION_DAYS } from "./events.js";
import { settleTakeoverWaitOnCancel } from "./thread-takeover.js";

describe("pruneTransientEvents", () => {
  it("deletes only the transient run events older than the retention window", async () => {
    const deleteMany = vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 7 }));
    const now = new Date("2026-12-20T00:00:00.000Z");
    const db = { event: { deleteMany } } as unknown as Pick<PrismaClient, "event">;
    const count = await pruneTransientEvents(db, now);
    expect(count).toBe(7);
    expect(deleteMany).toHaveBeenCalledOnce();
    const where = deleteMany.mock.calls[0]![0].where as {
      OR: unknown;
      createdAt: { lt: Date };
    };
    expect(where.OR).toEqual([
      { type: "thread.progress" },
      { type: "thread.meta", payload: { equals: { activity: { thinking: true } } } },
      { type: "thread.meta", payload: { equals: { activity: { thinking: false } } } },
    ]);
    expect(where.createdAt.lt).toEqual(
      new Date(now.getTime() - TRANSIENT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
  });
});

describe("settleTakeoverWaitOnCancel", () => {
  const txWith = (computerRow: unknown) => ({
    $queryRaw: vi.fn(async () => (computerRow ? [computerRow] : [])),
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
  });

  it("drops the cancelled run's control claim when the user is not on the screen", async () => {
    const tx = txWith({ botId: "bot-1", controlBotId: "bot-1", controlLeaseId: null });
    await settleTakeoverWaitOnCancel(tx as unknown as Prisma.TransactionClient, "run-1");
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: {
        controlRunId: "run-1",
        OR: [{ controlHolder: { not: "user" } }, { controlLeaseId: null }],
      },
      data: { controlRunId: null },
    });
  });

  it("leaves the binding alone while the user holds this bot's screen", async () => {
    const tx = txWith({ botId: "bot-1", controlBotId: "bot-1", controlLeaseId: "lease-1" });
    await settleTakeoverWaitOnCancel(tx as unknown as Prisma.TransactionClient, "run-1");
    expect(tx.computer.updateMany).not.toHaveBeenCalled();
  });

  it("settles when the screen lease belongs to another bot", async () => {
    const tx = txWith({ botId: "bot-1", controlBotId: "bot-2", controlLeaseId: "lease-1" });
    await settleTakeoverWaitOnCancel(tx as unknown as Prisma.TransactionClient, "run-1");
    expect(tx.computer.updateMany).toHaveBeenCalledOnce();
  });
});

describe("sendUserMessage clientNonce", () => {
  it("refuses a send without a nonce before touching the database", async () => {
    const findUnique = vi.fn(async () => null);
    const prisma = { message: { findUnique } } as unknown as PrismaClient;
    await expect(
      sendUserMessage(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "user",
        clientNonce: "",
      }),
    ).rejects.toThrow("requires a clientNonce");
    expect(findUnique).not.toHaveBeenCalled();
  });
});
