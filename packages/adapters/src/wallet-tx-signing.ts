import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * Minimal, dependency-light EIP-1559 signing for wallet proposals.
 *
 * Only what a proposal needs is implemented: the type-2 (EIP-1559) payload,
 * its signing hash, and the signature. No decoding, no typed data, no legacy
 * transactions — a proposal is created, signed and broadcast in exactly one
 * shape, so anything else is out of scope by construction.
 *
 * Amounts arrive as decimal wei strings and the recipient/calldata as hex,
 * exactly as `WalletProposal` stores them, so no caller can reformat a field
 * between validation and signing.
 */

/** RLP-encode a byte string. Single bytes under 0x80 encode as themselves. */
function rlpBytes(bytes: Uint8Array): Uint8Array {
  const first = bytes.length === 1 ? bytes[0] : undefined;
  if (first !== undefined && first < 0x80) return bytes;
  return concat(rlpLength(bytes.length, 0x80), bytes);
}

/** RLP-encode a list of already-encoded items. */
function rlpList(items: Uint8Array[]): Uint8Array {
  const payload = concat(...items);
  return concat(rlpLength(payload.length, 0xc0), payload);
}

/** The RLP length prefix for a payload of `length`, offset by `offset`. */
function rlpLength(length: number, offset: number): Uint8Array {
  if (length < 56) return new Uint8Array([offset + length]);
  // Long form: offset + 55 + byte-length-of-length (0xb7+ for strings, 0xf7+ for lists),
  // then the big-endian length bytes.
  const lengthBytes = minimalBytes(BigInt(length));
  return concat(new Uint8Array([offset + 55 + lengthBytes.length]), lengthBytes);
}

/** Minimal big-endian bytes for a non-negative integer (0 encodes as empty). */
function minimalBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const hex = value.toString(16).padStart(2, "0");
  return hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A decimal wei/hex quantity, as the proposal stores it, as minimal bytes. */
function quantity(value: string): Uint8Array {
  return minimalBytes(BigInt(value));
}

/** Hex data (`0x…`, possibly empty) as bytes; null encodes as empty. */
function dataBytes(value: string | null): Uint8Array {
  if (value === null || value === "0x") return new Uint8Array();
  return hexToBytes(strip0x(value));
}

/** @noble's hexToBytes wants bare hex; proposals store `0x`-prefixed values. */
function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

/** The transaction fields a proposal carries, exactly as stored. */
export interface WalletTxFields {
  chainId: number;
  nonce: number;
  to: string | null;
  value: string;
  data: string | null;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

/**
 * The EIP-1559 signing payload: `0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 * gasLimit, to, value, data, accessList])`. An empty access list is correct here — a proposal
 * never carries one, so the field is always the empty list.
 */
export function eip1559SigningPayload(fields: WalletTxFields): Uint8Array {
  const toBytes = fields.to === null ? new Uint8Array() : hexToBytes(strip0x(fields.to));
  return concat(
    new Uint8Array([0x02]),
    rlpList([
      rlpBytes(minimalBytes(BigInt(fields.chainId))),
      rlpBytes(minimalBytes(BigInt(fields.nonce))),
      rlpBytes(quantity(fields.maxPriorityFeePerGas)),
      rlpBytes(quantity(fields.maxFeePerGas)),
      rlpBytes(quantity(fields.gasLimit)),
      rlpBytes(toBytes),
      rlpBytes(quantity(fields.value)),
      rlpBytes(dataBytes(fields.data)),
      rlpList([]),
    ]),
  );
}

/** keccak256 of the signing payload: the hash the owner's key signs. */
export function eip1559SigningHash(fields: WalletTxFields): Uint8Array {
  return keccak_256(eip1559SigningPayload(fields));
}

export interface SignedWalletTransaction {
  /** `0x02 || RLP([…, yParity, r, s])` — what an RPC broadcast accepts. */
  readonly signedTransaction: string;
  /** keccak256 of the signed transaction: the transaction hash. */
  readonly transactionHash: string;
  /** Lowercase sender address, recovered from the signature. */
  readonly from: string;
}

/**
 * Sign one proposal's transaction with a wallet's private key. The key is
 * wiped before this returns, whatever the outcome.
 */
export function signEip1559Transaction(
  fields: WalletTxFields,
  privateKey: Uint8Array,
): SignedWalletTransaction {
  try {
    const signingHash = eip1559SigningHash(fields);
    const signature = secp256k1.sign(signingHash, privateKey);
    const { r, s, recovery } = signature;
    if (recovery === undefined) throw new Error("Signature carries no recovery id");
    // RLP integers take minimal bytes: parity 0 is the empty string (0x80), 1 is 0x01.
    const yParity = minimalBytes(BigInt(recovery));

    const signed = concat(
      new Uint8Array([0x02]),
      rlpList([
        rlpBytes(minimalBytes(BigInt(fields.chainId))),
        rlpBytes(minimalBytes(BigInt(fields.nonce))),
        rlpBytes(quantity(fields.maxPriorityFeePerGas)),
        rlpBytes(quantity(fields.maxFeePerGas)),
        rlpBytes(quantity(fields.gasLimit)),
        rlpBytes(fields.to === null ? new Uint8Array() : hexToBytes(strip0x(fields.to))),
        rlpBytes(quantity(fields.value)),
        rlpBytes(dataBytes(fields.data)),
        rlpList([]),
        rlpBytes(yParity),
        rlpBytes(minimalBytes(r)),
        rlpBytes(minimalBytes(s)),
      ]),
    );
    return {
      signedTransaction: `0x${bytesToHex(signed)}`,
      transactionHash: `0x${bytesToHex(keccak_256(signed))}`,
      from: senderAddress(privateKey),
    };
  } finally {
    privateKey.fill(0);
  }
}

/** The lowercase EIP-55-less address a private key controls. */
function senderAddress(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  // Uncompressed key is 0x04 || X(32) || Y(32); the address is the last 20 bytes of keccak(X||Y).
  const hash = keccak_256(publicKey.slice(1));
  return `0x${bytesToHex(hash.slice(-20))}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
