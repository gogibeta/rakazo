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
 * - Unlock verification draws on the same counters: failures here count
 *   toward the same lockout, and a lockout earned elsewhere refuses here.
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

/** A password was verified for a person who has not set one yet. */
export class WalletVaultNotConfiguredError extends Error {
  constructor() {
    super(NOT_CONFIGURED);
    this.name = "WalletVaultNotConfiguredError";
  }
}

/**
 * The outcome of reserving one password attempt, taken BEFORE any scrypt work.
 *
 * `locked` means the reservation was refused: the row is locked out, or the
 * attempt would exceed the limit, so no derivation runs at all.
 */
type AttemptReservation =
  | {
      locked: false;
      /** The counter value this reservation claimed. */
      attempted: number;
      /** True when this reservation is the one that set the lockout. */
      setLockout: boolean;
      lockedUntil: Date | null;
    }
  | { locked: true; failedAttempts: number; lockedUntil: Date | null };

/**
 * Reserve one password attempt atomically, BEFORE any password is verified.
 *
 * This is the whole throttle. Reading `lockedUntil`, spending ~300ms in scrypt,
 * and only then recording the failure let N concurrent wrong guesses all pass
 * the stale check before any of them counted: the lockout was enforced after
 * the expensive part, which is exactly the window an attacker parallelises.
 *
 * The reservation is ONE conditional statement: increment the counter only
 * while the row is not locked out and the counter is still under the limit.
 * Postgres serialises the row, so of N concurrent callers exactly the allowed
 * number match, and the rest see zero rows and are refused before any scrypt
 * runs. The statement that brings the count to the limit also sets the
 * lockout, in the same statement, so the window does not exist at all.
 *
 * Because an attempt is reserved before it is verified, a SUCCESSFUL
 * verification must give its reservation back (see the counters reset in
 * `verifyWalletVaultPassword` / `changeWalletVaultPassword`). A request that
 * dies mid-verification leaves its reservation spent, which fails closed: at
 * worst a legitimate attempt costs one slot in a five-attempt budget.
 */
async function reservePasswordAttempt(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<AttemptReservation> {
  const lockoutAt = new Date(now.getTime() + WALLET_VAULT_LOCKOUT_MS);
  // One statement covering both windows:
  //
  // - No lockout, counter under the limit: claim the next slot, and set the
  //   lockout in the same write when this claim reaches the limit.
  // - A lockout that has run its course: this attempt opens a fresh window, so
  //   the counter restarts at 1 rather than staying pinned at the limit. Treating
  //   an expired lockout as "still over the limit" would lock the account forever.
  //
  // Every column reference in SET is the OLD row, as PostgreSQL defines it for the
  // target table, so each CASE compares and increments the pre-statement value.
  const claimed = await prisma.$queryRaw<
    Array<{ failedAttempts: number; lockedUntil: Date | null }>
  >`
    UPDATE "wallet_vaults"
    SET "failedAttempts" =
          CASE WHEN "lockedUntil" <= ${now} THEN 1 ELSE "failedAttempts" + 1 END,
        "lockedUntil" =
          CASE
            WHEN "lockedUntil" <= ${now} THEN NULL
            WHEN "failedAttempts" + 1 >= ${WALLET_VAULT_MAX_FAILED_ATTEMPTS}
              THEN ${lockoutAt}::timestamptz
            ELSE "lockedUntil"
          END
    WHERE "userId" = ${userId}
      AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
      AND ("lockedUntil" IS NOT NULL OR "failedAttempts" < ${WALLET_VAULT_MAX_FAILED_ATTEMPTS})
    RETURNING "failedAttempts", "lockedUntil"`;

  const row = claimed[0];
  if (!row) {
    // Refused. Read the counters so the caller's audit hears the real state
    // rather than a guess; this is the rare path, not the hot one.
    const current = (await prisma.walletVault.findUnique({ where: { userId } })) as VaultRow | null;
    return {
      locked: true,
      failedAttempts: current?.failedAttempts ?? WALLET_VAULT_MAX_FAILED_ATTEMPTS,
      lockedUntil: current?.lockedUntil ?? null,
    };
  }
  const setLockout =
    row.lockedUntil !== null && Math.abs(row.lockedUntil.getTime() - lockoutAt.getTime()) < 1;
  return {
    locked: false,
    // The counter AFTER this claim: what the row holds right now, and what the
    // conditional give-back and reset must match to know nobody else moved it.
    attempted: row.failedAttempts,
    setLockout,
    lockedUntil: row.lockedUntil,
  };
}

/**
 * Count one failed password attempt that was already reserved. The counter moved
 * when the attempt was reserved, so this reports what that reservation recorded
 * rather than a second read that other attempts may have moved on.
 */
function failedAttemptOutcome(reservation: AttemptReservation): {
  failedAttempts: number;
  lockedUntil: Date | null;
} {
  if (reservation.locked) {
    return { failedAttempts: reservation.failedAttempts, lockedUntil: reservation.lockedUntil };
  }
  return { failedAttempts: reservation.attempted, lockedUntil: reservation.lockedUntil };
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
 * that swaps the verifier, and the throttle counters reset — conditionally,
 * so a failure recorded concurrently with the change is never erased.
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

  // Reserve the attempt BEFORE the expensive verification. A caller who is
  // locked out, or whose attempt would exceed the limit, is refused here with no
  // scrypt work and no slot taken — and N concurrent callers can only ever claim
  // the slots the limit allows.
  const reservation = await reservePasswordAttempt(prisma, userId, now);
  const reject = async (): Promise<never> => {
    await hooks?.onRejected?.(failedAttemptOutcome(reservation));
    throw new WalletVaultPasswordError();
  };
  if (reservation.locked) throw new WalletVaultPasswordError();
  if (!(await verifyPassword(vault.verifier, input.currentPassword))) return reject();

  const verifier = await createPasswordVerifier(input.newPassword);
  await prisma.$transaction(async (tx) => {
    // Revoke first: moving the epoch retires every grant minted under the
    // old password before the new verifier exists.
    await tx.walletVault.update({
      where: { userId },
      data: { passwordEpoch: { increment: 1 } },
    });
    // Swap the verifier, give the reserved attempt back and clear any lockout —
    // conditionally, on the counters this change reserved. A failure recorded
    // concurrently moved them; the swap still lands but the reset must not erase it.
    const swapped = await tx.walletVault.updateMany({
      where: { userId, failedAttempts: reservation.attempted },
      data: { verifier, changedAt: now, failedAttempts: 0, lockedUntil: null },
    });
    if (swapped.count === 0) {
      await tx.walletVault.update({
        where: { userId },
        data: { verifier, changedAt: now },
      });
    }
  });
  return { configured: true, changedAt: now.toISOString() };
}

/**
 * Verify a wallet password for a vault unlock. This is the vault service's
 * one password check, and it shares the throttle with password change:
 * attempts draw on the same counters, so failures here count toward the
 * same lockout and a lockout earned elsewhere refuses here too. On success
 * the counters reset — conditionally, so a failure recorded concurrently
 * is never erased by the success that raced it — and the current
 * `passwordEpoch` comes back: the epoch is what the vault mints the new
 * grant under. Every rejection is the same generic error, and `onRejected`
 * hears counts only, never a password.
 */
export async function verifyWalletVaultPassword(
  prisma: PrismaClient,
  userId: string,
  password: string,
  hooks?: {
    onRejected?: (info: { failedAttempts: number; lockedUntil: Date | null }) => Promise<void>;
    now?: Date;
  },
): Promise<{ passwordEpoch: number }> {
  const row = await prisma.walletVault.findUnique({ where: { userId } });
  if (!row) throw new WalletVaultNotConfiguredError();
  const vault = row as VaultRow;
  const now = hooks?.now ?? new Date();

  // Reserve the attempt BEFORE scrypt. Reading `lockedUntil`, spending the
  // derivation, and recording afterwards was the race: N parallel guesses all
  // passed the stale check before any of them counted. The reservation is one
  // conditional statement, so only the slots the limit allows are ever claimed,
  // and a caller who is locked out does no work at all.
  const reservation = await reservePasswordAttempt(prisma, userId, now);
  if (reservation.locked) throw new WalletVaultPasswordError();
  if (!(await verifyPassword(vault.verifier, password))) {
    await hooks?.onRejected?.(failedAttemptOutcome(reservation));
    throw new WalletVaultPasswordError();
  }

  // One conditional statement that both gives this attempt's slot back and clears
  // the throttle, written so a racing failure survives.
  //
  // `attempted` is the counter this attempt claimed. If the row still holds it,
  // nothing else moved the counter while this password was verifying, so the whole
  // throttle is cleared — the common case, and what "knowing the password clears
  // it" means. If the row has moved on, a failure landed meanwhile: only this
  // attempt's own slot is given back, and the other failure's count stands.
  const cleared = await prisma.walletVault.updateMany({
    where: { userId, failedAttempts: reservation.attempted },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  if (cleared.count === 0) {
    await prisma.walletVault.updateMany({
      where: { userId, failedAttempts: { gt: 0 } },
      data: { failedAttempts: { decrement: 1 } },
    });
  }
  return { passwordEpoch: vault.passwordEpoch };
}
