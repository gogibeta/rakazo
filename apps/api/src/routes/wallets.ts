import { ORPCError } from "@orpc/server";
import {
  changeWalletVaultPassword,
  migrateUserWalletToPasswordEnvelope,
  setupWalletVaultPassword,
  WalletMigrationError,
  WalletMigrationNotFoundError,
  WalletVaultAlreadyConfiguredError,
  WalletVaultNotConfiguredError,
  WalletVaultPasswordError,
} from "@rakazo/adapters/wallet-vault";
import { WalletVaultClientError } from "@rakazo/adapters/wallet-vault-client";
import { walletVaultUnlockStatus } from "@rakazo/adapters/wallet-vault-unlock";
import type {
  WalletChain,
  WalletMigrationStatus,
  WalletSummary,
  WalletUseSummary,
  WalletVaultStatus,
} from "@rakazo/contracts";
import { recordSecurityEvent } from "@rakazo/db";
import {
  walletMigrationEvent,
  walletVaultPasswordRejectedEvent,
  walletVaultUnlockRejectedEvent,
} from "../security-audit.js";
import { evmWalletFromSecret, WalletSecretError } from "../wallet-address.js";
import type { RouterContext } from "./context.js";

type WalletRow = {
  id: string;
  name: string;
  chain: string;
  address: string;
  migrationStatus: string;
  createdAt: Date;
};

/** What a list may show: the sealed secret never leaves the server. */
function summary(row: WalletRow): WalletSummary {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain as WalletChain,
    address: row.address,
    migrationStatus: row.migrationStatus as WalletMigrationStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

export function walletsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /**
   * The owner's vault state as the settings surface may see it: the durable
   * password state plus the vault's live grant. When the vault cannot be
   * reached this reads as locked and unavailable — never a stale "unlocked".
   */
  async function vaultStatusFor(userId: string): Promise<WalletVaultStatus> {
    return walletVaultUnlockStatus({
      prisma: deps.prisma,
      vaultClient: deps.walletVault ?? null,
      userId,
    });
  }

  return {
    wallets: {
      list: authed.wallets.list.handler(async ({ context }) => {
        const rows = await deps.prisma.userWallet.findMany({
          where: { userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return { wallets: rows.map(summary) };
      }),
      add: authed.wallets.add.handler(async ({ context, input }) => {
        // The address is derived before anything is stored, so a secret that
        // cannot be read saves nothing — and is never quoted back.
        let derived: { address: string; normalizedSecret: string };
        try {
          derived = evmWalletFromSecret(input.secret);
        } catch (error) {
          if (error instanceof WalletSecretError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        const existing = await deps.prisma.userWallet.findFirst({
          where: { userId: context.actor.userId, name: input.name },
          select: { id: true },
        });
        if (existing) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A wallet with this name already exists.",
          });
        }
        const row = await deps.prisma.userWallet.create({
          data: {
            userId: context.actor.userId,
            name: input.name,
            chain: input.chain ?? "evm",
            address: derived.address,
            // Placeholder replaced by the sealed value below, in the same
            // request; the row is deleted if sealing fails.
            secretCipher: "",
          },
        });
        try {
          // Sealed with the row's id as the record id, the way bot secrets seal.
          const stored = await deps.secrets.put(
            derived.normalizedSecret,
            {
              operationId: "wallets.add",
              traceId: "wallets.add",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            },
            { recordId: row.id },
          );
          const sealed = await deps.prisma.userWallet.update({
            where: { id: row.id },
            data: { secretCipher: stored.ciphertext },
          });
          return summary(sealed);
        } catch (error) {
          // Never leave a wallet behind whose secret silently did not save.
          await deps.prisma.userWallet.delete({ where: { id: row.id } }).catch(() => undefined);
          throw error;
        }
      }),
      remove: authed.wallets.remove.handler(async ({ context, input }) => {
        const removed = await deps.prisma.userWallet.deleteMany({
          where: { id: input.walletId, userId: context.actor.userId },
        });
        if (removed.count === 0) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        return { ok: true as const };
      }),
      // Migrating one wallet to its password envelope. Owner-only by
      // construction: this surface is the signed-in Settings session, the
      // password arrives with the call, and no bot tool can reach it. The
      // attempt's start and failure are recorded here; the success is
      // recorded by the audited-procedure table like every credential
      // change. None of the events carries the password or any secret.
      migrate: authed.wallets.migrate.handler(async ({ context, input }) => {
        try {
          await migrateUserWalletToPasswordEnvelope({
            prisma: deps.prisma,
            secretStore: deps.secrets,
            userId: context.actor.userId,
            walletId: input.walletId,
            password: input.password,
            deriveAddress: (secret) => evmWalletFromSecret(secret).address,
            hooks: {
              onEvent: async (event) => {
                if (event.outcome === "succeeded") return;
                await recordSecurityEvent(
                  walletMigrationEvent(context.actor, event.walletId, event.outcome),
                );
              },
              onPasswordRejected: async (info) => {
                await recordSecurityEvent(walletVaultPasswordRejectedEvent(context.actor, info));
              },
            },
          });
        } catch (error) {
          if (error instanceof WalletMigrationNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: error.message });
          }
          if (
            error instanceof WalletVaultNotConfiguredError ||
            error instanceof WalletVaultPasswordError ||
            error instanceof WalletMigrationError
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        const row = await deps.prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: context.actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        return summary(row);
      }),
      uses: authed.wallets.uses.handler(async ({ context, input }) => {
        const wallet = await deps.prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: context.actor.userId },
          select: { id: true },
        });
        if (!wallet) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        const rows = await deps.prisma.userWalletUse.findMany({
          where: { walletId: wallet.id, userId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        const uses: WalletUseSummary[] = rows.map((row) => ({
          id: row.id,
          botName: row.botName,
          purpose: row.purpose,
          site: row.site,
          createdAt: row.createdAt.toISOString(),
        }));
        return { uses };
      }),
      // The wallet-vault password: only its existence, last change, and the
      // live unlock state are ever read back. Passwords arrive over the
      // signed-in session and go straight to the vault state; they are
      // never stored or logged.
      vaultStatus: authed.wallets.vaultStatus.handler(async ({ context }) =>
        vaultStatusFor(context.actor.userId),
      ),
      // Unlocking the vault for six hours. Owner-session only by
      // construction: this surface is the signed-in Settings session, and
      // no bot tool can reach it. The vault verifies the password against
      // the shared throttle and writes the audit row before the grant
      // returns; a rejected attempt is recorded here too. The grant handle
      // never crosses — only the fresh status.
      vaultUnlock: authed.wallets.vaultUnlock.handler(async ({ context, input }) => {
        const client = deps.walletVault ?? null;
        if (!client) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            message: "The wallet vault is unavailable.",
          });
        }
        try {
          await client.unlock(context.actor.userId, input.password);
        } catch (error) {
          if (error instanceof WalletVaultClientError) {
            if (error.code === "password_rejected") {
              await recordSecurityEvent(walletVaultUnlockRejectedEvent(context.actor));
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            if (error.code === "not_configured") {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw new ORPCError("SERVICE_UNAVAILABLE", {
              message: "The wallet vault is unavailable.",
            });
          }
          throw error;
        }
        return vaultStatusFor(context.actor.userId);
      }),
      // Locking the vault now: the grant ends immediately, whatever the
      // clock said. When the vault cannot be reached the lock is refused
      // rather than claimed — the grant may still be live in the vault.
      vaultLock: authed.wallets.vaultLock.handler(async ({ context }) => {
        const client = deps.walletVault ?? null;
        if (!client) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            message: "The wallet vault is unavailable.",
          });
        }
        try {
          await client.lock(context.actor.userId);
        } catch (error) {
          if (error instanceof WalletVaultClientError) {
            throw new ORPCError("SERVICE_UNAVAILABLE", {
              message: "The wallet vault is unavailable.",
            });
          }
          throw error;
        }
        return vaultStatusFor(context.actor.userId);
      }),
      setVaultPassword: authed.wallets.setVaultPassword.handler(async ({ context, input }) => {
        try {
          await setupWalletVaultPassword(deps.prisma, context.actor.userId, input.password);
        } catch (error) {
          if (error instanceof WalletVaultAlreadyConfiguredError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        return vaultStatusFor(context.actor.userId);
      }),
      changeVaultPassword: authed.wallets.changeVaultPassword.handler(
        async ({ context, input }) => {
          try {
            await changeWalletVaultPassword(deps.prisma, context.actor.userId, input, {
              onRejected: async (info) => {
                await recordSecurityEvent(walletVaultPasswordRejectedEvent(context.actor, info));
              },
            });
          } catch (error) {
            if (error instanceof WalletVaultPasswordError) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw error;
          }
          return vaultStatusFor(context.actor.userId);
        },
      ),
    },
  };
}
