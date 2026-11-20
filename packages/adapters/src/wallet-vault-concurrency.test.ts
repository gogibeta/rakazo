import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createVaultSqlShim } from "./wallet-vault-fake.js";
import {
  changeWalletVaultPassword,
  verifyWalletVaultPassword,
  WALLET_VAULT_LOCKOUT_MS,
  WALLET_VAULT_MAX_FAILED_ATTEMPTS,
  WalletVaultPasswordError,
} from "./wallet-vault-impl.js";

// Dummy passwords for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";
const NEW_PASSWORD = "test-vault-password-two";
const WRONG = "test-vault-password-wrong";
const NOW = new Date("2026-09-01T00:00:00.000Z");

/**
 * Password verification under the test's control: every call parks until
 * the test resolves it, so concurrent attempts interleave exactly where
 * the test wants them — after every caller has read the vault row and
 * before any of them writes.
 */
const pendingVerifications = vi.hoisted(() => ({
  calls: [] as Array<{ password: string; resolve: (ok: boolean) => void }>,
}));

vi.mock("./wallet-envelope.js", () => ({
  verifyPassword: vi.fn(
    (_verifier: string, password: string) =>
      new Promise<boolean>((resolve) => {
        pendingVerifications.calls.push({ password, resolve });
      }),
  ),
  createPasswordVerifier: vi.fn(
    async (password: string) => `pw-v1:test-verifier-for-${password.length}-chars`,
  ),
}));

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

/** The vault table in memory; each write applies atomically, as Prisma's would. */
function vaultStore() {
  const rows = new Map<string, VaultRow>();
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
        const row = rows.get(where.userId);
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: VaultRow }) => {
        rows.set(data.userId, { ...data });
        return { ...data };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
          const row = rows.get(where.userId)!;
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
          for (const row of rows.values()) {
            if (matches(row, where)) {
              apply(row, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
    ...createVaultSqlShim(rows),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return { prisma: client as unknown as PrismaClient, rows };
}

function seedVault(
  store: ReturnType<typeof vaultStore>,
  overrides: Partial<VaultRow> = {},
): VaultRow {
  const row: VaultRow = {
    userId: "u1",
    verifier: "pw-v1:test-verifier",
    verifierVersion: 1,
    passwordEpoch: 1,
    configuredAt: NOW,
    changedAt: NOW,
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
  store.rows.set("u1", row);
  return row;
}

/** Wait until `count` password checks are parked, then hand them to the test. */
async function parkedVerifications(count: number) {
  await vi.waitFor(() => expect(pendingVerifications.calls).toHaveLength(count));
  return pendingVerifications.calls.splice(0, count);
}

describe("wallet vault throttle under concurrency", () => {
  it("loses none of N concurrent wrong attempts, and the lockout engages exactly at the threshold", async () => {
    const store = vaultStore();
    seedVault(store);
    const total = WALLET_VAULT_MAX_FAILED_ATTEMPTS;

    // One short of the threshold, all at once: every failure lands, no lockout yet.
    const firstWave = Array.from({ length: total - 1 }, () =>
      verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: NOW }).catch(
        (caught: unknown) => caught,
      ),
    );
    for (const call of await parkedVerifications(total - 1)) call.resolve(false);
    for (const outcome of await Promise.all(firstWave)) {
      expect(outcome).toBeInstanceOf(WalletVaultPasswordError);
    }
    expect(store.rows.get("u1")!.failedAttempts).toBe(total - 1);
    expect(store.rows.get("u1")!.lockedUntil).toBeNull();

    // The next failure is the threshold: the lockout engages with it.
    const last = verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: NOW }).catch(
      (caught: unknown) => caught,
    );
    for (const call of await parkedVerifications(1)) call.resolve(false);
    expect(await last).toBeInstanceOf(WalletVaultPasswordError);
    expect(store.rows.get("u1")!.failedAttempts).toBe(total);
    expect(store.rows.get("u1")!.lockedUntil).toEqual(
      new Date(NOW.getTime() + WALLET_VAULT_LOCKOUT_MS),
    );
  });

  it("a successful verification never erases a failure recorded concurrently", async () => {
    const store = vaultStore();
    seedVault(store, { failedAttempts: 2 });

    const success = verifyWalletVaultPassword(store.prisma, "u1", PASSWORD, { now: NOW });
    const failure = verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: NOW }).catch(
      (caught: unknown) => caught,
    );
    const [successCall, failureCall] = await parkedVerifications(2);
    expect(successCall!.password).toBe(PASSWORD);
    expect(failureCall!.password).toBe(WRONG);
    // The failure lands first; the success resolves after it.
    failureCall!.resolve(false);
    expect(await failure).toBeInstanceOf(WalletVaultPasswordError);
    successCall!.resolve(true);
    expect(await success).toEqual({ passwordEpoch: 1 });
    // The success did not reset the counter over the concurrent failure.
    expect(store.rows.get("u1")!.failedAttempts).toBe(3);
    expect(store.rows.get("u1")!.lockedUntil).toBeNull();
  });

  it("a password change uses the same atomic transition: epoch and verifier move, a concurrent failure survives", async () => {
    const store = vaultStore();
    seedVault(store, { failedAttempts: 1 });

    const change = changeWalletVaultPassword(
      store.prisma,
      "u1",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { now: NOW },
    );
    const failure = verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: NOW }).catch(
      (caught: unknown) => caught,
    );
    const [changeCall, failureCall] = await parkedVerifications(2);
    expect(changeCall!.password).toBe(PASSWORD);
    failureCall!.resolve(false);
    expect(await failure).toBeInstanceOf(WalletVaultPasswordError);
    changeCall!.resolve(true);
    expect(await change).toEqual({ configured: true, changedAt: NOW.toISOString() });

    const row = store.rows.get("u1")!;
    expect(row.passwordEpoch).toBe(2);
    expect(row.verifier).toBe(`pw-v1:test-verifier-for-${NEW_PASSWORD.length}-chars`);
    // The change did not reset the throttle over the concurrent failure.
    expect(row.failedAttempts).toBe(2);
  });
});
