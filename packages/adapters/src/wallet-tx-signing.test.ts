import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  eip1559SigningHash,
  eip1559SigningPayload,
  signEip1559Transaction,
} from "./wallet-tx-signing.js";

const KEY = hexToBytes("11".repeat(32));

const FIELDS = {
  chainId: 11155111,
  nonce: 3,
  to: "0x1111111111111111111111111111111111111111",
  value: "1000000000000000000",
  data: null,
  gasLimit: "21000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000000",
};

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("eip1559SigningPayload", () => {
  it("prefixes the type-2 byte and encodes fields in RLP field order", () => {
    const payload = eip1559SigningPayload(FIELDS);
    expect(payload[0]).toBe(0x02);
    // Pinned so an encoding change cannot slip through silently.
    expect(toHex(payload)).toBe(
      "02f283aa36a703843b9aca00847735940082520894" +
        "1111111111111111111111111111111111111111" +
        "880de0b6b3a764000080c0",
    );
  });

  it("encodes a contract deploy with no recipient, carrying its bytecode", () => {
    const payload = eip1559SigningPayload({ ...FIELDS, to: null, value: "0", data: "0x60806040" });
    // `to` is the empty byte string (0x80); the init bytecode follows it.
    expect(toHex(payload)).toBe("02da83aa36a703843b9aca00847735940082520880808460806040c0");
  });

  it("encodes zero quantities as the empty byte string, not a zero byte", () => {
    // RLP encodes 0 as 0x80 (empty); a literal 0x00 byte would be a decoding hazard.
    const payload = eip1559SigningPayload({ ...FIELDS, nonce: 0, value: "0" });
    expect(toHex(payload)).toBe(
      "02ea83aa36a780843b9aca00847735940082520894" +
        "1111111111111111111111111111111111111111" +
        "8080c0",
    );
  });
});

describe("eip1559SigningHash", () => {
  it("is keccak256 of the payload", () => {
    const payload = eip1559SigningPayload(FIELDS);
    expect(toHex(eip1559SigningHash(FIELDS))).toBe(toHex(keccak_256(payload)));
  });
});

describe("signEip1559Transaction", () => {
  it("produces a signature whose recovered sender is the key's address", () => {
    const signed = signEip1559Transaction(FIELDS, new Uint8Array(KEY));
    const hash = eip1559SigningHash(FIELDS);
    const raw = hexToBytes(signed.signedTransaction.slice(2));
    // The tail is [yParity][RLP r][RLP s]; r and s are 32 bytes under a 0xa0 prefix.
    const yParity = raw[raw.length - 67]!;
    const r = raw.slice(raw.length - 65, raw.length - 33);
    const s = raw.slice(raw.length - 32);
    const recovered = secp256k1.Signature.fromCompact(concat(r, s))
      .addRecoveryBit(yParity)
      .recoverPublicKey(hash);
    const expected = secp256k1.getPublicKey(KEY, false);
    expect(Buffer.from(recovered.toRawBytes(false)).toString("hex")).toBe(
      Buffer.from(expected).toString("hex"),
    );
  });

  it("reports the sender address the key controls", () => {
    const signed = signEip1559Transaction(FIELDS, new Uint8Array(KEY));
    // Address = last 20 bytes of keccak(uncompressed pubkey without its 0x04 prefix).
    const pub = secp256k1.getPublicKey(KEY, false);
    const address = `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString("hex")}`;
    expect(signed.from).toBe(address);
    expect(signed.from).toHaveLength(42);
  });

  it("is deterministic, and pins the exact signed bytes and hash", () => {
    const first = signEip1559Transaction(FIELDS, new Uint8Array(KEY));
    const second = signEip1559Transaction(FIELDS, new Uint8Array(KEY));
    expect(first.signedTransaction).toBe(second.signedTransaction);
    expect(first.signedTransaction).toBe(
      "0x02c07583aa36a703843b9aca00847735940082520894" +
        "1111111111111111111111111111111111111111" +
        "880de0b6b3a764000080c0" +
        "00a00f3c0e2641f3011d52eb42cc80d4926fb3ccae61ff717e42dd153da79576f4a2" +
        "a0605b8d19dfef04c8d62183e3dd1febc01a6a6617c9c21572153b280fc239f2df",
    );
    expect(first.transactionHash).toBe(
      "0x89936b796b0a926a446e66903160980857efe163e50c1a62a8d40298408cd5d8",
    );
  });

  it("gives a different signature for different fields", () => {
    const a = signEip1559Transaction(FIELDS, new Uint8Array(KEY));
    const b = signEip1559Transaction({ ...FIELDS, nonce: 4 }, new Uint8Array(KEY));
    expect(a.signedTransaction).not.toBe(b.signedTransaction);
    expect(a.transactionHash).not.toBe(b.transactionHash);
  });

  it("wipes the caller's private key copy before returning", () => {
    const key = new Uint8Array(KEY);
    signEip1559Transaction(FIELDS, key);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it("signs a contract deploy with no recipient", () => {
    const signed = signEip1559Transaction(
      { ...FIELDS, to: null, value: "0", data: "0x60806040" },
      new Uint8Array(KEY),
    );
    expect(signed.signedTransaction.startsWith("0x02")).toBe(true);
    expect(signed.transactionHash).toHaveLength(66);
    expect(signed.signedTransaction).toBe(
      "0x02c05d83aa36a703843b9aca00847735940082520880808460806040c0" +
        "00a0fb6effca9138992cf8e148da64cd40b433bda24a1eb2ac484001829988974187" +
        "a043eb3821e66a3a3479862f47183edd63d116b8f8d9435a042399041a68cb1651",
    );
  });
});
