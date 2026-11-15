import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { createStreamingRedactor } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserTool } from "./run-tools-computer.js";
import { walletTools } from "./run-tools-wallets.js";
import { EncryptedSecretStore } from "./secrets.js";

// The well-known public Hardhat test account #0 key: a published test vector.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const url = "https://example.test/import";
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "u",
  signal: new AbortController().signal,
};

type UseRow = Record<string, unknown>;

/** A wallet store of one sealed wallet, and the usage records written to it. */
async function walletStore() {
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const stored = await secretStore.put(KEY, context, { recordId: "w1" });
  const row = {
    id: "w1",
    userId: "u",
    name: "burner",
    chain: "evm",
    address: ADDRESS,
    secretCipher: stored.ciphertext,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
  const uses: UseRow[] = [];
  const prisma = {
    userWallet: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) =>
        where.userId === row.userId && where.name === row.name ? row : null,
      ),
      findMany: vi.fn(async () => [row]),
    },
    userWalletUse: {
      create: vi.fn(async ({ data }: { data: UseRow }) => {
        uses.push(data);
        return data;
      }),
    },
    taughtSkill: { findFirst: async () => null },
  };
  return { secretStore, row, uses, prisma: prisma as unknown as PrismaClient };
}

describe("browser_act types a saved wallet only where the user approved it", () => {
  async function fillWallet(approval?: Record<string, unknown>) {
    const { secretStore, row, uses, prisma } = await walletStore();
    const secrets: string[] = [];
    const browser = new FakeBrowserProvider({
      pages: {
        [url]: {
          title: "Import",
          html: "<input aria-label='Private key' type='password' />",
        },
      },
    });
    await browser.navigate(computer, { url }, context);
    // A bot snapshots the page before acting, which is what hands out the refs.
    await browser.snapshot(computer, {}, context);
    const ctx = {
      deps: { prisma, secretStore },
      run: { userId: "u", spaceId: "space", id: "run-1", botId: "b1" },
      bot: { id: "b1", name: "Chief" },
      context,
      computer: {
        heldForTakeover: false,
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets,
      state: {
        walletHosts: new Set<string>(),
        screen: { unchangedVisualStreak: { count: 0 } },
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      },
    };
    const result = await pageBrowserTool(
      ctx as never,
      {
        name: "browser_act",
        args: {
          actions: [
            {
              kind: "fill_wallet",
              ref: "e1",
              wallet: "burner",
              site: "https://example.test",
              purpose: "Import into the testnet wallet",
            },
          ],
          ...(approval
            ? {
                walletApproval: {
                  wallet: "burner",
                  site: "https://example.test",
                  purpose: "Import into the testnet wallet",
                  address: ADDRESS,
                  savedAt: row.updatedAt.toISOString(),
                  ...approval,
                },
              }
            : {}),
        },
        finish: async (r: unknown) => r,
      } as never,
    );
    return { seen: JSON.stringify(result), secrets, uses };
  }

  it("refuses without the user's approval of this wallet on this site", async () => {
    for (const approval of [
      undefined,
      { site: "https://other.example.test" },
      { wallet: "other" },
    ]) {
      const { seen, secrets, uses } = await fillWallet(approval);
      expect(seen).toContain("not approved");
      expect(seen).not.toContain(KEY);
      expect(secrets).toEqual([]);
      expect(uses).toEqual([]);
    }
  });

  it("refuses a wallet changed after the approval, and records nothing", async () => {
    const { seen, secrets, uses } = await fillWallet({
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(seen).toContain("changed after the user approved");
    expect(secrets).toEqual([]);
    expect(uses).toEqual([]);
  });

  it("types it once approved, hides the key, joins the run's redactions, and records the use", async () => {
    const { seen, secrets, uses } = await fillWallet({});
    expect(seen).not.toContain("not approved");
    expect(seen).not.toContain("could not");
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(KEY.slice(2));
    expect(secrets).toContain(KEY);
    expect(uses).toEqual([
      expect.objectContaining({
        walletId: "w1",
        userId: "u",
        botId: "b1",
        botName: "Chief",
        purpose: "Import into the testnet wallet",
        site: "https://example.test",
      }),
    ]);
  });
});

describe("list_wallets", () => {
  it("shows names, chains and addresses only", async () => {
    const { prisma } = await walletStore();
    const result = await walletTools.list_wallets!(
      { deps: { prisma }, run: { userId: "u" } } as never,
      {} as never,
    );
    expect(result).toEqual({ wallets: [{ name: "burner", chain: "evm", address: ADDRESS }] });
    const seen = JSON.stringify(result);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain("secretCipher");
  });
});

describe("wallet_propose", () => {
  const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
  const PROPOSED = {
    walletId: "w1",
    chainId: 99801,
    to: RECIPIENT,
    value: "1000000000000000",
    data: null,
  };

  /**
   * A store with one wallet and its proposals, and a stand-in chain that reports
   * fixed values: the seam the executor uses so no test reaches a network.
   */
  function proposeContext(
    options: {
      ownerStartedRun?: boolean;
      migrationStatus?: string;
      balanceWei?: string;
      gas?: string;
      audits?: unknown[];
    } = {},
  ) {
    const created: Array<Record<string, unknown>> = [];
    const wallet = {
      id: "w1",
      userId: "u",
      name: "burner",
      address: ADDRESS,
      migrationStatus: options.migrationStatus ?? "password_protected",
    };
    const prisma = {
      userWallet: { findFirst: vi.fn(async () => wallet), findMany: vi.fn(async () => [wallet]) },
      walletProposal: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const stored = { id: "p1", createdAt: new Date("2026-11-15T12:00:00.000Z"), ...data };
          created.push(stored);
          return stored;
        }),
      },
      externalEffect: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "e1",
          ...data,
        })),
      },
      auditEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
      space: { findUnique: vi.fn(async () => ({ organizationId: "org", name: "Test" })) },
      user: { findUnique: vi.fn(async () => ({ email: "owner@rakazo.test" })) },
    };
    const walletRpc = () => ({
      chainId: async () => 99801,
      balanceWei: async () => options.balanceWei ?? "1000000000000000000",
      nonce: async () => 0,
      estimateGas: async () => options.gas ?? "21000",
      fees: async () => ({ maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1000000000" }),
    });
    const ctx = {
      deps: { prisma, walletRpc },
      run: { id: "run-1", userId: "u", spaceId: "space", threadId: "t1", trigger: "user" },
      bot: { id: "b1", name: "Chief" },
      thread: { id: "t1" },
      runId: "run-1",
      source: { ownerStartedRun: options.ownerStartedRun ?? true },
      secrets: [],
      state: {},
    };
    return { ctx, created, prisma };
  }

  it("returns a deterministic summary and stores the validated proposal", async () => {
    const { ctx, created } = proposeContext();
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: PROPOSED,
      } as never,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      id: "p1",
      chainId: 99801,
      to: RECIPIENT,
      amountWei: "1000000000000000",
      nonce: 0,
      gasLimit: "25201",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
      maxTotalFeeWei: "75603000000000",
      canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      walletName: "burner",
      chainName: "Elysium Testnet",
      nativeSymbol: "HYPE",
    });
    expect(created).toHaveLength(1);
    // Nothing that could sign is ever in the result.
    const seen = JSON.stringify(result);
    for (const forbidden of ["private", "passwordWrap", "keyCiphertext", "secretCipher"]) {
      expect(seen).not.toContain(forbidden);
    }
  });

  it("refuses a run the owner did not start, before any chain read", async () => {
    const { ctx, created } = proposeContext({ ownerStartedRun: false });
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: PROPOSED,
      } as never,
    )) as { error: string };
    expect(result.error).toContain("run the owner started");
    expect(created).toHaveLength(0);
  });

  it("refuses a legacy wallet with the reason the model can act on", async () => {
    const { ctx, created } = proposeContext({ migrationStatus: "legacy_server_only" });
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: PROPOSED,
      } as never,
    )) as { error: string };
    expect(result.error).toContain("not protected by the wallet password");
    expect(created).toHaveLength(0);
  });

  it("refuses insufficient balance including the fee, and stores nothing", async () => {
    const { ctx, created } = proposeContext({ balanceWei: "1000000000000000" });
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: PROPOSED,
      } as never,
    )) as { error: string };
    expect(result.error).toContain("enough for the amount plus the maximum fee");
    expect(created).toHaveLength(0);
  });

  it("refuses a malformed proposal before the chain is touched", async () => {
    const { ctx, created } = proposeContext();
    for (const args of [
      { ...PROPOSED, to: "nope" },
      { ...PROPOSED, value: "0.5" },
      { ...PROPOSED, chainId: 1 },
    ]) {
      const result = (await walletTools.wallet_propose!(
        ctx as never,
        {
          args,
        } as never,
      )) as { error: string };
      expect(result.error).toBeTruthy();
      expect(created).toHaveLength(0);
    }
  });
});
