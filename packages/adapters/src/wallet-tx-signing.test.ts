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

// --- An RLP decoder written independently of the encoder under test. ---
// If the encoder is self-consistent but wrong, these checks still reject its
// output instead of enshrining it: non-canonical long forms, non-minimal
// integers, and trailing bytes all throw.

type RlpItem = Uint8Array | RlpItem[];

function lengthAt(input: Uint8Array, at: number, bytes: number): number {
  let value = 0n;
  for (let i = 0; i < bytes; i++) value = (value << 8n) | BigInt(input[at + i]!);
  return Number(value);
}

function decodeItem(input: Uint8Array, at: number): [RlpItem, number] {
  const prefix = input[at]!;
  if (prefix < 0x80) return [Uint8Array.of(prefix), at + 1];
  if (prefix < 0xb8) {
    const length = prefix - 0x80;
    return [input.slice(at + 1, at + 1 + length), at + 1 + length];
  }
  if (prefix < 0xc0) {
    // Long string: canonical only when the payload really exceeds 55 bytes.
    const length = lengthAt(input, at + 1, prefix - 0xb7);
    if (length <= 55) throw new Error(`non-canonical long string (length ${length})`);
    const start = at + 1 + (prefix - 0xb7);
    return [input.slice(start, start + length), start + length];
  }
  if (prefix < 0xf8) {
    const length = prefix - 0xc0;
    return [decodeList(input, at + 1, at + 1 + length), at + 1 + length];
  }
  // Long list: canonical only when the payload really exceeds 55 bytes.
  const length = lengthAt(input, at + 1, prefix - 0xf7);
  if (length <= 55) throw new Error(`non-canonical long list (length ${length})`);
  const start = at + 1 + (prefix - 0xf7);
  return [decodeList(input, start, start + length), start + length];
}

function decodeList(input: Uint8Array, at: number, end: number): RlpItem[] {
  const items: RlpItem[] = [];
  let cursor = at;
  while (cursor < end) {
    const [item, next] = decodeItem(input, cursor);
    items.push(item);
    cursor = next;
  }
  if (cursor !== end) throw new Error("list payload length mismatch");
  return items;
}

function rlpDecode(bytes: Uint8Array): RlpItem {
  const [item, next] = decodeItem(bytes, 0);
  if (next !== bytes.length) throw new Error("trailing bytes after the RLP item");
  return item;
}

function asList(item: RlpItem): RlpItem[] {
  if (!Array.isArray(item)) throw new Error("expected a list");
  return item;
}

function asBytes(item: RlpItem): Uint8Array {
  if (Array.isArray(item)) throw new Error("expected a byte string");
  return item;
}

function asInteger(item: RlpItem): bigint {
  const bytes = asBytes(item);
  // Zero is the empty string; a lone 0x00 byte is never a canonical integer.
  if (bytes.length === 1 && bytes[0] === 0) throw new Error("non-canonical zero integer");
  if (bytes.length > 1 && bytes[0] === 0) throw new Error("non-canonical integer leading zero");
  return BigInt(`0x${bytes.length === 0 ? "0" : toHex(bytes)}`);
}

function decodedFields(signedTransaction: string): RlpItem[] {
  const raw = hexToBytes(signedTransaction.slice(2));
  if (raw[0] !== 0x02) throw new Error("missing type-2 prefix");
  return asList(rlpDecode(raw.slice(1)));
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
    const items = decodedFields(signed.signedTransaction);
    const yParity = Number(asInteger(items[9]!));
    const r = hexToBytes(asInteger(items[10]!).toString(16).padStart(64, "0"));
    const s = hexToBytes(asInteger(items[11]!).toString(16).padStart(64, "0"));
    const recovered = secp256k1.Signature.fromCompact(concat(r, s))
      .addRecoveryBit(yParity)
      .recoverPublicKey(eip1559SigningHash(FIELDS));
    const expected = secp256k1.getPublicKey(KEY, false);
    expect(toHex(recovered.toRawBytes(false))).toBe(toHex(expected));
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
      "0x02f87583aa36a703843b9aca00847735940082520894" +
        "1111111111111111111111111111111111111111" +
        "880de0b6b3a764000080c0" +
        "80a00f3c0e2641f3011d52eb42cc80d4926fb3ccae61ff717e42dd153da79576f4a2" +
        "a0605b8d19dfef04c8d62183e3dd1febc01a6a6617c9c21572153b280fc239f2df",
    );
    expect(first.transactionHash).toBe(
      "0xd027bed4da920c9205c59b1a20b03e6a0ba1c370f6c357d79de2632b71d26591",
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
      "0x02f85d83aa36a703843b9aca00847735940082520880" +
        "808460806040c080a0fb6effca9138992cf8e148da64cd40b433bda24a1eb2ac48" +
        "4001829988974187a043eb3821e66a3a3479862f47183edd63d116b8f8d9435a04" +
        "2399041a68cb1651",
    );
  });
});

describe("canonical RLP wire format", () => {
  it("decodes to twelve fields behind a canonical long-form list prefix", () => {
    const raw = hexToBytes(
      signEip1559Transaction(FIELDS, new Uint8Array(KEY)).signedTransaction.slice(2),
    );
    // The 117-byte payload needs the long list form 0xf8 0x75, never 0xc0 0x75.
    expect(raw[1]).toBe(0xf8);
    expect(raw[2]).toBe(117);
    const items = asList(rlpDecode(raw.slice(1)));
    expect(items).toHaveLength(12);
    expect(asInteger(items[0]!)).toBe(BigInt(FIELDS.chainId));
    expect(asInteger(items[1]!)).toBe(BigInt(FIELDS.nonce));
    expect(toHex(asBytes(items[5]!))).toBe(FIELDS.to.slice(2));
    expect(asInteger(items[6]!)).toBe(BigInt(FIELDS.value));
    expect(asList(items[8]!)).toHaveLength(0);
  });

  it("encodes recovery parity 0 as the empty string, not a 0x00 byte", () => {
    const items = decodedFields(
      signEip1559Transaction(FIELDS, new Uint8Array(KEY)).signedTransaction,
    );
    expect(asInteger(items[9]!)).toBe(0n);
    expect(asBytes(items[9]!)).toHaveLength(0);
  });

  it("encodes recovery parity 1 as the single byte 0x01", () => {
    const signed = signEip1559Transaction(FIELDS, new Uint8Array(hexToBytes("01".repeat(32))));
    const items = decodedFields(signed.signedTransaction);
    expect(asInteger(items[9]!)).toBe(1n);
    expect(toHex(asBytes(items[9]!))).toBe("01");
    expect(signed.signedTransaction).toBe(
      "0x02f87583aa36a703843b9aca00847735940082520894" +
        "1111111111111111111111111111111111111111880de0b6b3a764000080c001a0" +
        "1352e6cab3f6a96a818513b6664df6a19de06011a5c81ba16775a019448dbfada0" +
        "4acaa5244ea593cfc2ca816e0567af9ce2231b9689152d24084d7f00b15f9216",
    );
    expect(signed.transactionHash).toBe(
      "0x22ec15b6505162e68f8ad5f5da9e7023004ecbebbc130a79f5a011d15846eb21",
    );
  });

  it("uses the long string form for calldata longer than 55 bytes", () => {
    const signed = signEip1559Transaction(
      { ...FIELDS, data: `0x${"ab".repeat(70)}` },
      new Uint8Array(KEY),
    );
    const items = decodedFields(signed.signedTransaction);
    expect(toHex(asBytes(items[7]!))).toBe("ab".repeat(70));
  });

  it("recovers the signer from the decoded signature at both parities", () => {
    for (const key of [KEY, hexToBytes("01".repeat(32))]) {
      const signed = signEip1559Transaction(FIELDS, new Uint8Array(key));
      const items = decodedFields(signed.signedTransaction);
      const yParity = Number(asInteger(items[9]!));
      const r = hexToBytes(asInteger(items[10]!).toString(16).padStart(64, "0"));
      const s = hexToBytes(asInteger(items[11]!).toString(16).padStart(64, "0"));
      const recovered = secp256k1.Signature.fromCompact(concat(r, s))
        .addRecoveryBit(yParity)
        .recoverPublicKey(eip1559SigningHash(FIELDS));
      expect(toHex(recovered.toRawBytes(false))).toBe(toHex(secp256k1.getPublicKey(key, false)));
    }
  });
});
