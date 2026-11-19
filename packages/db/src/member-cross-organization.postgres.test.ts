import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/**
 * `members_tenant_select` matches the caller's own member row in any organization,
 * which is right for reads: a person may see their own membership wherever it is.
 * The write policies must not inherit that branch. It is not bound to the current
 * organization, so in org X's tenant context it would match the caller's row in
 * org Y and let a tenant update or delete their membership there.
 *
 * `members_tenant_update` and `members_tenant_delete` therefore carry only the
 * current-organization predicate. This test pins that: the same row is readable
 * from org X's context, but not writable, and writes inside org X still work.
 */
describePostgres("member rows across organizations (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const orgX = `xorg-${suffix}`;
  const spaceX = `xspace-${suffix}`;
  const orgY = `yorg-${suffix}`;
  const spaceY = `yspace-${suffix}`;
  const callerId = `cross-caller-${suffix}`;
  const leaverId = `cross-leaver-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const system = asSystem(prisma);
    const createdAt = new Date();
    await system.user.createMany({
      data: [callerId, leaverId].map((id) => ({
        id,
        name: id,
        email: `${id}@rakazo.test`,
        emailVerified: true,
      })),
    });
    const organizations: Array<{ organizationId: string; spaceId: string; name: string }> = [
      { organizationId: orgX, spaceId: spaceX, name: "X" },
      { organizationId: orgY, spaceId: spaceY, name: "Y" },
    ];
    for (const { organizationId, spaceId, name } of organizations) {
      await system.organization.create({
        data: { id: organizationId, name, slug: organizationId, createdAt },
      });
      // Default, so the trigger puts every member of the organization in it.
      await system.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: callerId,
        },
      });
      await system.member.create({
        data: {
          id: `${organizationId}-caller-member`,
          organizationId,
          userId: callerId,
          role: "owner",
          createdAt,
        },
      });
    }
    // A second person in X, so the delete below has a same-organization row to
    // remove without disturbing the caller's own memberships.
    await system.member.create({
      data: {
        id: `${orgX}-leaver-member`,
        organizationId: orgX,
        userId: leaverId,
        role: "guest",
        createdAt,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).organization.deleteMany({ where: { id: { in: [orgX, orgY] } } });
    await asSystem(prisma).user.deleteMany({ where: { id: { in: [callerId, leaverId] } } });
    await close();
  });

  it("keeps the caller's member row in another organization read-only", async () => {
    const inY = { organizationId: orgY, userId: callerId };
    const inX = { organizationId: orgX, userId: callerId };
    const tenantX = { spaceId: spaceX, userId: callerId };

    // Readable through the own-row branch the select policy keeps.
    expect(
      await runAsTenant(tenantX, () =>
        prisma.member.findMany({ where: inY, select: { organizationId: true } }),
      ),
    ).toEqual([{ organizationId: orgY }]);

    // Delete first: on the old policy the update's WITH CHECK rejected the new
    // row, which would mask the worse hole, a delete that silently succeeded.
    expect(await runAsTenant(tenantX, () => prisma.member.deleteMany({ where: inY }))).toEqual({
      count: 0,
    });
    expect(
      await runAsTenant(tenantX, () =>
        prisma.member.updateMany({ where: inY, data: { role: "admin" } }),
      ),
    ).toEqual({ count: 0 });
    await expect(
      runAsTenant(tenantX, () => prisma.member.delete({ where: { organizationId_userId: inY } })),
    ).rejects.toThrow();
    await expect(
      runAsTenant(tenantX, () =>
        prisma.member.update({
          where: { organizationId_userId: inY },
          data: { role: "admin" },
        }),
      ),
    ).rejects.toThrow();

    // The row survived with its original role.
    expect(
      await runAsSystem("row-level security test", () =>
        prisma.member.findFirstOrThrow({ where: inY, select: { role: true } }),
      ),
    ).toEqual({ role: "owner" });

    // Same-organization writes still work, so the policy binds to the
    // organization rather than refusing member writes outright.
    expect(
      await runAsTenant(tenantX, () =>
        prisma.member.updateMany({ where: inX, data: { role: "member" } }),
      ),
    ).toEqual({ count: 1 });
    expect(
      await runAsTenant(tenantX, () =>
        prisma.member.updateMany({ where: inX, data: { role: "owner" } }),
      ),
    ).toEqual({ count: 1 });
    expect(
      await runAsTenant(tenantX, () =>
        prisma.member.deleteMany({ where: { organizationId: orgX, userId: leaverId } }),
      ),
    ).toEqual({ count: 1 });
  });
});
