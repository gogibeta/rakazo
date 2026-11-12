import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/**
 * Deriving an EVM address from a wallet secret the user pasted into Settings:
 * a private key directly, or a BIP-39 seed phrase through the standard
 * Ethereum account path (m/44'/60'/0'/0/0). Runs only here, server-side, at
 * save time; the fill path later types the sealed secret without deriving
 * anything. The error never quotes the secret.
 */
export class WalletSecretError extends Error {
  constructor() {
    super("That private key or seed phrase could not be read. Check it and try again.");
    this.name = "WalletSecretError";
  }
}

/** The EIP-55 checksummed address for a 32-byte private key. */
function addressFromPrivateKey(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(publicKey.slice(1));
  const lower = bytesToHex(hash.slice(-20));
  const check = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  return `0x${[...lower].map((char, index) => (parseInt(check[index]!, 16) >= 8 ? char.toUpperCase() : char)).join("")}`;
}

const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;

/**
 * The wallet a pasted secret belongs to: its public address, and the secret in
 * the canonical form to seal (a phrase lowercased with single spaces, a key as
 * pasted) — the form a page's import field accepts.
 */
export function evmWalletFromSecret(secret: string): { address: string; normalizedSecret: string } {
  const trimmed = secret.trim();
  try {
    if (PRIVATE_KEY.test(trimmed)) {
      const hex = trimmed.replace(/^0x/, "");
      return {
        address: addressFromPrivateKey(hexToBytes(hex)),
        normalizedSecret: trimmed,
      };
    }
    const phrase = trimmed.toLowerCase().split(/\s+/).join(" ");
    if (validateMnemonic(phrase, wordlist)) {
      const account = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive("m/44'/60'/0'/0/0");
      if (!account.privateKey) throw new WalletSecretError();
      return { address: addressFromPrivateKey(account.privateKey), normalizedSecret: phrase };
    }
  } catch (error) {
    if (error instanceof WalletSecretError) throw error;
    throw new WalletSecretError();
  }
  throw new WalletSecretError();
}
