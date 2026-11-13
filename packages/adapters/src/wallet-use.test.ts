import { describe, expect, it } from "vitest";
import { requestedWalletUse, walletUseOf, walletUseSummary } from "./wallet-use.js";

const fill = (over: Record<string, unknown> = {}) => ({
  kind: "fill_wallet",
  ref: "e3",
  wallet: "burner",
  site: "https://faucet.example.test/claim",
  purpose: "Claim testnet tokens",
  ...over,
});

describe("requestedWalletUse", () => {
  it("reads the wallet, site and purpose from a fill_wallet step", () => {
    expect(requestedWalletUse([fill()])).toEqual({
      wallet: "burner",
      site: "https://faucet.example.test",
      purpose: "Claim testnet tokens",
    });
  });

  it("sees no wallet use in other steps", () => {
    expect(requestedWalletUse([{ kind: "click", ref: "e1" }])).toBeUndefined();
    expect(requestedWalletUse("nope")).toBeUndefined();
  });

  it("refuses a fill without an HTTPS site, and two wallets in one call", () => {
    expect(requestedWalletUse([fill({ site: "http://faucet.example.test" })])).toEqual({
      error: expect.stringContaining("HTTPS"),
    });
    expect(requestedWalletUse([fill(), fill({ wallet: "other", purpose: "Second" })])).toEqual({
      error: expect.stringContaining("one wallet"),
    });
  });

  it("flattens and caps the purpose the card will show", () => {
    const use = requestedWalletUse([fill({ purpose: `  Claim\n tokens ${"x".repeat(300)}` })]);
    expect(use && "purpose" in use && use.purpose.startsWith("Claim tokens")).toBe(true);
    expect(use && "purpose" in use && use.purpose.length).toBe(200);
  });
});

describe("walletUseOf", () => {
  const use = {
    wallet: "burner",
    site: "https://faucet.example.test",
    purpose: "Claim testnet tokens",
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    savedAt: "2026-09-01T00:00:00.000Z",
  };

  it("round-trips a persisted wallet use", () => {
    expect(walletUseOf(use)).toEqual(use);
    // A persisted use names an origin, never a page URL: requestedWalletUse reduces it first.
    expect(walletUseOf({ ...use, site: "https://faucet.example.test/claim?x=1" })).toBeUndefined();
  });

  it("rejects values that are not a wallet use", () => {
    expect(walletUseOf(undefined)).toBeUndefined();
    expect(walletUseOf({ ...use, site: "http://faucet.example.test" })).toBeUndefined();
    expect(walletUseOf({ ...use, wallet: "" })).toBeUndefined();
    expect(walletUseOf({ ...use, savedAt: 42 })).toBeUndefined();
  });

  it("summarizes as a once-only approval naming the wallet, the purpose and the address", () => {
    const summary = walletUseSummary(use);
    expect(summary.onceOnly).toBe(true);
    expect(summary.title).toContain("burner");
    expect(summary.title).toContain("faucet.example.test");
    expect(summary.lines.join(" ")).toContain("Claim testnet tokens");
    expect(summary.lines.join(" ")).toContain(use.address);
  });
});
