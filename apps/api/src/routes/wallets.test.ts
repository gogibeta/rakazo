import {
  verifyWalletVaultPassword,
  WalletVaultNotConfiguredError,
} from "@rakazo/adapters/wallet-vault";
import type { WalletVaultClient } from "@rakazo/adapters/wallet-vault-client";
import { WalletVaultClientError } from "@rakazo/adapters/wallet-vault-client";
import type { PrismaClient } from "@rakazo/db";
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
  keyCiphertext: string | null;
  passwordWrap: string | null;
  migrationStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The route handlers with the oRPC builder stubbed to hand them back bare. */
function routes(prisma: unknown, secrets: unknown, walletVault?: WalletVaultClient | null) {
  const procedure = { handler: (fn: unknown) => fn };
  const family = new Proxy({}, { get: () => procedure });
  const authed = new Proxy({}, { get: () => family });
  return walletsRoutes({
    deps: { prisma, secrets, walletVault },
    authed,
  } as unknown as RouterContext).wallets as unknown as Record<
    string,
    (call: { context: unknown; input?: unknown }) => Promise<unknown>
  >;
}

/**
 * A vault client over the test store's password state: unlock verifies
 * through the real shared throttle, grants last six hours, lock clears.
 * Sign and fill refuse, as the real vault does until PRs 6–7 wire them.
 */
function fakeVaultClient(store: ReturnType<typeof walletStore>): WalletVaultClient {
  const grants = new Map<string, { expiresAt: string; passwordEpoch: number }>();
  return {
    status: vi.fn(async (userId: string) => {
      const row = store.vaultRows().get(userId);
      const grant = grants.get(userId);
      const live = grant !== undefined && Date.parse(grant.expiresAt) > Date.now();
      return {
        configured: row !== undefined,
        unlocked: live,
        expiresAt: live ? grant.expiresAt : null,
        passwordEpoch: row ? row.passwordEpoch : null,
      };
    }),
    unlock: vi.fn(async (userId: string, password: string) => {
      let verified: { passwordEpoch: number };
      try {
        verified = await verifyWalletVaultPassword(
          store.prisma as unknown as PrismaClient,
          userId,
          password,
        );
      } catch (error) {
        if (error instanceof WalletVaultNotConfiguredError) {
          throw new WalletVaultClientError("not_configured");
        }
        throw new WalletVaultClientError("password_rejected");
      }
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      grants.set(userId, { expiresAt, passwordEpoch: verified.passwordEpoch });
      return { grantId: "grant-test", expiresAt, passwordEpoch: verified.passwordEpoch };
    }),
    lock: vi.fn(async (userId: string) => {
      grants.delete(userId);
      return { locked: true as const };
    }),
    sign: vi.fn(async () => {
      throw new WalletVaultClientError("signing_not_enabled");
    }),
    fill: vi.fn(async () => {
      throw new WalletVaultClientError("fill_not_enabled");
    }),
  };
}

function walletStore() {
  let rows: Row[] = [];
  const vaultRows = new Map<string, VaultRow>();
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
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<
            Row,
            "id" | "createdAt" | "updatedAt" | "keyCiphertext" | "passwordWrap" | "migrationStatus"
          >;
        }) => {
          const row: Row = {
            keyCiphertext: null,
            passwordWrap: null,
            migrationStatus: "legacy_server_only",
            ...data,
            id: `w${++next}`,
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
            updatedAt: new Date("2026-09-01T00:00:00.000Z"),
          };
          rows.push(row);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = (row: Row): boolean =>
            Object.entries(where).every(([key, condition]) => {
              const value = row[key as keyof Row];
              if (condition && typeof condition === "object" && "in" in condition) {
                return (condition as { in: unknown[] }).in.includes(value);
              }
              return value === condition;
            });
          let count = 0;
          for (const row of rows) {
            if (!matches(row)) continue;
            Object.assign(row, data);
            count++;
          }
          return { count };
        },
      ),
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
    walletVault: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        vaultRows.has(where.userId) ? { ...vaultRows.get(where.userId)! } : null,
      ),
      create: vi.fn(async ({ data }: { data: VaultRow }) => {
        vaultRows.set(data.userId, { ...data });
        return { ...data };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
          const row = vaultRows.get(where.userId)!;
          const record = row as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && "increment" in value) {
              record[key] = (record[key] as number) + (value as { increment: number }).increment;
            } else {
              record[key] = value;
            }
          }
          return { ...row };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          // The where shapes the password state uses: equality, null, `lte`, OR groups.
          const matches = (row: VaultRow, conditions: Record<string, unknown>): boolean =>
            Object.entries(conditions).every(([key, condition]) => {
              if (key === "OR") {
                return (condition as Array<Record<string, unknown>>).some((sub) =>
                  matches(row, sub),
                );
              }
              const value = row[key as keyof VaultRow];
              if (condition instanceof Date) {
                return value instanceof Date && value.getTime() === condition.getTime();
              }
              if (condition && typeof condition === "object") {
                const ops = condition as { lte?: Date };
                if (ops.lte !== undefined) return value instanceof Date && value <= ops.lte;
                return false;
              }
              return value === condition;
            });
          let count = 0;
          for (const row of vaultRows.values()) {
            if (!matches(row, where)) continue;
            const record = row as unknown as Record<string, unknown>;
            for (const [key, value] of Object.entries(data)) record[key] = value;
            count++;
          }
          return { count };
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, secrets, puts, rows: () => rows, vaultRows: () => vaultRows };
}

type VaultRow = {
  userId: string;
  verifier: string;
  verifierVersion: number;
  passwordEpoch: number;
  configuredAt: Date;
  changedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
};

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

  it("sets and changes the wallet password, storing only a verifier and answering generically", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    const password = "route-vault-password-one";
    const nextPassword = "route-vault-password-two";

    expect(await api.vaultStatus!({ context })).toEqual({
      configured: false,
      changedAt: null,
      unlocked: false,
      expiresAt: null,
      passwordEpoch: null,
      vaultAvailable: false,
    });

    const set = await api.setVaultPassword!({ context, input: { password } });
    expect(set).toMatchObject({ configured: true });
    const row = [...store.vaultRows().values()][0]!;
    expect(row.verifier.startsWith("pw-v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(password);
    // No response carries the password or the verifier.
    for (const response of [set, await api.vaultStatus!({ context })]) {
      expect(JSON.stringify(response)).not.toContain(password);
      expect(JSON.stringify(response)).not.toContain("pw-v1:");
    }

    await expect(api.setVaultPassword!({ context, input: { password } })).rejects.toThrow(
      /already set/,
    );
    // A wrong current password is refused with the one generic message.
    await expect(
      api.changeVaultPassword!({
        context,
        input: { currentPassword: "route-vault-password-wrong", newPassword: nextPassword },
      }),
    ).rejects.toThrow("The wallet password could not be verified.");

    const changed = await api.changeVaultPassword!({
      context,
      input: { currentPassword: password, newPassword: nextPassword },
    });
    expect(changed).toMatchObject({ configured: true });
    expect(row.passwordEpoch).toBe(2);
    expect(JSON.stringify(changed)).not.toContain(nextPassword);
  });

  it("unlocks for six hours and locks on demand, never returning the password or the grant", async () => {
    const store = walletStore();
    const vault = fakeVaultClient(store);
    const api = routes(store.prisma, store.secrets, vault);
    const password = "route-unlock-password-one";

    // Before any password exists, unlock is refused as not configured.
    await expect(api.vaultUnlock!({ context, input: { password } })).rejects.toThrow(
      /No wallet password is set yet/,
    );

    await api.setVaultPassword!({ context, input: { password } });
    expect(await api.vaultStatus!({ context })).toMatchObject({
      configured: true,
      unlocked: false,
      vaultAvailable: true,
    });

    // A wrong password stays locked and mints nothing.
    await expect(
      api.vaultUnlock!({ context, input: { password: "route-unlock-password-wrong" } }),
    ).rejects.toThrow("The wallet password could not be verified.");
    expect(await api.vaultStatus!({ context })).toMatchObject({ unlocked: false });

    const unlocked = (await api.vaultUnlock!({ context, input: { password } })) as {
      expiresAt: string | null;
    };
    expect(unlocked).toMatchObject({ configured: true, unlocked: true, vaultAvailable: true });
    const expiresIn = Date.parse(unlocked.expiresAt!) - Date.now();
    expect(expiresIn).toBeGreaterThan(5 * 60 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    // Neither the password nor the grant handle ever crosses to the browser.
    expect(JSON.stringify(unlocked)).not.toContain(password);
    expect(JSON.stringify(unlocked)).not.toContain("grant-test");

    const locked = await api.vaultLock!({ context });
    expect(locked).toMatchObject({ unlocked: false, expiresAt: null });
    expect(await api.vaultStatus!({ context })).toMatchObject({ unlocked: false });
  });

  it("fails closed as unavailable when the vault is absent or does not answer", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    const password = "route-unlock-password-one";
    await api.setVaultPassword!({ context, input: { password } });

    await expect(api.vaultUnlock!({ context, input: { password } })).rejects.toThrow(
      "The wallet vault is unavailable.",
    );
    await expect(api.vaultLock!({ context })).rejects.toThrow("The wallet vault is unavailable.");
    expect(await api.vaultStatus!({ context })).toMatchObject({
      configured: true,
      unlocked: false,
      vaultAvailable: false,
    });

    // A vault that cannot be reached reads the same as no vault at all.
    const down = fakeVaultClient(store);
    const apiDown = routes(store.prisma, store.secrets, down);
    vi.mocked(down.status).mockRejectedValueOnce(new WalletVaultClientError("vault_unavailable"));
    expect(await apiDown.vaultStatus!({ context })).toMatchObject({
      configured: true,
      unlocked: false,
      vaultAvailable: false,
    });
    vi.mocked(down.unlock).mockRejectedValueOnce(new WalletVaultClientError("vault_unavailable"));
    await expect(apiDown.vaultUnlock!({ context, input: { password } })).rejects.toThrow(
      "The wallet vault is unavailable.",
    );
    vi.mocked(down.lock).mockRejectedValueOnce(new WalletVaultClientError("vault_unavailable"));
    await expect(apiDown.vaultLock!({ context })).rejects.toThrow(
      "The wallet vault is unavailable.",
    );
  });

  it("migrates a wallet to its password envelope and never returns secret material", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    const password = "route-migration-password";
    // A cuid-shaped id, as the database generates (the envelope binds it).
    const walletId = "c000000000000000000000001";
    store.rows().push({
      id: walletId,
      userId: "u",
      name: "burner",
      chain: "evm",
      address: ADDRESS,
      secretCipher: "v2:sealed-value",
      keyCiphertext: null,
      passwordWrap: null,
      migrationStatus: "legacy_server_only",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    // No password set yet: migration cannot start.
    await expect(api.migrate!({ context, input: { walletId, password } })).rejects.toThrow(
      /No wallet password is set yet/,
    );

    await api.setVaultPassword!({ context, input: { password } });

    // A wrong password is the one generic rejection, and nothing changes.
    await expect(
      api.migrate!({ context, input: { walletId, password: "route-migration-wrong" } }),
    ).rejects.toThrow("The wallet password could not be verified.");
    expect(store.rows()[0]).toMatchObject({
      migrationStatus: "legacy_server_only",
      secretCipher: "v2:sealed-value",
    });

    const migrated = (await api.migrate!({ context, input: { walletId, password } })) as {
      migrationStatus: string;
    };
    expect(migrated.migrationStatus).toBe("password_protected");
    const row = store.rows()[0]!;
    expect(row.secretCipher).toBe("");
    expect(row.keyCiphertext).toMatch(/^pwk-v1:/);
    expect(row.passwordWrap).toMatch(/^pw-v1:/);
    for (const response of [migrated, await api.list!({ context })]) {
      const seen = JSON.stringify(response);
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain(password);
      expect(seen).not.toContain("pwk-v1:");
      expect(seen).not.toContain("pw-v1:");
    }

    // Re-running is a clean no-op.
    const again = (await api.migrate!({ context, input: { walletId, password } })) as {
      migrationStatus: string;
    };
    expect(again.migrationStatus).toBe("password_protected");
    expect(store.rows()[0]!.keyCiphertext).toBe(row.keyCiphertext);

    // Another person's wallet is not found, not migrated.
    await expect(
      api.migrate!({
        context: { actor: { userId: "other", spaceId: "s" }, signal: undefined },
        input: { walletId, password },
      }),
    ).rejects.toThrow(/Wallet not found/);
  });
});
