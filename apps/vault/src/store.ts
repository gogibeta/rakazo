import { verifyWalletVaultPassword } from "@rakazo/adapters/wallet-vault";
import type { WalletVaultStore } from "@rakazo/adapters/wallet-vault-service";
import type { PrismaClient } from "@rakazo/db";
import { requireMembership, runAsTenant } from "@rakazo/db";

/**
 * The vault's durable state over the database: the wallet-vault password
 * row (through the adapters password state, so unlock shares the throttle
 * with password change), wallet migration status, and the unlock audit
 * trail. Every query runs in the owner's tenant scope — resolved from
 * their membership like any other request — so row-level security binds
 * the vault to the person's own rows exactly as it binds the API.
 */
export function createPrismaVaultStore(prisma: PrismaClient): WalletVaultStore {
  /**
   * Run one operation in the person's tenant scope. Membership is resolved
   * for THIS operation, never cached: a removed or relocated membership
   * must stop working with the next vault call, not with the next vault
   * restart. Vault operations are rare — an unlock, a lock, a status
   * check — so the one membership lookup per call costs nothing worth a
   * stale authorization.
   */
  async function asTenant<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const actor = await requireMembership(prisma, userId);
    return runAsTenant({ spaceId: actor.spaceId, userId: actor.userId }, fn);
  }

  return {
    async vaultState(userId) {
      return asTenant(userId, async () => {
        const row = await prisma.walletVault.findUnique({
          where: { userId },
          select: { passwordEpoch: true },
        });
        return { configured: row !== null, passwordEpoch: row?.passwordEpoch ?? null };
      });
    },

    async verifyPassword(userId, password) {
      return asTenant(userId, () => verifyWalletVaultPassword(prisma, userId, password));
    },

    async walletMigrationStatus(userId, walletId) {
      return asTenant(userId, async () => {
        const row = await prisma.userWallet.findFirst({
          where: { id: walletId, userId, removedAt: null },
          select: { migrationStatus: true },
        });
        return row?.migrationStatus ?? null;
      });
    },

    async recordUnlock(input) {
      await asTenant(input.userId, () =>
        prisma.vaultUnlock.create({
          data: {
            userId: input.userId,
            grantId: input.grantId,
            passwordEpoch: input.passwordEpoch,
            issuedAt: input.issuedAt,
            expiresAt: input.expiresAt,
          },
        }),
      );
    },

    async recordLock(input) {
      await asTenant(input.userId, () =>
        prisma.vaultUnlock.updateMany({
          where: { userId: input.userId, grantId: input.grantId, revokedAt: null },
          data: { revokedAt: input.revokedAt },
        }),
      );
    },

    async readProposal(input) {
      return asTenant(input.userId, async () => {
        const row = await prisma.walletProposal.findFirst({
          where: { id: input.proposalId, userId: input.userId },
          select: {
            id: true,
            walletId: true,
            fromAddress: true,
            chainId: true,
            to: true,
            amountWei: true,
            data: true,
            nonce: true,
            gasLimit: true,
            maxFeePerGas: true,
            maxPriorityFeePerGas: true,
            status: true,
            canonicalHash: true,
            expiresAt: true,
          },
        });
        if (!row) return null;
        return {
          proposalId: row.id,
          walletId: row.walletId,
          fromAddress: row.fromAddress,
          chainId: row.chainId,
          to: row.to,
          amountWei: row.amountWei,
          data: row.data,
          nonce: row.nonce,
          gasLimit: row.gasLimit,
          maxFeePerGas: row.maxFeePerGas,
          maxPriorityFeePerGas: row.maxPriorityFeePerGas,
          status: row.status,
          canonicalHash: row.canonicalHash,
          expiresAt: row.expiresAt,
        };
      });
    },

    async readWalletKeyEnvelope(input) {
      return asTenant(input.userId, async () => {
        const row = await prisma.userWallet.findFirst({
          where: { id: input.walletId, userId: input.userId, removedAt: null },
          select: { keyCiphertext: true, passwordWrap: true },
        });
        if (!row?.keyCiphertext || !row.passwordWrap) return null;
        return { keyCiphertext: row.keyCiphertext, passwordWrap: row.passwordWrap };
      });
    },
  };
}
