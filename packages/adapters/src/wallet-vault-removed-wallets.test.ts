import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createWalletKeyEnvelope, openWalletKeyWithPassword } from "./wallet-envelope.js";
import { createVaultSqlShim } from "./wallet-vault-fake.js";
import { changeWalletVaultPassword, setupWalletVaultPassword } from "./wallet-vault-impl.js";

// W-1 (the password change re-wraps every migrated key envelope) meets W-2 (a
// removed wallet keeps its key so it can be restored). Neither item's own tests
// could see this case: W-1 predates the `removedAt` column, and W-2 does not
// touch the re-wrap. If the re-wrap skipped removed wallets, restoring one after
// a password change would hand the owner a wallet sealed under the old password
// — and restore itself would report success.

const PASSWORD = "test-vault-password-one";
const NEW_PASSWORD = "test-vault-password-two";
const PRIVATE_KEY = Buffer.from("ab".repeat(32), "hex");

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

type WalletRow = {
  id: string;
  userId: string;
  name: string;
  secretCipher: string;
  keyCiphertext: string | null;
  passwordWrap: string | null;
  migrationStatus: string;
  removedAt: Date | null;
};

/** The vault and wallet tables in memory, with the transaction Prisma would run. */
function vaultStore() {
  const vaultRows = new Map<string, VaultRow>();
  const wallets = new Map<string, WalletRow>();
  const apply = (row: VaultRow, data: Record<string, unknown>) => {
    const record = row as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        record[key] = (record[key] as number) + (value as { increment: number }).increment;
      } else {
        record[key] = value;
      }
    }
    return row;
  };
  const matches = (row: VaultRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === "OR") {
        return (condition as Array<Record<string, unknown>>).some((sub) => matches(row, sub));
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
  const client = {
    walletVault: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const row = vaultRows.get(where.userId);
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: VaultRow }) => {
        vaultRows.set(data.userId, { ...data });
        return { ...data };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
          const row = vaultRows.get(where.userId)!;
          apply(row, data);
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
          let count = 0;
          for (const row of vaultRows.values()) {
            if (matches(row, where)) {
              apply(row, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
    userWallet: {
      // The shape `rewrapUserWalletEnvelopes` asks for. `removedAt` is honoured
      // so a future "skip removed wallets" change is observable here instead of
      // passing silently.
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const out: WalletRow[] = [];
        for (const row of wallets.values()) {
          if (where.userId !== undefined && row.userId !== where.userId) continue;
          if (
            where.migrationStatus !== undefined &&
            row.migrationStatus !== where.migrationStatus
          ) {
            continue;
          }
          const wrap = where.passwordWrap as { not?: unknown } | undefined;
          if (wrap?.not === null && row.passwordWrap === null) continue;
          if (where.removedAt === null && row.removedAt !== null) continue;
          if (where.removedAt !== undefined && where.removedAt !== null && row.removedAt === null) {
            continue;
          }
          out.push({ ...row });
        }
        return out;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<WalletRow> }) => {
          const row = wallets.get(where.id);
          if (!row) throw new Error(`no wallet ${where.id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    ...createVaultSqlShim(vaultRows),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const vaultSnapshot = [...vaultRows.entries()].map(
        ([key, value]) => [key, structuredClone(value)] as const,
      );
      const walletSnapshot = [...wallets.entries()].map(
        ([key, value]) => [key, structuredClone(value)] as const,
      );
      try {
        return await fn(client);
      } catch (error) {
        vaultRows.clear();
        for (const [key, value] of vaultSnapshot) vaultRows.set(key, value as VaultRow);
        wallets.clear();
        for (const [key, value] of walletSnapshot) wallets.set(key, value as WalletRow);
        throw error;
      }
    }),
  };
  return { prisma: client as unknown as PrismaClient, vaultRows, wallets };
}

async function addMigratedWallet(
  store: ReturnType<typeof vaultStore>,
  walletId: string,
  password: string,
  removed: boolean,
) {
  const envelope = await createWalletKeyEnvelope({
    walletId,
    privateKey: PRIVATE_KEY,
    password,
  });
  store.wallets.set(walletId, {
    id: walletId,
    userId: "u1",
    name: removed ? `removed:${walletId}` : walletId,
    secretCipher: "",
    keyCiphertext: envelope.keyCiphertext,
    passwordWrap: envelope.passwordWrap,
    migrationStatus: "password_protected",
    removedAt: removed ? new Date("2026-11-10T00:00:00Z") : null,
  });
}

function envelopeOf(store: ReturnType<typeof vaultStore>, walletId: string) {
  const row = store.wallets.get(walletId)!;
  return { keyCiphertext: row.keyCiphertext!, passwordWrap: row.passwordWrap! };
}

describe("W-1 meets W-2: a removed wallet is still re-wrapped by a password change", () => {
  it("re-wraps a removed wallet, so restoring it after a password change still opens", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await addMigratedWallet(store, "clivewallet0000000000000a", PASSWORD, false);
    await addMigratedWallet(store, "cgonewallet0000000000000b", PASSWORD, true);

    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    // The removed wallet's key opens with the new password...
    const opened = await openWalletKeyWithPassword({
      walletId: "cgonewallet0000000000000b",
      envelope: envelopeOf(store, "cgonewallet0000000000000b"),
      password: NEW_PASSWORD,
    });
    expect(opened.equals(PRIVATE_KEY)).toBe(true);
    // ...and no longer with the old one, so the re-wrap really happened.
    await expect(
      openWalletKeyWithPassword({
        walletId: "cgonewallet0000000000000b",
        envelope: envelopeOf(store, "cgonewallet0000000000000b"),
        password: PASSWORD,
      }),
    ).rejects.toThrow();
    // The live wallet was re-wrapped too — the change is not selective.
    const liveOpened = await openWalletKeyWithPassword({
      walletId: "clivewallet0000000000000a",
      envelope: envelopeOf(store, "clivewallet0000000000000a"),
      password: NEW_PASSWORD,
    });
    expect(liveOpened.equals(PRIVATE_KEY)).toBe(true);
  });

  it("still refuses the old password after a change, whatever wallets are archived", async () => {
    // The typed refusal the acceptance test asks for: after a password change a
    // migrated wallet cannot be typed into a page at all, removed or not, and the
    // reason is the migration state rather than a missing row.
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await addMigratedWallet(store, "cgonewallet0000000000000b", PASSWORD, true);

    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    // A removed wallet keeps its migration state, which is what makes the fill
    // path refuse with `wallet_password_protected` rather than `wallet_not_found`.
    expect(store.wallets.get("cgonewallet0000000000000b")!.migrationStatus).toBe(
      "password_protected",
    );
    expect(store.wallets.get("cgonewallet0000000000000b")!.removedAt).not.toBeNull();
  });
});
