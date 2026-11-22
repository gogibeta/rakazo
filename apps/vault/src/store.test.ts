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

function fakePrisma() {
  const prisma = {
    // Mocks resolve `unknown` so each test can install exactly the row it
    // needs; the prisma object itself is cast to PrismaClient for the store.
    walletVault: {
      findUnique: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ passwordEpoch: 1 })),
    },
    userWallet: {
      findFirst: vi.fn(
        async (..._args: unknown[]): Promise<unknown> => ({
          migrationStatus: "legacy_server_only",
        }),
      ),
    },
    walletProposal: { findFirst: vi.fn(async (..._args: unknown[]): Promise<unknown> => null) },
    vaultUnlock: {
      create: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
      updateMany: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ count: 1 })),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, mocks: prisma };
}

describe("vault store tenant resolution", () => {
  beforeEach(() => {
    membership.spaces.clear();
    membership.resolutions.length = 0;
    membership.tenants.length = 0;
  });

  it("resolves membership for every operation, never from a cache", async () => {
    membership.spaces.set("u1", "space-a");
    const store = createPrismaVaultStore(fakePrisma().prisma);
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
    const store = createPrismaVaultStore(fakePrisma().prisma);
    expect(await store.vaultState("u1")).toEqual({ configured: true, passwordEpoch: 1 });

    membership.spaces.delete("u1");
    await expect(store.vaultState("u1")).rejects.toThrow("No personal space");
    await expect(store.walletMigrationStatus("u1", "w1")).rejects.toThrow("No personal space");
  });

  it("a relocated membership moves the tenant scope with the next operation", async () => {
    membership.spaces.set("u1", "space-a");
    const store = createPrismaVaultStore(fakePrisma().prisma);
    await store.vaultState("u1");
    membership.spaces.set("u1", "space-b");
    await store.vaultState("u1");
    expect(membership.tenants.map((tenant) => tenant.spaceId)).toEqual(["space-a", "space-b"]);
  });
});

describe("vault store proposal and envelope reads", () => {
  beforeEach(() => {
    membership.spaces.clear();
    membership.resolutions.length = 0;
    membership.tenants.length = 0;
  });

  const PROPOSAL_ROW = {
    id: "p1",
    walletId: "w1",
    fromAddress: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
    chainId: 11155111,
    to: "0x1111111111111111111111111111111111111111",
    amountWei: "1000000000000000000",
    data: null,
    nonce: 3,
    gasLimit: "21000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
    status: "proposed",
    canonicalHash: "canonical-hash",
    expiresAt: new Date("2026-09-01T00:15:00.000Z"),
  };

  it("reads a proposal in the caller's tenant scope and maps it for signing", async () => {
    membership.spaces.set("u1", "space-a");
    const { prisma, mocks } = fakePrisma();
    mocks.walletProposal.findFirst.mockResolvedValue(PROPOSAL_ROW);
    const store = createPrismaVaultStore(prisma);
    const proposal = await store.readProposal({ proposalId: "p1", userId: "u1" });
    // The row's `id` is mapped to `proposalId`; every other field is carried over.
    const { id, ...rest } = PROPOSAL_ROW;
    expect(proposal).toEqual({ ...rest, proposalId: id });
    // Bound to this person's id: the where clause scopes the row, and the
    // read runs under the membership's tenant, like every vault query.
    expect(mocks.walletProposal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1", userId: "u1" } }),
    );
    expect(membership.tenants).toEqual([{ spaceId: "space-a", userId: "u1" }]);
  });

  it("finds no proposal outside the caller's scope", async () => {
    membership.spaces.set("u1", "space-a");
    const { prisma, mocks } = fakePrisma();
    mocks.walletProposal.findFirst.mockResolvedValue(null);
    const store = createPrismaVaultStore(prisma);
    expect(await store.readProposal({ proposalId: "p1", userId: "u1" })).toBeNull();
  });

  it("reads a key envelope only when the wallet actually carries one", async () => {
    membership.spaces.set("u1", "space-a");
    const { prisma, mocks } = fakePrisma();
    const envelope = { keyCiphertext: "key-ciphertext", passwordWrap: "password-wrap" };
    mocks.userWallet.findFirst.mockResolvedValue({
      migrationStatus: "password_protected",
      ...envelope,
    });
    const store = createPrismaVaultStore(prisma);
    expect(await store.readWalletKeyEnvelope({ walletId: "w1", userId: "u1" })).toEqual(envelope);
    // An unmigrated wallet has no envelope to open, and a missing wallet has no row.
    mocks.userWallet.findFirst.mockResolvedValue({
      migrationStatus: "legacy_server_only",
      keyCiphertext: null,
      passwordWrap: null,
    });
    expect(await store.readWalletKeyEnvelope({ walletId: "w1", userId: "u1" })).toBeNull();
    mocks.userWallet.findFirst.mockResolvedValue(null);
    expect(await store.readWalletKeyEnvelope({ walletId: "w1", userId: "u1" })).toBeNull();
    expect(mocks.userWallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w1", userId: "u1", removedAt: null } }),
    );
  });

  it("a removed membership stops proposal and envelope reads too", async () => {
    membership.spaces.set("u1", "space-a");
    const { prisma, mocks } = fakePrisma();
    mocks.walletProposal.findFirst.mockResolvedValue(PROPOSAL_ROW);
    const store = createPrismaVaultStore(prisma);
    expect(await store.readProposal({ proposalId: "p1", userId: "u1" })).not.toBeNull();
    membership.spaces.delete("u1");
    await expect(store.readProposal({ proposalId: "p1", userId: "u1" })).rejects.toThrow(
      "No personal space",
    );
    await expect(store.readWalletKeyEnvelope({ walletId: "w1", userId: "u1" })).rejects.toThrow(
      "No personal space",
    );
  });
});
