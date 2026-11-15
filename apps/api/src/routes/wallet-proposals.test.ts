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
  wallet: { name: string; address: string };
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

/** A proposal store that applies the conditional updates the routes issue. */
function proposalStore(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, condition]) => {
      if (key === "id") return row.id === condition;
      if (key === "userId") return row.userId === condition;
      if (key === "status") return row.status === condition;
      if (key === "expiresAt" && condition && typeof condition === "object") {
        const ops = condition as { gt?: Date; lte?: Date };
        if (ops.gt) return row.expiresAt.getTime() > ops.gt.getTime();
        if (ops.lte) return row.expiresAt.getTime() <= ops.lte.getTime();
      }
      return false;
    });
  const prisma = {
    walletProposal: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Unwrap the relation include the service asks for.
        const found = rows.find((row) => matches(row, where));
        return found ?? null;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: { status: string } }) => {
          let count = 0;
          for (const row of rows) {
            if (!matches(row, where)) continue;
            row.status = data.status;
            count += 1;
          }
          return { count };
        },
      ),
    },
    securityEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    auditEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    space: { findUnique: vi.fn(async () => ({ organizationId: "org", name: "Test" })) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@rakazo.test" })) },
    member: { findMany: vi.fn(async () => []) },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    userId: "u",
    walletId: "w1",
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
    expiresAt: new Date("2026-11-15T12:15:00.000Z"),
    wallet: { name: "burner", address: ADDRESS },
    ...overrides,
  };
}

const context = { actor: { userId: "u", spaceId: "s" }, signal: undefined };

describe("wallet proposal routes", () => {
  it("lists only this owner's proposals, newest first, with display names", async () => {
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
    });
  });

  it("cancels a proposal and then shows it cancelled", async () => {
    const store = proposalStore([row()]);
    const api = routes(store.prisma);
    const cancelled = (await api.cancelProposal!({
      context,
      input: { proposalId: "p1" },
    })) as Record<string, unknown>;
    expect(cancelled.status).toBe("cancelled");
    expect(store.rows[0]!.status).toBe("cancelled");
  });

  it("reports a proposal that has already expired, and marks it expired", async () => {
    const store = proposalStore([
      row({ expiresAt: new Date("2026-11-01T00:00:00.000Z"), status: "proposed" }),
    ]);
    const api = routes(store.prisma);
    await expect(api.cancelProposal!({ context, input: { proposalId: "p1" } })).rejects.toThrow(
      /expired/,
    );
    expect(store.rows[0]!.status).toBe("expired");
  });

  it("applies expiry on a read, so a list never shows a stale proposal as live", async () => {
    const store = proposalStore([
      row({ expiresAt: new Date("2026-11-01T00:00:00.000Z"), status: "proposed" }),
    ]);
    const api = routes(store.prisma);
    const listed = (await api.proposals!({ context })) as { proposals: Array<{ status: string }> };
    expect(listed.proposals[0]!.status).toBe("expired");
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
    const probe = {
      privateKey: "0x" + "1".repeat(64),
      passwordWrap: "pw-v1:sealed",
      keyCiphertext: "pwk-v1:sealed",
    };
    Object.assign(store.rows[0]!).wallet = { name: "burner", address: ADDRESS, ...probe };
    const listed = await api.proposals!({ context });
    const single = await api.proposal!({ context, input: { proposalId: "p1" } });
    const seen = JSON.stringify([listed, single]);
    for (const forbidden of ["privateKey", "passwordWrap", "keyCiphertext", "pw-v1", "pwk-v1"]) {
      expect(seen).not.toContain(forbidden);
    }
  });
});
