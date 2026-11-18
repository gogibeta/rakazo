import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("default Space membership trigger (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `trigger-user-${suffix}`;
  const fellowUserId = `trigger-fellow-${suffix}`;
  const organizationId = `trigger-organization-${suffix}`;
  const spaceId = `trigger-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).organization.deleteMany({ where: { id: organizationId } });
    await asSystem(prisma).user.deleteMany({ where: { id: { in: [userId, fellowUserId] } } });
    await close();
  });

  it("adds a new organization member to its default Space", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const createdAt = new Date();
    const fixtures = asSystem(prisma);
    await fixtures.user.createMany({
      data: [
        {
          id: userId,
          name: "Trigger Test User",
          email: `${userId}@rakazo.test`,
          emailVerified: false,
        },
        {
          id: fellowUserId,
          name: "Trigger Fellow",
          email: `${fellowUserId}@rakazo.test`,
          emailVerified: false,
        },
      ],
    });
    await fixtures.organization.create({
      data: {
        id: organizationId,
        name: "Trigger Test Organization",
        slug: organizationId,
        createdAt,
      },
    });
    await fixtures.space.create({
      data: {
        id: spaceId,
        organizationId,
        name: "General",
        isDefault: true,
        createdByUserId: userId,
      },
    });

    // The fellow is already a member, so the Space has a tenant to write from.
    const fellowMemberId = `trigger-fellow-member-${suffix}`;
    await fixtures.member.create({
      data: {
        id: fellowMemberId,
        organizationId,
        userId: fellowUserId,
        role: "owner",
        createdAt,
      },
    });

    // The person joining is invited from inside that Space, the way accepting an
    // invite creates their membership: acceptance runs as system (the invite
    // token is the credential), and the trigger has to add them to the default
    // Space even though the row it inserts is outside the caller's own scope.
    const memberId = `trigger-member-${suffix}`;
    await runAsSystem("accept a Space invite", () =>
      prisma.member.create({
        data: { id: memberId, organizationId, userId, role: "member", createdAt },
      }),
    );

    const membership = await asSystem(prisma).spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
    });
    expect(membership).toMatchObject({
      id: `default-space-member:${memberId}`,
      spaceId,
      organizationId,
      userId,
      role: "member",
    });
  });
});
