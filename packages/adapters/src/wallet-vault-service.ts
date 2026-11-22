import { randomUUID } from "node:crypto";
import { openWalletKeyWithPassword } from "./wallet-envelope.js";
import { walletProposalCanonicalHash } from "./wallet-proposals.js";
import { signEip1559Transaction } from "./wallet-tx-signing.js";
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
 * - Unlock and lock are serialized per person: a lock issued while an
 *   unlock is still verifying runs after it and wins, so an explicit lock
 *   can never be undone by an unlock that was already in flight. Grant
 *   installation re-checks that the grant is still the live one before
 *   its handle is handed back.
 * - The store's unlock rows are an audit trail only. A stored row never
 *   authorizes anything; authorization is the live grant or nothing.
 *
 * Signing and filling are not implemented yet: wallets migrate to a
 * password envelope through Settings, and a migrated wallet passes the
 * migration check below — but until signing and the fill broker land, both
 * operations still refuse with a typed error rather than pretend.
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
  | "proposal_not_found"
  | "proposal_not_signable"
  | "proposal_tampered"
  | "wallet_key_mismatch"
  | "wallet_key_unreadable"
  | "legacy_path_ambiguous"
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
  proposal_not_found: "Proposal not found.",
  proposal_not_signable: "The proposal is no longer available to sign.",
  proposal_tampered: "The proposal does not match its recorded fingerprint.",
  wallet_key_mismatch: "The wallet key does not match the proposal's recorded sender.",
  wallet_key_unreadable: "The wallet's stored key could not be read as a signing key.",
  legacy_path_ambiguous:
    "This wallet's key came from a seed phrase, whose account path is not recorded, so it cannot be signed from here.",
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

const HEX_KEY_64 = /^[0-9a-fA-F]{64}$/;
const WORD_TOKEN = /^[A-Za-z]+$/;

/**
 * The 32 raw bytes secp256k1 signs with, from whatever the sealed secret held.
 *
 * Wallets migrated off the server seal kept their secret exactly as it was
 * typed: a 0x-hex string, bare hex, or a seed phrase. The curve needs 32 raw
 * bytes, so hex text is decoded here and everything else is refused with a
 * typed error rather than handed to the curve to misread.
 */
export function walletSigningKey(opened: Buffer): Buffer {
  if (opened.length === 32) return opened;
  const text = opened.toString("utf8").trim();
  const hex = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (HEX_KEY_64.test(hex)) return Buffer.from(hex, "hex");
  if (isSeedPhrase(text)) throw new WalletVaultServiceError("legacy_path_ambiguous");
  throw new WalletVaultServiceError("wallet_key_unreadable");
}

/** A BIP-39-sized run of words: readable, but its derivation path was never stored. */
function isSeedPhrase(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 12 && words.length <= 24 && words.every((word) => WORD_TOKEN.test(word));
}

/**
 * The stored proposal a signing request names, exactly as the database holds
 * it. The vault re-reads this itself — the caller names the proposal and
 * supplies nothing else — so what gets signed is what was validated, never a
 * transaction the caller reconstructed.
 */
export type WalletProposalForSigning = {
  proposalId: string;
  walletId: string;
  /** The sender the canonical hash covers; fixed at creation. */
  fromAddress: string;
  chainId: number;
  /** null for a contract deploy. */
  to: string | null;
  /** Native value in wei, as an exact decimal string. */
  amountWei: string;
  /** 0x-prefixed calldata; null when the call carries none. */
  data: string | null;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  status: string;
  /** sha256 of the canonical serialization, recorded at creation. */
  canonicalHash: string;
  expiresAt: Date;
};

/** The signed transaction the vault returns for a proposal. */
export type WalletVaultSignResult = {
  /** `0x02 || RLP([…, yParity, r, s])` — what an RPC broadcast accepts. */
  signedTransaction: string;
  /** keccak256 of the signed transaction. */
  transactionHash: string;
  /** Lowercase sender address, recovered from the signature. */
  from: string;
};

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
  /** The stored proposal to sign, or null when this person has no such proposal. */
  readProposal(input: {
    proposalId: string;
    userId: string;
  }): Promise<WalletProposalForSigning | null>;
  /** The wallet's key envelope, or null when this person has no such wallet. */
  readWalletKeyEnvelope(input: {
    walletId: string;
    userId: string;
  }): Promise<{ keyCiphertext: string; passwordWrap: string } | null>;
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
  /**
   * The password the envelopes open with, held only for the grant's life.
   * It is the password itself, not derived material, on purpose: each
   * wallet's envelope carries its own KDF salt and parameters, and the
   * envelope helpers derive the unwrap key from password + that envelope's
   * salt at open time. No single derived value can stand in for it across
   * wallets — pre-deriving per wallet at unlock would miss wallets
   * migrated during the window and hold more secrets, not fewer. The
   * buffer is wiped on every grant end: lock, expiry, epoch or generation
   * termination, replacement, a failed audit write, and shutdown.
   */
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
  /** Per-person chain serializing the operations that mint or end grants. */
  const stateChains = new Map<string, Promise<void>>();

  const generationOf = (userId: string) => generations.get(userId) ?? 0;

  /**
   * Run a grant-changing operation for one person after every earlier one
   * for that person has settled. Unlock and lock share the chain, so they
   * linearize: a lock issued during an in-flight unlock runs after the
   * unlock and revokes whatever it installed — the final state is locked.
   * Different people never wait on each other.
   */
  function serialized<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = stateChains.get(userId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    stateChains.set(
      userId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

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
   * The audit row for a grant termination, best-effort: expiry, a stale
   * generation, an epoch that moved. The revocation itself already happened
   * in memory and must stand even when the audit write fails — a failed
   * write never resurrects a grant or blocks its end — so errors are
   * swallowed here. The live grant map, never the audit row, authorizes.
   */
  async function auditRevocation(grant: Grant): Promise<void> {
    try {
      await auditLock(grant);
    } catch {
      // Best effort only: the grant is already gone from memory.
    }
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
      const stale = revoke(userId);
      if (stale) await auditRevocation(stale);
      throw new WalletVaultServiceError("vault_locked");
    }
    if (now().getTime() >= grant.expiresAt.getTime()) {
      const expired = revoke(userId);
      if (expired) await auditRevocation(expired);
      throw new WalletVaultServiceError("grant_expired");
    }
    const state = await deps.store.vaultState(userId);
    if (!state.configured || state.passwordEpoch !== grant.passwordEpoch) {
      const stale = revoke(userId);
      if (stale) await auditRevocation(stale);
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
      if (grant && !live) {
        revoke(userId);
        await auditRevocation(grant);
      }
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
     *
     * Serialized with lock per person: a lock issued while this unlock is
     * still verifying runs after it and revokes what it installed, and the
     * installed grant is re-checked after the audit write, so a grant that
     * was revoked meanwhile (expiry noticed by a status check, a shutdown)
     * is never handed back as live.
     */
    async unlock(userId: string, password: string): Promise<WalletVaultUnlockResult> {
      return serialized(userId, async () => {
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
        if (replaced) await auditRevocation(replaced);

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
        // The grant may have ended while its audit row was written — a
        // status check that found it stale, a shutdown emptying every
        // grant. Never hand back a handle that is no longer the live one.
        if (grants.get(userId) !== grant || grant.generation !== generationOf(userId)) {
          if (grants.get(userId) === grant) revoke(userId);
          await auditRevocation(grant);
          throw new WalletVaultServiceError("vault_locked");
        }
        return {
          grantId: grant.grantId,
          expiresAt: grant.expiresAt.toISOString(),
          passwordEpoch: grant.passwordEpoch,
        };
      });
    },

    /**
     * Lock the vault for a person: the grant ends now, in memory first and
     * in audit best-effort. Serialized with unlock per person, so a lock
     * issued during an in-flight unlock still wins.
     */
    async lock(userId: string): Promise<{ locked: true }> {
      return serialized(userId, async () => {
        const grant = revoke(userId);
        if (grant) await auditRevocation(grant);
        return { locked: true as const };
      });
    },

    /** End every grant, on shutdown. No audit writes: the process is going away. */
    lockAll(): void {
      for (const userId of [...grants.keys()]) revoke(userId);
    },

    /**
     * Sign for a wallet under a grant. Not implemented yet — migration now
     * lands wallets in password envelopes, but signing itself is a later
     * step — so after grant and wallet validation this refuses, typed,
     * rather than pretend to sign.
     */
    /**
     * Sign one stored proposal with its wallet's key.
     *
     * The caller names the proposal and supplies nothing else: the proposal is
     * re-read here, its canonical hash is recomputed from the stored fields and
     * compared against the hash recorded when the owner approved it, and only
     * then is the wallet's key opened and the transaction signed. A caller can
     * therefore never swap in different fields, a different proposal, or a
     * different wallet between confirmation and signing.
     */
    async sign(input: {
      proposalId: string;
      userId: string;
      grantId: string;
    }): Promise<WalletVaultSignResult> {
      const grant = await requireGrant(input.userId, input.grantId, "sign");
      const proposal = await deps.store.readProposal({
        proposalId: input.proposalId,
        userId: input.userId,
      });
      if (!proposal) throw new WalletVaultServiceError("proposal_not_found");
      if (proposal.status !== "proposed" || proposal.expiresAt.getTime() <= now().getTime()) {
        throw new WalletVaultServiceError("proposal_not_signable");
      }
      // The stored hash is the fingerprint the owner confirmed. Recompute it from
      // the stored fields: a mismatch means the row was altered after approval, and
      // the proposal must not be signed.
      const canonicalHash = walletProposalCanonicalHash({
        from: proposal.fromAddress,
        chainId: proposal.chainId,
        to: proposal.to,
        value: proposal.amountWei,
        data: proposal.data,
        nonce: proposal.nonce,
        gasLimit: proposal.gasLimit,
        maxFeePerGas: proposal.maxFeePerGas,
        maxPriorityFeePerGas: proposal.maxPriorityFeePerGas,
      });
      if (canonicalHash !== proposal.canonicalHash) {
        throw new WalletVaultServiceError("proposal_tampered");
      }
      await requireMigratedWallet(input.userId, proposal.walletId);
      const envelope = await deps.store.readWalletKeyEnvelope({
        walletId: proposal.walletId,
        userId: input.userId,
      });
      if (!envelope) throw new WalletVaultServiceError("wallet_not_found");
      const opened = await openWalletKeyWithPassword({
        walletId: proposal.walletId,
        envelope,
        password: grant.passwordMaterial.toString("utf8"),
      });
      let privateKey: Buffer;
      try {
        privateKey = walletSigningKey(opened);
      } catch (error) {
        opened.fill(0);
        throw error;
      }
      // The reader may have decoded a fresh buffer; the sealed bytes are no longer needed.
      if (privateKey !== opened) opened.fill(0);
      try {
        const signed = signEip1559Transaction(
          {
            chainId: proposal.chainId,
            nonce: proposal.nonce,
            to: proposal.to,
            value: proposal.amountWei,
            data: proposal.data,
            gasLimit: proposal.gasLimit,
            maxFeePerGas: proposal.maxFeePerGas,
            maxPriorityFeePerGas: proposal.maxPriorityFeePerGas,
          },
          privateKey,
        );
        // The canonical hash binds the proposal to one sender. If the key just
        // used does not control that sender, the signature would not match what
        // the owner confirmed — refuse rather than hand back the wrong signature.
        if (signed.from.toLowerCase() !== proposal.fromAddress.toLowerCase()) {
          throw new WalletVaultServiceError("wallet_key_mismatch");
        }
        return signed;
      } finally {
        privateKey.fill(0);
      }
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
