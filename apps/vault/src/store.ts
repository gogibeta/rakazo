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
  const tenants = new Map<string, { spaceId: string; userId: string }>();

  async function tenantFor(userId: string): Promise<{ spaceId: string; userId: string }> {
    const cached = tenants.get(userId);
    if (cached) return cached;
    const actor = await requireMembership(prisma, userId);
    const tenant = { spaceId: actor.spaceId, userId: actor.userId };
    tenants.set(userId, tenant);
    return tenant;
  }

  async function asTenant<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return runAsTenant(await tenantFor(userId), fn);
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
          where: { id: walletId, userId },
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
  };
}
