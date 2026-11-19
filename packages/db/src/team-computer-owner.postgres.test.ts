import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { teamComputerUserId } from "./computers.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/**
 * `teamComputerUserId` runs its lookup as system in whichever client it is given.
 * A root client and a transaction client are told apart by `$transaction`, which
 * only the root one carries: `$queryRaw` is on both, so testing for it sent every
 * root client down the transaction-local path, where the bypass is gone before
 * the lookup runs, the owner is missed, and the caller silently falls back to
 * `input.userId`.
 */
describePostgres("teamComputerUserId (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `team-org-${suffix}`;
  const spaceId = `team-space-${suffix}`;
  const ownerUserId = `team-owner-${suffix}`;
  const memberUserId = `team-member-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).organization.create({
      data: { id: organizationId, name: "Team", slug: organizationId, createdAt: new Date() },
    });
    await asSystem(prisma).user.createMany({
      data: [ownerUserId, memberUserId].map((id) => ({
        id,
        name: id,
        email: `${id}@rakazo.test`,
        emailVerified: true,
      })),
    });
    await asSystem(prisma).space.create({
      data: {
        id: spaceId,
        organizationId,
        name: "Shared",
        isDefault: true,
        createdByUserId: ownerUserId,
      },
    });
    // The trigger adds each new member to the organization's default Space, so the
    // space_members rows are already there; give the owner's the owner role, since
    // the trigger copies the organization role it was inserted with.
    await asSystem(prisma).member.createMany({
      data: [
        {
          id: `${ownerUserId}-member`,
          organizationId,
          userId: ownerUserId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: `${memberUserId}-member`,
          organizationId,
          userId: memberUserId,
          role: "member",
          createdAt: new Date(),
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).organization.deleteMany({ where: { id: organizationId } });
    await asSystem(prisma).user.deleteMany({ where: { id: { in: [ownerUserId, memberUserId] } } });
    await close();
  });

  it("returns the Space owner from a root client, not the caller", async () => {
    // A non-owner member asks: the answer must be the owner, never the fallback.
    const resolved = await runAsTenant({ spaceId, userId: memberUserId }, () =>
      teamComputerUserId(prisma, { spaceId, userId: memberUserId }),
    );
    expect(resolved).toBe(ownerUserId);
    expect(resolved).not.toBe(memberUserId);
  });

  it("returns the Space owner from inside an interactive transaction", async () => {
    const resolved = await runAsTenant({ spaceId, userId: memberUserId }, () =>
      prisma.$transaction((tx) => teamComputerUserId(tx, { spaceId, userId: memberUserId })),
    );
    expect(resolved).toBe(ownerUserId);
  });

  it("falls back to the caller only when the Space has no owner row", async () => {
    const emptySpaceId = `team-empty-space-${suffix}`;
    const strangerId = `team-stranger-${suffix}`;
    await asSystem(prisma).space.create({
      data: { id: emptySpaceId, organizationId, name: "Empty" },
    });
    try {
      const resolved = await runAsSystem("test fixture", () =>
        teamComputerUserId(prisma, { spaceId: emptySpaceId, userId: strangerId }),
      );
      expect(resolved).toBe(strangerId);
    } finally {
      await asSystem(prisma).space.deleteMany({ where: { id: emptySpaceId } });
    }
  });
});
