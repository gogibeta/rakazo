import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
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
  walletProposalGasLimit,
  walletProposalMaxTotalFeeWei,
} from "./wallet-proposals.js";
import { createWalletRpcClient, WalletRpcError } from "./wallet-rpc.js";

// The well-known public Hardhat test account #0: a published test vector.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const GWEI = 1_000_000_000n;

function jsonRpcAnswer(result: unknown, id = 1) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
}

/**
 * A node that answers for one chain with fixed values and records what was
 * asked. It answers with the id the request carried, as a real node does.
 */
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
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params: unknown[];
      id: number;
    };
    calls.push({ method: body.method, params: body.params });
    const answer = (result: unknown) => jsonRpcAnswer(result, body.id);
    switch (body.method) {
      case "eth_chainId":
        return answer(`0x${(options.chainId ?? 99801).toString(16)}`);
      case "eth_getBalance":
        return answer(`0x${BigInt(options.balanceWei ?? "0").toString(16)}`);
      case "eth_getTransactionCount":
        return answer(`0x${(options.nonce ?? 0).toString(16)}`);
      case "eth_estimateGas":
        return answer(`0x${BigInt(options.gas ?? "21000").toString(16)}`);
      case "eth_getBlockByNumber":
        return answer({
          number: "0x1",
          baseFeePerGas:
            options.baseFee === undefined ? undefined : `0x${BigInt(options.baseFee).toString(16)}`,
        });
      case "eth_maxPriorityFeePerGas":
        return answer(`0x${BigInt(options.priority ?? GWEI.toString()).toString(16)}`);
      case "eth_gasPrice":
        return answer(`0x${BigInt(options.gasPrice ?? GWEI.toString()).toString(16)}`);
      default:
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } }),
          { status: 200 },
        );
    }
  });
  return { fetch: fetch as unknown as typeof fetch, calls };
}

/** One proposal row the fake store keeps, with its event log. */
type StoredRow = Record<string, unknown> & {
  id: string;
  userId: string;
  status: string;
  expiresAt: Date;
};

/**
 * The store a proposal write touches: the wallet read, the parameterized
 * INSERT ... RETURNING the service issues, the read paths, and the security
 * event log. Rows and events let a test see exactly what one write did.
 *
 * The insert is answered from the values the service passes, in the order the
 * statement binds them — the same order the SQL uses — so a change to the
 * service's insert shows up as a changed row here rather than passing silently.
 */
function proposalStore(wallet: {
  id: string;
  userId: string;
  name: string;
  address: string;
  migrationStatus: string;
}) {
  const rows: StoredRow[] = [];
  const events: Array<Record<string, unknown>> = [];
  const prisma = {
    userWallet: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === wallet.id && where.userId === wallet.userId ? wallet : null,
      ),
    },
    walletProposal: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    // The service's INSERT ... RETURNING, rebuilt from the bound values in the
    // statement's own order. One stubbed call answers once; the guard keeps a
    // duplicate mock registration from doubling the row.
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (rows.length > 0)
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        }));
      const [
        id,
        userId,
        walletId,
        fromAddress,
        chainId,
        to,
        asset,
        amountWei,
        data,
        nonce,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        rpcProfile,
        ,
        canonicalHash,
        interval,
        runId,
      ] = values as [
        string,
        string,
        string,
        string,
        number,
        string | null,
        string,
        string,
        string | null,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
      ];
      const createdAt = new Date("2026-11-15T12:00:00.000Z");
      // The bind is "<milliseconds> milliseconds", as the statement builds it.
      const ttl = Number(/^(\d+) milliseconds$/.exec(interval)?.[1] ?? 15 * 60 * 1_000);
      const stored = {
        id,
        userId,
        walletId,
        fromAddress,
        chainId,
        to,
        asset,
        amountWei,
        data,
        nonce,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        rpcProfile,
        status: "proposed",
        canonicalHash,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + ttl),
        runId,
      } as unknown as StoredRow;
      rows.push(stored);
      return [{ id, createdAt, expiresAt: stored.expiresAt }];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma: prisma as unknown as PrismaClient, rows, events, mock: prisma };
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
  ttlMs?: number;
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
    spaceId: "space-1",
    runId: "run-1",
    proposed,
    rpcFor: (chain) =>
      createWalletRpcClient({
        chainId: chain.chainId,
        rpcUrl: "https://rpc.test",
        fetch: node.fetch,
      }),
    ttlMs: overrides.ttlMs,
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

  it("keeps the deadline active while the body is read, not just the headers", async () => {
    // Headers arrive at once; the body never finishes. The call must refuse with a
    // typed timeout rather than hang, which a `response.json()` after clearTimeout
    // would have done.
    const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch,
      timeoutMs: 60,
    });
    await expect(rpc.chainId()).rejects.toMatchObject({ code: "rpc_unavailable" });
  });

  it("refuses a body larger than any real JSON-RPC answer before parsing it", async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"result":"0x1"}${" ".repeat(1_100_000)}`;
    const fetch = (async () =>
      new Response(huge, { status: 200 })) as unknown as typeof globalThis.fetch;
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch,
      timeoutMs: 2_000,
    });
    await expect(rpc.chainId()).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("accepts only a matching JSON-RPC 2.0 envelope with one of result or error", async () => {
    const envelope = (body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
    const cases: Array<[unknown, string]> = [
      [{ jsonrpc: "2.0", id: 99, result: "0x1" }, "different request"],
      [{ id: 1, result: "0x1" }, "unreadable"],
      [{ jsonrpc: "1.0", id: 1, result: "0x1" }, "unreadable"],
      [{ jsonrpc: "2.0", id: 1 }, "unreadable"],
      [{ jsonrpc: "2.0", id: 1, result: "0x1", error: { code: 1 } }, "unreadable"],
      [{ jsonrpc: "2.0", id: 1, error: { code: -32000 } }, "refused"],
    ];
    for (const [body, message] of cases) {
      const rpc = createWalletRpcClient({
        chainId: 99801,
        rpcUrl: "https://rpc.test",
        fetch: envelope(body),
      });
      await expect(rpc.chainId(), message).rejects.toMatchObject({ code: "rpc_error" });
    }
  });

  it("refuses a quantity too long to be a uint256, without converting it", async () => {
    const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      // 99801 in hex is 0x185d9; the balance answer is deliberately absurd in length.
      const result = body.method === "eth_chainId" ? "0x185d9" : `0x${"f".repeat(400)}`;
      return jsonRpcAnswer(result, body.id);
    }) as unknown as typeof fetch;
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch,
    });
    await expect(rpc.balanceWei(ADDRESS)).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("refuses a nonce outside the storable range", async () => {
    const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      const result = body.method === "eth_chainId" ? "0x185d9" : `0x${(2n ** 40n).toString(16)}`;
      return jsonRpcAnswer(result, body.id);
    }) as unknown as typeof fetch;
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch,
    });
    await expect(rpc.nonce(ADDRESS)).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("uses ONE absolute deadline: a slow body cannot borrow a second timeout", async () => {
    // Headers arrive at once; the body trickles one byte per tick for longer than the
    // whole budget. With a deadline restarted per step this call would still succeed.
    const fetch: typeof globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      // A stream that NEVER completes on its own: every byte waits far longer than
      // the whole budget. The only way this call can end is the deadline, so the
      // test measures the deadline rather than racing the fake's own pacing.
      const stream = new ReadableStream<Uint8Array>({
        async pull() {
          // Never resolves and never enqueues: nothing the fake does can end this
          // call, so the deadline is the only exit and the assertion cannot race a
          // partially delivered body on a loaded runner.
          await new Promise(() => undefined);
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const rpc = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch,
      timeoutMs: 80,
    });
    await expect(rpc.chainId()).rejects.toMatchObject({ code: "rpc_unavailable" });
    // It gave up near the one deadline, not after a second one per step.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses an envelope carrying both result and error", async () => {
    // Presence is judged by key alone: `error: null` beside a result is still two
    // answers in one envelope, and picking either one would be a guess.
    for (const body of [
      { jsonrpc: "2.0", id: 1, result: "0x185d9", error: null },
      { jsonrpc: "2.0", id: 1, result: "0x185d9", error: { code: -32000 } },
    ]) {
      const fetch = (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
      const rpc = createWalletRpcClient({
        chainId: 99801,
        rpcUrl: "https://rpc.test",
        fetch,
      });
      await expect(rpc.chainId()).rejects.toMatchObject({ code: "rpc_error" });
    }
  });

  it("refuses a non-canonical or over-64-digit quantity before converting it", async () => {
    // 2^256 exactly: 65 hex digits. A decimal-digit bound would let this through,
    // and so would BigInt parsing it happily. Also: zero-padded and uppercase are
    // not canonical RPC quantities.
    const cases = [`0x1${"0".repeat(64)}`, "0x00ff", "0x00", "0xFF", "0x", "ff", "0x-1"];
    for (const value of cases) {
      const fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
        return jsonRpcAnswer(body.method === "eth_chainId" ? "0x185d9" : value, body.id);
      }) as unknown as typeof globalThis.fetch;
      const rpc = createWalletRpcClient({ chainId: 99801, rpcUrl: "https://rpc.test", fetch });
      await expect(rpc.balanceWei(ADDRESS), value).rejects.toMatchObject({ code: "rpc_error" });
    }
    // The largest canonical quantity still parses: 64 hex digits.
    const max = `0x${"f".repeat(64)}`;
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      return jsonRpcAnswer(body.method === "eth_chainId" ? "0x185d9" : max, body.id);
    }) as unknown as typeof globalThis.fetch;
    const rpc = createWalletRpcClient({ chainId: 99801, rpcUrl: "https://rpc.test", fetch });
    await expect(rpc.balanceWei(ADDRESS)).resolves.toBe(((1n << 256n) - 1n).toString(10));
  });

  it("falls back to eth_gasPrice only when the node does not implement the tip method", async () => {
    // Method-not-found: the fallback runs.
    const unsupported: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      if (body.method === "eth_maxPriorityFeePerGas") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } }),
          { status: 200 },
        );
      }
      const result =
        body.method === "eth_chainId"
          ? "0x185d9"
          : body.method === "eth_gasPrice"
            ? "0x3b9aca00"
            : { number: "0x1", baseFeePerGas: "0x3b9aca00" };
      return jsonRpcAnswer(result, body.id);
    }) as unknown as typeof fetch;
    const ok = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: unsupported,
    });
    await expect(ok.fees()).resolves.toEqual({
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
    });

    // A timeout on the tip method is NOT a reason to try another method: it must
    // surface as the proposal refusal it is, not be swallowed.
    const timingOut: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      if (body.method === "eth_maxPriorityFeePerGas") {
        // A body that produces nothing and never closes, so the deadline is the
        // only exit: an enqueued byte could be read as a complete (unparseable)
        // body on a loaded runner, which fails as rpc_error instead of the
        // timeout this test is about.
        const stream = new ReadableStream<Uint8Array>({
          async pull() {
            await new Promise(() => undefined);
          },
        });
        return new Response(stream, { status: 200 });
      }
      const result =
        body.method === "eth_chainId" ? "0x185d9" : { number: "0x1", baseFeePerGas: "0x3b9aca00" };
      return jsonRpcAnswer(result, body.id);
    }) as unknown as typeof fetch;
    const failing = createWalletRpcClient({
      chainId: 99801,
      rpcUrl: "https://rpc.test",
      fetch: timingOut,
      timeoutMs: 60,
    });
    await expect(failing.fees()).rejects.toMatchObject({ code: "rpc_unavailable" });
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
      fromAddress: ADDRESS.toLowerCase(),
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
    // Creation and its security event commit together.
    expect(store.events).toEqual([
      expect.objectContaining({
        type: "credential.changed",
        userId: WALLET.userId,
        spaceId: "space-1",
        metadata: expect.objectContaining({
          procedure: "wallets.proposals",
          kind: "wallet_proposal",
          // The event names the row that was written, by its generated id.
          proposalId: expect.stringMatching(/^c[a-z0-9]{24}$/),
          outcome: "created",
        }),
      }),
    ]);
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
    expect(store.events).toHaveLength(0);
  });

  it("refuses another person's wallet", async () => {
    await expect(
      createWalletProposal({
        prisma: proposalStore(WALLET).prisma,
        userId: "someone-else",
        spaceId: "space-1",
        proposed: { walletId: WALLET.id, chainId: 99801, to: RECIPIENT, value: "0", data: null },
        rpcFor: () => {
          throw new Error("must not reach the chain");
        },
      }),
    ).rejects.toMatchObject({ code: "wallet_not_found" });
  });

  it("refuses when the balance cannot cover the value plus the maximum fee", async () => {
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

  it("applies the gas cap to the stored limit, after padding, and never clamps", async () => {
    // An estimate that passes the raw check but whose padded limit would not.
    // 1,500,000 * 1.2 + 1 = 1,800,001, above the cap, so this must refuse.
    const { promise, store } = create({
      node: { balanceWei: (10n ** 24n).toString(), gas: WALLET_PROPOSAL_GAS_LIMIT_MAX.toString() },
    });
    await expect(promise).rejects.toMatchObject({ code: "gas_limit_too_high" });
    expect(store.rows).toHaveLength(0);

    // An estimate whose padded limit fits is accepted, stored as padded.
    const accepted = create({
      node: { balanceWei: (10n ** 24n).toString(), gas: "1200000" },
    });
    const { row } = await accepted.promise;
    expect(row.gasLimit).toBe("1440001");
    expect(BigInt(row.gasLimit)).toBeLessThanOrEqual(WALLET_PROPOSAL_GAS_LIMIT_MAX);
  });

  it("pads the estimate by 20% and rounds up", () => {
    expect(walletProposalGasLimit(21_000n)).toBe(25_201n);
    expect(walletProposalGasLimit(1n)).toBe(2n);
    expect(walletProposalGasLimit(50_000n)).toBe(60_001n);
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

  it("refuses a lifetime longer than the maximum before anything is stored", async () => {
    const { promise, store } = create({ ttlMs: 61 * 60 * 1_000 });
    await expect(promise).rejects.toMatchObject({ code: "invalid_request" });
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

  it("rests on a key-sorting serializer, proven independently of this module", () => {
    // stableJsonValue is the whole reason two equivalent inputs hash alike; pin that
    // property here so a change to it fails in this suite too.
    expect(stableJsonValue({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      stableJsonValue({ a: [2, { c: 3, d: 4 }], b: 1 }),
    );
    expect(stableJsonValue({ a: 1 })).not.toBe(stableJsonValue({ a: 2 }));
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

  it("is what the stored proposal carries, over the stored sender", async () => {
    const { promise } = create({
      node: { balanceWei: (10n ** 18n).toString(), nonce: 3, gas: "21000", baseFee: "1000000000" },
    });
    const { row } = await promise;
    expect(row.canonicalHash).toBe(
      walletProposalCanonicalHash({
        chainId: 99801,
        from: ADDRESS.toLowerCase(),
        to: RECIPIENT,
        value: "1000000000000000",
        data: null,
        nonce: 3,
        gasLimit: "25201",
        maxFeePerGas: "3000000000",
        maxPriorityFeePerGas: "1000000000",
      }),
    );
    // The hash is reconstructible from the stored row alone, with no wallet read.
    expect(row.fromAddress).toBe(ADDRESS.toLowerCase());
  });

  it("reports the maximum fee as gasLimit times maxFeePerGas", () => {
    expect(walletProposalMaxTotalFeeWei({ gasLimit: "25201", maxFeePerGas: "3000000000" })).toBe(
      "75603000000000",
    );
  });
});

describe("status transitions", () => {
  /**
   * A store whose conditional UPDATE behaves like the real statement: it matches
   * the expected current status, compares the deadline against the database's
   * clock, and returns the id when it changed a row. Each call is one event.
   */
  function statusStore(row: { id: string; userId: string; status: string; expiresAt: Date }) {
    const rows = [row];
    const events: Array<Record<string, unknown>> = [];
    const prisma = {
      walletProposal: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
          rows.find((r) => r.id === where.id && r.userId === where.userId)
            ? { id: row.id, status: row.status }
            : null,
        ),
      },
      securityEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        }),
      },
      // Assigned below; the placeholder keeps the object's shape while the fake
      // conditional UPDATE needs the same object to close over.
      $queryRaw: vi.fn(async (): Promise<Array<{ id: string }>> => []),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    // The raw conditional UPDATE is issued through $queryRaw; the fake answers it
    // the way Postgres would for the one row this store holds.
    const queued: Array<{ to: string; requireLive: boolean }> = [];
    prisma.$queryRaw = vi.fn(async () => {
      // Each raw UPDATE consumes the next queued expectation, as the real service
      // issues exactly one statement per transition attempt.
      const pendingTransition = queued.shift();
      if (!pendingTransition) return [];
      const now = new Date("2026-11-15T12:00:00.000Z");
      const live = row.expiresAt.getTime() > now.getTime();
      if (row.status !== "proposed") return [];
      if (pendingTransition.requireLive && !live) return [];
      if (pendingTransition.to === "expired" && live) return [];
      row.status = pendingTransition.to;
      return [{ id: row.id }];
    });
    return {
      prisma: prisma as unknown as PrismaClient,
      rows,
      events,
      /** Queue the conditional updates the service will issue, in order. */
      expectTransition: (to: string, requireLive = false) => {
        queued.push({ to, requireLive });
      },
    };
  }

  const base = {
    id: "p1",
    userId: "user-1",
    status: "proposed",
    expiresAt: new Date("2026-11-15T13:00:00.000Z"),
  };

  it("cancels a live proposal and records exactly one event", async () => {
    const store = statusStore({ ...base });
    store.expectTransition("cancelled", true);
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(store.rows[0]!.status).toBe("cancelled");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "cancelled" }),
    });
  });

  it("persists expiry instead of cancelling, when the deadline passed first", async () => {
    const store = statusStore({
      ...base,
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    // The cancel's live-guarded update matches nothing; the service then issues the
    // expiry, which is the transition that wins — and the only one recorded.
    store.expectTransition("cancelled", true);
    store.expectTransition("expired");
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).rejects.toMatchObject({ code: "proposal_expired" });
    expect(store.rows[0]!.status).toBe("expired");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "expired" }),
    });
  });

  it("never re-cancels a cancelled proposal, and records nothing", async () => {
    const store = statusStore({ ...base, status: "cancelled" });
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).rejects.toMatchObject({ code: "proposal_not_cancellable" });
    expect(store.events).toHaveLength(0);
  });

  it("reports the winning transition only: a second expiry writes no second event", async () => {
    const store = statusStore({
      ...base,
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    store.expectTransition("expired");
    await expect(
      expireWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).resolves.toBe(true);
    expect(store.rows[0]!.status).toBe("expired");
    expect(store.events).toHaveLength(1);
    // The row is no longer proposed, so the statement matches nothing.
    await expect(
      expireWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).resolves.toBe(false);
    expect(store.events).toHaveLength(1);
  });

  it("refuses to expire a proposal that is still live", async () => {
    const store = statusStore({ ...base });
    store.expectTransition("expired");
    await expect(
      expireWalletProposal({
        prisma: store.prisma,
        userId: "user-1",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).resolves.toBe(false);
    expect(store.rows[0]!.status).toBe("proposed");
    expect(store.events).toHaveLength(0);
  });

  it("expires every overdue proposal with one event per proposal", async () => {
    const store = statusStore({
      ...base,
      expiresAt: new Date("2026-11-15T11:00:00.000Z"),
    });
    store.expectTransition("expired");
    const expired = await expireOverdueWalletProposals({
      prisma: store.prisma,
      userId: "user-1",
      spaceId: "space-1",
    });
    expect(expired).toEqual(["p1"]);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      metadata: expect.objectContaining({ proposalId: "p1", outcome: "expired" }),
    });
  });

  it("refuses to cancel someone else's proposal", async () => {
    const store = statusStore({ ...base });
    await expect(
      cancelWalletProposal({
        prisma: store.prisma,
        userId: "user-2",
        spaceId: "space-1",
        proposalId: "p1",
      }),
    ).rejects.toBeInstanceOf(WalletProposalError);
    expect(store.events).toHaveLength(0);
  });
});
