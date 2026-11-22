import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listUserWallets, resolveUserWalletFill } from "./user-wallets.js";

// The well-known public Hardhat test account #0: a published test vector.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SAVED_AT = "2026-09-01T00:00:00.000Z";

function fillStore(migrationStatus: string) {
  const row = {
    id: "w1",
    userId: "u1",
    name: "burner",
    chain: "evm",
    address: ADDRESS,
    secretCipher: "v2:sealed",
    keyCiphertext: migrationStatus === "password_protected" ? "pwk-v1:sealed" : null,
    passwordWrap: migrationStatus === "password_protected" ? "pw-v1:sealed" : null,
    migrationStatus,
    createdAt: new Date(SAVED_AT),
    updatedAt: new Date(SAVED_AT),
  };
  const prisma = {
    userWallet: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) =>
        where.userId === row.userId && where.name === row.name ? row : null,
      ),
    },
  } as unknown as PrismaClient;
  const load = vi.fn(async () => KEY);
  return { prisma, load };
}

describe("resolveUserWalletFill and migration", () => {
  it("fills a legacy wallet through the server seal, as before", async () => {
    const { prisma, load } = fillStore("legacy_server_only");
    const result = await resolveUserWalletFill({
      prisma,
      secretStore: { load },
      userId: "u1",
      name: "burner",
      site: "https://example.test",
      savedAt: SAVED_AT,
    });
    expect(result).toMatchObject({ text: KEY, walletId: "w1" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refuses a migrated wallet without ever opening a seal", async () => {
    const { prisma, load } = fillStore("password_protected");
    const result = await resolveUserWalletFill({
      prisma,
      secretStore: { load },
      userId: "u1",
      name: "burner",
      site: "https://example.test",
      savedAt: SAVED_AT,
    });
    expect(result).toEqual({
      error: expect.stringContaining("protected by the wallet password"),
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("still fills a wallet whose migration failed — it never left the legacy seal", async () => {
    const { prisma, load } = fillStore("migration_failed");
    const result = await resolveUserWalletFill({
      prisma,
      secretStore: { load },
      userId: "u1",
      name: "burner",
      site: "https://example.test",
      savedAt: SAVED_AT,
    });
    expect(result).toMatchObject({ text: KEY, walletId: "w1" });
  });
});

describe("listUserWallets", () => {
  // A bot plans with the live wallets only. A removed wallet still exists so the
  // owner can restore it, but offering it to a bot would let a run propose
  // against a wallet the owner believes is gone.
  it("asks for live wallets only, and maps just the public fields", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "w1",
        name: "burner",
        chain: "evm",
        address: ADDRESS,
        secretCipher: "v2:sealed",
        removedAt: null,
        removedName: null,
      },
    ]);
    const prisma = { userWallet: { findMany } } as unknown as PrismaClient;

    expect(await listUserWallets(prisma, "u1")).toEqual([
      { id: "w1", name: "burner", chain: "evm", address: ADDRESS },
    ]);
    // The filter is what keeps a removed wallet out; without it the query
    // returns it and a bot can plan with it.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", removedAt: null } }),
    );
  });
});
