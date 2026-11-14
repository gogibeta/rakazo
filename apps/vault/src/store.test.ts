import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaVaultStore } from "./store.js";

/**
 * Membership as the test sets it: a userId maps to the space their
 * membership currently resolves to, and an absent entry means the
 * membership is gone. Every resolution and every tenant scope the store
 * runs under is recorded, so the tests can see both.
 */
const membership = vi.hoisted(() => ({
  spaces: new Map<string, string>(),
  resolutions: [] as string[],
  tenants: [] as Array<{ spaceId: string; userId: string }>,
}));

vi.mock("@rakazo/db", () => ({
  requireMembership: vi.fn(async (_prisma: unknown, userId: string) => {
    membership.resolutions.push(userId);
    const spaceId = membership.spaces.get(userId);
    if (!spaceId) throw new Error("No personal space");
    return { userId, spaceId, email: "owner@example.com", isDeploymentOwner: false };
  }),
  runAsTenant: vi.fn(
    async (tenant: { spaceId: string; userId: string }, fn: () => Promise<unknown>) => {
      membership.tenants.push(tenant);
      return fn();
    },
  ),
}));

function fakePrisma(): PrismaClient {
  return {
    walletVault: { findUnique: vi.fn(async () => ({ passwordEpoch: 1 })) },
    userWallet: { findFirst: vi.fn(async () => ({ migrationStatus: "legacy_server_only" })) },
    vaultUnlock: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  } as unknown as PrismaClient;
}

describe("vault store tenant resolution", () => {
  beforeEach(() => {
    membership.spaces.clear();
    membership.resolutions.length = 0;
    membership.tenants.length = 0;
  });

  it("resolves membership for every operation, never from a cache", async () => {
    membership.spaces.set("u1", "space-a");
    const store = createPrismaVaultStore(fakePrisma());
    await store.vaultState("u1");
    await store.vaultState("u1");
    await store.walletMigrationStatus("u1", "w1");
    expect(membership.resolutions).toEqual(["u1", "u1", "u1"]);
    expect(membership.tenants).toEqual([
      { spaceId: "space-a", userId: "u1" },
      { spaceId: "space-a", userId: "u1" },
      { spaceId: "space-a", userId: "u1" },
    ]);
  });

  it("a removed membership stops working without a process restart", async () => {
    membership.spaces.set("u1", "space-a");
    const store = createPrismaVaultStore(fakePrisma());
    expect(await store.vaultState("u1")).toEqual({ configured: true, passwordEpoch: 1 });

    membership.spaces.delete("u1");
    await expect(store.vaultState("u1")).rejects.toThrow("No personal space");
    await expect(store.walletMigrationStatus("u1", "w1")).rejects.toThrow("No personal space");
  });

  it("a relocated membership moves the tenant scope with the next operation", async () => {
    membership.spaces.set("u1", "space-a");
    const store = createPrismaVaultStore(fakePrisma());
    await store.vaultState("u1");
    membership.spaces.set("u1", "space-b");
    await store.vaultState("u1");
    expect(membership.tenants.map((tenant) => tenant.spaceId)).toEqual(["space-a", "space-b"]);
  });
});
