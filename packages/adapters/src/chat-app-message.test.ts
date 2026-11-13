import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { MessagingDeliveryDeps } from "./messaging-delivery.js";
import { queueOwnerChatAppMessage } from "./messaging-delivery.js";

type Identity = { id: string; provider: string; userId: string; createdAt: Date };
type OutboundRow = {
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  body: string;
  sourceMessageId: string | null;
  createdAt: Date;
};

/**
 * The slice of Prisma the queue path touches: the owner's identity rows, and
 * the outbox transaction (conversation lock, latest-row read, deduped insert).
 */
function fakeDeps(identities: Identity[]) {
  const rows: OutboundRow[] = [];
  const findMany = vi.fn(async (args: { where: { userId: string } }) =>
    identities
      .filter((identity) => identity.userId === args.where.userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ id, provider }) => ({ id, provider })),
  );
  const tx = {
    $queryRaw: vi.fn(async () => []),
    messagingOutbound: {
      aggregate: vi.fn(async (args: { where: { identityId: string } }) => {
        const mine = rows.filter((row) => row.identityId === args.where.identityId);
        const latest = mine.reduce<Date | null>(
          (max, row) => (max === null || row.createdAt > max ? row.createdAt : max),
          null,
        );
        return { _max: { createdAt: latest } };
      }),
      createMany: vi.fn(async (args: { data: OutboundRow[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of args.data) {
          if (rows.some((existing) => existing.idempotencyKey === row.idempotencyKey)) continue;
          rows.push(row);
          count += 1;
        }
        return { count };
      }),
    },
  };
  const prisma = {
    messagingIdentity: { findMany },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue },
  } as unknown as Pick<MessagingDeliveryDeps, "prisma" | "jobs">;
  return { deps, rows, findMany, enqueue };
}

const telegram: Identity = {
  id: "mi-telegram",
  provider: "telegram",
  userId: "user-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
const slack: Identity = {
  id: "mi-slack",
  provider: "slack",
  userId: "user-1",
  createdAt: new Date("2026-01-02T00:00:00Z"),
};
const whatsapp: Identity = {
  id: "mi-whatsapp",
  provider: "whatsapp",
  userId: "user-1",
  createdAt: new Date("2026-01-03T00:00:00Z"),
};
const someoneElses: Identity = {
  id: "mi-other",
  provider: "telegram",
  userId: "user-2",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const send = (deps: Pick<MessagingDeliveryDeps, "prisma" | "jobs">, body = "the report") =>
  queueOwnerChatAppMessage(deps, {
    userId: "user-1",
    body,
    idempotencyKey: "chatapps:effect-1",
  });

describe("queueOwnerChatAppMessage", () => {
  it("queues one DM row for a linked Telegram identity and enqueues the drain", async () => {
    const { deps, rows, enqueue } = fakeDeps([telegram]);
    const result = await send(deps);
    expect(result).toEqual({ ok: true, providers: ["telegram"], parts: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: "chatapps:effect-1:mi-telegram:0",
      kind: "dm",
      identityId: "mi-telegram",
      body: "the report",
      sourceMessageId: null,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "messaging.deliver" }));
  });

  it("resolves recipients from the acting owner only, never another person's identities", async () => {
    const { deps, rows, findMany } = fakeDeps([someoneElses, telegram]);
    const result = await send(deps);
    expect(result.ok).toBe(true);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
    expect(rows.map((row) => row.identityId)).toEqual(["mi-telegram"]);
  });

  it("splits a long Telegram message into ordered parts at the platform limit", async () => {
    const { deps, rows } = fakeDeps([telegram]);
    const body = `${"x".repeat(4_000)}${"y".repeat(4_000)}${"z".repeat(1_000)}`;
    const result = await send(deps, body);
    expect(result).toMatchObject({ ok: true, providers: ["telegram"] });
    expect(rows.length).toBeGreaterThan(1);
    for (const [index, row] of rows.entries()) {
      expect(row.body.length).toBeLessThanOrEqual(4_096);
      expect(row.idempotencyKey).toBe(`chatapps:effect-1:mi-telegram:${index}`);
      expect(row.kind).toBe("dm");
    }
    expect(rows.map((row) => row.body).join("")).toBe(body);
    if (result.ok) expect(result.parts).toBe(rows.length);
  });

  it("sends an unsplit single row to a linked Slack identity", async () => {
    const { deps, rows } = fakeDeps([slack]);
    const body = "s".repeat(9_000);
    const result = await send(deps, body);
    expect(result).toEqual({ ok: true, providers: ["slack"], parts: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(body);
  });

  it("queues for every linked platform but never WhatsApp", async () => {
    const { deps, rows } = fakeDeps([telegram, whatsapp, slack]);
    const result = await send(deps);
    expect(result).toEqual({ ok: true, providers: ["telegram", "slack"], parts: 2 });
    expect(rows.map((row) => row.identityId).sort()).toEqual(["mi-slack", "mi-telegram"]);
  });

  it("fails with linking guidance when the owner has no chat app linked", async () => {
    const { deps, rows, enqueue } = fakeDeps([]);
    const result = await send(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Settings → Messaging");
      expect(result.error).toContain("QR code");
    }
    expect(rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails rather than sending when only WhatsApp is linked", async () => {
    const { deps, rows, enqueue } = fakeDeps([whatsapp]);
    const result = await send(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("WhatsApp");
      expect(result.error).toContain("Settings → Messaging");
    }
    expect(rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues nothing twice when the same call is retried", async () => {
    const { deps, rows } = fakeDeps([telegram]);
    await send(deps);
    const again = await send(deps);
    expect(again.ok).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("rejects an empty message before any lookup", async () => {
    const { deps, rows, findMany, enqueue } = fakeDeps([telegram]);
    const result = await send(deps, "   ");
    expect(result).toEqual({ ok: false, error: "message is required" });
    expect(findMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
