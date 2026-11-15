import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { verifyPassword } from "./wallet-envelope.js";
import {
  changeWalletVaultPassword,
  setupWalletVaultPassword,
  verifyWalletVaultPassword,
  WALLET_VAULT_LOCKOUT_MS,
  WALLET_VAULT_MAX_FAILED_ATTEMPTS,
  WalletVaultAlreadyConfiguredError,
  WalletVaultNotConfiguredError,
  WalletVaultPasswordError,
  walletVaultStatus,
} from "./wallet-vault-impl.js";

// Dummy passwords for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";
const NEW_PASSWORD = "test-vault-password-two";
const WRONG = "test-vault-password-wrong";

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

/** The vault table in memory, with the transaction Prisma would run. */
function vaultStore() {
  const rows = new Map<string, VaultRow>();
  const apply = (row: VaultRow, data: Record<string, unknown>) => {
    const record = row as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        record[key] = (record[key] as number) + (value as { increment: number }).increment;
      } else if (value && typeof value === "object" && "decrement" in value) {
        // A success gives back exactly the slot it reserved.
        record[key] = (record[key] as number) - (value as { decrement: number }).decrement;
      } else {
        record[key] = value;
      }
    }
    return row;
  };
  /** The where shapes the password state uses: equality, null, `lte`, and OR groups. */
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
        const ops = condition as { lte?: Date; gt?: number; gte?: number };
        if (ops.lte !== undefined) return value instanceof Date && value <= ops.lte;
        if (ops.gt !== undefined) return typeof value === "number" && value > ops.gt;
        if (ops.gte !== undefined) return typeof value === "number" && value >= ops.gte;
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
    /**
     * The throttle's reservation, as the real conditional UPDATE behaves: one
     * statement that claims a slot only while the row is unlocked and under the
     * limit, and sets the lockout in the same write when the claim reaches it.
     * Modelling it faithfully is what lets a concurrency test mean anything —
     * a read-then-write fake would reproduce the very race under test.
     */
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // The binds, in the statement's order: now, now, limit, lockoutAt, userId, now, limit.
      const [now, , limit, lockoutAt, userId] = values as [Date, Date, number, Date, string];
      const row = rows.get(userId);
      if (!row) return [];
      const lockedOut = row.lockedUntil !== null && row.lockedUntil > now;
      const overLimit = row.lockedUntil === null && row.failedAttempts >= limit;
      if (lockedOut || overLimit) return [];
      // An expired lockout opens a fresh window: the counter restarts at 1.
      row.failedAttempts = row.lockedUntil !== null ? 1 : row.failedAttempts + 1;
      if (row.lockedUntil !== null) row.lockedUntil = null;
      else if (row.failedAttempts >= limit) row.lockedUntil = lockoutAt;
      return [{ failedAttempts: row.failedAttempts, lockedUntil: row.lockedUntil }];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return { prisma: client as unknown as PrismaClient, rows };
}

describe("wallet vault password state", () => {
  it("reports unconfigured before setup and stores only a verifier on setup", async () => {
    const store = vaultStore();
    expect(await walletVaultStatus(store.prisma, "u1")).toEqual({
      configured: false,
      changedAt: null,
    });

    const status = await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    expect(status.configured).toBe(true);
    expect(status.changedAt).not.toBeNull();

    const row = store.rows.get("u1")!;
    expect(row.verifier.startsWith("pw-v1:")).toBe(true);
    expect(row.passwordEpoch).toBe(1);
    // The stored row can be shown anywhere: it holds no password.
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(await verifyPassword(row.verifier, PASSWORD)).toBe(true);
    expect(await verifyPassword(row.verifier, WRONG)).toBe(false);
  });

  it("refuses a second setup — changing is a separate, verified act", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await expect(setupWalletVaultPassword(store.prisma, "u1", NEW_PASSWORD)).rejects.toThrow(
      WalletVaultAlreadyConfiguredError,
    );
    // The original password still stands.
    expect(await verifyPassword(store.rows.get("u1")!.verifier, PASSWORD)).toBe(true);
  });

  // Password derivations are deliberately expensive; these cases chain several.
  it("changes the password only with the current one, moving the epoch and resetting the throttle", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const onRejected = vi.fn(async () => undefined);
    await expect(
      changeWalletVaultPassword(
        store.prisma,
        "u1",
        { currentPassword: WRONG, newPassword: NEW_PASSWORD },
        { onRejected },
      ),
    ).rejects.toThrow(WalletVaultPasswordError);
    expect(store.rows.get("u1")!.failedAttempts).toBe(1);
    expect(onRejected).toHaveBeenCalledWith({ failedAttempts: 1, lockedUntil: null });
    // The audit hook hears counts only — never a password.
    expect(JSON.stringify(onRejected.mock.calls)).not.toContain(WRONG);
    expect(JSON.stringify(onRejected.mock.calls)).not.toContain(NEW_PASSWORD);

    const status = await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const row = store.rows.get("u1")!;
    expect(status.configured).toBe(true);
    expect(row.passwordEpoch).toBe(2);
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(await verifyPassword(row.verifier, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row.verifier, PASSWORD)).toBe(false);

    // The old password no longer changes anything; the new one does.
    await expect(
      changeWalletVaultPassword(store.prisma, "u1", {
        currentPassword: PASSWORD,
        newPassword: "test-vault-password-three",
      }),
    ).rejects.toThrow(WalletVaultPasswordError);
    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: NEW_PASSWORD,
      newPassword: "test-vault-password-three",
    });
    expect(store.rows.get("u1")!.passwordEpoch).toBe(3);
  }, 30_000);

  it("locks attempts after repeated failures, refuses even the right password, then recovers", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const start = new Date("2026-09-01T00:00:00.000Z");
    for (let attempt = 1; attempt <= WALLET_VAULT_MAX_FAILED_ATTEMPTS; attempt++) {
      await expect(
        changeWalletVaultPassword(
          store.prisma,
          "u1",
          { currentPassword: WRONG, newPassword: NEW_PASSWORD },
          { now: start },
        ),
      ).rejects.toThrow(WalletVaultPasswordError);
    }
    const locked = store.rows.get("u1")!;
    expect(locked.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).toEqual(new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS));

    // During the lockout the right password is refused too, with the same
    // generic error, and the attempt is not counted again.
    const error = await changeWalletVaultPassword(
      store.prisma,
      "u1",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { now: new Date(start.getTime() + 60_000) },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletVaultPasswordError);
    expect((error as Error).message).toBe("The wallet password could not be verified.");
    expect(store.rows.get("u1")!.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);

    // Once the lockout has run its course, the right password works again.
    const after = new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS + 1_000);
    await changeWalletVaultPassword(
      store.prisma,
      "u1",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { now: after },
    );
    expect(store.rows.get("u1")!.failedAttempts).toBe(0);
    expect(store.rows.get("u1")!.lockedUntil).toBeNull();
  }, 30_000);

  it("cannot change a password that was never set, and never leaks a password in errors", async () => {
    const store = vaultStore();
    const error = await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect((error as Error).message).not.toContain(NEW_PASSWORD);
  });

  it("keeps each person's vault apart", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    expect(await walletVaultStatus(store.prisma, "u2")).toEqual({
      configured: false,
      changedAt: null,
    });
    await expect(
      changeWalletVaultPassword(store.prisma, "u2", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toThrow("No wallet password is set yet.");
  });
});

describe("wallet vault unlock verification", () => {
  it("refuses before setup with the not-configured error", async () => {
    const store = vaultStore();
    await expect(verifyWalletVaultPassword(store.prisma, "u1", PASSWORD)).rejects.toThrow(
      WalletVaultNotConfiguredError,
    );
  });

  it("verifies the right password, returns the epoch, and resets the throttle", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await expect(verifyWalletVaultPassword(store.prisma, "u1", WRONG)).rejects.toThrow(
      WalletVaultPasswordError,
    );
    expect(store.rows.get("u1")!.failedAttempts).toBe(1);

    expect(await verifyWalletVaultPassword(store.prisma, "u1", PASSWORD)).toEqual({
      passwordEpoch: 1,
    });
    expect(store.rows.get("u1")!.failedAttempts).toBe(0);
    expect(store.rows.get("u1")!.lockedUntil).toBeNull();
  }, 30_000);

  it("counts wrong unlock attempts toward the same lockout as password changes", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const start = new Date("2026-09-01T00:00:00.000Z");
    const onRejected = vi.fn(async () => undefined);
    for (let attempt = 1; attempt <= WALLET_VAULT_MAX_FAILED_ATTEMPTS; attempt++) {
      await expect(
        verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: start, onRejected }),
      ).rejects.toThrow(WalletVaultPasswordError);
    }
    const locked = store.rows.get("u1")!;
    expect(locked.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).toEqual(new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS));
    expect(onRejected).toHaveBeenLastCalledWith({
      failedAttempts: WALLET_VAULT_MAX_FAILED_ATTEMPTS,
      lockedUntil: new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS),
    });
    // The audit hook hears counts only — never a password.
    expect(JSON.stringify(onRejected.mock.calls)).not.toContain(WRONG);

    // During the lockout even the right password is refused, uncounted, and
    // a password change draws on the same lockout.
    await expect(
      verifyWalletVaultPassword(store.prisma, "u1", PASSWORD, {
        now: new Date(start.getTime() + 60_000),
      }),
    ).rejects.toThrow(WalletVaultPasswordError);
    await expect(
      changeWalletVaultPassword(
        store.prisma,
        "u1",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { now: new Date(start.getTime() + 60_000) },
      ),
    ).rejects.toThrow(WalletVaultPasswordError);
    expect(store.rows.get("u1")!.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);

    // Once the lockout runs its course, the right password verifies again.
    const after = new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS + 1_000);
    expect(await verifyWalletVaultPassword(store.prisma, "u1", PASSWORD, { now: after })).toEqual({
      passwordEpoch: 1,
    });
    expect(store.rows.get("u1")!.failedAttempts).toBe(0);
  }, 30_000);

  it("cannot exceed the attempt limit under N concurrent guesses", async () => {
    // The bug this replaces: the lockout was checked before ~300ms of scrypt and
    // recorded only afterwards, so N parallel guesses all passed the stale check
    // and all ran a derivation. Reserving the slot in one conditional statement
    // BEFORE the work is what closes that window — so this test starts its
    // attempts together and counts how many ever reached a verification.
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const start = new Date("2026-09-01T00:00:00.000Z");

    // A derivation counter on the real verifier path would be ideal, but the
    // service calls the envelope helper directly; what matters is what the row
    // records and how many callers were let through. Every caller that gets past
    // the reservation pays for a derivation, so the row's counter is the number
    // of derivations the throttle allowed.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: start }),
      ),
    );

    // Every call refused: the password is wrong, and past the limit the throttle
    // refuses before verifying.
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletVaultPasswordError);
    }
    // And the counter never passes the limit, however many arrived at once.
    const row = store.rows.get("u1")!;
    expect(row.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(row.failedAttempts).toBeLessThanOrEqual(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    // The lockout is set, so a later attempt is refused without any work.
    expect(row.lockedUntil).toEqual(new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS));
  }, 60_000);

  it("counts no more than the limit across concurrent password changes too", async () => {
    // The same throttle guards password change, so the same reservation must hold
    // there: N concurrent changes with the wrong current password claim at most
    // the allowed slots.
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const start = new Date("2026-09-01T00:00:00.000Z");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        changeWalletVaultPassword(
          store.prisma,
          "u1",
          { currentPassword: WRONG, newPassword: NEW_PASSWORD },
          { now: start },
        ),
      ),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const row = store.rows.get("u1")!;
    expect(row.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    // The verifier was never swapped by a refused change.
    expect(row.passwordEpoch).toBe(1);
  }, 60_000);

  it("opens a fresh attempt window after the lockout expires, rather than staying locked", async () => {
    // An expired lockout must not read as "still over the limit": that would make
    // the lockout permanent, which is worse than the race it replaced.
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const start = new Date("2026-09-01T00:00:00.000Z");
    for (let attempt = 1; attempt <= WALLET_VAULT_MAX_FAILED_ATTEMPTS; attempt++) {
      await expect(
        verifyWalletVaultPassword(store.prisma, "u1", WRONG, { now: start }),
      ).rejects.toThrow(WalletVaultPasswordError);
    }
    expect(store.rows.get("u1")!.lockedUntil).not.toBeNull();

    // The right password after the lockout expires verifies, and costs one slot
    // before its success gives it back.
    const after = new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS + 1_000);
    await expect(
      verifyWalletVaultPassword(store.prisma, "u1", PASSWORD, { now: after }),
    ).resolves.toEqual({ passwordEpoch: 1 });
    expect(store.rows.get("u1")!.failedAttempts).toBe(0);
    expect(store.rows.get("u1")!.lockedUntil).toBeNull();

    // And a fresh window means a fresh budget: one wrong attempt now counts 1,
    // not 6.
    await expect(
      verifyWalletVaultPassword(store.prisma, "u1", WRONG, {
        now: new Date(after.getTime() + 1_000),
      }),
    ).rejects.toThrow(WalletVaultPasswordError);
    expect(store.rows.get("u1")!.failedAttempts).toBe(1);
  }, 30_000);
});
