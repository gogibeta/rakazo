import { createHash } from "node:crypto";
import {
  verifyWalletVaultPassword,
  WalletVaultNotConfiguredError,
} from "@rakazo/adapters/wallet-vault";
import type { WalletVaultClient } from "@rakazo/adapters/wallet-vault-client";
import { WalletVaultClientError } from "@rakazo/adapters/wallet-vault-client";
import { createVaultSqlShim } from "@rakazo/adapters/wallet-vault-fake";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { walletsRoutes } from "./wallets.js";

// W-2 records a security event on removal and restore. The real recorder needs a
// request context and a database; these tests only need to see what it was told.
const recorded = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    recordSecurityEvent: vi.fn(async (event: Record<string, unknown>) => {
      recorded.push(event);
    }),
  };
});

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
  removedAt: Date | null;
  removedName: string | null;
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
    // The reservation throttle's raw SQL, backed by the same in-memory rows the model
    // doubles below mutate, so password verification runs the real statements.
    ...createVaultSqlShim(vaultRows),
    userWallet: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<
            Row,
            | "id"
            | "createdAt"
            | "updatedAt"
            | "keyCiphertext"
            | "passwordWrap"
            | "migrationStatus"
            | "removedAt"
            | "removedName"
          >;
        }) => {
          const row: Row = {
            keyCiphertext: null,
            passwordWrap: null,
            migrationStatus: "legacy_server_only",
            removedAt: null,
            removedName: null,
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
              // `{ not: null }` is how the restore path asks for removed rows.
              if (condition && typeof condition === "object" && "not" in condition) {
                return value !== (condition as { not: unknown }).not;
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
        async ({
          where,
          select,
        }: {
          where: {
            userId: string;
            name?: string;
            id?: string;
            removedAt?: null | { not: null };
          };
          select?: Record<string, boolean>;
        }) => {
          const row =
            rows.find(
              (entry) =>
                entry.userId === where.userId &&
                (where.name === undefined || entry.name === where.name) &&
                (where.id === undefined || entry.id === where.id) &&
                (where.removedAt === undefined ||
                  (where.removedAt === null ? entry.removedAt === null : entry.removedAt !== null)),
            ) ?? null;
          if (!row || !select) return row;
          // Honour `select`, the way Prisma does: a caller that asks for two
          // fields must not receive the sealed secret alongside them.
          return Object.fromEntries(
            Object.keys(select)
              .filter((key) => select[key])
              .map((key) => [key, row[key as keyof Row]]),
          );
        },
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string; removedAt?: null } }) =>
        rows.filter(
          (row) =>
            row.userId === where.userId &&
            (where.removedAt === undefined || row.removedAt === where.removedAt),
        ),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (!row) throw new Error("not found");
        return row;
      }),
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
    // Proposals outlive a wallet removal: the row is archived, not deleted, so the
    // `onDelete: Cascade` on `WalletProposal.wallet` never fires. The table holds real
    // rows so the test can show they are still there afterwards. Asserting only that no
    // delete was called would prove the absence of a call the code has no reason to make,
    // which is weaker than the DoD's "proposals kept".
    walletProposal: (() => {
      type ProposalRow = { id: string; userId: string; walletId: string; status: string };
      let proposalRows: ProposalRow[] = [];
      return {
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          proposalRows = proposalRows.filter((row) => row.id !== where.id);
          return { id: where.id };
        }),
        deleteMany: vi.fn(async ({ where }: { where: { walletId?: string } }) => {
          const before = proposalRows.length;
          proposalRows = proposalRows.filter(
            (row) => where.walletId !== undefined && row.walletId !== where.walletId,
          );
          return { count: before - proposalRows.length };
        }),
        updateMany: vi.fn(
          async ({ where, data }: { where: { walletId?: string }; data?: { status?: string } }) => {
            // Apply the write the way Prisma does. A double that only counted matches
            // would let a "cancel every proposal of this wallet" mutation pass unseen,
            // which is exactly the kind of cascade this test exists to catch.
            const hit = proposalRows.filter(
              (row) => where.walletId === undefined || row.walletId === where.walletId,
            );
            for (const row of hit) {
              if (data?.status !== undefined) row.status = data.status;
            }
            return { count: hit.length };
          },
        ),
        seed: (rows: ProposalRow[]) => {
          proposalRows = rows.map((row) => ({ ...row }));
        },
        rows: () => proposalRows.map((row) => ({ ...row })),
      };
    })(),
    // The removal-confirmation table: tokens are stored by digest, so the double
    // hashes the token the caller holds the same way the real code does.
    walletRemovalConfirmation: (() => {
      type TokenRow = {
        id: string;
        userId: string;
        walletId: string;
        tokenHash: string;
        expiresAt: Date;
        consumedAt: Date | null;
      };
      let tokenRows: TokenRow[] = [];
      let tokenNext = 0;
      const digest = (token: string) => createHash("sha256").update(token).digest("hex");
      return {
        create: vi.fn(async ({ data }: { data: Omit<TokenRow, "id" | "consumedAt"> }) => {
          const row: TokenRow = { ...data, id: `t${++tokenNext}`, consumedAt: null };
          tokenRows.push(row);
          return row;
        }),
        findFirst: vi.fn(
          async ({ where }: { where: { tokenHash: string; userId: string; walletId: string } }) =>
            tokenRows.find(
              (row) =>
                row.tokenHash === where.tokenHash &&
                row.userId === where.userId &&
                row.walletId === where.walletId,
            ) ?? null,
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; consumedAt?: null };
            data: { consumedAt: Date };
          }) => {
            const row = tokenRows.find((entry) => entry.id === where.id);
            // Honour `where` exactly, the way Prisma does. The previous version
            // checked `consumedAt` unconditionally, which made the double stricter
            // than the code: deleting the condition from the source left the test
            // passing. Now the guard must be in the code to be observed.
            if (!row) return { count: 0 };
            if (where.consumedAt === null && row.consumedAt !== null) return { count: 0 };
            row.consumedAt = data.consumedAt;
            return { count: 1 };
          },
        ),
        rows: () => tokenRows,
        digest,
        reset: () => {
          tokenRows = [];
        },
      };
    })(),
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
      removedAt: null,
      removedName: null,
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

/** Remove a wallet the way the UI does: ask for a token, then spend it. */
async function removeWithToken(
  api: Record<string, (call: { context: unknown; input?: unknown }) => Promise<unknown>>,
  context: { actor: { userId: string; spaceId: string }; signal: undefined },
  walletId: string,
) {
  const confirmation = (await api.requestRemove!({ context, input: { walletId } })) as {
    token: string;
  };
  return api.remove!({ context, input: { walletId, confirmationToken: confirmation.token } });
}

describe("W-2: removing a wallet is a soft delete", () => {
  // `recorded` is module-level so the mock can see it; each case starts empty.
  beforeEach(() => {
    recorded.length = 0;
  });

  it("keeps the row and the secret, releases the name, and audits the removal", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    recorded.length = 0;

    const result = await removeWithToken(api, context, "w1");
    expect(result).toEqual({ ok: true });

    // The row is still there with its sealed secret: the whole point of W-2 is
    // that a removal no longer destroys the only server-side copy of the key.
    const row = store.rows()[0]!;
    expect(row.secretCipher).toBe("v2:sealed-value");
    expect(row.removedAt).toBeInstanceOf(Date);
    expect(row.removedName).toBe("burner");
    // The name is released so a new wallet may take it, and the row is left
    // holding something recognisably not a name anyone chose.
    expect(row.name).toBe("removed:w1");

    expect(recorded).toEqual([
      expect.objectContaining({
        type: "wallet.removed",
        userId: "u",
        metadata: { walletId: "w1", chain: "evm", name: "burner" },
      }),
    ]);
    // Nothing secret reaches the audit event.
    expect(JSON.stringify(recorded)).not.toContain(KEY.slice(2));
  });

  it("hides a removed wallet from list, uses and migrate, but keeps it restorable", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await removeWithToken(api, context, "w1");

    expect(await api.list!({ context })).toEqual({ wallets: [] });
    await expect(api.uses!({ context, input: { walletId: "w1" } })).rejects.toThrow(
      /Wallet not found/,
    );
    await expect(
      api.migrate!({ context, input: { walletId: "w1", password: "correct horse battery" } }),
    ).rejects.toThrow(/Wallet not found/);

    // Restoring brings it back under its old name, with the secret intact.
    const restored = await api.restore!({ context, input: { walletId: "w1" } });
    expect(restored).toMatchObject({ id: "w1", name: "burner", address: ADDRESS });
    expect(store.rows()[0]).toMatchObject({ removedAt: null, removedName: null, name: "burner" });
    expect(await api.list!({ context })).toEqual({
      wallets: [expect.objectContaining({ id: "w1", name: "burner" })],
    });
    expect(recorded.map((event) => event.type)).toEqual(["wallet.removed", "wallet.restored"]);
  });

  it("archives the row without touching the owner's pending proposals", async () => {
    // The DoD for this step names "proposals kept" as part of the combined acceptance.
    // A soft delete cannot cascade, so the proposals survive by construction — but that
    // is exactly the kind of guarantee that dies silently when someone later changes the
    // write to a real `delete`. The assertion is on the rows themselves, not on whether a
    // delete happened to be called: the rows are what the person would lose.
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    store.prisma.walletProposal.seed([
      { id: "p1", userId: "u", walletId: "w1", status: "proposed" },
    ]);

    await removeWithToken(api, context, "w1");

    // The proposal is still there, unchanged, and still points at the archived wallet.
    expect(store.prisma.walletProposal.rows()).toEqual([
      { id: "p1", userId: "u", walletId: "w1", status: "proposed" },
    ]);
    // The row itself is still there too, which is what keeps the foreign key valid.
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]!.removedAt).not.toBeNull();
  });

  it("lets the name be reused after removal, and refuses to restore over the new wallet", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await removeWithToken(api, context, "w1");

    // The name was released, so this must not trip the duplicate-name check.
    await expect(
      api.add!({ context, input: { name: "burner", secret: KEY } }),
    ).resolves.toMatchObject({ name: "burner" });

    // Restoring the old wallet would collide, and the owner gets something they
    // can act on rather than a unique-constraint error surfacing as a 500.
    await expect(api.restore!({ context, input: { walletId: "w1" } })).rejects.toThrow(
      /already exists/,
    );
    expect(store.rows().filter((row) => row.removedAt === null)).toHaveLength(1);
  });

  it("reports a second removal as not found instead of rewriting the released name", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await removeWithToken(api, context, "w1");
    const firstRemovedAt = store.rows()[0]!.removedAt;

    // A removed wallet cannot even get a token: `requestRemove` filters on
    // `removedAt: null`, so the second attempt is refused before any write.
    await expect(api.requestRemove!({ context, input: { walletId: "w1" } })).rejects.toThrow(
      /Wallet not found/,
    );
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: "any-token" } }),
    ).rejects.toThrow(/Wallet not found/);
    // Unchanged: the loser of the race did not touch the row.
    expect(store.rows()[0]!.removedAt).toBe(firstRemovedAt);
    expect(recorded.filter((event) => event.type === "wallet.removed")).toHaveLength(1);
  });

  it("reports not found when the row is removed between the read and the write", async () => {
    // The plain second-removal case above is caught by `findFirst` filtering on
    // `removedAt: null`, so it never exercises the guard on the write itself.
    // This drives the real race: the read still sees a live row, and by the time
    // the write runs another caller has removed it. Without the write's own
    // `removedAt: null` condition this would rewrite the name the winner
    // released and log a second removal that never happened.
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    const nameBefore = store.rows()[0]!.name;
    // The read still sees a live row; the write is made to lose the race the way
    // a concurrent removal would. The double honours `where` so that dropping the
    // `removedAt: null` condition makes it match and report a write that happened.
    const updateMany = store.prisma.userWallet.updateMany as unknown as {
      mockImplementationOnce: (
        fn: (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>,
      ) => void;
    };
    updateMany.mockImplementationOnce(async ({ where }) => {
      // Simulate the other caller having removed it already.
      store.rows()[0]!.removedAt = new Date();
      const matches =
        (where.removedAt === undefined || store.rows()[0]!.removedAt === null) &&
        (where.id === undefined || store.rows()[0]!.id === where.id);
      return { count: matches ? 1 : 0 };
    });

    // A real token for a live wallet, so this fails on the write's own
    // condition rather than on the token.
    const { token } = (await api.requestRemove!({ context, input: { walletId: "w1" } })) as {
      token: string;
    };
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
    ).rejects.toThrow(/Wallet not found/);
    // The row is untouched: the loser of the race did not rewrite the name the
    // winner released, and no second removal was logged.
    expect(store.rows()[0]!.name).toBe(nameBefore);
    expect(recorded.filter((event) => event.type === "wallet.removed")).toHaveLength(0);
  });

  it("does not let another user remove or restore a wallet", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    const other = { actor: { userId: "other", spaceId: "s" }, signal: undefined };

    await expect(
      api.remove!({ context: other, input: { walletId: "w1", confirmationToken: "any" } }),
    ).rejects.toThrow(/Wallet not found/);
    expect(store.rows()[0]!.removedAt).toBeNull();

    await removeWithToken(api, context, "w1");
    await expect(api.restore!({ context: other, input: { walletId: "w1" } })).rejects.toThrow(
      /Removed wallet not found/,
    );
    expect(store.rows()[0]!.removedAt).toBeInstanceOf(Date);
  });
});

describe("W-2: a removal needs a single-use token", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("refuses a removal with no token, with a wrong token, or with a token for another wallet", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await api.add!({ context, input: { name: "second", secret: KEY } });

    // No token at all.
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: "" } }),
    ).rejects.toThrow();
    // A token nobody issued.
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: "not-a-real-token" } }),
    ).rejects.toThrow(/not valid for this wallet/);
    // A real token, but issued for a different wallet.
    const forSecond = (await api.requestRemove!({ context, input: { walletId: "w2" } })) as {
      token: string;
    };
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: forSecond.token } }),
    ).rejects.toThrow(/not valid for this wallet/);

    // Nothing was removed by any of those.
    expect(store.rows().every((row) => row.removedAt === null)).toBe(true);
    expect(recorded.filter((event) => event.type === "wallet.removed")).toHaveLength(0);
  });

  it("spends a token once: the same token cannot remove a second wallet", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    await api.add!({ context, input: { name: "second", secret: KEY } });
    const { token } = (await api.requestRemove!({ context, input: { walletId: "w1" } })) as {
      token: string;
    };

    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
    ).resolves.toEqual({ ok: true });
    // Replaying the same token is refused, even though the wallet it names is
    // now removed and the lookup would fail anyway — the point is the token.
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
    ).rejects.toThrow(/Wallet not found|not valid/);
    expect(recorded.filter((event) => event.type === "wallet.removed")).toHaveLength(1);
  });

  it("refuses an expired token", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    const { token } = (await api.requestRemove!({ context, input: { walletId: "w1" } })) as {
      token: string;
    };
    // Age the token past its five minutes rather than waiting.
    const tokenRow = (
      store.prisma.walletRemovalConfirmation as unknown as {
        rows: () => Array<{ expiresAt: Date }>;
      }
    )
      .rows()
      .find((row) => row.expiresAt instanceof Date);
    tokenRow!.expiresAt = new Date(Date.now() - 1000);

    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
    ).rejects.toThrow(/expired/);
    expect(store.rows()[0]!.removedAt).toBeNull();
  });

  it("returns the wallet's name and address with the token, so the owner can check it", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });

    const confirmation = (await api.requestRemove!({
      context,
      input: { walletId: "w1" },
    })) as { token: string; expiresAt: string; wallet: { name: string; address: string } };

    expect(confirmation.wallet).toEqual({ name: "burner", address: ADDRESS });
    // Five minutes, not longer.
    const ttl = Date.parse(confirmation.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // The token is opaque and never derived from the wallet.
    expect(confirmation.token).not.toContain("w1");
    expect(JSON.stringify(confirmation)).not.toContain(KEY);
  });

  it("does not issue a token for another user's wallet, or for a removed one", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    const other = { actor: { userId: "other", spaceId: "s" }, signal: undefined };

    await expect(api.requestRemove!({ context: other, input: { walletId: "w1" } })).rejects.toThrow(
      /Wallet not found/,
    );
    await removeWithToken(api, context, "w1");
    await expect(api.requestRemove!({ context, input: { walletId: "w1" } })).rejects.toThrow(
      /Wallet not found/,
    );
  });
});

describe("W-2: a token is spent exactly once", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("refuses the second use of a token even while its wallet is still live", async () => {
    // The replay case in the block above cannot reach the token logic: the first
    // removal makes the wallet disappear, so the second call is refused by the
    // wallet lookup. This drives the consumption path itself — two tokens for the
    // same wallet, one of them spent, and the spent one replayed while the wallet
    // is still there.
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });

    const spent = (await api.requestRemove!({ context, input: { walletId: "w1" } })) as {
      token: string;
    };
    // Consume it without removing: the confirmation is what is being tested.
    const { consumeWalletRemovalConfirmation } = await import(
      "@rakazo/adapters/wallet-removal-confirmation"
    );
    await consumeWalletRemovalConfirmation({
      prisma: store.prisma as unknown as PrismaClient,
      userId: "u",
      walletId: "w1",
      token: spent.token,
    });

    // The wallet is still live, so the lookup succeeds and the refusal can only
    // come from the token being spent.
    expect(store.rows()[0]!.removedAt).toBeNull();
    await expect(
      api.remove!({ context, input: { walletId: "w1", confirmationToken: spent.token } }),
    ).rejects.toThrow(/not valid for this wallet/);
    expect(store.rows()[0]!.removedAt).toBeNull();
  });

  it("lets two callers race one token and exactly one win", async () => {
    const store = walletStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({ context, input: { name: "burner", secret: KEY } });
    const { token } = (await api.requestRemove!({ context, input: { walletId: "w1" } })) as {
      token: string;
    };

    const results = await Promise.allSettled([
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
      api.remove!({ context, input: { walletId: "w1", confirmationToken: token } }),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(recorded.filter((event) => event.type === "wallet.removed")).toHaveLength(1);
  });
});
