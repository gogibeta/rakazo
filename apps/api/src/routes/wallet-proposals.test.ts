import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { walletProposalRoutes } from "./wallet-proposals.js";

// The well-known public Hardhat test account #0: a published test vector.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

type Row = {
  id: string;
  userId: string;
  walletId: string;
  fromAddress: string;
  chainId: number;
  to: string | null;
  asset: string;
  amountWei: string;
  data: string | null;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  rpcProfile: string;
  status: string;
  canonicalHash: string;
  createdAt: Date;
  expiresAt: Date;
  wallet: { name: string };
};

/** The route handlers with the oRPC builder stubbed to hand them back bare. */
function routes(prisma: unknown) {
  const procedure = { handler: (fn: unknown) => fn };
  const family = new Proxy({}, { get: () => procedure });
  const authed = new Proxy({}, { get: () => family });
  return walletProposalRoutes({
    deps: { prisma },
    authed,
  } as unknown as RouterContext) as unknown as Record<
    string,
    (call: { context: unknown; input?: unknown }) => Promise<unknown>
  >;
}

/**
 * A proposal store that behaves like the real statements: the conditional
 * expiry UPDATE compares the deadline against the database clock, and the
 * transition writes its event in the same transaction as the status change.
 */
function proposalStore(rows: Row[]) {
  const events: Array<Record<string, unknown>> = [];
  /** The next raw UPDATE consumes one of these, in order. */
  const queued: Array<{ to: string; requireLive: boolean }> = [];
  const prisma = {
    walletProposal: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const found = rows.find((row) => row.id === where.id && row.userId === where.userId);
        return found ?? null;
      }),
      updateMany: vi.fn(),
    },
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    $queryRaw: vi.fn(async () => {
      const pending = queued.shift();
      if (!pending) return [];
      const now = Date.now();
      const wins = rows.filter((row) => {
        if (row.status !== "proposed") return false;
        if (pending.to === "expired" && row.expiresAt.getTime() > now) return false;
        if (pending.requireLive && row.expiresAt.getTime() <= now) return false;
        row.status = pending.to;
        return true;
      });
      return wins.map((row) => ({ id: row.id }));
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    rows,
    events,
    queue: (to: string, requireLive = false) => queued.push({ to, requireLive }),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    userId: "u",
    walletId: "w1",
    fromAddress: ADDRESS.toLowerCase(),
    chainId: 99801,
    to: RECIPIENT,
    asset: "HYPE",
    amountWei: "1000000000000000",
    data: null,
    nonce: 3,
    gasLimit: "25201",
    maxFeePerGas: "3000000000",
    maxPriorityFeePerGas: "1000000000",
    rpcProfile: "elysium-testnet",
    status: "proposed",
    canonicalHash: "a".repeat(64),
    createdAt: new Date("2026-11-15T12:00:00.000Z"),
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
    wallet: { name: "burner" },
    ...overrides,
  };
}

const context = { actor: { userId: "u", spaceId: "s" }, signal: undefined };

describe("wallet proposal routes", () => {
  it("lists only this owner's proposals, with display names", async () => {
    const store = proposalStore([row(), row({ id: "p2", userId: "someone-else" })]);
    const api = routes(store.prisma);
    const listed = (await api.proposals!({ context })) as { proposals: Array<{ id: string }> };
    expect(listed.proposals.map((proposal) => proposal.id)).toEqual(["p1"]);
  });

  it("reads one proposal without recomputing what was validated", async () => {
    const store = proposalStore([row()]);
    const api = routes(store.prisma);
    const found = (await api.proposal!({ context, input: { proposalId: "p1" } })) as Record<
      string,
      unknown
    >;
    expect(found).toMatchObject({
      id: "p1",
      chainName: "Elysium Testnet",
      walletName: "burner",
      canonicalHash: "a".repeat(64),
      status: "proposed",
      // The sender is the stored one, not whatever the wallet says today.
      walletAddress: ADDRESS.toLowerCase(),
    });
  });

  it("cancels a proposal, persisting the change and its single event", async () => {
    const store = proposalStore([row()]);
    store.queue("cancelled", true);
    const api = routes(store.prisma);
    const cancelled = (await api.cancelProposal!({
      context,
      input: { proposalId: "p1" },
    })) as Record<string, unknown>;
    expect(cancelled.status).toBe("cancelled");
    expect(store.rows[0]!.status).toBe("cancelled");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "cancelled" }),
    });
  });

  it("reports an expired proposal as expired and persists that, not a cancel", async () => {
    const store = proposalStore([
      row({ expiresAt: new Date(Date.now() - 60_000), status: "proposed" }),
    ]);
    // The live-guarded cancel matches nothing; the expiry is the transition that wins.
    store.queue("cancelled", true);
    store.queue("expired");
    const api = routes(store.prisma);
    await expect(api.cancelProposal!({ context, input: { proposalId: "p1" } })).rejects.toThrow(
      /expired/,
    );
    expect(store.rows[0]!.status).toBe("expired");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "expired" }),
    });
  });

  it("persists expiry on read, so a list never shows a stale proposal as live", async () => {
    const store = proposalStore([
      row({ expiresAt: new Date(Date.now() - 60_000), status: "proposed" }),
    ]);
    store.queue("expired");
    const api = routes(store.prisma);
    const listed = (await api.proposals!({ context })) as { proposals: Array<{ status: string }> };
    expect(listed.proposals[0]!.status).toBe("expired");
    expect(store.rows[0]!.status).toBe("expired");
    // The transition is recorded once, by the statement that made it.
    expect(store.events).toHaveLength(1);
  });

  it("records one event per expired proposal, naming each one", async () => {
    const expiredAt = new Date(Date.now() - 60_000);
    const store = proposalStore([
      row({ id: "p1", expiresAt: expiredAt }),
      row({ id: "p2", expiresAt: expiredAt }),
    ]);
    store.queue("expired");
    const api = routes(store.prisma);
    const listed = (await api.proposals!({ context })) as { proposals: Array<{ status: string }> };
    expect(listed.proposals.map((proposal) => proposal.status)).toEqual(["expired", "expired"]);
    expect(store.events.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ proposalId: "p1", outcome: "expired" }),
      expect.objectContaining({ proposalId: "p2", outcome: "expired" }),
    ]);
  });

  it("answers 404 for someone else's proposal and 400 for an uncancellable one", async () => {
    const store = proposalStore([row(), row({ id: "p2", status: "cancelled" })]);
    const api = routes(store.prisma);
    await expect(api.proposal!({ context, input: { proposalId: "missing" } })).rejects.toThrow(
      /not found/i,
    );
    await expect(api.cancelProposal!({ context, input: { proposalId: "p2" } })).rejects.toThrow(
      /only a proposed transaction/i,
    );
  });

  it("carries no secret material in any response", async () => {
    const store = proposalStore([row()]);
    const api = routes(store.prisma);
    Object.assign(store.rows[0]!, {
      privateKey: `0x${"1".repeat(64)}`,
      passwordWrap: "pw-v1:sealed",
      keyCiphertext: "pwk-v1:sealed",
    });
    const listed = await api.proposals!({ context });
    const single = await api.proposal!({ context, input: { proposalId: "p1" } });
    const seen = JSON.stringify([listed, single]);
    for (const forbidden of ["privateKey", "passwordWrap", "keyCiphertext", "pw-v1", "pwk-v1"]) {
      expect(seen).not.toContain(forbidden);
    }
  });
});
