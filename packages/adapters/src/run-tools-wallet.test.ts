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
