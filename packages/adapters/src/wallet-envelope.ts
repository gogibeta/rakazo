import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

/**
 * Password envelope for wallet keys (format pw-v1).
 *
 * Each wallet gets a random data-encryption key (DEK). The DEK encrypts the
 * wallet's private key, and the DEK itself is wrapped twice: once by the
 * server key (operational reads, migration) and once by a key derived from
 * the owner's wallet password. Opening the password wrap therefore needs the
 * password even with full database and server-file access; changing the
 * password re-wraps the DEK without touching the key ciphertext.
 *
 * The password-derived key comes from scrypt at parameters far above the
 * server seal's (N=16384 is too cheap for a user password): N=32768, r=8,
 * p=4, tuned to land in the few-hundred-millisecond range on a small VM and
 * persisted per envelope so they can be raised later. Parameters are
 * validated on open so a tampered envelope cannot force a trivial or a
 * memory-exhausting derivation. Password-derived keys are never cached.
 *
 * Every wrap and the key ciphertext bind the wallet id as associated data,
 * so an envelope cannot be moved to another wallet or purpose. Errors are
 * deliberately generic: they never carry password, key, or plaintext
 * material, and nothing here logs.
 */

const FORMAT_PREFIX = "pw-v1:";
const AAD_PURPOSE = "private-key-password-envelope-v1";
const DEK_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERIFIER_BYTES = 32;

/** scrypt parameters for both password derivation and the password verifier. */
export type ScryptParams = { N: number; r: number; p: number };

export const PASSWORD_SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 4 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Persisted parameters are honored only inside these bounds. */
const PARAM_LIMITS = {
  N: { min: 2 ** 14, max: 2 ** 18 },
  r: { min: 8, max: 8 },
  p: { min: 1, max: 8 },
} as const;

export type WalletKeyEnvelope = {
  /** The private key encrypted under the wallet DEK. */
  keyCiphertext: string;
  /** The DEK wrapped by the server key. */
  serverWrap: string;
  /** The DEK wrapped by the password-derived key. */
  passwordWrap: string;
};

/** A serialized pw-v1 password wrap: the fields needed to re-derive and open it. */
export type PasswordEnvelope = {
  kdf: "scrypt";
  params: ScryptParams;
  salt: string;
  nonce: string;
  tag: string;
  wrappedDek: string;
};

function aadFor(walletId: string): Buffer {
  return Buffer.from(`${walletId}||${AAD_PURPOSE}`, "utf8");
}

function assertWalletId(walletId: string): void {
  if (typeof walletId !== "string" || walletId.length === 0 || walletId.includes("|")) {
    throw new Error("wallet envelope: invalid wallet id");
  }
}

function assertSecretBytes(value: Buffer, name: string): void {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error(`wallet envelope: ${name} must be non-empty bytes`);
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) =>
      error ? reject(new Error("wallet envelope: key derivation failed")) : resolve(key),
    );
  });
}

function sealBytes(
  key: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { nonce: Buffer; tag: Buffer; enc: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), enc };
}

function openBytes(
  key: Buffer,
  aad: Buffer,
  parts: { nonce: Buffer; tag: Buffer; enc: Buffer },
  failure: string,
): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parts.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.enc), decipher.final()]);
  } catch {
    throw new Error(failure);
  }
}

function encodeParts(parts: { nonce: Buffer; tag: Buffer; enc: Buffer }): string {
  return Buffer.concat([parts.nonce, parts.tag, parts.enc]).toString("base64");
}

function decodeParts(
  serialized: string,
  failure: string,
): { nonce: Buffer; tag: Buffer; enc: Buffer } {
  const buf = Buffer.from(serialized, "base64");
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error(failure);
  return {
    nonce: buf.subarray(0, NONCE_BYTES),
    tag: buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    enc: buf.subarray(NONCE_BYTES + TAG_BYTES),
  };
}

const malformed = "wallet envelope: malformed password envelope";

function checkParams(params: ScryptParams): void {
  const { N, r, p } = params;
  if (
    !Number.isInteger(N) ||
    N < PARAM_LIMITS.N.min ||
    N > PARAM_LIMITS.N.max ||
    (N & (N - 1)) !== 0
  ) {
    throw new Error(malformed);
  }
  if (
    r !== PARAM_LIMITS.r.min ||
    !Number.isInteger(p) ||
    p < PARAM_LIMITS.p.min ||
    p > PARAM_LIMITS.p.max
  ) {
    throw new Error(malformed);
  }
  // Derivation memory is ~128 * N * r * p bytes; keep it inside the cap the
  // derivation itself enforces, so stored params cannot demand more.
  if (128 * N * r * p > SCRYPT_MAXMEM) throw new Error(malformed);
}

/** Serialize a password wrap to its stored pw-v1 string. */
export function serializePasswordEnvelope(envelope: PasswordEnvelope): string {
  const payload = {
    kdf: envelope.kdf,
    N: envelope.params.N,
    r: envelope.params.r,
    p: envelope.params.p,
    salt: envelope.salt,
    nonce: envelope.nonce,
    tag: envelope.tag,
    wrappedDek: envelope.wrappedDek,
  };
  return FORMAT_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function base64Field(value: unknown, bytes?: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(malformed);
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value) throw new Error(malformed);
  if (bytes !== undefined && buf.length !== bytes) throw new Error(malformed);
  return value;
}

/** Parse a stored pw-v1 string, rejecting any other version or shape. */
export function parsePasswordEnvelope(serialized: string): PasswordEnvelope {
  if (typeof serialized !== "string" || !serialized.startsWith(FORMAT_PREFIX)) {
    throw new Error("wallet envelope: unsupported envelope version");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(serialized.slice(FORMAT_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error(malformed);
  }
  if (typeof payload !== "object" || payload === null || payload.kdf !== "scrypt") {
    throw new Error(malformed);
  }
  const params = { N: payload.N, r: payload.r, p: payload.p } as ScryptParams;
  if (
    typeof params.N !== "number" ||
    typeof params.r !== "number" ||
    typeof params.p !== "number"
  ) {
    throw new Error(malformed);
  }
  checkParams(params);
  const wrappedDek = base64Field(payload.wrappedDek);
  if (Buffer.from(wrappedDek, "base64").length !== DEK_BYTES) throw new Error(malformed);
  return {
    kdf: "scrypt",
    params,
    salt: base64Field(payload.salt, SALT_BYTES),
    nonce: base64Field(payload.nonce, NONCE_BYTES),
    tag: base64Field(payload.tag, TAG_BYTES),
    wrappedDek,
  };
}

/** Wrap a wallet DEK under a key derived from the owner's password. */
export async function wrapDekWithPassword(input: {
  walletId: string;
  dek: Buffer;
  password: string;
}): Promise<string> {
  assertWalletId(input.walletId);
  if (!Buffer.isBuffer(input.dek) || input.dek.length !== DEK_BYTES) {
    throw new Error("wallet envelope: invalid data key");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(input.password, salt, PASSWORD_SCRYPT_PARAMS, 32);
  try {
    const parts = sealBytes(key, aadFor(input.walletId), input.dek);
    return serializePasswordEnvelope({
      kdf: "scrypt",
      params: { ...PASSWORD_SCRYPT_PARAMS },
      salt: salt.toString("base64"),
      nonce: parts.nonce.toString("base64"),
      tag: parts.tag.toString("base64"),
      wrappedDek: parts.enc.toString("base64"),
    });
  } finally {
    key.fill(0);
  }
}

/** Open a password wrap. A wrong password and any tampering fail the same way. */
export async function unwrapDekWithPassword(input: {
  walletId: string;
  envelope: string;
  password: string;
}): Promise<Buffer> {
  assertWalletId(input.walletId);
  const parsed = parsePasswordEnvelope(input.envelope);
  const key = await deriveKey(
    input.password,
    Buffer.from(parsed.salt, "base64"),
    parsed.params,
    32,
  );
  try {
    return openBytes(
      key,
      aadFor(input.walletId),
      {
        nonce: Buffer.from(parsed.nonce, "base64"),
        tag: Buffer.from(parsed.tag, "base64"),
        enc: Buffer.from(parsed.wrappedDek, "base64"),
      },
      "wallet envelope: cannot open password envelope",
    );
  } finally {
    key.fill(0);
  }
}

/** Wrap a wallet DEK under the server key (a raw 32-byte key held by the server seal). */
export function wrapDekWithServerKey(input: {
  walletId: string;
  dek: Buffer;
  serverKey: Buffer;
}): string {
  assertWalletId(input.walletId);
  if (!Buffer.isBuffer(input.dek) || input.dek.length !== DEK_BYTES) {
    throw new Error("wallet envelope: invalid data key");
  }
  if (!Buffer.isBuffer(input.serverKey) || input.serverKey.length !== 32) {
    throw new Error("wallet envelope: invalid server key");
  }
  return encodeParts(sealBytes(input.serverKey, aadFor(input.walletId), input.dek));
}

/** Open a server-key wrap; used for operational reads and migration, never signing unlocks. */
export function unwrapDekWithServerKey(input: {
  walletId: string;
  wrap: string;
  serverKey: Buffer;
}): Buffer {
  assertWalletId(input.walletId);
  if (!Buffer.isBuffer(input.serverKey) || input.serverKey.length !== 32) {
    throw new Error("wallet envelope: invalid server key");
  }
  return openBytes(
    input.serverKey,
    aadFor(input.walletId),
    decodeParts(input.wrap, "wallet envelope: cannot open server wrap"),
    "wallet envelope: cannot open server wrap",
  );
}

/**
 * Seal a wallet's private key into a full envelope: a fresh random DEK
 * encrypts the key, and the DEK is wrapped by both the server key and the
 * owner's password.
 */
export async function createWalletKeyEnvelope(input: {
  walletId: string;
  privateKey: Buffer;
  password: string;
  serverKey: Buffer;
}): Promise<WalletKeyEnvelope> {
  assertWalletId(input.walletId);
  assertSecretBytes(input.privateKey, "private key");
  const dek = randomBytes(DEK_BYTES);
  try {
    const keyCiphertext = encodeParts(sealBytes(dek, aadFor(input.walletId), input.privateKey));
    const serverWrap = wrapDekWithServerKey({
      walletId: input.walletId,
      dek: dek,
      serverKey: input.serverKey,
    });
    const passwordWrap = await wrapDekWithPassword({
      walletId: input.walletId,
      dek,
      password: input.password,
    });
    return { keyCiphertext, serverWrap, passwordWrap };
  } finally {
    dek.fill(0);
  }
}

/** Open the private key with the owner's password — the vault unlock path. */
export async function openWalletKeyWithPassword(input: {
  walletId: string;
  envelope: WalletKeyEnvelope;
  password: string;
}): Promise<Buffer> {
  const dek = await unwrapDekWithPassword({
    walletId: input.walletId,
    envelope: input.envelope.passwordWrap,
    password: input.password,
  });
  try {
    return openBytes(
      dek,
      aadFor(input.walletId),
      decodeParts(input.envelope.keyCiphertext, "wallet envelope: cannot open wallet key"),
      "wallet envelope: cannot open wallet key",
    );
  } finally {
    dek.fill(0);
  }
}

/** Open the private key with the server wrap — operational reads and migration only. */
export function openWalletKeyWithServerKey(input: {
  walletId: string;
  envelope: WalletKeyEnvelope;
  serverKey: Buffer;
}): Buffer {
  const dek = unwrapDekWithServerKey({
    walletId: input.walletId,
    wrap: input.envelope.serverWrap,
    serverKey: input.serverKey,
  });
  try {
    return openBytes(
      dek,
      aadFor(input.walletId),
      decodeParts(input.envelope.keyCiphertext, "wallet envelope: cannot open wallet key"),
      "wallet envelope: cannot open wallet key",
    );
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap the DEK under a new password after a password change. Only the
 * password wrap changes; the key ciphertext and server wrap are untouched.
 */
export async function rewrapWalletKeyEnvelope(input: {
  walletId: string;
  envelope: WalletKeyEnvelope;
  currentPassword: string;
  newPassword: string;
}): Promise<WalletKeyEnvelope> {
  const dek = await unwrapDekWithPassword({
    walletId: input.walletId,
    envelope: input.envelope.passwordWrap,
    password: input.currentPassword,
  });
  try {
    const passwordWrap = await wrapDekWithPassword({
      walletId: input.walletId,
      dek,
      password: input.newPassword,
    });
    return { ...input.envelope, passwordWrap };
  } finally {
    dek.fill(0);
  }
}

/**
 * Create the stored password verifier: a scrypt hash of the password with its
 * own salt and parameters, kept apart from the envelope. The verifier lets a
 * wrong password fail cleanly before any wallet is touched; it is never used
 * as an encryption key.
 */
export async function createPasswordVerifier(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveKey(password, salt, PASSWORD_SCRYPT_PARAMS, VERIFIER_BYTES);
  const payload = {
    kdf: "scrypt",
    N: PASSWORD_SCRYPT_PARAMS.N,
    r: PASSWORD_SCRYPT_PARAMS.r,
    p: PASSWORD_SCRYPT_PARAMS.p,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
  return FORMAT_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Check a password against a stored verifier in constant time. A malformed verifier never matches. */
export async function verifyPassword(verifier: string, password: string): Promise<boolean> {
  if (typeof verifier !== "string" || !verifier.startsWith(FORMAT_PREFIX)) return false;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(verifier.slice(FORMAT_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null || payload.kdf !== "scrypt") return false;
  const params = { N: payload.N, r: payload.r, p: payload.p } as ScryptParams;
  if (typeof params.N !== "number" || typeof params.r !== "number" || typeof params.p !== "number")
    return false;
  try {
    checkParams(params);
    const salt = Buffer.from(base64Field(payload.salt, SALT_BYTES), "base64");
    const expected = Buffer.from(base64Field(payload.hash, VERIFIER_BYTES), "base64");
    const actual = await deriveKey(password, salt, params, VERIFIER_BYTES);
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
    }
  } catch {
    return false;
  }
}
