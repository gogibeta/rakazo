import { createCipheriv, randomBytes, scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScryptParams, WalletKeyEnvelope } from "./wallet-envelope.js";
import * as envelopeModule from "./wallet-envelope.js";
import {
  createPasswordVerifier,
  createWalletKeyEnvelope,
  openWalletKeyWithPassword,
  PASSWORD_SCRYPT_PARAMS,
  parsePasswordEnvelope,
  rewrapWalletKeyEnvelope,
  serializePasswordEnvelope,
  unwrapDekWithPassword,
  verifyPassword,
  wrapDekWithPassword,
} from "./wallet-envelope.js";

// Fixed dummy material only — nothing here is, or could be, a real key.
// Wallet ids use the cuid v1 grammar the database generates for wallet rows.
const WALLET_ID = "ca1a1a1a1a1a1a1a1a1a1a1a1";
const OTHER_WALLET_ID = "cb2b2b2b2b2b2b2b2b2b2b2b2";
const PASSWORD = "correct horse battery staple (fixture)";
const NEW_PASSWORD = "a different fixture password";
const PRIVATE_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);
const AAD_BASE = "private-key-password-envelope-v1";

function deriveWith(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { ...params, maxmem: 512 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return deriveWith(password, salt, PASSWORD_SCRYPT_PARAMS);
}

async function fixtureEnvelope(walletId = WALLET_ID) {
  return createWalletKeyEnvelope({ walletId, privateKey: PRIVATE_KEY, password: PASSWORD });
}

let shared: Promise<WalletKeyEnvelope> | undefined;
function sharedEnvelope(): Promise<WalletKeyEnvelope> {
  if (!shared) shared = fixtureEnvelope();
  return shared;
}

function rawPayloadString(payload: Record<string, unknown>): string {
  return `pw-v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function rawPayloadText(jsonText: string): string {
  return `pw-v1:${Buffer.from(jsonText, "utf8").toString("base64url")}`;
}

function payloadOf(serialized: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(serialized.slice("pw-v1:".length), "base64url").toString("utf8"));
}

/** Build a password wrap by hand, with caller-chosen parameters and the real AAD. */
async function manualPasswordWrap(input: {
  walletId: string;
  dek: Buffer;
  password: string;
  params: ScryptParams;
}): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveWith(input.password, salt, input.params);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`${input.walletId}||${AAD_BASE}||password-dek-wrap`, "utf8"));
    const enc = Buffer.concat([cipher.update(input.dek), cipher.final()]);
    return rawPayloadString({
      kdf: "scrypt",
      N: input.params.N,
      r: input.params.r,
      p: input.params.p,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      wrappedDek: enc.toString("base64"),
    });
  } finally {
    key.fill(0);
  }
}

/** Build a key ciphertext by hand, bound to a chosen wallet id's private-key AAD. */
function manualKeyCiphertext(input: { aadWalletId: string; dek: Buffer }): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.dek, nonce);
  cipher.setAAD(Buffer.from(`${input.aadWalletId}||${AAD_BASE}||private-key`, "utf8"));
  const enc = Buffer.concat([cipher.update(PRIVATE_KEY), cipher.final()]);
  return `pwk-v1:${Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString("base64")}`;
}

function mapKeyCiphertextBody(serialized: string, map: (body: Buffer) => Buffer): string {
  const body = Buffer.from(serialized.slice("pwk-v1:".length), "base64");
  return `pwk-v1:${map(body).toString("base64")}`;
}

describe("wallet password envelope", () => {
  it("round-trips the private key through the password wrap", async () => {
    const envelope = await fixtureEnvelope();
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: PASSWORD }),
    ).resolves.toEqual(PRIVATE_KEY);
  });

  it("round-trips a bare DEK through the password wrap", async () => {
    const dek = randomBytes(32);
    const passwordWrap = await wrapDekWithPassword({
      walletId: WALLET_ID,
      dek,
      password: PASSWORD,
    });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: passwordWrap, password: PASSWORD }),
    ).resolves.toEqual(dek);
  });

  it("persists no server-held path to the key", async () => {
    const envelope = await fixtureEnvelope();
    // The complete persisted record is exactly two fields, and neither one
    // opens without the password.
    expect(Object.keys(envelope).sort()).toEqual(["keyCiphertext", "passwordWrap"]);
    // The module exports no server-key opening path at all.
    expect(envelopeModule).not.toHaveProperty("wrapDekWithServerKey");
    expect(envelopeModule).not.toHaveProperty("unwrapDekWithServerKey");
    expect(envelopeModule).not.toHaveProperty("openWalletKeyWithServerKey");
  });

  it("cannot be opened without the password, even with the complete record", async () => {
    const envelope = await fixtureEnvelope();
    // Wrong and empty passwords fail; the record alone is not enough.
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: "not the password" }),
    ).rejects.toThrow("cannot open password envelope");
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: "" }),
    ).rejects.toThrow("cannot open password envelope");
    // The two fields are not interchangeable: neither opens in the other's role.
    await expect(
      unwrapDekWithPassword({
        walletId: WALLET_ID,
        envelope: envelope.keyCiphertext,
        password: PASSWORD,
      }),
    ).rejects.toThrow();
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: { keyCiphertext: envelope.passwordWrap, passwordWrap: envelope.passwordWrap },
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open wallet key");
  });

  it("rejects tampering with every part of the password wrap", async () => {
    const envelope = await fixtureEnvelope();
    const parsed = parsePasswordEnvelope(envelope.passwordWrap);
    const flip = (value: string) => {
      const buf = Buffer.from(value, "base64");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64");
    };
    const variants = [
      { ...parsed, salt: flip(parsed.salt) },
      { ...parsed, nonce: flip(parsed.nonce) },
      { ...parsed, tag: flip(parsed.tag) },
      { ...parsed, wrappedDek: flip(parsed.wrappedDek) },
    ];
    for (const variant of variants) {
      await expect(
        unwrapDekWithPassword({
          walletId: WALLET_ID,
          envelope: serializePasswordEnvelope(variant),
          password: PASSWORD,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects truncated, extended, and substituted password wrap parts", async () => {
    const envelope = await fixtureEnvelope();
    const other = await fixtureEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    const otherPayload = payloadOf(other.passwordWrap);
    const resize = (value: string, bytes: number) =>
      Buffer.from(value, "base64").subarray(0, bytes).toString("base64");
    const extend = (value: string) =>
      Buffer.concat([Buffer.from(value, "base64"), Buffer.from([0])]).toString("base64");
    const wrappedDek = payload.wrappedDek as string;
    const variants = [
      { ...payload, wrappedDek: resize(wrappedDek, 31) },
      { ...payload, wrappedDek: extend(wrappedDek) },
      { ...payload, nonce: otherPayload.nonce },
      { ...payload, salt: otherPayload.salt },
    ];
    for (const variant of variants) {
      await expect(
        unwrapDekWithPassword({
          walletId: WALLET_ID,
          envelope: rawPayloadString(variant),
          password: PASSWORD,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects tampering with each region of the key ciphertext", async () => {
    const envelope = await fixtureEnvelope();
    const flipAt = (offset: number) =>
      mapKeyCiphertextBody(envelope.keyCiphertext, (body) => {
        const copy = Buffer.from(body);
        copy[offset] = copy[offset]! ^ 0xff;
        return copy;
      });
    const bodyLength = Buffer.from(envelope.keyCiphertext.slice("pwk-v1:".length), "base64").length;
    const variants = [
      flipAt(0), // nonce region
      flipAt(20), // tag region
      flipAt(bodyLength - 1), // ciphertext region
      mapKeyCiphertextBody(envelope.keyCiphertext, (body) => body.subarray(0, body.length - 1)),
      mapKeyCiphertextBody(envelope.keyCiphertext, (body) =>
        Buffer.concat([body, Buffer.from([0])]),
      ),
    ];
    for (const keyCiphertext of variants) {
      await expect(
        openWalletKeyWithPassword({
          walletId: WALLET_ID,
          envelope: { ...envelope, keyCiphertext },
          password: PASSWORD,
        }),
      ).rejects.toThrow("cannot open wallet key");
    }
  });

  it("binds the key ciphertext to its wallet independently of the wrap", async () => {
    // A known DEK lets the key ciphertext be tested on its own: the wrap
    // opens fine, so a failure here can only come from the ciphertext's AAD.
    const dek = randomBytes(32);
    const passwordWrap = await wrapDekWithPassword({
      walletId: OTHER_WALLET_ID,
      dek,
      password: PASSWORD,
    });
    const foreign = manualKeyCiphertext({ aadWalletId: WALLET_ID, dek });
    await expect(
      openWalletKeyWithPassword({
        walletId: OTHER_WALLET_ID,
        envelope: { keyCiphertext: foreign, passwordWrap },
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open wallet key");
    const own = manualKeyCiphertext({ aadWalletId: OTHER_WALLET_ID, dek });
    await expect(
      openWalletKeyWithPassword({
        walletId: OTHER_WALLET_ID,
        envelope: { keyCiphertext: own, passwordWrap },
        password: PASSWORD,
      }),
    ).resolves.toEqual(PRIVATE_KEY);
  });

  it("binds the password wrap to its wallet independently of the key ciphertext", async () => {
    const envelope = await fixtureEnvelope();
    await expect(
      unwrapDekWithPassword({
        walletId: OTHER_WALLET_ID,
        envelope: envelope.passwordWrap,
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open password envelope");
    await expect(
      openWalletKeyWithPassword({ walletId: OTHER_WALLET_ID, envelope, password: PASSWORD }),
    ).rejects.toThrow("cannot open password envelope");
  });

  it("does not interchange envelope parts between wallets sealed with the same password", async () => {
    const first = await fixtureEnvelope(WALLET_ID);
    const second = await fixtureEnvelope(OTHER_WALLET_ID);
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: { ...first, passwordWrap: second.passwordWrap },
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open");
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: { ...first, keyCiphertext: second.keyCiphertext },
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open");
  });

  it("rejects another version and malformed serializations", async () => {
    const envelope = await fixtureEnvelope();
    const wrongVersion = `pw-v9:${envelope.passwordWrap.slice("pw-v1:".length)}`;
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: wrongVersion, password: PASSWORD }),
    ).rejects.toThrow("unsupported envelope version");
    await expect(
      unwrapDekWithPassword({
        walletId: WALLET_ID,
        envelope: "pw-v1:not-json",
        password: PASSWORD,
      }),
    ).rejects.toThrow("malformed");
    expect(() => parsePasswordEnvelope("v2:whatever")).toThrow("unsupported envelope version");
  });

  it("re-wraps under a new password without changing the key ciphertext", async () => {
    const envelope = await fixtureEnvelope();
    const rewrapped = await rewrapWalletKeyEnvelope({
      walletId: WALLET_ID,
      envelope,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(rewrapped.keyCiphertext).toBe(envelope.keyCiphertext);
    expect(rewrapped.passwordWrap).not.toBe(envelope.passwordWrap);
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: rewrapped,
        password: NEW_PASSWORD,
      }),
    ).resolves.toEqual(PRIVATE_KEY);
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope: rewrapped, password: PASSWORD }),
    ).rejects.toThrow("cannot open");
    await expect(
      rewrapWalletKeyEnvelope({
        walletId: WALLET_ID,
        envelope,
        currentPassword: "not the password",
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toThrow("cannot open");
  });

  it("re-wrap does not vouch for the key ciphertext", async () => {
    const envelope = await fixtureEnvelope();
    const damaged = {
      ...envelope,
      keyCiphertext: mapKeyCiphertextBody(envelope.keyCiphertext, (body) => {
        const copy = Buffer.from(body);
        copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff;
        return copy;
      }),
    };
    // Re-wrapping authenticates only the password wrap, so it succeeds —
    // and the damage still surfaces, at the key stage, on open.
    const rewrapped = await rewrapWalletKeyEnvelope({
      walletId: WALLET_ID,
      envelope: damaged,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: rewrapped,
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow("cannot open wallet key");
  });

  it("never puts plaintext secret material in thrown errors", async () => {
    const envelope = await fixtureEnvelope();
    const attempts = [
      () =>
        openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: "not the password" }),
      () =>
        openWalletKeyWithPassword({
          walletId: OTHER_WALLET_ID,
          envelope,
          password: PASSWORD,
        }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (caught: unknown) => caught as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toContain(PRIVATE_KEY.toString("hex"));
      expect(error!.message).not.toContain(PASSWORD);
    }
  });
});

describe("KDF parameter policy", () => {
  it("freezes the default parameters", () => {
    expect(PASSWORD_SCRYPT_PARAMS).toEqual({ N: 32_768, r: 8, p: 4 });
    expect(Object.isFrozen(PASSWORD_SCRYPT_PARAMS)).toBe(true);
  });

  it("persists the KDF parameters and honors a stored approved profile on open", async () => {
    const envelope = await fixtureEnvelope();
    const parsed = parsePasswordEnvelope(envelope.passwordWrap);
    expect(parsed.kdf).toBe("scrypt");
    expect(parsed.params).toEqual(PASSWORD_SCRYPT_PARAMS);

    const profile = { N: 32_768, r: 8, p: 1 };
    const dek = randomBytes(32);
    const wrap = await manualPasswordWrap({
      walletId: WALLET_ID,
      dek,
      password: PASSWORD,
      params: profile,
    });
    expect(parsePasswordEnvelope(wrap).params).toEqual(profile);
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: wrap, password: PASSWORD }),
    ).resolves.toEqual(dek);
  });

  it("rejects the cheap legacy profile even when its cryptography is valid", async () => {
    // Built exactly like the old accepted test: a correct wrap under
    // N=16384, r=8, p=1. Policy now rejects it before derivation.
    const dek = randomBytes(32);
    const wrap = await manualPasswordWrap({
      walletId: WALLET_ID,
      dek,
      password: PASSWORD,
      params: { N: 16_384, r: 8, p: 1 },
    });
    expect(() => parsePasswordEnvelope(wrap)).toThrow("malformed");
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: wrap, password: PASSWORD }),
    ).rejects.toThrow("malformed");
  });

  it("fails authentication when accepted parameters are changed without re-encrypting", async () => {
    const envelope = await sharedEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    for (const tampered of [
      { ...payload, N: 65_536 },
      { ...payload, p: 2 },
    ]) {
      await expect(
        unwrapDekWithPassword({
          walletId: WALLET_ID,
          envelope: rawPayloadString(tampered),
          password: PASSWORD,
        }),
      ).rejects.toThrow("cannot open password envelope");
    }
  });

  it("rejects out-of-policy parameter shapes at parse time", async () => {
    const envelope = await sharedEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    const cases: Record<string, unknown>[] = [
      { ...payload, N: 1000 }, // below the floor and not a power of two
      { ...payload, N: 32_768.5 }, // fractional
      { ...payload, N: "32768" }, // wrong type
      { ...payload, r: 4 }, // r is fixed at 8
      { ...payload, p: 0 }, // below the floor
      { ...payload, p: 9 }, // above the ceiling
      { ...payload, N: 2 ** 18 }, // dominant memory would exceed the bound
      { ...payload, N: 2 ** 17, p: 8 }, // work would exceed the bound
    ];
    for (const bad of cases) {
      expect(() => parsePasswordEnvelope(rawPayloadString(bad))).toThrow("malformed");
    }
  });

  it("accepts the boundary profiles at parse time", async () => {
    const envelope = await sharedEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    for (const params of [
      { N: 2 ** 15, r: 8, p: 1 }, // the floor
      { N: 2 ** 17, r: 8, p: 4 }, // the memory and work ceilings together
    ]) {
      const parsed = parsePasswordEnvelope(rawPayloadString({ ...payload, ...params }));
      expect(parsed.params).toEqual(params);
    }
  });

  it("derives successfully at the maximum-memory profile", async () => {
    // N=2**17 has a ~128 MiB dominant allocation; the policy bound keeps it
    // at half of maxmem, so the module's own derivation must succeed.
    const dek = randomBytes(32);
    const wrap = await manualPasswordWrap({
      walletId: WALLET_ID,
      dek,
      password: PASSWORD,
      params: { N: 2 ** 17, r: 8, p: 1 },
    });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: wrap, password: PASSWORD }),
    ).resolves.toEqual(dek);
  });
});

describe("strict codecs", () => {
  it("rejects non-canonical outer base64url encodings", async () => {
    const envelope = await sharedEnvelope();
    const body = envelope.passwordWrap.slice("pw-v1:".length);
    const variants = [
      `pw-v1:${body}=`, // padding is not part of the canonical form
      `pw-v1:+${body.slice(1)}`, // a standard-base64 character in a url payload
      `pw-v1:${body.slice(0, 8)} ${body.slice(8)}`, // stray whitespace
    ];
    for (const variant of variants) {
      expect(() => parsePasswordEnvelope(variant)).toThrow();
    }
  });

  it("rejects duplicate, unknown, missing, and reordered JSON properties", async () => {
    const envelope = await sharedEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    const salt = payload.salt as string;
    const withDuplicate = JSON.stringify(payload).replace(
      `"salt":"${salt}"`,
      `"salt":"${salt}","salt":"${salt}"`,
    );
    expect(() => parsePasswordEnvelope(rawPayloadText(withDuplicate))).toThrow("malformed");
    expect(() => parsePasswordEnvelope(rawPayloadString({ ...payload, extra: 1 }))).toThrow(
      "malformed",
    );
    const missingTag = { ...payload };
    delete missingTag.tag;
    expect(() => parsePasswordEnvelope(rawPayloadString(missingTag))).toThrow("malformed");
    const reordered = {
      salt: payload.salt,
      kdf: payload.kdf,
      N: payload.N,
      r: payload.r,
      p: payload.p,
      nonce: payload.nonce,
      tag: payload.tag,
      wrappedDek: payload.wrappedDek,
    };
    expect(() => parsePasswordEnvelope(rawPayloadString(reordered))).toThrow("malformed");
  });

  it("rejects oversized serialized inputs before parsing", async () => {
    expect(() => parsePasswordEnvelope(`pw-v1:${"A".repeat(2048)}`)).toThrow("malformed");
    const envelope = await sharedEnvelope();
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: { ...envelope, keyCiphertext: `pwk-v1:${"A".repeat(3000)}` },
        password: PASSWORD,
      }),
    ).rejects.toThrow("cannot open wallet key");
  });

  it("rejects non-canonical inner base64 and wrong field lengths", async () => {
    const envelope = await sharedEnvelope();
    const payload = payloadOf(envelope.passwordWrap);
    const unpaddedSalt = (payload.salt as string).replace(/=+$/, "");
    expect(() =>
      parsePasswordEnvelope(rawPayloadString({ ...payload, salt: unpaddedSalt })),
    ).toThrow("malformed");
    const resize = (bytes: number) => randomBytes(bytes).toString("base64");
    expect(() =>
      parsePasswordEnvelope(rawPayloadString({ ...payload, wrappedDek: resize(31) })),
    ).toThrow("malformed");
    expect(() =>
      parsePasswordEnvelope(rawPayloadString({ ...payload, wrappedDek: resize(33) })),
    ).toThrow("malformed");
    expect(() => parsePasswordEnvelope(rawPayloadString({ ...payload, salt: resize(15) }))).toThrow(
      "malformed",
    );
  });

  it("rejects unframed, empty, and non-canonical key ciphertexts", async () => {
    const envelope = await sharedEnvelope();
    const unframed = envelope.keyCiphertext.slice("pwk-v1:".length);
    const emptyPayload = `pwk-v1:${randomBytes(28).toString("base64")}`; // nonce + tag, no ciphertext
    const padded = `${envelope.keyCiphertext}=`;
    for (const keyCiphertext of [unframed, emptyPayload, padded]) {
      await expect(
        openWalletKeyWithPassword({
          walletId: WALLET_ID,
          envelope: { ...envelope, keyCiphertext },
          password: PASSWORD,
        }),
      ).rejects.toThrow("cannot open wallet key");
    }
  });

  it("validates on serialize too", async () => {
    const envelope = await sharedEnvelope();
    const parsed = parsePasswordEnvelope(envelope.passwordWrap);
    expect(() => serializePasswordEnvelope({ ...parsed, params: { N: 1024, r: 8, p: 1 } })).toThrow(
      "invalid password envelope",
    );
    expect(() =>
      serializePasswordEnvelope({ ...parsed, salt: randomBytes(8).toString("base64") }),
    ).toThrow("invalid password envelope");
    expect(() => serializePasswordEnvelope({ ...parsed, kdf: "argon2" as "scrypt" })).toThrow(
      "invalid password envelope",
    );
  });
});

describe("error contract", () => {
  it("uses one generic message per failure stage", async () => {
    const envelope = await sharedEnvelope();
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: "not the password" }),
    ).rejects.toThrow(new Error("wallet envelope: cannot open password envelope"));
    const damaged = {
      ...envelope,
      keyCiphertext: mapKeyCiphertextBody(envelope.keyCiphertext, (body) => {
        const copy = Buffer.from(body);
        copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff;
        return copy;
      }),
    };
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope: damaged, password: PASSWORD }),
    ).rejects.toThrow(new Error("wallet envelope: cannot open wallet key"));
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: "pw-v1:%%%", password: PASSWORD }),
    ).rejects.toThrow(new Error("wallet envelope: malformed password envelope"));
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: "pw-v9:AAAA", password: PASSWORD }),
    ).rejects.toThrow(new Error("wallet envelope: unsupported envelope version"));
  });

  it("rejects wallet ids outside the cuid grammar", async () => {
    const envelope = await sharedEnvelope();
    const badIds = [
      "",
      "wallet-fixture-1",
      "CA1A1A1A1A1A1A1A1A1A1A1A1", // uppercase
      "ca1a1a1a1a1a1a1a1a1a1a1", // too short
      "ca1a1a1a1a1a1a1a1a|a1a1", // separator in the id
    ];
    for (const walletId of badIds) {
      await expect(
        createWalletKeyEnvelope({ walletId, privateKey: PRIVATE_KEY, password: PASSWORD }),
      ).rejects.toThrow("invalid wallet id");
      await expect(
        unwrapDekWithPassword({ walletId, envelope: envelope.passwordWrap, password: PASSWORD }),
      ).rejects.toThrow("invalid wallet id");
    }
  });

  it("rejects invalid runtime inputs", async () => {
    await expect(
      wrapDekWithPassword({ walletId: WALLET_ID, dek: randomBytes(31), password: PASSWORD }),
    ).rejects.toThrow("invalid data key");
    await expect(
      createWalletKeyEnvelope({
        walletId: WALLET_ID,
        privateKey: Buffer.alloc(0),
        password: PASSWORD,
      }),
    ).rejects.toThrow("non-empty");
    await expect(
      createWalletKeyEnvelope({
        walletId: WALLET_ID,
        privateKey: randomBytes(1025),
        password: PASSWORD,
      }),
    ).rejects.toThrow("too large");
  });
});

describe("password verifier", () => {
  it("accepts the right password and rejects others", async () => {
    const verifier = await createPasswordVerifier(PASSWORD);
    await expect(verifyPassword(verifier, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(verifier, "not the password")).resolves.toBe(false);
    await expect(verifyPassword(verifier, "")).resolves.toBe(false);
  });

  it("uses its own salt: two verifiers for one password differ and both verify", async () => {
    const first = await createPasswordVerifier(PASSWORD);
    const second = await createPasswordVerifier(PASSWORD);
    expect(first).not.toBe(second);
    await expect(verifyPassword(first, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(second, PASSWORD)).resolves.toBe(true);
  });

  it("derives independently of the envelope wrap: neither opens the other", async () => {
    // The verifier is a bare hash; feeding it to the envelope opener fails,
    // and a password wrap is not a verifier.
    const verifier = await createPasswordVerifier(PASSWORD);
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: verifier, password: PASSWORD }),
    ).rejects.toThrow();
    const envelope = await fixtureEnvelope();
    await expect(verifyPassword(envelope.passwordWrap, PASSWORD)).resolves.toBe(false);
  });

  it("matches a straight scrypt of the password under its own salt", async () => {
    const verifier = await createPasswordVerifier(PASSWORD);
    const payload = JSON.parse(
      Buffer.from(verifier.slice("pw-v1:".length), "base64url").toString("utf8"),
    ) as { salt: string; hash: string };
    const expected = await derive(PASSWORD, Buffer.from(payload.salt, "base64"));
    expect(payload.hash).toBe(expected.toString("base64"));
  });

  it("never matches a malformed verifier", async () => {
    await expect(verifyPassword("pw-v1:not-json", PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword("garbage", PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword("", PASSWORD)).resolves.toBe(false);
  });

  it("never matches a verifier with extra, duplicate, or non-canonical content", async () => {
    const verifier = await createPasswordVerifier(PASSWORD);
    const payload = payloadOf(verifier);
    await expect(
      verifyPassword(rawPayloadString({ ...payload, extra: 1 }), PASSWORD),
    ).resolves.toBe(false);
    const hash = payload.hash as string;
    const withDuplicate = JSON.stringify(payload).replace(
      `"hash":"${hash}"`,
      `"hash":"${hash}","hash":"${hash}"`,
    );
    await expect(verifyPassword(rawPayloadText(withDuplicate), PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword(`${verifier}=`, PASSWORD)).resolves.toBe(false);
  });

  it("never matches a verifier derived under out-of-policy parameters", async () => {
    // A correct hash under the cheap legacy profile: the verifier policy is
    // the envelope policy, so this must not verify.
    const salt = randomBytes(16);
    const hash = await deriveWith(PASSWORD, salt, { N: 16_384, r: 8, p: 1 });
    const weak = rawPayloadString({
      kdf: "scrypt",
      N: 16_384,
      r: 8,
      p: 1,
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
    });
    await expect(verifyPassword(weak, PASSWORD)).resolves.toBe(false);
  });
});
