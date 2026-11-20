import { WALLET_VAULT_LOCKOUT_MS, WALLET_VAULT_MAX_FAILED_ATTEMPTS } from "./wallet-vault-impl.js";

/**
 * The columns an in-memory vault row needs for the raw-SQL shim below. The fake stores the
 * database's bigint columns as plain numbers; the shim mirrors the driver's bigint coercion
 * on read, so the implementation's strict BigInt comparisons behave as they do for real.
 */
export type FakeVaultRow = {
  userId: string;
  verifier: string;
  passwordEpoch?: number;
  failedAttempts?: number;
  lockedUntil?: Date | null;
  throttleGeneration?: number;
  windowStartedAt?: Date | null;
  pendingReservations?: Record<string, string>;
  credentialRevision?: number;
};

/** The shape Prisma hands a raw query: the SQL text plus its interpolated values. */
type RawQuery = { sql?: unknown; values?: unknown };

type RunResult = { rows: Record<string, unknown>[]; count: number };

const asText = (query: RawQuery): string => (typeof query.sql === "string" ? query.sql : "");
const asValues = (query: RawQuery): unknown[] => (Array.isArray(query.values) ? query.values : []);

/**
 * An in-memory stand-in for the wallet-vault throttle's raw SQL. The real statements are
 * covered by the PostgreSQL journey tests; this shim exists so the in-memory unit tests can
 * drive the same reservation code paths without a database. It implements exactly the seven
 * statements the throttle uses and nothing else, so an unsupported query fails loudly instead
 * of silently diverging from the database.
 */
export function createVaultSqlShim<R extends FakeVaultRow>(rows: Map<string, R>) {
  let tokenSequence = 1_000n;

  const getRow = (userId: string): R | undefined => {
    const row = rows.get(userId);
    if (!row) return undefined;
    // Mirror the database's column defaults so a row created through the model API still
    // carries every throttle column the raw statements read and write.
    row.passwordEpoch ??= 1;
    row.failedAttempts ??= 0;
    row.lockedUntil ??= null;
    row.throttleGeneration ??= 0;
    row.windowStartedAt ??= null;
    row.pendingReservations ??= {};
    row.credentialRevision ??= 0;
    return row;
  };

  /** The user id is the only string parameter that names a row in the map. */
  const findUserId = (values: unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === "string" && rows.has(value));

  /** A reservation token is the first string that is not the user id (tokens are numeric). */
  const findToken = (values: unknown[], userId: string | undefined): string | undefined =>
    values.find((value): value is string => typeof value === "string" && value !== userId);

  const findDate = (values: unknown[]): Date | undefined =>
    values.find((value): value is Date => value instanceof Date);

  const lockoutFrom = (start: Date | null): Date | null =>
    start ? new Date(start.getTime() + WALLET_VAULT_LOCKOUT_MS) : null;

  const run = (query: RawQuery): RunResult => {
    const text = asText(query);
    const values = asValues(query);
    const row = getRow(findUserId(values) ?? "");

    // lockVaultRow: the single row every throttle writer serializes on.
    if (text.includes("FOR UPDATE")) {
      if (!row) return { rows: [], count: 0 };
      return {
        rows: [
          {
            userId: row.userId,
            verifier: row.verifier,
            passwordEpoch: row.passwordEpoch,
            failedAttempts: row.failedAttempts,
            lockedUntil: row.lockedUntil,
            throttleGeneration: row.throttleGeneration,
            windowStartedAt: row.windowStartedAt,
            pendingReservations: { ...row.pendingReservations },
            credentialRevision: row.credentialRevision,
          },
        ],
        count: 1,
      };
    }
    // dbNow: the database clock, read after the row lock.
    if (text.includes("clock_timestamp()")) return { rows: [{ now: new Date() }], count: 1 };
    // nextReservationToken: a sequence that is never reset, so tokens are never reused.
    if (text.includes("nextval(")) {
      tokenSequence += 1n;
      return { rows: [{ token: tokenSequence }], count: 1 };
    }
    if (!row) return { rows: [], count: 0 };

    // normalizeWalletVaultWindow: retire an expired window and start a new generation.
    if (text.includes('"throttleGeneration" = "throttleGeneration" + 1')) {
      if (row.windowStartedAt === null) return { rows: [], count: 0 };
      row.throttleGeneration = (row.throttleGeneration ?? 0) + 1;
      row.windowStartedAt = null;
      row.failedAttempts = 0;
      row.lockedUntil = null;
      return { rows: [], count: 1 };
    }
    // reserveWalletVaultAttempt: charge one attempt and admit the token into this window.
    if (text.includes("jsonb_build_object")) {
      const token = findToken(values, row.userId);
      if (row.pendingReservations === undefined) row.pendingReservations = {};
      const pending = row.pendingReservations;
      if (token === undefined) return { rows: [], count: 0 };
      if (row.failedAttempts >= WALLET_VAULT_MAX_FAILED_ATTEMPTS) return { rows: [], count: 0 };
      if (pending[token] !== undefined) return { rows: [], count: 0 };
      if (row.windowStartedAt === null) row.windowStartedAt = findDate(values) ?? new Date();
      row.failedAttempts += 1;
      pending[token] = String(row.throttleGeneration ?? 0);
      row.lockedUntil =
        row.failedAttempts >= WALLET_VAULT_MAX_FAILED_ATTEMPTS
          ? lockoutFrom(row.windowStartedAt)
          : null;
      return { rows: [], count: 1 };
    }
    // settleSuccessInTx: refund only a token that was admitted in the current window.
    if (text.includes("jsonb_extract_path_text")) {
      const token = findToken(values, row.userId);
      if (row.pendingReservations === undefined) row.pendingReservations = {};
      const pending = row.pendingReservations;
      if (token === undefined || pending[token] === undefined) return { rows: [], count: 0 };
      const ownsCharge = pending[token] === String(row.throttleGeneration ?? 0);
      delete pending[token];
      if (ownsCharge) row.failedAttempts -= 1;
      row.lockedUntil = null;
      return { rows: [{ failedAttempts: row.failedAttempts, lockedUntil: null }], count: 1 };
    }
    // settleFailureInTx: the charge stays; only the pending token goes.
    if (text.includes('"pendingReservations" = "pendingReservations" - ')) {
      const token = findToken(values, row.userId);
      if (row.pendingReservations === undefined) row.pendingReservations = {};
      const pending = row.pendingReservations;
      if (token === undefined || pending[token] === undefined) return { rows: [], count: 0 };
      delete pending[token];
      row.lockedUntil =
        row.failedAttempts >= WALLET_VAULT_MAX_FAILED_ATTEMPTS
          ? lockoutFrom(row.windowStartedAt)
          : null;
      return {
        rows: [{ failedAttempts: row.failedAttempts, lockedUntil: row.lockedUntil }],
        count: 1,
      };
    }
    throw new Error(`wallet vault fake: unsupported raw SQL: ${text.slice(0, 160)}`);
  };

  return {
    $queryRaw: async (query: RawQuery): Promise<Record<string, unknown>[]> => run(query).rows,
    $executeRaw: async (query: RawQuery): Promise<number> => run(query).count,
  };
}
