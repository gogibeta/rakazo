import { describe, expect, it } from "vitest";
import { evmWalletFromSecret, WalletSecretError } from "./wallet-address.js";

// The well-known public Hardhat test account #0. Its key and phrase are
// published test vectors, not anyone's wallet.
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("evmWalletFromSecret", () => {
  it("derives the Hardhat account #0 address from its private key", () => {
    expect(evmWalletFromSecret(HARDHAT_KEY).address).toBe(HARDHAT_ADDRESS);
    expect(evmWalletFromSecret(HARDHAT_KEY.slice(2)).address).toBe(HARDHAT_ADDRESS);
    expect(
      evmWalletFromSecret(`  ${HARDHAT_KEY.toUpperCase().replace("0X", "0x")}  `).address,
    ).toBe(HARDHAT_ADDRESS);
  });

  it("derives the same address from the Hardhat seed phrase", () => {
    const derived = evmWalletFromSecret(HARDHAT_PHRASE);
    expect(derived.address).toBe(HARDHAT_ADDRESS);
    expect(derived.normalizedSecret).toBe(HARDHAT_PHRASE);
    // Extra whitespace and capitals in a pasted phrase still read as the phrase.
    expect(evmWalletFromSecret(HARDHAT_PHRASE.replaceAll(" ", "  \n")).address).toBe(
      HARDHAT_ADDRESS,
    );
  });

  it("rejects values that are neither a key nor a valid phrase, without quoting them", () => {
    for (const bad of [
      "",
      "0x1234",
      "not a seed phrase at all",
      "test test test test test test test test test test test test",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]) {
      let caught: unknown;
      try {
        evmWalletFromSecret(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WalletSecretError);
      if (bad) expect((caught as Error).message).not.toContain(bad);
    }
  });
});
