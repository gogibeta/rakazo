import { resolveVaultServiceToken } from "@rakazo/core";
import type {
  WalletVaultGrantStatus,
  WalletVaultServiceErrorCode,
  WalletVaultUnlockResult,
} from "./wallet-vault-service.js";

/**
 * The API and worker's only path to the wallet vault: a small HTTP client
 * for the vault service's internal API. It exists so no other process ever
 * touches a wallet password beyond passing an owner's unlock attempt
 * through, and never receives key material back — responses are rebuilt
 * field by field from the vault's structured results, so nothing the vault
 * did not mean to send can cross.
 *
 * Every failure is a {@link WalletVaultClientError}. A vault that cannot be
 * reached, times out, or answers off-shape reports `vault_unavailable`:
 * callers fail closed, with no fallback path and no local key handling.
 * Calls are single attempts — retrying a refused or ambiguous vault call
 * is the caller's explicit decision, never this client's.
 */

export type WalletVaultClientErrorCode =
  | WalletVaultServiceErrorCode
  | "unauthorized"
  | "invalid_request"
  | "vault_unavailable";

const CLIENT_ERROR_MESSAGES: Record<WalletVaultClientErrorCode, string> = {
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
  unauthorized: "The vault refused the service credential.",
  invalid_request: "The vault refused the request.",
  vault_unavailable: "The wallet vault is unavailable.",
};

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(CLIENT_ERROR_MESSAGES));

/** A vault call failure with a stable code. Never carries a password or material. */
export class WalletVaultClientError extends Error {
  readonly code: WalletVaultClientErrorCode;
  constructor(code: WalletVaultClientErrorCode) {
    super(CLIENT_ERROR_MESSAGES[code]);
    this.name = "WalletVaultClientError";
    this.code = code;
  }
}

/** A completed sign, as the vault will report it: the hash and the use record, nothing else. */
export type WalletVaultSignResult = { txHash: string; walletUseId: string };

export type WalletVaultClient = ReturnType<typeof createWalletVaultClient>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WalletVaultClientError("vault_unavailable");
  }
  return value;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new WalletVaultClientError("vault_unavailable");
  }
  return value;
}

function nullableEpochField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new WalletVaultClientError("vault_unavailable");
  }
  return value;
}

/**
 * Create a vault client for an explicit vault address and service token.
 * The token is the deployment's dedicated vault credential; it is sent as
 * a bearer token and never logged.
 */
export function createWalletVaultClient(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Unreachable, timed out, or aborted: the vault is unavailable and
      // the operation did not happen. Nothing falls back to local handling.
      throw new WalletVaultClientError("vault_unavailable");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WalletVaultClientError("vault_unavailable");
    }
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
      if (KNOWN_CODES.has(code))
        throw new WalletVaultClientError(code as WalletVaultClientErrorCode);
      throw new WalletVaultClientError("vault_unavailable");
    }
    if (!isRecord(payload)) throw new WalletVaultClientError("vault_unavailable");
    return payload;
  }

  return {
    /** Unlock state for a person: configured, unlocked, grant expiry, epoch. */
    async status(userId: string): Promise<WalletVaultGrantStatus> {
      const payload = await call("/v1/status", { userId });
      if (typeof payload.configured !== "boolean" || typeof payload.unlocked !== "boolean") {
        throw new WalletVaultClientError("vault_unavailable");
      }
      return {
        configured: payload.configured,
        unlocked: payload.unlocked,
        expiresAt: nullableStringField(payload, "expiresAt"),
        passwordEpoch: nullableEpochField(payload, "passwordEpoch"),
      };
    },

    /**
     * Pass an owner's unlock attempt to the vault. The password crosses to
     * the vault only; the result is the grant handle and its fixed expiry.
     */
    async unlock(userId: string, password: string): Promise<WalletVaultUnlockResult> {
      const payload = await call("/v1/unlock", { userId, password });
      const passwordEpoch = nullableEpochField(payload, "passwordEpoch");
      if (passwordEpoch === null) throw new WalletVaultClientError("vault_unavailable");
      return {
        grantId: stringField(payload, "grantId"),
        expiresAt: stringField(payload, "expiresAt"),
        passwordEpoch,
      };
    },

    /** End the person's grant now. */
    async lock(userId: string): Promise<{ locked: true }> {
      const payload = await call("/v1/lock", { userId });
      if (payload.locked !== true) throw new WalletVaultClientError("vault_unavailable");
      return { locked: true as const };
    },

    /** Ask the vault to sign for a wallet under a grant. Returns only the hash. */
    async sign(input: {
      userId: string;
      grantId: string;
      walletId: string;
    }): Promise<WalletVaultSignResult> {
      const payload = await call("/v1/sign", { ...input });
      return {
        txHash: stringField(payload, "txHash"),
        walletUseId: stringField(payload, "walletUseId"),
      };
    },

    /** Ask the vault's fill broker to fill a wallet secret into an approved page. */
    async fill(input: {
      userId: string;
      grantId: string;
      walletId: string;
      site: string;
    }): Promise<{ ok: true }> {
      const payload = await call("/v1/fill", { ...input });
      if (payload.ok !== true) throw new WalletVaultClientError("vault_unavailable");
      return { ok: true as const };
    },
  };
}

/**
 * The vault client for this process, from the environment: `VAULT_URL`
 * names the vault service, and the token is the deployment's dedicated
 * vault credential. Returns null when no vault is configured for this
 * process (or the credential cannot be resolved), which callers treat as
 * the vault being unavailable — wallet operations fail closed either way.
 */
export function vaultClientFromEnv(env: NodeJS.ProcessEnv = process.env): WalletVaultClient | null {
  const baseUrl = env.VAULT_URL?.trim();
  if (!baseUrl) return null;
  let token: string;
  try {
    token = resolveVaultServiceToken(env);
  } catch {
    return null;
  }
  return createWalletVaultClient({ baseUrl, token });
}
