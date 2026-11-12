import { ORPCError } from "@orpc/server";
import type { WalletChain, WalletSummary, WalletUseSummary } from "@rakazo/contracts";
import { evmWalletFromSecret, WalletSecretError } from "../wallet-address.js";
import type { RouterContext } from "./context.js";

type WalletRow = {
  id: string;
  name: string;
  chain: string;
  address: string;
  createdAt: Date;
};

/** What a list may show: the sealed secret never leaves the server. */
function summary(row: WalletRow): WalletSummary {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain as WalletChain,
    address: row.address,
    createdAt: row.createdAt.toISOString(),
  };
}

export function walletsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
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
    },
  };
}
