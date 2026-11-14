import type { PrismaClient } from "@rakazo/db";
import { createPasswordVerifier, verifyPassword } from "./wallet-envelope.js";

/**
 * The wallet-vault password state: setup and change of the dedicated wallet
 * password, backed by the `wallet_vaults` row. Only the verifier is stored —
 * a scrypt hash with its own salt, never the password and never a key — plus
 * the epoch that revokes unlock grants when it moves and the counters that
 * throttle password attempts.
 *
 * Unlock grants themselves never live here or anywhere in the database; they
 * are an in-memory capability of the vault service. This module owns only the
 * durable password lifecycle:
 *
 * - Setup runs once, only while no password exists.
 * - Change always requires the current password, even while the vault is
 *   unlocked, and moves `passwordEpoch` (revoking every grant minted under
 *   the old password) in the same transaction as the verifier swap.
 * - A wrong current password is counted; enough in a row lock further
 *   attempts for a bounded time, during which even the right password is
 *   refused. Every rejection answers with the same generic error, so the
 *   response never says which check failed.
 *
 * Nothing here logs, and no error, result, or audit callback ever carries a
 * password or a verifier.
 */

/** Consecutive wrong passwords that trigger the lockout. */
export const WALLET_VAULT_MAX_FAILED_ATTEMPTS = 5;
/** How long password attempts stay locked after too many failures. */
export const WALLET_VAULT_LOCKOUT_MS = 15 * 60 * 1_000;

const NOT_CONFIGURED = "No wallet password is set yet.";
const GENERIC_REJECTION = "The wallet password could not be verified.";

/** The one failure every password rejection shares, whatever check failed. */
export class WalletVaultPasswordError extends Error {
  constructor() {
    super(GENERIC_REJECTION);
    this.name = "WalletVaultPasswordError";
  }
}

/** Setup was attempted when a wallet password already exists. */
export class WalletVaultAlreadyConfiguredError extends Error {
  constructor() {
    super("A wallet password is already set. Change it instead.");
    this.name = "WalletVaultAlreadyConfiguredError";
  }
}

/** Vault password state safe to show the owner: never the verifier. */
export type WalletVaultStatus = {
  configured: boolean;
  /** When the password was last set or changed; null while unconfigured. */
  changedAt: string | null;
};

type VaultRow = {
  verifier: string;
  passwordEpoch: number;
  configuredAt: Date;
  changedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
};

/** What the settings surface may know about a person's vault. */
export async function walletVaultStatus(
  prisma: PrismaClient,
  userId: string,
): Promise<WalletVaultStatus> {
  const row = await prisma.walletVault.findUnique({
    where: { userId },
    select: { changedAt: true },
  });
  return { configured: row !== null, changedAt: row?.changedAt.toISOString() ?? null };
}

/**
 * Set the wallet password for the first time. Only the verifier is stored.
 * Fails when a password already exists — changing is a separate, verified act.
 */
export async function setupWalletVaultPassword(
  prisma: PrismaClient,
  userId: string,
  password: string,
): Promise<WalletVaultStatus> {
  const existing = await prisma.walletVault.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) throw new WalletVaultAlreadyConfiguredError();
  const verifier = await createPasswordVerifier(password);
  const now = new Date();
  const row = await prisma.walletVault.create({
    data: {
      userId,
      verifier,
      verifierVersion: 1,
      passwordEpoch: 1,
      configuredAt: now,
      changedAt: now,
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  return { configured: true, changedAt: row.changedAt.toISOString() };
}

/**
 * Change the wallet password. The current password is always required — an
 * active unlock grant is not proof of knowing it. On success the epoch moves
 * (revoking grants minted under the old password) in the same transaction
 * that swaps the verifier, and the throttle counters reset.
 *
 * `onRejected` fires after a rejection has been recorded, with counts only,
 * so the caller can audit the attempt; it never receives a password.
 */
export async function changeWalletVaultPassword(
  prisma: PrismaClient,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  hooks?: {
    onRejected?: (info: { failedAttempts: number; lockedUntil: Date | null }) => Promise<void>;
    now?: Date;
  },
): Promise<WalletVaultStatus> {
  const row = await prisma.walletVault.findUnique({ where: { userId } });
  if (!row) throw new Error(NOT_CONFIGURED);
  const vault = row as VaultRow;
  const now = hooks?.now ?? new Date();

  const reject = async (): Promise<never> => {
    const failedAttempts = vault.failedAttempts + 1;
    const lockedUntil =
      failedAttempts >= WALLET_VAULT_MAX_FAILED_ATTEMPTS
        ? new Date(now.getTime() + WALLET_VAULT_LOCKOUT_MS)
        : vault.lockedUntil;
    await prisma.walletVault.update({
      where: { userId },
      data: { failedAttempts, lockedUntil },
    });
    await hooks?.onRejected?.({ failedAttempts, lockedUntil });
    throw new WalletVaultPasswordError();
  };

  // While locked out, even the right password is refused, and the attempt
  // is not counted again — the lockout simply runs its course.
  if (vault.lockedUntil && vault.lockedUntil > now) throw new WalletVaultPasswordError();
  if (!(await verifyPassword(vault.verifier, input.currentPassword))) return reject();

  const verifier = await createPasswordVerifier(input.newPassword);
  const updated = await prisma.$transaction(async (tx) => {
    // Revoke first: moving the epoch retires every grant minted under the
    // old password before the new verifier exists.
    await tx.walletVault.update({
      where: { userId },
      data: { passwordEpoch: { increment: 1 } },
    });
    return tx.walletVault.update({
      where: { userId },
      data: { verifier, changedAt: now, failedAttempts: 0, lockedUntil: null },
    });
  });
  return { configured: true, changedAt: updated.changedAt.toISOString() };
}
