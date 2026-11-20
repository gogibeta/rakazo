import type { Prisma, PrismaClient } from "@rakazo/db";
import { Prisma as PrismaSql } from "@rakazo/db";
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

/**
 * Wallet-vault password throttle, v8 reservation design (pr66-design.md).
 *
 * Every password attempt reserves a slot BEFORE verification runs, and settles that
 * reservation afterwards. A reservation is one row-locked conditional UPDATE that charges
 * `failedAttempts` and records the attempt's token in `pendingReservations`, tagged with the
 * `throttleGeneration` it was admitted in. Settlement removes exactly its own token: a success
 * in the current generation refunds its slot, a failure leaves the charge in place, and a
 * reservation from an expired window can do neither to the new window.
 *
 * This replaces the earlier counter-only scheme, where a success reset the counter and could
 * therefore erase failures that raced it — the A/B/C race the design fixes.
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
 * The state one reservation reads back, and what settlement needs to act on it.
 */
export interface WalletVaultReservation {
  token: string;
  credentialRevision: bigint;
  credentialMaterial: string;
  passwordEpoch: number;
}

/**
 * Reserve one password attempt against a vault row, before any verification runs.
 *
 * The whole transition is one `SELECT ... FOR UPDATE` plus one conditional `UPDATE`, so two
 * concurrent attempts serialize on the row: admission is `failedAttempts < LIMIT` after expiry
 * normalization, and the charge plus the pending token land together or not at all. A refused
 * attempt never reaches the verifier.
 *
 * Returns null when the vault is missing or the budget is exhausted — the caller must not
 * verify. The returned `credentialMaterial` is the snapshot this reservation must be checked
 * against, and `credentialRevision` is what a later password change compares.
 */
export async function reserveWalletVaultAttempt(
  prisma: PrismaClient,
  userId: string,
  at?: Date,
): Promise<WalletVaultReservation | null> {
  return prisma.$transaction(async (tx) => {
    // Lock the one row every writer of this vault's throttle fields serializes on. A missing
    // row fails closed: nothing to verify against, and nothing to create here.
    const locked = await lockVaultRow(tx, userId);
    const row = locked[0];
    if (!row) return null;

    // The clock, taken after the lock: a transaction that waited out a window boundary
    // must not keep the expired window's accounting. Tests may pin it; production reads
    // the database clock so every writer of this row agrees on the time.
    const now = at ?? (await dbNow(tx));

    // Normalize expiry: an ended window is retired, its charges stay historical, and its
    // pending tokens stay in the map but can no longer touch the new window's counter.
    const generation = await normalizeWalletVaultWindow(tx, row, now);
    if (generation === null) return null;

    // Normalize may have just reset the counters for a fresh window, so the locked snapshot
    // can be stale about the live attempt budget: re-read it before deciding admission.
    const current = (await lockVaultRow(tx, userId))[0];
    if (!current) return null;
    if (current.failedAttempts >= WALLET_VAULT_MAX_FAILED_ATTEMPTS) return null;

    const token = await nextReservationToken(tx);
    const generationText = generation.toString();
    const charged = await tx.$executeRaw(PrismaSql.sql`
      UPDATE "wallet_vaults"
      SET "windowStartedAt" = COALESCE("windowStartedAt", ${now}::timestamp),
          "failedAttempts" = "failedAttempts" + 1,
          "pendingReservations" =
            "pendingReservations" || jsonb_build_object(${token}::text, ${generationText}::text),
          "lockedUntil" =
            CASE WHEN "failedAttempts" + 1 >= ${WALLET_VAULT_MAX_FAILED_ATTEMPTS}
              THEN COALESCE("windowStartedAt", ${now}::timestamp) + ${lockoutInterval()}
              ELSE NULL END
      WHERE "userId" = ${userId}
        AND "failedAttempts" < ${WALLET_VAULT_MAX_FAILED_ATTEMPTS}
        AND NOT jsonb_exists("pendingReservations", ${token}::text)`);
    if (charged === 0) return null;

    return {
      token,
      credentialRevision: current.credentialRevision,
      credentialMaterial: current.verifier,
      passwordEpoch: current.passwordEpoch,
    };
  });
}

/** Vault password state safe to show the owner: never the verifier. */
export type WalletVaultStatus = {
  configured: boolean;
  /** When the password was last set or changed; null while unconfigured. */
  changedAt: string | null;
};

type WalletVaultRow = {
  userId: string;
  verifier: string;
  passwordEpoch: number;
  failedAttempts: number;
  lockedUntil: Date | null;
  throttleGeneration: bigint;
  windowStartedAt: Date | null;
  pendingReservations: Record<string, string>;
  credentialRevision: bigint;
};

/** The persisted throttle counters, read back after a settlement lands. */
type ThrottleState = { failedAttempts: number; lockedUntil: Date | null };

/** What settling one reservation reports. A token already gone settles nothing. */
export type Settlement =
  | { settled: false }
  | {
      settled: true;
      failedAttempts: number;
      lockedUntil: Date | null;
      passwordEpoch?: number;
      /** Set on a success whose credential snapshot had been replaced concurrently. */
      credentialsChanged?: boolean;
    };

/** The counters a rejected attempt reports: the hook never sees a password. */
export type RejectionInfo = { failedAttempts: number; lockedUntil: Date | null };

/**
 * A 15-minute lockout/window as a constant Postgres interval — never built from input. Built
 * lazily so importing this module never touches the `Prisma` namespace: a test double that
 * mocks `@rakazo/db` without it must still be able to import the module.
 */
const lockoutInterval = (): Prisma.Sql => PrismaSql.sql`INTERVAL '15 minutes'`;

/** Lock the one vault row every writer of its throttle fields serializes on. */
async function lockVaultRow(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<WalletVaultRow[]> {
  const rows = await tx.$queryRaw<WalletVaultRow[]>(PrismaSql.sql`
    SELECT "userId", "verifier", "passwordEpoch", "failedAttempts", "lockedUntil",
           "throttleGeneration", "windowStartedAt", "pendingReservations", "credentialRevision"
    FROM "wallet_vaults" WHERE "userId" = ${userId} FOR UPDATE`);
  // The driver hands 64-bit columns back as strings; every generation and revision
  // comparison below is a strict BigInt equality, so normalize them once, here.
  return rows.map((row) => ({
    ...row,
    throttleGeneration: BigInt(row.throttleGeneration),
    credentialRevision: BigInt(row.credentialRevision),
  }));
}

/** The database clock, taken after the row lock. */
async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<[{ now: Date }]>(
    PrismaSql.sql`SELECT clock_timestamp() AS "now"`,
  );
  const now = rows[0]?.now;
  if (!now) throw new Error("wallet vault clock unavailable");
  return now;
}

/**
 * Retire an expired accounting window. Returns the generation the caller is operating in, or
 * null when the row disappeared. Charges from a retired window stay historical: the map keeps
 * old tokens so a late settlement can find and remove its own without touching the new window.
 */
async function normalizeWalletVaultWindow(
  tx: Prisma.TransactionClient,
  row: WalletVaultRow,
  now: Date,
): Promise<bigint | null> {
  const expired =
    row.windowStartedAt !== null &&
    now.getTime() - row.windowStartedAt.getTime() >= WALLET_VAULT_LOCKOUT_MS;
  if (!expired) return row.throttleGeneration;
  const bumped = await tx.$executeRaw(PrismaSql.sql`
    UPDATE "wallet_vaults"
    SET "throttleGeneration" = "throttleGeneration" + 1,
        "windowStartedAt" = NULL,
        "failedAttempts" = 0,
        "lockedUntil" = NULL
    WHERE "userId" = ${row.userId}
      AND "windowStartedAt" IS NOT NULL`);
  if (bumped === 0) return null;
  return row.throttleGeneration + 1n;
}

/**
 * A non-reused reservation identity. The sequence is never reset during normal operation, so
 * a token can never be re-issued and mistaken for a live reservation.
 */
async function nextReservationToken(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<[{ token: bigint }]>(PrismaSql.sql`
    SELECT nextval('wallet_vault_reservation_token_seq')::bigint AS token`);
  const token = rows[0]?.token;
  // Sequence exhaustion fails closed rather than reusing a token.
  if (token === undefined) throw new Error("wallet vault reservation token unavailable");
  return token.toString();
}

/**
 * Settle a reservation after verification finished. Exactly one of these runs per admitted
 * attempt, and both remove only the reservation's own token, so a settlement can never
 * consume another attempt's charge.
 */

/** A correct verification: refund the slot when the token belongs to the current window. */
async function settleSuccessInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  token: string,
  at?: Date,
): Promise<Settlement> {
  const locked = await lockVaultRow(tx, userId);
  const row = locked[0];
  if (!row) return { settled: false };
  const now = at ?? (await dbNow(tx));
  const generation = await normalizeWalletVaultWindow(tx, row, now);
  if (generation === null) return { settled: false };
  const tokenGeneration = row.pendingReservations[token];
  if (tokenGeneration === undefined) return { settled: false };
  // Only a token admitted in the current window holds a charge this settlement may return;
  // an older window's token leaves the new window's counter untouched. The comparison is
  // made in SQL against the row's live generation, so it cannot drift from the row being
  // updated and no host-side boolean has to be bound as a query parameter.
  const updated = await tx.$queryRaw<ThrottleState[]>(PrismaSql.sql`
    UPDATE "wallet_vaults"
    SET "pendingReservations" = "pendingReservations" - ${token}::text,
        "failedAttempts" =
          CASE
            WHEN jsonb_extract_path_text("pendingReservations", ${token}::text)
                 = "throttleGeneration"::text
            THEN "failedAttempts" - 1
            ELSE "failedAttempts"
          END,
        "lockedUntil" = NULL
    WHERE "userId" = ${userId} AND jsonb_exists("pendingReservations", ${token}::text)
    RETURNING "failedAttempts", "lockedUntil"`);
  const state = updated[0];
  if (!state) return { settled: false };
  return {
    settled: true,
    passwordEpoch: row.passwordEpoch,
    credentialsChanged: false,
    failedAttempts: state.failedAttempts,
    lockedUntil: state.lockedUntil,
  };
}

/** A correct verification: refund the slot when the token belongs to the current window. */
export async function settleWalletVaultSuccess(
  prisma: PrismaClient,
  userId: string,
  token: string,
  at?: Date,
): Promise<Settlement> {
  return prisma.$transaction(async (tx) => settleSuccessInTx(tx, userId, token, at));
}

/** A wrong verification: the charge stays; only the pending token goes. */
async function settleFailureInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  token: string,
  at?: Date,
): Promise<Settlement> {
  const locked = await lockVaultRow(tx, userId);
  const row = locked[0];
  if (!row) return { settled: false };
  const now = at ?? (await dbNow(tx));
  const generation = await normalizeWalletVaultWindow(tx, row, now);
  if (generation === null) return { settled: false };
  if (row.pendingReservations[token] === undefined) return { settled: false };
  const updated = await tx.$queryRaw<ThrottleState[]>(PrismaSql.sql`
    UPDATE "wallet_vaults"
    SET "pendingReservations" = "pendingReservations" - ${token}::text,
        "lockedUntil" =
          CASE WHEN "failedAttempts" >= ${WALLET_VAULT_MAX_FAILED_ATTEMPTS}
            THEN "windowStartedAt" + ${lockoutInterval()}
            ELSE NULL END
    WHERE "userId" = ${userId} AND jsonb_exists("pendingReservations", ${token}::text)
    RETURNING "failedAttempts", "lockedUntil"`);
  const state = updated[0];
  if (!state) return { settled: false };
  return {
    settled: true,
    failedAttempts: state.failedAttempts,
    lockedUntil: state.lockedUntil,
  };
}

/** A wrong verification: the charge stays; only the pending token goes. */
export async function settleWalletVaultFailure(
  prisma: PrismaClient,
  userId: string,
  token: string,
  at?: Date,
): Promise<Settlement> {
  return prisma.$transaction(async (tx) => settleFailureInTx(tx, userId, token, at));
}

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
 * active unlock grant is not proof of knowing it.
 *
 * The change reserves a slot, verifies the current password against the snapshot its
 * reservation returned, and only then swaps the verifier — conditionally on the credential
 * revision the reservation read, so two verified changes can never overwrite the same starting
 * version. The epoch moves in the same transaction, revoking every grant minted under the old
 * password. The reservation is settled in that same transaction whether the revision matched or
 * not: a correct password must never be recorded as a failure.
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
  // A missing vault is a different refusal from a throttled one, and must stay so.
  const existing = await prisma.walletVault.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (!existing) throw new WalletVaultNotConfiguredError();

  const at = hooks?.now;
  const reservation = await reserveWalletVaultAttempt(prisma, userId, at);
  if (!reservation) throw new WalletVaultPasswordError();
  const reject = async (): Promise<never> => {
    const outcome = await settleWalletVaultFailure(prisma, userId, reservation.token, at);
    if (outcome.settled) {
      await hooks?.onRejected?.({
        failedAttempts: outcome.failedAttempts,
        lockedUntil: outcome.lockedUntil,
      });
    }
    throw new WalletVaultPasswordError();
  };
  if (!(await verifyPassword(reservation.credentialMaterial, input.currentPassword))) {
    return reject();
  }
  const verifier = await createPasswordVerifier(input.newPassword);
  // The replacement is prepared outside the transaction; the swap is conditional on the
  // revision the reservation read, so a concurrent change wins and this one refunds instead.
  // The reservation is settled in the same transaction whether the revision matched or not:
  // a correct password must never be recorded as a failure.
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockVaultRow(tx, userId);
    const row = locked[0];
    if (!row) return { settled: false } as Settlement;
    const now = at ?? (await dbNow(tx));
    const generation = await normalizeWalletVaultWindow(tx, row, now);
    if (generation === null) return { settled: false } as Settlement;
    const pending = row.pendingReservations[reservation.token] !== undefined;
    const revisionMatches = pending && row.credentialRevision === reservation.credentialRevision;
    if (revisionMatches) {
      await tx.walletVault.update({
        where: { userId },
        data: {
          verifier,
          changedAt: now,
          passwordEpoch: { increment: 1 },
          credentialRevision: { increment: 1 },
        },
      });
    }
    const settled = await settleSuccessInTx(tx, userId, reservation.token, at);
    return { ...settled, credentialsChanged: !revisionMatches };
  });
  if (outcome.settled && outcome.credentialsChanged) {
    // The password was correct for the snapshot this reservation read, so the slot is
    // refunded — but a newer credential already exists, so this change did not land.
    throw new WalletVaultPasswordError();
  }
  const changedAt = await walletVaultStatus(prisma, userId);
  return { configured: true, changedAt: changedAt.changedAt ?? new Date().toISOString() };
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
  // A missing vault is a different refusal from a throttled one, and must stay so.
  const existing = await prisma.walletVault.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (!existing) throw new WalletVaultNotConfiguredError();

  // Reserve before any verification: the slot is charged whether the guess is right or wrong,
  // and only this attempt's own settlement can give it back.
  const at = hooks?.now;
  const reservation = await reserveWalletVaultAttempt(prisma, userId, at);
  if (!reservation) throw new WalletVaultPasswordError();

  if (!(await verifyPassword(reservation.credentialMaterial, password))) {
    const outcome = await settleWalletVaultFailure(prisma, userId, reservation.token, at);
    if (outcome.settled) {
      await hooks?.onRejected?.({
        failedAttempts: outcome.failedAttempts,
        lockedUntil: outcome.lockedUntil,
      });
    }
    throw new WalletVaultPasswordError();
  }

  const settled = await settleWalletVaultSuccess(prisma, userId, reservation.token, at);
  // The password matched the snapshot this reservation read, but the vault was re-keyed
  // concurrently: the slot is refunded and the attempt is not a failure, yet it must not
  // authorize — the same generic refusal, so the response never says which check moved.
  if (!settled.settled || settled.credentialsChanged) throw new WalletVaultPasswordError();
  return { passwordEpoch: settled.passwordEpoch ?? reservation.passwordEpoch };
}
