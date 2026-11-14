import { randomUUID } from "node:crypto";
import { WalletVaultNotConfiguredError, WalletVaultPasswordError } from "./wallet-vault-impl.js";

/**
 * The wallet vault's in-memory core: unlock grants and the operations they
 * authorize. This module is the vault service's brain; the service process
 * (apps/vault) wires it to the database and an HTTP surface, and the API and
 * worker only ever reach it through the vault client.
 *
 * A grant is a capability that exists ONLY in this process's memory:
 *
 * - Unlock verifies the owner's wallet password against the durable vault
 *   state (the store), then mints a grant with a fixed six-hour expiry.
 *   Activity never extends it.
 * - The grant record holds the password material the vault will need to
 *   open wallet envelopes at signing time. It never leaves this process:
 *   it is not persisted, not returned, and not logged, and its buffer is
 *   wiped when the grant ends. (Buffer wiping is best-effort exposure
 *   reduction, not guaranteed erasure — the honest boundary the envelope
 *   helpers document.)
 * - Lock, expiry, a newer unlock, and a password change (an epoch move in
 *   the durable state) each end a grant immediately. A vault restart ends
 *   every grant, because nothing about a grant is restored from the store.
 * - The store's unlock rows are an audit trail only. A stored row never
 *   authorizes anything; authorization is the live grant or nothing.
 *
 * Signing and filling are not implemented yet: no wallet is migrated to a
 * password envelope until the migration step lands, so after full grant
 * validation both operations refuse with a typed error rather than pretend.
 * The validation order is deliberate — grant first, wallet second — so a
 * caller without a live grant learns nothing about wallets.
 *
 * Nothing here logs, and no error or result carries a password, a verifier,
 * key material, or an envelope.
 */

/** How long an unlock lasts. Fixed at mint; use does not extend it. */
export const WALLET_VAULT_GRANT_TTL_MS = 6 * 60 * 60 * 1_000;

/** Operations an unlock grant can authorize. */
export const WALLET_VAULT_GRANT_OPERATIONS = ["sign", "fill"] as const;
export type WalletVaultGrantOperation = (typeof WALLET_VAULT_GRANT_OPERATIONS)[number];

/** The machine-readable reason a vault operation failed. */
export type WalletVaultServiceErrorCode =
  | "not_configured"
  | "password_rejected"
  | "vault_locked"
  | "grant_expired"
  | "grant_mismatch"
  | "epoch_mismatch"
  | "operation_not_allowed"
  | "wallet_not_found"
  | "wallet_not_migrated"
  | "signing_not_enabled"
  | "fill_not_enabled";

const ERROR_MESSAGES: Record<WalletVaultServiceErrorCode, string> = {
  not_configured: "No wallet password is set yet.",
  password_rejected: "The wallet password could not be verified.",
  vault_locked: "The wallet vault is locked.",
  grant_expired: "The wallet vault unlock has expired.",
  grant_mismatch: "The unlock grant does not match.",
  epoch_mismatch: "The wallet password changed; unlock again.",
  operation_not_allowed: "The unlock grant does not allow this operation.",
  wallet_not_found: "Wallet not found.",
  wallet_not_migrated: "The wallet is not protected by the wallet password yet.",
  signing_not_enabled: "Wallet signing is not available yet.",
  fill_not_enabled: "Wallet filling is not available yet.",
};

/** A vault failure with a stable code callers can map to a response. */
export class WalletVaultServiceError extends Error {
  readonly code: WalletVaultServiceErrorCode;
  constructor(code: WalletVaultServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WalletVaultServiceError";
    this.code = code;
  }
}

/**
 * The durable state the vault core needs, nothing more. The vault service
 * implements this over the database; tests implement it in memory. Password
 * verification goes through the wallet-vault password state, so unlock and
 * password change share the one throttle on the vault row.
 */
export interface WalletVaultStore {
  /** Whether a wallet password exists for the person, and its current epoch. */
  vaultState(userId: string): Promise<{ configured: boolean; passwordEpoch: number | null }>;
  /**
   * Verify a wallet password under the shared throttle. Resolves with the
   * epoch the password verified under; rejects with
   * {@link WalletVaultNotConfiguredError} or {@link WalletVaultPasswordError}.
   */
  verifyPassword(userId: string, password: string): Promise<{ passwordEpoch: number }>;
  /** The wallet's migration status, or null when the person has no such wallet. */
  walletMigrationStatus(userId: string, walletId: string): Promise<string | null>;
  /** Append the audit row for a minted grant. Audit only: never read back for authorization. */
  recordUnlock(input: {
    userId: string;
    grantId: string;
    passwordEpoch: number;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  /** Mark a grant's audit row revoked. Audit only, like {@link recordUnlock}. */
  recordLock(input: { userId: string; grantId: string; revokedAt: Date }): Promise<void>;
}

/** What an unlock hands back: the grant handle and its fixed expiry. Never material. */
export type WalletVaultUnlockResult = {
  grantId: string;
  expiresAt: string;
  passwordEpoch: number;
};

/** Unlock state safe to show the owner: no grant handle, no material. */
export type WalletVaultGrantStatus = {
  configured: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  passwordEpoch: number | null;
};

type Grant = {
  grantId: string;
  userId: string;
  passwordEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
  generation: number;
  operations: ReadonlySet<WalletVaultGrantOperation>;
  /** The password the envelopes open with, held only for the grant's life. */
  passwordMaterial: Buffer;
};

export type WalletVaultService = ReturnType<typeof createWalletVaultService>;

/**
 * Create the vault core over a store. `now` and `newGrantId` are injectable
 * so tests can travel in time and predict grant ids.
 */
export function createWalletVaultService(deps: {
  store: WalletVaultStore;
  now?: () => Date;
  newGrantId?: () => string;
}) {
  const now = deps.now ?? (() => new Date());
  const newGrantId = deps.newGrantId ?? (() => randomUUID());
  /** Live grants by user. Memory only: a restart starts fully locked. */
  const grants = new Map<string, Grant>();
  /** Per-person revocation generation; a grant minted under an older one is dead. */
  const generations = new Map<string, number>();

  const generationOf = (userId: string) => generations.get(userId) ?? 0;

  /** End a person's grant now: wipe its material and retire its generation. */
  function revoke(userId: string): Grant | undefined {
    const grant = grants.get(userId);
    generations.set(userId, generationOf(userId) + 1);
    if (grant) {
      grant.passwordMaterial.fill(0);
      grants.delete(userId);
    }
    return grant;
  }

  async function auditLock(grant: Grant): Promise<void> {
    await deps.store.recordLock({
      userId: grant.userId,
      grantId: grant.grantId,
      revokedAt: now(),
    });
  }

  /**
   * The gate every privileged operation passes. Any defect — no grant, the
   * wrong grant handle, a retired generation, expiry, an epoch that moved
   * under the grant, an operation the grant does not cover — fails closed
   * with a typed error, and a grant found defective is revoked on the spot.
   */
  async function requireGrant(
    userId: string,
    grantId: string,
    operation: WalletVaultGrantOperation,
  ): Promise<Grant> {
    const grant = grants.get(userId);
    if (!grant) throw new WalletVaultServiceError("vault_locked");
    if (grant.grantId !== grantId) throw new WalletVaultServiceError("grant_mismatch");
    if (grant.generation !== generationOf(userId)) {
      revoke(userId);
      throw new WalletVaultServiceError("vault_locked");
    }
    if (now().getTime() >= grant.expiresAt.getTime()) {
      revoke(userId);
      throw new WalletVaultServiceError("grant_expired");
    }
    const state = await deps.store.vaultState(userId);
    if (!state.configured || state.passwordEpoch !== grant.passwordEpoch) {
      const stale = revoke(userId);
      if (stale) await auditLock(stale);
      throw new WalletVaultServiceError("epoch_mismatch");
    }
    if (!grant.operations.has(operation)) {
      throw new WalletVaultServiceError("operation_not_allowed");
    }
    return grant;
  }

  /** Refuse a sign or fill for a wallet the grant may not act on yet. */
  async function requireMigratedWallet(
    userId: string,
    walletId: string,
  ): Promise<{ migrationStatus: string }> {
    const migrationStatus = await deps.store.walletMigrationStatus(userId, walletId);
    if (migrationStatus === null) throw new WalletVaultServiceError("wallet_not_found");
    if (migrationStatus !== "password_protected") {
      throw new WalletVaultServiceError("wallet_not_migrated");
    }
    return { migrationStatus };
  }

  return {
    /** Unlock state for the owner: configured, and whether a live grant exists. */
    async status(userId: string): Promise<WalletVaultGrantStatus> {
      const state = await deps.store.vaultState(userId);
      const grant = grants.get(userId);
      const live =
        grant !== undefined &&
        grant.generation === generationOf(userId) &&
        now().getTime() < grant.expiresAt.getTime() &&
        state.configured &&
        state.passwordEpoch === grant.passwordEpoch;
      if (grant && !live) revoke(userId);
      return {
        configured: state.configured,
        unlocked: live,
        expiresAt: live ? grant.expiresAt.toISOString() : null,
        passwordEpoch: state.passwordEpoch,
      };
    },

    /**
     * Verify the wallet password and mint the one live grant for the person,
     * replacing any previous one. The audit row is written before the grant
     * is returned; if it cannot be written the grant is wiped and the unlock
     * fails — an unlock the audit cannot see does not happen.
     */
    async unlock(userId: string, password: string): Promise<WalletVaultUnlockResult> {
      let verified: { passwordEpoch: number };
      try {
        verified = await deps.store.verifyPassword(userId, password);
      } catch (error) {
        if (error instanceof WalletVaultNotConfiguredError) {
          throw new WalletVaultServiceError("not_configured");
        }
        if (error instanceof WalletVaultPasswordError) {
          throw new WalletVaultServiceError("password_rejected");
        }
        throw error;
      }

      const replaced = revoke(userId);
      if (replaced) await auditLock(replaced);

      const issuedAt = now();
      const grant: Grant = {
        grantId: newGrantId(),
        userId,
        passwordEpoch: verified.passwordEpoch,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + WALLET_VAULT_GRANT_TTL_MS),
        generation: generationOf(userId),
        operations: new Set(WALLET_VAULT_GRANT_OPERATIONS),
        passwordMaterial: Buffer.from(password, "utf8"),
      };
      grants.set(userId, grant);
      try {
        await deps.store.recordUnlock({
          userId,
          grantId: grant.grantId,
          passwordEpoch: grant.passwordEpoch,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
        });
      } catch (error) {
        revoke(userId);
        throw error;
      }
      return {
        grantId: grant.grantId,
        expiresAt: grant.expiresAt.toISOString(),
        passwordEpoch: grant.passwordEpoch,
      };
    },

    /** Lock the vault for a person: the grant ends now, in memory and in audit. */
    async lock(userId: string): Promise<{ locked: true }> {
      const grant = revoke(userId);
      if (grant) await auditLock(grant);
      return { locked: true as const };
    },

    /** End every grant, on shutdown. No audit writes: the process is going away. */
    lockAll(): void {
      for (const userId of [...grants.keys()]) revoke(userId);
    },

    /**
     * Sign for a wallet under a grant. Not implemented yet — no wallet is
     * password-protected until migration lands — so after grant and wallet
     * validation this refuses, typed, rather than pretend to sign.
     */
    async sign(input: { userId: string; grantId: string; walletId: string }): Promise<never> {
      await requireGrant(input.userId, input.grantId, "sign");
      await requireMigratedWallet(input.userId, input.walletId);
      throw new WalletVaultServiceError("signing_not_enabled");
    },

    /** The fill broker's shape, with the same validation order as sign. */
    async fill(input: {
      userId: string;
      grantId: string;
      walletId: string;
      site: string;
    }): Promise<never> {
      await requireGrant(input.userId, input.grantId, "fill");
      await requireMigratedWallet(input.userId, input.walletId);
      throw new WalletVaultServiceError("fill_not_enabled");
    },
  };
}
