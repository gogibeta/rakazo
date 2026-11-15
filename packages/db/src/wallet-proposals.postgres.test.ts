import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

/**
 * What the database itself guarantees about a stored wallet proposal, run as
 * the application's runtime login (`rakazo_app`), not as the migration owner.
 *
 * The service can be wrong, and a future caller can be careless; these tests
 * describe the boundary underneath both. A proposal is a transaction its owner
 * may later be asked to sign, so its canonical payload, its sender, its owner,
 * its wallet and its lifetime are written once, and the only change any writer
 * can make is `proposed -> cancelled | expired`.
 *
 * The trigger these tests exercise is created by
 * 20261222130000_wallet_proposals_integrity; the constraints are too.
 */
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("wallet proposals are immutable (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `wp-owner-${suffix}`;
  const otherUserId = `wp-other-${suffix}`;
  const walletId = `wp-wallet-${suffix}`;
  const otherWalletId = `wp-wallet-other-${suffix}`;
  const fromAddress = "0x1111111111111111111111111111111111111111";
  const proposalId = `wp-proposal-${suffix}`;
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;

  const canonicalHash = createHash("sha256").update(`proposal-${suffix}`).digest("hex");

  /**
   * Insert one proposal through the runtime login's raw SQL — the statement an
   * attacker holding the application's own credentials would run, so the one the
   * database must refuse. Runs inside the owner's tenant scope, as any request
   * writing their proposal would.
   */
  function insertProposal(
    overrides: Partial<{
      id: string;
      userId: string;
      walletId: string;
      fromAddress: string;
      chainId: number;
      amountWei: string;
      nonce: number;
      gasLimit: string;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
      status: string;
      expiresAt: string;
    }> = {},
  ) {
    const values = {
      id: proposalId,
      userId,
      walletId,
      fromAddress,
      chainId: 99801,
      amountWei: "1000",
      nonce: 3,
      gasLimit: "25201",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
      status: "proposed",
      expiresAt: "15 minutes",
      ...overrides,
    };
    const sql = `INSERT INTO "wallet_proposals" (
        "id", "userId", "walletId", "fromAddress", "chainId", "to", "asset", "amountWei",
        "data", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rpcProfile",
        "status", "canonicalHash", "expiresAt"
      ) VALUES ($1, $2, $3, $4, $5, '0x2222222222222222222222222222222222222222',
                'HYPE', $6, NULL, $7, $8, $9, $10, 'elysium-testnet', $11, $12,
                now() + $13::interval)`;
    const params = [
      values.id,
      values.userId,
      values.walletId,
      values.fromAddress,
      values.chainId,
      values.amountWei,
      values.nonce,
      values.gasLimit,
      values.maxFeePerGas,
      values.maxPriorityFeePerGas,
      values.status,
      canonicalHash,
      values.expiresAt,
    ];
    // A system scope is needed only when the row is deliberately someone else's; the
    // database's own constraints are what the test is asking about, not the policies.
    return values.userId === userId
      ? runAsTenant({ spaceId: "unused-space", userId }, () => db.$executeRawUnsafe(sql, ...params))
      : runAsSystem("seed a proposal that must be refused", () =>
          db.$executeRawUnsafe(sql, ...params),
        );
  }

  /**
   * One raw statement as the runtime login would run it for this owner: inside
   * their tenant scope, so the row is visible and the database's own rules are
   * what decides the outcome.
   */
  function asOwner(statement: string): Promise<number> {
    return runAsTenant({ spaceId: "unused-space", userId }, () => db.$executeRawUnsafe(statement));
  }

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 2 });
    db = app.prisma;
    const o = owner.prisma;
    await o.user.createMany({
      data: [
        { id: userId, name: "Proposal owner", email: `${userId}@rakazo.test` },
        { id: otherUserId, name: "Someone else", email: `${otherUserId}@rakazo.test` },
      ],
    });
    await o.userWallet.createMany({
      data: [
        {
          id: walletId,
          userId,
          name: "burner",
          chain: "evm",
          address: fromAddress,
          secretCipher: "",
          keyCiphertext: "pwk-v1:test",
          passwordWrap: "pw-v1:test",
          migrationStatus: "password_protected",
        },
        {
          id: otherWalletId,
          userId: otherUserId,
          name: "theirs",
          chain: "evm",
          address: "0x3333333333333333333333333333333333333333",
          secretCipher: "",
          keyCiphertext: "pwk-v1:test",
          passwordWrap: "pw-v1:test",
          migrationStatus: "password_protected",
        },
      ],
    });
    await insertProposal();
  });

  afterAll(async () => {
    try {
      await owner?.prisma.walletProposal.deleteMany({
        where: { userId: { in: [userId, otherUserId] } },
      });
      await owner?.prisma.userWallet.deleteMany({
        where: { id: { in: [walletId, otherWalletId] } },
      });
      await owner?.prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    } finally {
      await app?.prisma.$disconnect().catch(() => undefined);
      await app?.pool.end().catch(() => undefined);
      await owner?.prisma.$disconnect().catch(() => undefined);
      await owner?.pool.end().catch(() => undefined);
    }
  });

  it("runs as the runtime login, not the migration owner", async () => {
    const [row] = await db.$queryRaw<Array<{ login: string; owner: boolean }>>`
      SELECT current_user AS login, (
        SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user
      ) AS owner`;
    expect(row?.owner).toBe(false);
    expect(row?.login).not.toBe(decodeURIComponent(new URL(migrationUrl!).username));
  });

  it("refuses to rewrite the amount, the recipient, the calldata or the fees", async () => {
    const attempts = [
      `UPDATE "wallet_proposals" SET "amountWei" = '999999' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "to" = '0x4444444444444444444444444444444444444444' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "data" = '0xdead' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "nonce" = 99 WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "gasLimit" = '90000' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "maxFeePerGas" = '9' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "maxPriorityFeePerGas" = '1' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "canonicalHash" = repeat('b', 64) WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "fromAddress" = '0x5555555555555555555555555555555555555555' WHERE "id" = '${proposalId}'`,
    ];
    for (const statement of attempts) {
      await expect(asOwner(statement), statement).rejects.toThrow(/canonical fields are immutable/);
    }
    const [row] = await runAsTenant(
      { spaceId: "unused-space", userId },
      () =>
        db.$queryRaw<Array<{ amountWei: string; nonce: number; hash: string }>>`
        SELECT "amountWei", "nonce", "canonicalHash" AS hash
        FROM "wallet_proposals" WHERE "id" = ${proposalId}`,
    );
    expect(row).toMatchObject({ amountWei: "1000", nonce: 3, hash: canonicalHash });
  });

  it("refuses to change ownership, the wallet binding or the lifetime", async () => {
    for (const statement of [
      `UPDATE "wallet_proposals" SET "userId" = '${otherUserId}' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "walletId" = '${otherWalletId}' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "expiresAt" = now() + interval '10 hours' WHERE "id" = '${proposalId}'`,
      `UPDATE "wallet_proposals" SET "createdAt" = now() - interval '1 day' WHERE "id" = '${proposalId}'`,
    ]) {
      await expect(asOwner(statement), statement).rejects.toThrow(/canonical fields are immutable/);
    }
  });

  it("allows exactly one transition, proposed to cancelled, and then nothing", async () => {
    await expect(
      asOwner(`UPDATE "wallet_proposals" SET "status" = 'cancelled' WHERE "id" = '${proposalId}'`),
    ).resolves.toBe(1);
    for (const next of ["proposed", "expired"]) {
      await expect(
        asOwner(`UPDATE "wallet_proposals" SET "status" = '${next}' WHERE "id" = '${proposalId}'`),
      ).rejects.toThrow(/may only move from proposed/);
    }
    const [row] = await runAsTenant(
      { spaceId: "unused-space", userId },
      () =>
        db.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "wallet_proposals" WHERE "id" = ${proposalId}`,
    );
    expect(row?.status).toBe("cancelled");
  });

  it("refuses a row whose wallet belongs to someone else", async () => {
    // The composite key is the database-level answer to "is this the owner's wallet".
    await expect(
      insertProposal({ id: `wp-mismatch-${suffix}`, userId: otherUserId, walletId }),
    ).rejects.toThrow(/wallet_proposals_walletId_userId_fkey/);
  });

  it("refuses a malformed or out-of-range row outright", async () => {
    const attempts: Array<[Record<string, string | number>, RegExp]> = [
      [{ chainId: 1 }, /wallet_proposals_chain_chk/],
      [{ amountWei: "1.5" }, /amount_canonical_chk/],
      [{ amountWei: "-1" }, /amount_canonical_chk/],
      [{ gasLimit: "0" }, /gas_canonical_chk/],
      [{ maxPriorityFeePerGas: "9000000000" }, /fees_canonical_chk/],
      [{ status: "signed" }, /wallet_proposals_status_chk/],
      [{ expiresAt: "3 hours" }, /wallet_proposals_lifetime_chk/],
      [{ fromAddress: "0x1234" }, /wallet_proposals_from_chk/],
    ];
    for (const [overrides, expected] of attempts) {
      await expect(
        insertProposal({ id: `wp-bad-${suffix}-${Object.keys(overrides)[0]}`, ...overrides }),
      ).rejects.toThrow(expected);
    }
  });

  it("lets a proposal be deleted with its wallet, as an account removal does", async () => {
    // Destroying a proposal is not rewriting one: the pair below has no history worth
    // preserving, and the cascade must keep working for account deletion.
    const throwawayWallet = `wp-throwaway-${suffix}`;
    const throwawayProposal = `wp-throwaway-proposal-${suffix}`;
    await owner.prisma.userWallet.create({
      data: {
        id: throwawayWallet,
        userId,
        name: "throwaway",
        chain: "evm",
        address: "0x6666666666666666666666666666666666666666",
        secretCipher: "",
        keyCiphertext: "pwk-v1:test",
        passwordWrap: "pw-v1:test",
        migrationStatus: "password_protected",
      },
    });
    await insertProposal({
      id: throwawayProposal,
      walletId: throwawayWallet,
      fromAddress: "0x6666666666666666666666666666666666666666",
    });
    await owner.prisma.userWallet.delete({ where: { id: throwawayWallet } });
    await expect(
      owner.prisma.walletProposal.findUnique({ where: { id: throwawayProposal } }),
    ).resolves.toBeNull();
  });
});
