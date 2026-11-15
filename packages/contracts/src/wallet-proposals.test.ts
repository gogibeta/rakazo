import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  WALLET_CHAIN_IDS,
  WALLET_PROPOSAL_TTL_MS,
  WalletProposalSchema,
  WalletProposalStatusSchema,
  WalletProposeInput,
  WalletWeiSchema,
} from "./index.js";

// The well-known public Hardhat test account #0: a published test vector.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("wallet proposal contracts", () => {
  it("allowlists only the three testnets, and a fifteen-minute life", () => {
    expect([...WALLET_CHAIN_IDS].sort((a, b) => a - b)).toEqual([998, 99801, 11155111]);
    expect(WALLET_PROPOSAL_TTL_MS).toBe(15 * 60 * 1_000);
  });

  it("accepts the general transaction shape", () => {
    const send = { walletId: "w1", chainId: 99801, to: ADDRESS, value: "1", data: null };
    expect(WalletProposeInput.safeParse(send).success).toBe(true);
    const call = {
      ...send,
      data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dEaD",
    };
    expect(WalletProposeInput.safeParse(call).success).toBe(true);
    const deploy = { walletId: "w1", chainId: 998, to: null, value: "0", data: "0x6080" };
    expect(WalletProposeInput.safeParse(deploy).success).toBe(true);
  });

  it("refuses floats, exponents, negatives and values above uint256", () => {
    // Surrounding whitespace is trimmed, which is harmless; the digits themselves must be exact.
    for (const value of ["0.5", "1e18", "-1", "1,000"]) {
      expect(WalletWeiSchema.safeParse(value).success, value).toBe(false);
    }
    expect(WalletWeiSchema.safeParse(((1n << 256n) + 1n).toString(10)).success).toBe(false);
    expect(WalletWeiSchema.safeParse(((1n << 256n) - 1n).toString(10)).success).toBe(true);
  });

  it("refuses a deploy without bytecode, and one that sends value", () => {
    expect(
      WalletProposeInput.safeParse({
        walletId: "w1",
        chainId: 99801,
        to: null,
        value: "0",
        data: null,
      }).success,
    ).toBe(false);
    expect(
      WalletProposeInput.safeParse({
        walletId: "w1",
        chainId: 99801,
        to: null,
        value: "1",
        data: "0x60",
      }).success,
    ).toBe(false);
  });

  it("refuses a recipient that is not 20 hex bytes, and extra fields", () => {
    for (const to of ["0x1234", "not-an-address", `${ADDRESS}ff`]) {
      expect(
        WalletProposeInput.safeParse({ walletId: "w1", chainId: 99801, to, value: "0", data: null })
          .success,
        to,
      ).toBe(false);
    }
    expect(
      WalletProposeInput.safeParse({
        walletId: "w1",
        chainId: 99801,
        to: ADDRESS,
        value: "0",
        data: null,
        rpcUrl: "https://attacker.test",
      }).success,
    ).toBe(false);
  });

  it("carries no secret or signed material in a proposal view", () => {
    const row = {
      id: "p1",
      walletId: "w1",
      walletName: "burner",
      walletAddress: ADDRESS,
      chainId: 99801,
      chainName: "Elysium Testnet",
      nativeSymbol: "HYPE",
      to: ADDRESS,
      asset: "HYPE",
      amountWei: "1",
      data: null,
      nonce: 1,
      gasLimit: "25201",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "1000000000",
      rpcProfile: "elysium-testnet",
      status: "proposed",
      canonicalHash: "a".repeat(64),
      createdAt: "2026-11-15T12:00:00.000Z",
      expiresAt: "2026-11-15T12:15:00.000Z",
      signedTransaction: "0xdead",
      privateKey: `0x${"1".repeat(64)}`,
    };
    const view = WalletProposalSchema.parse(row);
    expect(Object.keys(view).sort()).not.toContain("signedTransaction");
    expect(Object.keys(view).sort()).not.toContain("privateKey");
    expect(WalletProposalStatusSchema.parse("proposed")).toBe("proposed");
    expect(WalletProposalStatusSchema.safeParse("signed").success).toBe(false);
  });
});

describe("the tool schema the model reads", () => {
  it("comes from the same contract the server validates, so `to` is required", () => {
    // The adapters build the tool's inputSchema with z.toJSONSchema(WalletProposeInput);
    // asserting the contract's own shape here is what keeps the two from drifting.
    const schema = z.toJSONSchema(WalletProposeInput, { io: "input" }) as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["walletId", "chainId", "to"]));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "chainId",
      "data",
      "to",
      "value",
      "walletId",
    ]);
    // `to` is nullable, not optional: a deploy says so explicitly.
    expect(
      WalletProposeInput.safeParse({
        walletId: "w1",
        chainId: 99801,
        value: "0",
        data: "0x60",
      }).success,
    ).toBe(false);
  });
});

describe("the wei schema never converts a bad amount", () => {
  it("rejects an oversized digit string without reaching BigInt", () => {
    // Zod keeps evaluating refinements after an earlier issue, so a refinement that
    // converted first would call BigInt on an arbitrarily long string. The length
    // and digits are checked before the conversion, and the message still says the
    // amount is out of range rather than surfacing a conversion error.
    const huge = "9".repeat(5_000);
    const parsed = WalletWeiSchema.safeParse(huge);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages).toContain("Amount exceeds uint256");
  });

  it("still accepts the uint256 maximum and rejects one wei more", () => {
    expect(WalletWeiSchema.safeParse(((1n << 256n) - 1n).toString(10)).success).toBe(true);
    expect(WalletWeiSchema.safeParse((1n << 256n).toString(10)).success).toBe(false);
  });
});
