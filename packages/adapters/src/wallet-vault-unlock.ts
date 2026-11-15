import type { WalletVaultStatus } from "@rakazo/contracts";
import { isOwnerStartedRun } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { WalletVaultClient } from "./wallet-vault-client.js";
import { WalletVaultClientError } from "./wallet-vault-client.js";
import { walletVaultStatus } from "./wallet-vault-impl.js";
import type { WalletVaultGrantOperation, WalletVaultGrantStatus } from "./wallet-vault-service.js";
import { WALLET_VAULT_GRANT_OPERATIONS } from "./wallet-vault-service.js";

/**
 * The live unlock state for the settings surface, and the server-side
 * answer to "may this run use the wallet vault?" Both read the vault
 * service's live grant — the durable password row alone never authorizes
 * anything — and both fail closed when the vault cannot be reached.
 *
 * Unlock itself is an owner-session act: the RPCs that call the vault live
 * on the signed-in session only, and no bot tool reaches them. This module
 * is the other half of that boundary, for runs: a bot-initiated run must
 * not use an unlocked vault merely because the owner unlocked it earlier.
 * Proposal creation (PR 6) and signing (PR 7) call
 * {@link authorizeWalletRunOperation} before touching the vault; until
 * then this module's unit tests are the proof the gate holds.
 *
 * Nothing here logs, and no error or result carries a password, a grant
 * handle, or key material.
 */

/** The locked shape every vault failure degrades to: locked, unavailable. */
function lockedStatus(configured: boolean, changedAt: string | null): WalletVaultStatus {
  return {
    configured,
    changedAt,
    unlocked: false,
    expiresAt: null,
    passwordEpoch: null,
    vaultAvailable: false,
  };
}

/**
 * The owner's vault state as the settings surface may see it: the durable
 * password state from the database, plus the live grant from the vault.
 * When the vault is absent or does not answer, the vault reads as locked —
 * the UI shows the vault unavailable and disables unlock, never a stale
 * "unlocked" from an earlier read.
 */
export async function walletVaultUnlockStatus(input: {
  prisma: PrismaClient;
  vaultClient: WalletVaultClient | null;
  userId: string;
}): Promise<WalletVaultStatus> {
  const stored = await walletVaultStatus(input.prisma, input.userId);
  if (!input.vaultClient) return lockedStatus(stored.configured, stored.changedAt);
  let live: WalletVaultGrantStatus;
  try {
    live = await input.vaultClient.status(input.userId);
  } catch (error) {
    if (error instanceof WalletVaultClientError) {
      return lockedStatus(stored.configured, stored.changedAt);
    }
    throw error;
  }
  return {
    configured: stored.configured,
    changedAt: stored.changedAt,
    unlocked: live.unlocked,
    expiresAt: live.expiresAt,
    passwordEpoch: live.passwordEpoch,
    vaultAvailable: true,
  };
}

/** Why a run may not use the wallet vault. */
export type WalletRunAuthorizationErrorCode =
  | "run_not_owner_started"
  | "vault_not_configured"
  | "vault_locked"
  | "vault_unavailable"
  | "operation_not_allowed";

const RUN_AUTHORIZATION_MESSAGES: Record<WalletRunAuthorizationErrorCode, string> = {
  run_not_owner_started: "Only a run the owner started can use the wallet vault.",
  vault_not_configured: "No wallet password is set yet.",
  vault_locked: "The wallet vault is locked.",
  vault_unavailable: "The wallet vault is unavailable.",
  operation_not_allowed: "The unlock grant does not allow this operation.",
};

/** A run refused the wallet vault, with the one stable reason. */
export class WalletRunAuthorizationError extends Error {
  readonly code: WalletRunAuthorizationErrorCode;
  constructor(code: WalletRunAuthorizationErrorCode) {
    super(RUN_AUTHORIZATION_MESSAGES[code]);
    this.name = "WalletRunAuthorizationError";
    this.code = code;
  }
}

/**
 * May this run use the wallet vault for this operation class? The run's
 * owner-started-ness comes from the server's own run record — never a
 * bot-supplied flag — and is checked first, so a routine run is refused
 * even while the vault is unlocked. The vault's live grant is checked
 * second: unconfigured, locked, expired, or unreachable all refuse.
 * Resolves with the grant expiry the operation may rely on; the expiry is
 * fixed at unlock and nothing here extends it.
 */
export async function authorizeWalletRunOperation(input: {
  userId: string;
  run: { trigger: string; followUpFromUser: boolean };
  operation: WalletVaultGrantOperation;
  vaultClient: WalletVaultClient | null;
}): Promise<{ expiresAt: string }> {
  if (!WALLET_VAULT_GRANT_OPERATIONS.includes(input.operation)) {
    throw new WalletRunAuthorizationError("operation_not_allowed");
  }
  if (!isOwnerStartedRun(input.run.trigger, input.run.followUpFromUser)) {
    throw new WalletRunAuthorizationError("run_not_owner_started");
  }
  if (!input.vaultClient) {
    throw new WalletRunAuthorizationError("vault_unavailable");
  }
  let status: WalletVaultGrantStatus;
  try {
    status = await input.vaultClient.status(input.userId);
  } catch (error) {
    if (error instanceof WalletVaultClientError) {
      throw new WalletRunAuthorizationError("vault_unavailable");
    }
    throw error;
  }
  if (!status.configured) {
    throw new WalletRunAuthorizationError("vault_not_configured");
  }
  if (!status.unlocked || status.expiresAt === null) {
    throw new WalletRunAuthorizationError("vault_locked");
  }
  return { expiresAt: status.expiresAt };
}
