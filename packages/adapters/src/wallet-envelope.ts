import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

/**
 * Password envelope for wallet keys (formats pw-v1 and pwk-v1).
 *
 * Each wallet gets a random data-encryption key (DEK). The DEK encrypts the
 * wallet's private key (the pwk-v1 key ciphertext), and the DEK itself is
 * wrapped exactly once: by a key derived from the owner's wallet password
 * (the pw-v1 password wrap). There is deliberately no server-key wrap. With
 * the complete persisted record and every server-held secret, but without
 * the password, the DEK — and therefore the private key — cannot be
 * recovered; the password is cryptographically required, not merely checked.
 * Changing the password re-wraps the DEK without touching the key
 * ciphertext. Legacy wallets sealed by the server seal live elsewhere (the
 * EncryptedSecretStore path) and never pass through this module.
 *
 * The password-derived key comes from scrypt (N=16384 is too cheap for a
 * user password): the default profile is N=32768, r=8, p=4, tuned to land
 * in the few-hundred-millisecond range on a small VM. Parameters persist
 * per envelope so they can be raised later, but stored parameters are
 * honored only inside an approved policy: a minimum security floor, a
 * memory bound with runtime headroom, and a separate CPU-work bound (see
 * checkParams). Password-derived keys are never cached.
 *
 * Both ciphertexts bind the wallet id and a distinct role as associated
 * data, so a ciphertext cannot be moved to another wallet or replayed in
 * the other role. Errors are deliberately generic: they never carry
 * password, key, or plaintext material, and nothing here logs. Failure
 * stages are not indistinguishable, and this module does not pretend
 * otherwise: malformed records fail before derivation, a wrong password
 * and a tampered password wrap fail after derivation with the same generic
 * error, and a damaged key ciphertext fails at the second stage. Only the
 * password verifier's final comparison is constant-time. Callers at the
 * unlock boundary must translate failures into one non-sensitive response.
 *
 * Buffer wiping here is best-effort exposure reduction, never guaranteed
 * erasure: passwords are immutable strings, caller-owned buffers and
 * returned plaintext are the caller's responsibility to clear, and native
 * crypto internals are out of reach.
 */

const FORMAT_PREFIX = "pw-v1:";
const KEY_FORMAT_PREFIX = "pwk-v1:";
const AAD_PURPOSE = "private-key-password-envelope-v1";
const DEK_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERIFIER_BYTES = 32;
/** Bound the private-key payload to the formats wallets actually store. */
const MAX_PRIVATE_KEY_BYTES = 1024;
/** Serialized inputs are size-bounded before any decoding or parsing. */
const MAX_PASSWORD_ENVELOPE_CHARS = 1024;
const MAX_VERIFIER_CHARS = 1024;
const MAX_KEY_CIPHERTEXT_CHARS = 2048;

/**
 * Wallet ids are the cuid v1 values the database generates for wallet rows
 * ("c" followed by 24 lowercase alphanumerics). Restricting ids to that
 * grammar keeps the AAD framing unambiguous: no separators, no non-ASCII,
 * no strings that could collapse to the same bytes.
 */
const WALLET_ID_PATTERN = /^c[a-z0-9]{24}$/;

type AadRole = "private-key" | "password-dek-wrap";

/** scrypt parameters for both password derivation and the password verifier. */
export type ScryptParams = { N: number; r: number; p: number };

/** The profile new envelopes and verifiers are created with. Frozen: policy is not mutable state. */
export const PASSWORD_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 32_768,
  r: 8,
  p: 4,
});
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/**
 * Approved-parameter policy for stored records. The floor keeps the cheap
 * N=16384, r=8, p=1 profile out. The memory bound uses the dominant scrypt
 * allocation (~128 * N * r bytes; p mostly adds work, not memory) and
 * stays at half of maxmem, so every accepted profile leaves headroom for
 * derivation overhead instead of validating here and failing at runtime.
 * The work bound caps N * r * p at four times the default profile.
 */
const PARAM_FLOOR = { N: 2 ** 15, r: 8, p: 1 } as const;
const PARAM_CEILING = { N: 2 ** 17, r: 8, p: 8 } as const;
const MAX_KDF_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_KDF_WORK = 2 ** 22;

export type WalletKeyEnvelope = {
  /** The private key encrypted under the wallet DEK (pwk-v1). */
  keyCiphertext: string;
  /** The DEK wrapped by the password-derived key (pw-v1). The only wrap. */
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

const PASSWORD_ENVELOPE_KEYS = ["kdf", "N", "r", "p", "salt", "nonce", "tag", "wrappedDek"];
const VERIFIER_KEYS = ["kdf", "N", "r", "p", "salt", "hash"];

function aadFor(walletId: string, role: AadRole): Buffer {
  return Buffer.from(`${walletId}||${AAD_PURPOSE}||${role}`, "utf8");
}

function assertWalletId(walletId: string): void {
  if (typeof walletId !== "string" || !WALLET_ID_PATTERN.test(walletId)) {
    throw new Error("wallet envelope: invalid wallet id");
  }
}

function assertSecretBytes(value: Buffer, name: string): void {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error(`wallet envelope: ${name} must be non-empty bytes`);
  }
  if (value.length > MAX_PRIVATE_KEY_BYTES) {
    throw new Error(`wallet envelope: ${name} is too large`);
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("wallet envelope: key derivation failed"));
    try {
      scrypt(password, salt, length, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) =>
        error || !key ? fail() : resolve(key),
      );
    } catch {
      // scrypt throws synchronously for invalid options; normalize those to
      // the same generic failure as callback errors.
      fail();
    }
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
  let head: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parts.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    head = decipher.update(parts.enc);
    tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    throw new Error(failure);
  } finally {
    // The update() output is plaintext before final() authenticates it;
    // wipe both intermediates on success and on authentication failure.
    head?.fill(0);
    tail?.fill(0);
  }
}

function encodeParts(parts: { nonce: Buffer; tag: Buffer; enc: Buffer }): string {
  return Buffer.concat([parts.nonce, parts.tag, parts.enc]).toString("base64");
}

const malformed = "wallet envelope: malformed password envelope";
const cannotOpenKey = "wallet envelope: cannot open wallet key";

/** Encode a key ciphertext with its pwk-v1 type framing. */
function encodeKeyCiphertext(parts: { nonce: Buffer; tag: Buffer; enc: Buffer }): string {
  return KEY_FORMAT_PREFIX + encodeParts(parts);
}

/**
 * Decode a pwk-v1 key ciphertext strictly: canonical base64, and a decoded
 * length that fits a nonce, a tag, and a bounded private-key payload. Any
 * defect reports as the generic open failure, like an authentication error.
 */
function decodeKeyCiphertext(serialized: string): { nonce: Buffer; tag: Buffer; enc: Buffer } {
  if (typeof serialized !== "string" || !serialized.startsWith(KEY_FORMAT_PREFIX)) {
    throw new Error(cannotOpenKey);
  }
  const body = serialized.slice(KEY_FORMAT_PREFIX.length);
  if (body.length === 0 || body.length > MAX_KEY_CIPHERTEXT_CHARS) {
    throw new Error(cannotOpenKey);
  }
  const buf = Buffer.from(body, "base64");
  if (buf.toString("base64") !== body) throw new Error(cannotOpenKey);
  if (
    buf.length < NONCE_BYTES + TAG_BYTES + 1 ||
    buf.length > NONCE_BYTES + TAG_BYTES + MAX_PRIVATE_KEY_BYTES
  ) {
    throw new Error(cannotOpenKey);
  }
  return {
    nonce: buf.subarray(0, NONCE_BYTES),
    tag: buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    enc: buf.subarray(NONCE_BYTES + TAG_BYTES),
  };
}

function checkParams(params: ScryptParams): void {
  const { N, r, p } = params;
  if (!Number.isInteger(N) || N < PARAM_FLOOR.N || N > PARAM_CEILING.N || (N & (N - 1)) !== 0) {
    throw new Error(malformed);
  }
  if (r !== PARAM_FLOOR.r || !Number.isInteger(p) || p < PARAM_FLOOR.p || p > PARAM_CEILING.p) {
    throw new Error(malformed);
  }
  if (128 * N * r > MAX_KDF_MEMORY_BYTES) throw new Error(malformed);
  if (N * r * p > MAX_KDF_WORK) throw new Error(malformed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

/**
 * Decode canonical base64url: re-encoding the decoded bytes must reproduce
 * the input exactly, so alternate spellings, padding, and stray characters
 * are all rejected before the payload is parsed.
 */
function decodeBase64UrlStrict(value: string): Buffer {
  const buf = Buffer.from(value, "base64url");
  if (buf.toString("base64url") !== value) throw new Error(malformed);
  return buf;
}

function parseJsonPayload(
  serialized: string,
  maxChars: number,
): { raw: string; payload: Record<string, unknown> } {
  if (serialized.length > maxChars) throw new Error(malformed);
  const raw = decodeBase64UrlStrict(serialized.slice(FORMAT_PREFIX.length)).toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(malformed);
  }
  if (!isRecord(payload)) throw new Error(malformed);
  return { raw, payload };
}

function readParams(payload: Record<string, unknown>): ScryptParams {
  const params = { N: payload.N, r: payload.r, p: payload.p } as ScryptParams;
  if (
    typeof params.N !== "number" ||
    typeof params.r !== "number" ||
    typeof params.p !== "number"
  ) {
    throw new Error(malformed);
  }
  checkParams(params);
  return params;
}

function base64Field(value: unknown, bytes: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(malformed);
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value || buf.length !== bytes) throw new Error(malformed);
  return value;
}

/** Serialize a password wrap to its stored pw-v1 string, validating first. */
export function serializePasswordEnvelope(envelope: PasswordEnvelope): string {
  const payload = {
    kdf: envelope.kdf,
    N: envelope.params?.N,
    r: envelope.params?.r,
    p: envelope.params?.p,
    salt: envelope.salt,
    nonce: envelope.nonce,
    tag: envelope.tag,
    wrappedDek: envelope.wrappedDek,
  };
  const serialized =
    FORMAT_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  try {
    parsePasswordEnvelope(serialized);
  } catch {
    throw new Error("wallet envelope: invalid password envelope");
  }
  return serialized;
}

/** Parse a stored pw-v1 string, rejecting any other version or shape. */
export function parsePasswordEnvelope(serialized: string): PasswordEnvelope {
  if (typeof serialized !== "string" || !serialized.startsWith(FORMAT_PREFIX)) {
    throw new Error("wallet envelope: unsupported envelope version");
  }
  const { raw, payload } = parseJsonPayload(serialized, MAX_PASSWORD_ENVELOPE_CHARS);
  if (!hasExactKeys(payload, PASSWORD_ENVELOPE_KEYS) || payload.kdf !== "scrypt") {
    throw new Error(malformed);
  }
  const params = readParams(payload);
  const fields = {
    salt: base64Field(payload.salt, SALT_BYTES),
    nonce: base64Field(payload.nonce, NONCE_BYTES),
    tag: base64Field(payload.tag, TAG_BYTES),
    wrappedDek: base64Field(payload.wrappedDek, DEK_BYTES),
  };
  // The stored form is one canonical serialization: re-encoding the parsed
  // fields must reproduce it byte for byte. This rejects duplicate or
  // unknown properties, reordering, and non-canonical numbers or strings.
  const canonical = JSON.stringify({
    kdf: "scrypt",
    N: params.N,
    r: params.r,
    p: params.p,
    ...fields,
  });
  if (canonical !== raw) throw new Error(malformed);
  return { kdf: "scrypt", params, ...fields };
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
    const parts = sealBytes(key, aadFor(input.walletId, "password-dek-wrap"), input.dek);
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

/**
 * Open a password wrap. Malformed records fail before derivation; a wrong
 * password and a tampered wrap both fail after derivation with the same
 * generic error, so those two are not distinguishable here.
 */
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
      aadFor(input.walletId, "password-dek-wrap"),
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

/**
 * Seal a wallet's private key into a full envelope: a fresh random DEK
 * encrypts the key, and the DEK is wrapped by the owner's password — the
 * only wrap. Nothing the server holds can open the result.
 */
export async function createWalletKeyEnvelope(input: {
  walletId: string;
  privateKey: Buffer;
  password: string;
}): Promise<WalletKeyEnvelope> {
  assertWalletId(input.walletId);
  assertSecretBytes(input.privateKey, "private key");
  const dek = randomBytes(DEK_BYTES);
  try {
    const keyCiphertext = encodeKeyCiphertext(
      sealBytes(dek, aadFor(input.walletId, "private-key"), input.privateKey),
    );
    const passwordWrap = await wrapDekWithPassword({
      walletId: input.walletId,
      dek,
      password: input.password,
    });
    return { keyCiphertext, passwordWrap };
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
  if (!isRecord(input.envelope)) throw new Error(cannotOpenKey);
  const dek = await unwrapDekWithPassword({
    walletId: input.walletId,
    envelope: input.envelope.passwordWrap,
    password: input.password,
  });
  try {
    return openBytes(
      dek,
      aadFor(input.walletId, "private-key"),
      decodeKeyCiphertext(input.envelope.keyCiphertext),
      cannotOpenKey,
    );
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap the DEK under a new password after a password change. Only the
 * password wrap changes; the key ciphertext is untouched. Success proves
 * the password wrap opened and re-wrapped — it does not prove the key
 * ciphertext is intact, and a copied old envelope opened with the old
 * password still works: the DEK does not change. Callers must not treat
 * either as revocation or as a wallet usability check.
 */
export async function rewrapWalletKeyEnvelope(input: {
  walletId: string;
  envelope: WalletKeyEnvelope;
  currentPassword: string;
  newPassword: string;
}): Promise<WalletKeyEnvelope> {
  if (!isRecord(input.envelope)) throw new Error(cannotOpenKey);
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
 * as an encryption key. Verifiers are held to the same parameter policy as
 * envelopes, so a verifier is never weaker than the wrap it guards.
 */
export async function createPasswordVerifier(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveKey(password, salt, PASSWORD_SCRYPT_PARAMS, VERIFIER_BYTES);
  try {
    const payload = {
      kdf: "scrypt",
      N: PASSWORD_SCRYPT_PARAMS.N,
      r: PASSWORD_SCRYPT_PARAMS.r,
      p: PASSWORD_SCRYPT_PARAMS.p,
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
    };
    return FORMAT_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  } finally {
    hash.fill(0);
  }
}

/**
 * Check a password against a stored verifier. Only the final comparison is
 * constant-time; malformed or out-of-policy records return false
 * immediately and valid records cost a derivation. A malformed verifier
 * never matches.
 */
export async function verifyPassword(verifier: string, password: string): Promise<boolean> {
  if (typeof verifier !== "string" || !verifier.startsWith(FORMAT_PREFIX)) return false;
  try {
    const { raw, payload } = parseJsonPayload(verifier, MAX_VERIFIER_CHARS);
    if (!hasExactKeys(payload, VERIFIER_KEYS) || payload.kdf !== "scrypt") return false;
    const params = readParams(payload);
    const salt = base64Field(payload.salt, SALT_BYTES);
    const hash = base64Field(payload.hash, VERIFIER_BYTES);
    const canonical = JSON.stringify({
      kdf: "scrypt",
      N: params.N,
      r: params.r,
      p: params.p,
      salt,
      hash,
    });
    if (canonical !== raw) return false;
    const actual = await deriveKey(password, Buffer.from(salt, "base64"), params, VERIFIER_BYTES);
    try {
      return timingSafeEqual(actual, Buffer.from(hash, "base64"));
    } finally {
      actual.fill(0);
    }
  } catch {
    return false;
  }
}
