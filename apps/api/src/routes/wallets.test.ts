import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { walletsRoutes } from "./wallets.js";

// The well-known public Hardhat test account #0: a published test vector.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PHRASE = "test test test test test test test test test test test junk";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Row = {
  id: string;
  userId: string;
  name: string;
  chain: string;
  address: string;
  secretCipher: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The route handlers with the oRPC builder stubbed to hand them back bare. */
function routes(prisma: unknown, secrets: unknown) {
  const procedure = { handler: (fn: unknown) => fn };
  const family = new Proxy({}, { get: () => procedure });
  const authed = new Proxy({}, { get: () => family });
  return walletsRoutes({ deps: { prisma, secrets }, authed } as unknown as RouterContext)
    .wallets as unknown as Record<
    string,
    (call: { context: unknown; input?: unknown }) => Promise<unknown>
  >;
}

function walletStore() {
  let rows: Row[] = [];
  let next = 0;
  const puts: Array<{ plaintext: string; recordId?: string }> = [];
  const secrets = {
    put: vi.fn(async (plaintext: string, _context: unknown, options?: { recordId?: string }) => {
      puts.push({ plaintext, recordId: options?.recordId });
      return { ciphertext: "v2:sealed-value" };
    }),
    load: vi.fn(async () => KEY),
  };
  const prisma = {
    userWallet: {
      create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
        const row: Row = {
          ...data,
          id: `w${++next}`,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((entry) => entry.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; name?: string; id?: string } }) =>
          rows.find(
            (row) =>
              row.userId === where.userId &&
              (where.name === undefined || row.name === where.name) &&
              (where.id === undefined || row.id === where.id),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows = rows.filter((row) => row.id !== where.id);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const before = rows.length;
        rows = rows.filter((row) => !(row.id === where.id && row.userId === where.userId));
        return { count: before - rows.length };
      }),
    },
    userWalletUse: { findMany: vi.fn(async () => []) },
  };
  return { prisma, secrets, puts, rows: () => rows };
}

const context = { actor: { userId: "u", spaceId: "s" }, signal: undefined };

describe("wallets routes", () => {
  it("derives the address, seals the secret, and never returns it from add, list or uses", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);

    const added = await api.add!({ context, input: { name: "burner", secret: KEY } });
    expect(added).toMatchObject({ name: "burner", chain: "evm", address: ADDRESS });
    // The secret went to the seal, keyed by the row's id — nowhere else.
    expect(store.puts).toEqual([{ plaintext: KEY, recordId: "w1" }]);
    expect(store.rows()[0]).toMatchObject({ secretCipher: "v2:sealed-value", address: ADDRESS });

    const listed = await api.list!({ context });
    const used = await api.uses!({ context, input: { walletId: "w1" } });
    for (const response of [added, listed, used]) {
      const seen = JSON.stringify(response);
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain(KEY.slice(2));
      expect(seen).not.toContain("secretCipher");
      expect(seen).not.toContain("v2:sealed-value");
    }
    expect(listed).toEqual({
      wallets: [expect.objectContaining({ id: "w1", name: "burner", address: ADDRESS })],
    });
  });

  it("derives the same address from a seed phrase and seals the phrase, not the key", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    const added = await api.add!({ context, input: { name: "phrase", secret: ` ${PHRASE} ` } });
    expect(added).toMatchObject({ address: ADDRESS });
    expect(store.puts).toEqual([{ plaintext: PHRASE, recordId: "w1" }]);
    expect(JSON.stringify(added)).not.toContain("junk");
  });

  it("refuses an unreadable secret and a duplicate name, saving nothing", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await expect(
      api.add!({ context, input: { name: "bad", secret: "not a key or a phrase" } }),
    ).rejects.toThrow(/could not be read/);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await expect(api.add!({ context, input: { name: "burner", secret: KEY } })).rejects.toThrow(
      /already exists/,
    );
    expect(store.rows()).toHaveLength(1);
  });

  it("deletes the row when sealing fails, so no wallet keeps an unsealed secret", async () => {
    const store = walletStore();
    store.secrets.put.mockRejectedValueOnce(new Error("seal failed"));
    const api = routes(store.prisma, store.secrets);
    await expect(api.add!({ context, input: { name: "burner", secret: KEY } })).rejects.toThrow(
      "seal failed",
    );
    expect(store.rows()).toEqual([]);
  });
});
