import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { WALLET_CHAINS, walletChain } from "./wallet-chains.js";
import {
  cancelWalletProposal,
  createWalletProposal,
  expireOverdueWalletProposals,
  expireWalletProposal,
  WALLET_PROPOSAL_GAS_LIMIT_MAX,
  WalletProposalError,
  walletProposalCanonicalHash,
  walletProposalCanonicalJson,
  walletProposalMaxTotalFeeWei,
} from "./wallet-proposals.js";
import { createWalletRpcClient, WalletRpcError } from "./wallet-rpc.js";

// The well-known public Hardhat test account #0: a published test vector.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const GWEI = 1_000_000_000n;

function jsonRpcAnswer(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}

/** A node that answers for one chain with fixed values, and records what was asked. */
function fakeNode(options: {
  chainId?: number;
  balanceWei?: string;
  nonce?: number;
  gas?: string;
  baseFee?: string;
  priority?: string;
  gasPrice?: string;
}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    switch (body.method) {
      case "eth_chainId":
        return jsonRpcAnswer(`0x${(options.chainId ?? 99801).toString(16)}`);
      case "eth_getBalance":
        return jsonRpcAnswer(`0x${BigInt(options.balanceWei ?? "0").toString(16)}`);
      case "eth_getTransactionCount":
        return jsonRpcAnswer(`0x${(options.nonce ?? 0).toString(16)}`);
      case "eth_estimateGas":
        return jsonRpcAnswer(`0x${BigInt(options.gas ?? "21000").toString(16)}`);
      case "eth_getBlockByNumber":
        return jsonRpcAnswer({
          number: "0x1",
          baseFeePerGas:
            options.baseFee === undefined ? undefined : `0x${BigInt(options.baseFee).toString(16)}`,
        });
      case "eth_maxPriorityFeePerGas":
        return jsonRpcAnswer(`0x${BigInt(options.priority ?? GWEI.toString()).toString(16)}`);
      case "eth_gasPrice":
        return jsonRpcAnswer(`0x${BigInt(options.gasPrice ?? GWEI.toString()).toString(16)}`);
      default:
        return new Response(JSON.stringify({ error: { code: -32601, message: "no" } }), {
          status: 200,
        });
    }
  });
  return { fetch: fetch as unknown as typeof fetch, calls };
}

/** The proposal store a validation writes to, with the queries the service makes. */
function proposalStore(wallet: {
  id: string;
  userId: string;
  name: string;
  address: string;
  migrationStatus: string;
}) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    userWallet: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === wallet.id && where.userId === wallet.userId ? wallet : null,
      ),
    },
    walletProposal: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `proposal-${rows.length + 1}`,
          createdAt: new Date("2026-11-15T12:00:00.000Z"),
          ...data,
        };
        rows.push(row);
        return row;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows, mock: prisma };
}

const WALLET = {
  id: "wallet-1",
  userId: "user-1",
  name: "burner",
  address: ADDRESS,
  migrationStatus: "password_protected",
};

function create(overrides: {
  proposed?: Record<string, unknown>;
  wallet?: typeof WALLET;
  node?: Parameters<typeof fakeNode>[0];
  now?: Date;
}) {
  const store = proposalStore(overrides.wallet ?? WALLET);
  const proposed = overrides.proposed ?? {
    walletId: WALLET.id,
    chainId: 99801,
    to: RECIPIENT,
    value: "1000000000000000",
    data: null,
  };
  // The fake node answers for the chain the proposal names, unless a test
  // deliberately points it at another one.
  const node = fakeNode({
    chainId: proposed.chainId as number,
    balanceWei: (10n ** 18n).toString(),
    ...overrides.node,
  });
  const promise = createWalletProposal({
    prisma: store.prisma,
    userId: overrides.wallet?.userId ?? WALLET.userId,
    runId: "run-1",
    proposed,
    rpcFor: (chain) =>
      createWalletRpcClient({
        chainId: chain.chainId,
        rpcUrl: "https://rpc.test",
        fetch: node.fetch,
      }),
    now: () => overrides.now ?? new Date("2026-11-15T12:00:00.000Z"),
  });
  return { promise, store, node };
}

describe("the chain registry", () => {
  it("allowlists exactly the three testnets, each with one server-chosen profile", () => {
    expect([...WALLET_CHAINS.keys()].sort((a, b) => a - b)).toEqual([998, 99801, 11155111]);
    for (const chain of WALLET_CHAINS.values()) {
      expect(chain.rpcUrl.startsWith("https://")).toBe(true);
      expect(chain.rpcProfile).toMatch(/^[a-z0-9-]+$/);
    }
    expect(walletChain(1)).toBeUndefined();
    expect(walletChain(0x38)).toBeUndefined();
  });
});

describe("the proposal RPC client", () => {
  it("verifies the chain before answering anything else", async () => {
    const node = fakeNode({ chainId: 11155111 });
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: node.fetch,
    });
    await expect(rpc.balanceWei(ADDRESS)).rejects.toMatchObject({ code: "chain_mismatch" });
    // Only the chain check ran; no balance was read from the wrong chain.
    expect(node.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
  });

  it("returns exact decimal strings for balances and fees", async () => {
    const node = fakeNode({
      balanceWei: "123456789012345678901234567890",
      priority: "1500000000",
      baseFee: "1000000000",
    });
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: node.fetch,
    });
    await expect(rpc.balanceWei(ADDRESS)).resolves.toBe("123456789012345678901234567890");
    await expect(rpc.fees()).resolves.toEqual({
      maxFeePerGas: "3500000000",
      maxPriorityFeePerGas: "1500000000",
    });
  });

  it("fails closed when the node cannot be reached", async () => {
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    await expect(rpc.chainId()).rejects.toBeInstanceOf(WalletRpcError);
  });

  it("has no method that could sign or send", async () => {
    const node = fakeNode({});
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: node.fetch,
    });
    expect(Object.keys(rpc).sort()).toEqual([
      "balanceWei",
      "chainId",
      "estimateGas",
      "fees",
      "nonce",
    ]);
  });
});

describe("creating a proposal", () => {
  it("stores a native send with server-filled nonce, fees and gas", async () => {
    const { promise, store } = create({
      node: { balanceWei: (10n ** 18n).toString(), nonce: 7, gas: "21000", baseFee: "1000000000" },
    });
    const { row, wallet, chain } = await promise;
    expect(wallet.name).toBe("burner");
    expect(chain.chainId).toBe(99801);
    expect(row).toMatchObject({
      walletId: WALLET.id,
      chainId: 99801,
      to: RECIPIENT,
      amountWei: "1000000000000000",
      data: null,
      nonce: 7,
      status: "proposed",
      rpcProfile: "elysium-testnet",
      asset: "HYPE",
    });
    // Gas carries the 20% headroom on the node's estimate.
    expect(row.gasLimit).toBe("25201");
    expect(row.maxFeePerGas).toBe("3000000000");
    expect(row.maxPriorityFeePerGas).toBe("1000000000");
    expect(row.expiresAt.toISOString()).toBe("2026-11-15T12:15:00.000Z");
    expect(store.rows).toHaveLength(1);
  });

  it("stores a data-carrying call: to and data together, value optional", async () => {
    const { promise } = create({
      node: { balanceWei: (10n ** 18n).toString(), gas: "60000" },
      proposed: {
        walletId: WALLET.id,
        chainId: 11155111,
        to: RECIPIENT,
        value: "0",
        data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead",
      },
    });
    const { row, chain } = await promise;
    expect(chain.chainId).toBe(11155111);
    expect(row.data).toBe(
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead",
    );
    expect(row.amountWei).toBe("0");
    expect(row.asset).toBe("ETH");
  });

  it("stores a deploy shape: no recipient, bytecode in data, no value", async () => {
    const { promise } = create({
      node: { balanceWei: (10n ** 18n).toString(), gas: "300000" },
      proposed: {
        walletId: WALLET.id,
        chainId: 998,
        to: null,
        value: "0",
        data: "0x6080604052348015600f57600080fd5b50",
      },
    });
    const { row, chain } = await promise;
    expect(chain.chainId).toBe(998);
    expect(row.to).toBeNull();
    expect(row.data).toBe("0x6080604052348015600f57600080fd5b50");
    expect(row.rpcProfile).toBe("hyperevm-testnet");
  });

  it("refuses a chain that is not allowlisted", async () => {
    const { promise, store } = create({
      proposed: { walletId: WALLET.id, chainId: 1, to: RECIPIENT, value: "0", data: null },
    });
    await expect(promise).rejects.toMatchObject({ code: "chain_not_allowed" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a legacy wallet that the vault could never sign for", async () => {
    const { promise, store } = create({
      wallet: { ...WALLET, migrationStatus: "legacy_server_only" },
    });
    await expect(promise).rejects.toMatchObject({ code: "wallet_not_migrated" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses another person's wallet", async () => {
    const { promise } = create({});
    await expect(
      createWalletProposal({
        prisma: proposalStore(WALLET).prisma,
        userId: "someone-else",
        proposed: { walletId: WALLET.id, chainId: 99801, to: RECIPIENT, value: "0", data: null },
        rpcFor: () => {
          throw new Error("must not reach the chain");
        },
      }),
    ).rejects.toMatchObject({ code: "wallet_not_found" });
    await expect(promise).resolves.toBeDefined();
  });

  it("refuses when the balance cannot cover the value plus the maximum fee", async () => {
    // 0.001 ETH is enough for the value alone, but not value + gas * maxFee.
    const { promise, store } = create({
      proposed: {
        walletId: WALLET.id,
        chainId: 99801,
        to: RECIPIENT,
        value: "1000000000000000",
        data: null,
      },
      node: { balanceWei: "1000000000000000", gas: "21000" },
    });
    await expect(promise).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses an invalid recipient before touching the chain", async () => {
    const { promise, store } = create({
      proposed: { walletId: WALLET.id, chainId: 99801, to: "0xnot-an-address", value: "0" },
    });
    await expect(promise).rejects.toMatchObject({ code: "invalid_request" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a float amount and an amount above uint256", async () => {
    for (const value of ["0.5", "1e18", "1.0", "-1"]) {
      const { promise } = create({
        proposed: { walletId: WALLET.id, chainId: 99801, to: RECIPIENT, value, data: null },
      });
      await expect(promise).rejects.toMatchObject({ code: "invalid_request" });
    }
    const { promise } = create({
      proposed: {
        walletId: WALLET.id,
        chainId: 99801,
        to: RECIPIENT,
        value: ((1n << 256n) + 1n).toString(10),
        data: null,
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a deploy without bytecode and a deploy that sends value", async () => {
    const noData = create({
      proposed: { walletId: WALLET.id, chainId: 99801, to: null, value: "0", data: null },
    });
    await expect(noData.promise).rejects.toMatchObject({ code: "invalid_request" });
    const withValue = create({
      proposed: { walletId: WALLET.id, chainId: 99801, to: null, value: "1", data: "0x60" },
    });
    await expect(withValue.promise).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses gas above the cap rather than clamping it", async () => {
    const { promise } = create({
      node: {
        balanceWei: (10n ** 24n).toString(),
        gas: (WALLET_PROPOSAL_GAS_LIMIT_MAX + 1n).toString(),
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "gas_limit_too_high" });
  });

  it("refuses a fee suggestion above the cap", async () => {
    const { promise } = create({
      node: { balanceWei: (10n ** 24n).toString(), priority: (600n * GWEI).toString() },
    });
    await expect(promise).rejects.toMatchObject({ code: "fee_cap_exceeded" });
  });

  it("refuses when the chain answers for another network", async () => {
    const { promise, store } = create({ node: { chainId: 11155111, balanceWei: "1" } });
    await expect(promise).rejects.toMatchObject({ code: "chain_mismatch" });
    expect(store.rows).toHaveLength(0);
  });
});

describe("the canonical hash", () => {
  const fields = {
    chainId: 99801,
    from: ADDRESS,
    to: RECIPIENT,
    value: "1000",
    data: null,
    nonce: 3,
    gasLimit: "25201",
    maxFeePerGas: "3000000000",
    maxPriorityFeePerGas: "1000000000",
  };

  it("is stable across field order and address case", () => {
    const reordered = {
      maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
      nonce: fields.nonce,
      gasLimit: fields.gasLimit,
      data: fields.data,
      value: fields.value,
      to: RECIPIENT.toLowerCase(),
      from: ADDRESS.toLowerCase(),
      chainId: 99801,
      maxFeePerGas: fields.maxFeePerGas,
    };
    expect(walletProposalCanonicalJson(reordered)).toBe(walletProposalCanonicalJson(fields));
    expect(walletProposalCanonicalHash(reordered)).toBe(walletProposalCanonicalHash(fields));
    expect(walletProposalCanonicalHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field that defines the transaction changes", () => {
    const base = walletProposalCanonicalHash(fields);
    for (const change of [
      { to: null },
      { value: "1001" },
      { data: "0x01" },
      { nonce: 4 },
      { gasLimit: "25202" },
      { maxFeePerGas: "3000000001" },
      { maxPriorityFeePerGas: "1000000001" },
      { chainId: 998 },
      { from: RECIPIENT },
    ]) {
      expect(walletProposalCanonicalHash({ ...fields, ...change })).not.toBe(base);
    }
  });

  it("is what the stored proposal carries, so a changed field would be a new proposal", async () => {
    const { promise } = create({
      node: { balanceWei: (10n ** 18n).toString(), nonce: 3, gas: "21000", baseFee: "1000000000" },
    });
    const { row } = await promise;
    expect(row.canonicalHash).toBe(
      walletProposalCanonicalHash({
        chainId: 99801,
        from: ADDRESS,
        to: RECIPIENT,
        value: "1000000000000000",
        data: null,
        nonce: 3,
        gasLimit: "25201",
        maxFeePerGas: "3000000000",
        maxPriorityFeePerGas: "1000000000",
      }),
    );
  });

  it("reports the maximum fee as gasLimit times maxFeePerGas", () => {
    expect(walletProposalMaxTotalFeeWei({ gasLimit: "25201", maxFeePerGas: "3000000000" })).toBe(
      "75603000000000",
    );
  });
});

describe("status transitions", () => {
  /** A store with one proposal and the conditional updates the service issues. */
  function statusStore(row: { id: string; status: string; expiresAt: Date }) {
    const rows = [row];
    const matches = (candidate: (typeof rows)[number], where: Record<string, unknown>) =>
      Object.entries(where).every(([key, condition]) => {
        if (key === "id") return candidate.id === condition;
        if (key === "userId") return true;
        if (key === "status") return candidate.status === condition;
        if (key === "expiresAt" && condition && typeof condition === "object") {
          const ops = condition as { gt?: Date; lte?: Date };
          if (ops.gt) return candidate.expiresAt.getTime() > ops.gt.getTime();
          if (ops.lte) return candidate.expiresAt.getTime() <= ops.lte.getTime();
        }
        return false;
      });
    const prisma = {
      walletProposal: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string } }) =>
            rows.find((candidate) => matches(candidate, where)) ?? null,
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: { status: string } }) => {
            let count = 0;
            for (const candidate of rows) {
              if (!matches(candidate, where)) continue;
              candidate.status = data.status;
              count += 1;
            }
            return { count };
          },
        ),
      },
    };
    return { prisma: prisma as unknown as PrismaClient, rows };
  }

  it("cancels a proposed transaction and records it", async () => {
    const store = statusStore({
      id: "p1",
      status: "proposed",
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
    });
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        proposalId: "p1",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(store.rows[0]!.status).toBe("cancelled");
  });

  it("lets no expired proposal transition further", async () => {
    const store = statusStore({
      id: "p1",
      status: "proposed",
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    const now = () => new Date("2026-11-15T12:00:00.000Z");
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        proposalId: "p1",
        now,
      }),
    ).rejects.toMatchObject({ code: "proposal_expired" });
    // The cancel marked it expired, not cancelled: expiry is not a decision.
    expect(store.rows[0]!.status).toBe("expired");
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        proposalId: "p1",
        now,
      }),
    ).rejects.toMatchObject({ code: "proposal_not_cancellable" });
    expect(store.rows[0]!.status).toBe("expired");
  });

  it("never re-cancels a cancelled proposal", async () => {
    const store = statusStore({
      id: "p1",
      status: "cancelled",
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
    });
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        proposalId: "p1",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "proposal_not_cancellable" });
  });

  it("expires only overdue proposals, and only proposed ones", async () => {
    const overdue = statusStore({
      id: "p1",
      status: "proposed",
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    await expect(
      expireWalletProposal({
        prisma: overdue.prisma,
        userId: "user-1",
        proposalId: "p1",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).resolves.toBe(true);
    expect(overdue.rows[0]!.status).toBe("expired");

    const live = statusStore({
      id: "p2",
      status: "proposed",
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
    });
    await expect(
      expireWalletProposal({
        prisma: live.prisma,
        userId: "user-1",
        proposalId: "p2",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).resolves.toBe(false);
    expect(live.rows[0]!.status).toBe("proposed");
  });

  it("sweeps every overdue proposal for the owner in one conditional write", async () => {
    const store = statusStore({
      id: "p1",
      status: "proposed",
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    await expect(
      expireOverdueWalletProposals({
        prisma: store.prisma,
        userId: "user-1",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).resolves.toBe(1);
    expect(store.rows[0]!.status).toBe("expired");
  });

  it("refuses to cancel someone else's proposal", async () => {
    const store = statusStore({
      id: "p1",
      status: "proposed",
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
    });
    (store.prisma.walletProposal as unknown as { findFirst: unknown }).findFirst = vi.fn(
      async () => null,
    );
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-2",
        proposalId: "p1",
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(WalletProposalError);
  });
});
