import { describe, expect, it } from "vitest";
import { FILL_WALLET_REFUSAL, fillWalletEnabled } from "./wallet-fill-policy.js";

describe("fillWalletEnabled", () => {
  it("is off when nothing is set", () => {
    // The default is the whole point: an operator who never heard of this flag
    // must not have wallet secrets typed into pages.
    expect(fillWalletEnabled({})).toBe(false);
  });

  it("is off for any value other than 1", () => {
    for (const value of ["0", "true", "yes", "on", "", "  "]) {
      expect(fillWalletEnabled({ RAKAZO_FILL_WALLET: value })).toBe(false);
    }
  });

  it("is on when the flag is 1, so the change is reversible without a code edit", () => {
    expect(fillWalletEnabled({ RAKAZO_FILL_WALLET: "1" })).toBe(true);
    expect(fillWalletEnabled({ RAKAZO_FILL_WALLET: " 1 " })).toBe(true);
  });
});

describe("FILL_WALLET_REFUSAL", () => {
  it("tells the model not to retry or find another way to type the secret", () => {
    // A refusal that only says "not allowed" invites the model to look for a
    // workaround, which is how a secret ends up in a shell command instead.
    expect(FILL_WALLET_REFUSAL).toMatch(/switched off/i);
    expect(FILL_WALLET_REFUSAL).toMatch(/do not retry/i);
    expect(FILL_WALLET_REFUSAL).toMatch(/cannot be filled/i);
  });
});
