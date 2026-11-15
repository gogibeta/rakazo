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
  it("returns the id wallet_propose needs, and nothing secret", async () => {
    const { prisma } = await walletStore();
    const result = await walletTools.list_wallets!(
      { deps: { prisma }, run: { userId: "u" } } as never,
      {} as never,
    );
    // The id is the handle wallet_propose takes. Without it a bot can name a wallet
    // by a value the tool will never accept, which is how no proposal could ever be
    // created: list_wallets is the only place a bot learns what to pass.
    expect(result).toEqual({
      wallets: [{ id: "w1", name: "burner", chain: "evm", address: ADDRESS }],
    });
    const seen = JSON.stringify(result);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain("secretCipher");
    expect(seen).not.toContain("keyCiphertext");
    expect(seen).not.toContain("passwordWrap");
  });

  it("is the id wallet_propose then accepts, end to end", async () => {
    // The two tools are only useful together: a bot reads the list, then proposes
    // with what the list gave it. This drives exactly that pair against one store.
    const { prisma } = await walletStore();
    const listed = (await walletTools.list_wallets!(
      { deps: { prisma }, run: { userId: "u" } } as never,
      {} as never,
    )) as { wallets: Array<{ id: string }> };
    expect(listed.wallets[0]!.id).toBe("w1");

    // A store whose wallet lookup is strict on the id, as the real service is.
    const created: Array<Record<string, unknown>> = [];
    const strict = {
      userWallet: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
          where.userId === "u" && where.id === "w1"
            ? {
                id: "w1",
                userId: "u",
                name: "burner",
                address: ADDRESS,
                migrationStatus: "password_protected",
              }
            : null,
        ),
      },
      securityEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
      $queryRaw: vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
        const id = String(values[0] ?? "");
        if (!/^c[a-z0-9]{24}$/.test(id)) return [];
        const createdAt = new Date("2026-11-15T12:00:00.000Z");
        const stored = {
          id,
          walletId: values[2],
          fromAddress: values[3],
          chainId: values[4],
          to: values[5],
          asset: values[6],
          amountWei: values[7],
          data: values[8],
          nonce: values[9],
          gasLimit: values[10],
          maxFeePerGas: values[11],
          maxPriorityFeePerGas: values[12],
          rpcProfile: values[13],
          canonicalHash: values[15],
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1_000),
        };
        created.push(stored);
        return [{ id, createdAt, expiresAt: stored.expiresAt }];
      }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(strict)),
    };
    const walletRpc = () => ({
      chainId: async () => 99801,
      balanceWei: async () => "1000000000000000000",
      nonce: async () => 0,
      estimateGas: async () => "21000",
      fees: async () => ({ maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1000000000" }),
    });
    const ctx = {
      deps: { prisma: strict, walletRpc },
      run: { id: "run-1", userId: "u", spaceId: "space", threadId: "t1", trigger: "user" },
      bot: { id: "b1", name: "Chief" },
      thread: { id: "t1" },
      runId: "run-1",
      source: { ownerStartedRun: true },
      secrets: [],
      state: {},
    };
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: {
          walletId: listed.wallets[0]!.id,
          chainId: 99801,
          to: "0x000000000000000000000000000000000000dEaD",
          value: "1000",
          data: null,
        },
      } as never,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ chainId: 99801 });
    expect(created).toHaveLength(1);
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
      userWallet: {
        // Strict on both keys, as the real service is: the lookup is by id and
        // userId, so a name or an address finds nothing.
        findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
          where.userId === wallet.userId && where.id === wallet.id ? wallet : null,
        ),
        findMany: vi.fn(async () => [wallet]),
      },

      securityEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
      // The service's parameterized INSERT ... RETURNING: one row appears for
      // each insert the handler performs, with the database clock's timestamps.
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        // Prisma issues a few of its own statements through this path; only the
        // proposal INSERT binds an id in the cuid shape as its first value.
        const id = String(values[0] ?? "");
        if (!/^c[a-z0-9]{24}$/.test(id)) return [];
        // A retry of the same insert is the same row, not a second one.
        const existing = created.find((row) => row.id === id);
        if (existing) {
          return [{ id, createdAt: existing.createdAt, expiresAt: existing.expiresAt }];
        }
        const createdAt = new Date("2026-11-15T12:00:00.000Z");
        const stored = {
          id,
          walletId: values[2],
          fromAddress: values[3],
          chainId: values[4],
          to: values[5],
          asset: values[6],
          amountWei: values[7],
          data: values[8],
          nonce: values[9],
          gasLimit: values[10],
          maxFeePerGas: values[11],
          maxPriorityFeePerGas: values[12],
          rpcProfile: values[13],
          canonicalHash: values[15],
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1_000),
        };
        created.push(stored);
        return [{ id, createdAt, expiresAt: stored.expiresAt }];
      }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
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
      // The handler returns the id the insert generated.
      id: expect.stringMatching(/^c[a-z0-9]{24}$/),
      chainId: 99801,
      to: RECIPIENT,
      amountWei: "1000000000000000",
      nonce: 0,
      gasLimit: "25201",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
      maxTotalFeeWei: "75603000000000",
      canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: "2026-11-15T12:15:00.000Z",
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

  it("reaches the legacy gate with the id list_wallets returned", async () => {
    // The live bug was that the gate was unreachable: a bot had no id to pass, so
    // every call stopped at wallet_not_found and the migration check never ran.
    // This drives the real pair — list, then propose with what the list returned —
    // against a wallet that is still legacy.
    const { prisma, created } = proposeContext({ migrationStatus: "legacy_server_only" });
    const ctx = {
      deps: { prisma },
      run: { id: "run-1", userId: "u", spaceId: "space", threadId: "t1", trigger: "user" },
      bot: { id: "b1", name: "Chief" },
      thread: { id: "t1" },
      runId: "run-1",
      source: { ownerStartedRun: true },
      secrets: [],
      state: {},
    };
    const listed = (await walletTools.list_wallets!(
      { deps: { prisma }, run: { userId: "u" } } as never,
      {} as never,
    )) as { wallets: Array<{ id: string }> };
    const result = (await walletTools.wallet_propose!(
      ctx as never,
      {
        args: { ...PROPOSED, walletId: listed.wallets[0]!.id },
      } as never,
    )) as { error: string };
    expect(result.error).toContain("not protected by the wallet password");
    expect(created).toHaveLength(0);
  });

  it("still refuses a name or an address passed as walletId", async () => {
    // The lookup stays id-only: the list now hands out an id, and anything else is
    // a mistake the model must be told about, not a second accepted key form.
    for (const walletId of ["burner", ADDRESS]) {
      const { ctx, created } = proposeContext();
      const result = (await walletTools.wallet_propose!(
        ctx as never,
        {
          args: { ...PROPOSED, walletId },
        } as never,
      )) as { error: string };
      expect(result.error, walletId).toContain("Pass the id that list_wallets returns");
      expect(created, walletId).toHaveLength(0);
    }
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
