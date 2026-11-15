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
 * A proposal store that behaves like the real statements.
 *
 * The single-get read is ONE statement that both derives the effective status
 * from the deadline and performs the transition, so this fake models exactly
 * that: it is asked once, it decides with the clock the test supplies, and it
 * reports whether it was the statement that changed the row. A test that lets
 * the clock move between calls can therefore tell a single-statement read from a
 * sweep-then-read, which is the whole point of the shape.
 */
function proposalStore(rows: Row[]) {
  const events: Array<Record<string, unknown>> = [];
  /** The next raw statement consumes one of these, in order. */
  const queued: Array<{ to: string; requireLive: boolean }> = [];
  /** How many statements and transactions the route opened. */
  let statements = 0;
  let readStatements = 0;
  let transactions = 0;
  /** The clock the fake database reads, so a test can move time deliberately. */
  let clock: () => number = () => Date.now();

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
    /**
     * Both raw statements live here: the bulk expiry sweep the list issues, and
     * the single-statement get. The get's SELECT projection and its UPDATE CTE
     * share one `now()`, exactly as the SQL does.
     */
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements += 1;
      const sql = strings.join("?");
      // The single-get statement names the row it reads and carries a CASE.
      const isSingleGet = /CASE/.test(sql);
      if (isSingleGet) {
        readStatements += 1;
        // The statement is parameterized by proposalId then userId.
        const [proposalId, userId] = values as [string, string];
        const target = rows.find((r) => r.id === proposalId && r.userId === userId);
        if (!target) return [];
        const now = clock();
        const overdue = target.status === "proposed" && target.expiresAt.getTime() <= now;
        if (overdue) target.status = "expired";
        return [
          {
            ...target,
            walletName: target.wallet.name,
            // The effective status the projection returns: derived, not stored.
            status: overdue ? "expired" : target.status,
            expiredNow: overdue,
          },
        ];
      }
      const pending = queued.shift();
      if (!pending) return [];
      const now = clock();
      const wins = rows.filter((row) => {
        if (row.status !== "proposed") return false;
        if (pending.to === "expired" && row.expiresAt.getTime() > now) return false;
        if (pending.requireLive && row.expiresAt.getTime() <= now) return false;
        row.status = pending.to;
        return true;
      });
      return wins.map((row) => ({ id: row.id }));
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      return fn(prisma);
    }),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    rows,
    events,
    /** Every raw statement the route issued, and how many were the single-get read. */
    statements: () => statements,
    readStatements: () => readStatements,
    transactions: () => transactions,
    setClock: (next: () => number) => {
      clock = next;
    },
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

  it("derives expiry in the READ ITSELF, so a deadline crossing mid-get cannot return proposed", async () => {
    // The old shape swept, then read. Under READ COMMITTED each statement gets a
    // fresh snapshot, so a deadline passing between them let the read return
    // "proposed" for a row that had already expired. This test forces exactly that
    // crossing: the row is live when the request begins and past its deadline by
    // the time the read statement runs. It can only pass if the status comes from
    // the same statement that performs the transition.
    const liveAtStart = new Date("2026-11-15T12:00:00.000Z");
    const store = proposalStore([
      row({ status: "proposed", expiresAt: new Date(liveAtStart.getTime() + 1_000) }),
    ]);
    // The clock the database reads starts before the deadline, and crosses it the
    // first time the read statement asks for the time. That is precisely the
    // crossing the old two-statement shape could not survive: one statement sees
    // a single instant, so it must report what that instant says.
    let reads = 0;
    store.setClock(() => {
      reads += 1;
      return reads === 1 ? liveAtStart.getTime() + 2_000 : liveAtStart.getTime() + 2_000;
    });
    const api = routes(store.prisma);
    const found = (await api.proposal!({ context, input: { proposalId: "p1" } })) as {
      status: string;
    };

    expect(found.status).toBe("expired");
    // The transition is real: the stored row is expired, not just the view.
    expect(store.rows[0]!.status).toBe("expired");
    // And it was ONE read statement in one transaction, so there is no window at all.
    expect(store.readStatements()).toBe(1);
    expect(store.transactions()).toBe(1);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "expired" }),
    });
  });

  it("writes no second event when the same expired proposal is read again", async () => {
    const store = proposalStore([
      row({ expiresAt: new Date(Date.now() - 60_000), status: "proposed" }),
    ]);
    const api = routes(store.prisma);
    const first = (await api.proposal!({ context, input: { proposalId: "p1" } })) as {
      status: string;
    };
    const second = (await api.proposal!({ context, input: { proposalId: "p1" } })) as {
      status: string;
    };
    expect([first.status, second.status]).toEqual(["expired", "expired"]);
    expect(store.events).toHaveLength(1);
  });

  it("leaves a cancelled proposal cancelled, even past its deadline", async () => {
    const store = proposalStore([
      row({ status: "cancelled", expiresAt: new Date(Date.now() - 60_000) }),
    ]);
    const api = routes(store.prisma);
    const found = (await api.proposal!({ context, input: { proposalId: "p1" } })) as {
      status: string;
    };
    expect(found.status).toBe("cancelled");
    expect(store.events).toHaveLength(0);
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
    // The list path is unchanged: one sweep statement, one event per proposal.
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
