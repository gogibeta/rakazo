import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";
import { WalletAddInput, WalletSummarySchema, WalletUseSummarySchema } from "./wallets.js";

// The well-known public Hardhat test account #0: a published test vector.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("wallets rpc contract", () => {
  it("bounds the add input: a name and a secret, nothing unbounded", () => {
    expect(WalletAddInput.safeParse({ name: "burner", secret: KEY }).success).toBe(true);
    expect(WalletAddInput.safeParse({ name: "", secret: KEY }).success).toBe(false);
    expect(WalletAddInput.safeParse({ name: "x".repeat(81), secret: KEY }).success).toBe(false);
    expect(WalletAddInput.safeParse({ name: "burner", secret: "" }).success).toBe(false);
    expect(WalletAddInput.safeParse({ name: "burner", secret: "x".repeat(1_025) }).success).toBe(
      false,
    );
    expect(WalletAddInput.safeParse({ name: "burner", secret: KEY, chain: "solana" }).success).toBe(
      false,
    );
  });

  it("strips the secret and its sealed form from every output", () => {
    const row = {
      id: "w1",
      name: "burner",
      chain: "evm",
      address: ADDRESS,
      secretCipher: "v2:sealed",
      secret: KEY,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const summary = WalletSummarySchema.parse(row);
    expect(summary).toEqual({
      id: "w1",
      name: "burner",
      chain: "evm",
      address: ADDRESS,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const seen = JSON.stringify(summary);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain("sealed");
  });

  it("carries no secret material in a use record", () => {
    const use = WalletUseSummarySchema.parse({
      id: "u1",
      botName: "Chief",
      purpose: "Claim testnet tokens",
      site: "https://faucet.example.test",
      createdAt: "2026-09-01T00:00:00.000Z",
      secret: KEY,
    });
    expect(JSON.stringify(use)).not.toContain(KEY);
  });

  it("exposes exactly list, add, remove, uses and the vault password calls", () => {
    expect(Object.keys(appContract.wallets).sort()).toEqual([
      "add",
      "changeVaultPassword",
      "list",
      "remove",
      "setVaultPassword",
      "uses",
      "vaultStatus",
    ]);
  });
});
