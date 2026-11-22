import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createWalletKeyEnvelope,
  openWalletKeyWithPassword,
  verifyPassword,
} from "./wallet-envelope.js";
import { createVaultSqlShim } from "./wallet-vault-fake.js";
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

/** A user wallet, as the password change sees it: envelope plus migration state. */
type UserWalletRow = {
  id: string;
  userId: string;
  name: string;
  secretCipher: string;
  keyCiphertext: string | null;
  passwordWrap: string | null;
  migrationStatus: string;
};

/** The vault table in memory, with the transaction Prisma would run. */
function vaultStore() {
  const rows = new Map<string, VaultRow>();
  const wallets = new Map<string, UserWalletRow>();
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
    userWallet: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const out: UserWalletRow[] = [];
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
          out.push({ ...row });
        }
        return out;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<UserWalletRow> }) => {
          const row = wallets.get(where.id);
          if (!row) throw new Error(`no wallet ${where.id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    ...createVaultSqlShim(rows),
    // A real transaction rolls back when the callback throws, so a change that
    // fails mid-re-wrap leaves no trace. Emulate that here by snapshotting deep
    // copies of both tables and restoring them if the callback rejects — the
    // snapshot must be a copy, since the model methods mutate rows in place.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const vaultSnapshot = [...rows.entries()].map(
        ([key, value]) => [key, structuredClone(value)] as const,
      );
      const walletSnapshot = [...wallets.entries()].map(
        ([key, value]) => [key, structuredClone(value)] as const,
      );
      try {
        return await fn(client);
      } catch (error) {
        rows.clear();
        for (const [key, value] of vaultSnapshot) rows.set(key, value as VaultRow);
        wallets.clear();
        for (const [key, value] of walletSnapshot) wallets.set(key, value as UserWalletRow);
        throw error;
      }
    }),
  };
  return { prisma: client as unknown as PrismaClient, rows, wallets, client };
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
  it("changes the password only with the current one, moving the epoch and refunding its charge", async () => {
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
    // The success refunds exactly its own charge: the earlier wrong attempt stays charged.
    expect(row.failedAttempts).toBe(1);
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

  it("verifies the right password, returns the epoch, and refunds its own charge", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await expect(verifyWalletVaultPassword(store.prisma, "u1", WRONG)).rejects.toThrow(
      WalletVaultPasswordError,
    );
    expect(store.rows.get("u1")!.failedAttempts).toBe(1);

    expect(await verifyWalletVaultPassword(store.prisma, "u1", PASSWORD)).toEqual({
      passwordEpoch: 1,
    });
    // The success refunds exactly its own charge: the earlier wrong attempt stays charged.
    expect(store.rows.get("u1")!.failedAttempts).toBe(1);
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
});

describe("wallet password change re-wraps every migrated wallet (W-1)", () => {
  const WALLET_A = "caaaaaaaaaaaaaaaaaaaaaaaa";
  const WALLET_B = "cbbbbbbbbbbbbbbbbbbbbbbbb";
  const WALLET_LEGACY = "ccccccccccccccccccccccccc";
  const PRIVATE_KEY = Buffer.from("ab".repeat(32), "hex");

  /** A wallet whose key is envelope-wrapped under `password`, in the fake store. */
  async function addMigratedWallet(
    store: ReturnType<typeof vaultStore>,
    walletId: string,
    password: string,
  ) {
    const envelope = await createWalletKeyEnvelope({
      walletId,
      privateKey: PRIVATE_KEY,
      password,
    });
    store.wallets.set(walletId, {
      id: walletId,
      userId: "u1",
      name: walletId,
      secretCipher: "",
      keyCiphertext: envelope.keyCiphertext,
      passwordWrap: envelope.passwordWrap,
      migrationStatus: "password_protected",
    });
  }

  function envelopeOf(store: ReturnType<typeof vaultStore>, walletId: string) {
    const row = store.wallets.get(walletId)!;
    return { keyCiphertext: row.keyCiphertext!, passwordWrap: row.passwordWrap! };
  }

  it("re-wraps every migrated wallet, so the new password opens them and the old does not", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await addMigratedWallet(store, WALLET_A, PASSWORD);
    await addMigratedWallet(store, WALLET_B, PASSWORD);

    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    for (const walletId of [WALLET_A, WALLET_B]) {
      const opened = await openWalletKeyWithPassword({
        walletId,
        envelope: envelopeOf(store, walletId),
        password: NEW_PASSWORD,
      });
      expect(opened.equals(PRIVATE_KEY)).toBe(true);
      await expect(
        openWalletKeyWithPassword({
          walletId,
          envelope: envelopeOf(store, walletId),
          password: PASSWORD,
        }),
      ).rejects.toThrow();
    }
  });

  it("leaves a wallet that was never migrated alone", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    store.wallets.set(WALLET_LEGACY, {
      id: WALLET_LEGACY,
      userId: "u1",
      name: "legacy",
      secretCipher: "sealed-server-copy",
      keyCiphertext: null,
      passwordWrap: null,
      migrationStatus: "legacy_server_only",
    });

    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const row = store.wallets.get(WALLET_LEGACY)!;
    expect(row.migrationStatus).toBe("legacy_server_only");
    expect(row.secretCipher).toBe("sealed-server-copy");
    expect(row.keyCiphertext).toBeNull();
    expect(row.passwordWrap).toBeNull();
  });

  it("rolls the whole change back when one envelope cannot be re-wrapped", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    await addMigratedWallet(store, WALLET_A, PASSWORD);
    await addMigratedWallet(store, WALLET_B, PASSWORD);
    const epochAfterSetup = store.rows.get("u1")!.passwordEpoch;
    // B's wrap was made under a different password, so the change cannot open it
    // with the current one. Failing closed strands nothing: the password keeps
    // working and the owner investigates, instead of losing B for good.
    const other = await createWalletKeyEnvelope({
      walletId: WALLET_B,
      privateKey: PRIVATE_KEY,
      password: "a-different-password",
    });
    store.wallets.get(WALLET_B)!.passwordWrap = other.passwordWrap;

    await expect(
      changeWalletVaultPassword(store.prisma, "u1", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toThrow();

    // Nothing moved: the old verifier is still in place, the epoch did not
    // advance, and the wallet that would have re-wrapped fine is as it started.
    const vaultRow = store.rows.get("u1")!;
    expect(vaultRow.passwordEpoch).toBe(epochAfterSetup);
    expect(await verifyPassword(vaultRow.verifier, PASSWORD)).toBe(true);
    const stillOld = await openWalletKeyWithPassword({
      walletId: WALLET_A,
      envelope: envelopeOf(store, WALLET_A),
      password: PASSWORD,
    });
    expect(stillOld.equals(PRIVATE_KEY)).toBe(true);
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_A,
        envelope: envelopeOf(store, WALLET_A),
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow();
  });

  it("still moves the epoch when there are no wallets to re-wrap", async () => {
    const store = vaultStore();
    await setupWalletVaultPassword(store.prisma, "u1", PASSWORD);
    const epochAfterSetup = store.rows.get("u1")!.passwordEpoch;

    await changeWalletVaultPassword(store.prisma, "u1", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(store.rows.get("u1")!.passwordEpoch).toBe(epochAfterSetup + 1);
  });
});
