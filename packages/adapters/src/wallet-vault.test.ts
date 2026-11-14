import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { verifyPassword } from "./wallet-envelope.js";
import {
  changeWalletVaultPassword,
  setupWalletVaultPassword,
  WALLET_VAULT_LOCKOUT_MS,
  WALLET_VAULT_MAX_FAILED_ATTEMPTS,
  WalletVaultAlreadyConfiguredError,
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
      } else {
        record[key] = value;
      }
    }
    return row;
  };
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
    },
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
