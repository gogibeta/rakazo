import { ORPCError } from "@orpc/server";
import {
  consumeWalletRemovalConfirmation,
  issueWalletRemovalConfirmation,
  WalletRemovalConfirmationError,
} from "@rakazo/adapters/wallet-removal-confirmation";
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
import { walletProposalRoutes } from "./wallet-proposals.js";

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

/**
 * The placeholder name a removed wallet is left holding. `@@unique([userId,
 * name])` means the real name must be given up so the owner can add a new
 * wallet under it; the row's id keeps the placeholder unique, and it is
 * recognisable in a database dump as not a name anyone chose.
 */
function removedWalletName(id: string): string {
  return `removed:${id}`;
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
      // Proposal RPCs live beside the wallet list, in the same family.
      ...walletProposalRoutes(ctx),
      list: authed.wallets.list.handler(async ({ context }) => {
        const rows = await deps.prisma.userWallet.findMany({
          where: { userId: context.actor.userId, removedAt: null },
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
          where: { userId: context.actor.userId, name: input.name, removedAt: null },
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
      /** Issue a single-use token for removing one wallet, with its name and address to check. */
      requestRemove: authed.wallets.requestRemove.handler(async ({ context, input }) => {
        try {
          return await issueWalletRemovalConfirmation({
            prisma: deps.prisma,
            userId: context.actor.userId,
            walletId: input.walletId,
          });
        } catch (error) {
          if (error instanceof WalletRemovalConfirmationError) {
            throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
          }
          throw error;
        }
      }),
      remove: authed.wallets.remove.handler(async ({ context, input }) => {
        // Soft delete. The row keeps the secret and the name it had, so the
        // owner can undo a removal — a hard delete here destroyed the only
        // copy of a key the owner may not have written down anywhere else.
        // `name` is released in the same write because `@@unique([userId,
        // name])` would otherwise block re-adding a wallet under that name;
        // `removedName` is what a restore puts back.
        const row = await deps.prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: context.actor.userId, removedAt: null },
          select: { id: true, name: true, chain: true },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        // The token is checked before the write and consumed in the same
        // request: a removal replayed from somewhere the owner is not looking
        // still needs a token they were shown this wallet's name for.
        try {
          await consumeWalletRemovalConfirmation({
            prisma: deps.prisma,
            userId: context.actor.userId,
            walletId: row.id,
            token: input.confirmationToken,
          });
        } catch (error) {
          if (error instanceof WalletRemovalConfirmationError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        // Read the name before the write: the audit event must name the wallet
        // the owner removed, not the placeholder the row is left holding.
        const { name } = row;
        // Conditional on `removedAt: null` so two removals cannot race: the
        // loser sees count 0 and reports not-found rather than rewriting the
        // name of a wallet the winner already released.
        const removed = await deps.prisma.userWallet.updateMany({
          where: { id: row.id, userId: context.actor.userId, removedAt: null },
          data: {
            removedAt: new Date(),
            removedName: name,
            name: removedWalletName(row.id),
          },
        });
        if (removed.count === 0) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        // Audited after the write: a removal that did not happen is not logged
        // as one. The event carries the chain and the name, never the secret.
        await recordSecurityEvent({
          type: "wallet.removed",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: { walletId: row.id, chain: row.chain, name },
        });
        return { ok: true as const };
      }),
      /** Undo a removal. Only a removed wallet can be restored, and only by its owner. */
      restore: authed.wallets.restore.handler(async ({ context, input }) => {
        const row = await deps.prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: context.actor.userId, removedAt: { not: null } },
          select: { id: true, name: true, removedName: true },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Removed wallet not found" });
        const name = row.removedName ?? row.name; // The name was released on removal, so the owner may have added a
        // different wallet under it since. Restoring would violate the unique
        // constraint, so refuse with something the owner can act on instead of
        // letting the database error surface as a 500.
        const clash = await deps.prisma.userWallet.findFirst({
          where: { userId: context.actor.userId, name, removedAt: null },
          select: { id: true },
        });
        if (clash) {
          throw new ORPCError("BAD_REQUEST", {
            message: `A wallet named "${name}" already exists. Rename or remove it first.`,
          });
        }
        const restored = await deps.prisma.userWallet.updateMany({
          where: { id: row.id, userId: context.actor.userId, removedAt: { not: null } },
          data: { removedAt: null, removedName: null, name },
        });
        if (restored.count === 0)
          throw new ORPCError("NOT_FOUND", { message: "Removed wallet not found" });
        await recordSecurityEvent({
          type: "wallet.restored",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: { walletId: row.id, name },
        });
        const back = await deps.prisma.userWallet.findUniqueOrThrow({ where: { id: row.id } });
        return summary(back);
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
          where: { id: input.walletId, userId: context.actor.userId, removedAt: null },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Wallet not found" });
        return summary(row);
      }),
      uses: authed.wallets.uses.handler(async ({ context, input }) => {
        const wallet = await deps.prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: context.actor.userId, removedAt: null },
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
