import { randomBytes, scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPasswordVerifier,
  createWalletKeyEnvelope,
  openWalletKeyWithPassword,
  openWalletKeyWithServerKey,
  PASSWORD_SCRYPT_PARAMS,
  parsePasswordEnvelope,
  rewrapWalletKeyEnvelope,
  serializePasswordEnvelope,
  unwrapDekWithPassword,
  unwrapDekWithServerKey,
  verifyPassword,
  wrapDekWithPassword,
  wrapDekWithServerKey,
} from "./wallet-envelope.js";

// Fixed dummy material only — nothing here is, or could be, a real key.
const WALLET_ID = "wallet-fixture-1";
const OTHER_WALLET_ID = "wallet-fixture-2";
const PASSWORD = "correct horse battery staple (fixture)";
const NEW_PASSWORD = "a different fixture password";
const PRIVATE_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);
const SERVER_KEY = Buffer.from(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "hex",
);
const OTHER_SERVER_KEY = randomBytes(32);

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      length,
      { ...PASSWORD_SCRYPT_PARAMS, maxmem: 512 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

async function fixtureEnvelope(walletId = WALLET_ID) {
  return createWalletKeyEnvelope({
    walletId,
    privateKey: PRIVATE_KEY,
    password: PASSWORD,
    serverKey: SERVER_KEY,
  });
}

describe("wallet password envelope", () => {
  it("round-trips the private key through the password wrap", async () => {
    const envelope = await fixtureEnvelope();
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: PASSWORD }),
    ).resolves.toEqual(PRIVATE_KEY);
  });

  it("round-trips the private key through the server wrap", async () => {
    const envelope = await fixtureEnvelope();
    expect(
      openWalletKeyWithServerKey({ walletId: WALLET_ID, envelope, serverKey: SERVER_KEY }),
    ).toEqual(PRIVATE_KEY);
  });

  it("round-trips a bare DEK through both wraps", async () => {
    const dek = randomBytes(32);
    const passwordWrap = await wrapDekWithPassword({
      walletId: WALLET_ID,
      dek,
      password: PASSWORD,
    });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: passwordWrap, password: PASSWORD }),
    ).resolves.toEqual(dek);
    const serverWrap = wrapDekWithServerKey({ walletId: WALLET_ID, dek, serverKey: SERVER_KEY });
    expect(
      unwrapDekWithServerKey({ walletId: WALLET_ID, wrap: serverWrap, serverKey: SERVER_KEY }),
    ).toEqual(dek);
  });

  it("rejects a wrong password", async () => {
    const envelope = await fixtureEnvelope();
    await expect(
      openWalletKeyWithPassword({ walletId: WALLET_ID, envelope, password: "not the password" }),
    ).rejects.toThrow("cannot open");
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

  it("rejects tampering with the key ciphertext and the server wrap", async () => {
    const envelope = await fixtureEnvelope();
    const flipSerialized = (serialized: string) => {
      const buf = Buffer.from(serialized, "base64");
      buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
      return buf.toString("base64");
    };
    expect(() =>
      openWalletKeyWithServerKey({
        walletId: WALLET_ID,
        envelope: { ...envelope, keyCiphertext: flipSerialized(envelope.keyCiphertext) },
        serverKey: SERVER_KEY,
      }),
    ).toThrow("cannot open");
    expect(() =>
      openWalletKeyWithServerKey({
        walletId: WALLET_ID,
        envelope: { ...envelope, serverWrap: flipSerialized(envelope.serverWrap) },
        serverKey: SERVER_KEY,
      }),
    ).toThrow("cannot open");
  });

  it("binds the envelope to its wallet: another wallet id cannot open it", async () => {
    const envelope = await fixtureEnvelope();
    await expect(
      openWalletKeyWithPassword({ walletId: OTHER_WALLET_ID, envelope, password: PASSWORD }),
    ).rejects.toThrow("cannot open");
    expect(() =>
      openWalletKeyWithServerKey({ walletId: OTHER_WALLET_ID, envelope, serverKey: SERVER_KEY }),
    ).toThrow("cannot open");
  });

  it("does not interchange envelopes between wallets sealed with the same password and server key", async () => {
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

  it("persists the KDF parameters and honors stored ones on open", async () => {
    const envelope = await fixtureEnvelope();
    const parsed = parsePasswordEnvelope(envelope.passwordWrap);
    expect(parsed.kdf).toBe("scrypt");
    expect(parsed.params).toEqual(PASSWORD_SCRYPT_PARAMS);

    // Re-encode the same wrap with a weaker (but in-bounds) parameter set and
    // the matching derivation: opening must follow the stored parameters.
    const weaker = { N: 16_384, r: 8, p: 1 };
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(PASSWORD, salt, 32, { ...weaker, maxmem: 512 * 1024 * 1024 }, (error, derived) =>
        error ? reject(error) : resolve(derived),
      );
    });
    const dek = randomBytes(32);
    const { createCipheriv } = await import("node:crypto");
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(parsed.nonce, "base64"));
    cipher.setAAD(Buffer.from(`${WALLET_ID}||private-key-password-envelope-v1`, "utf8"));
    const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
    const custom = serializePasswordEnvelope({
      ...parsed,
      params: weaker,
      salt: salt.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      wrappedDek: enc.toString("base64"),
    });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: custom, password: PASSWORD }),
    ).resolves.toEqual(dek);
  });

  it("refuses stored parameters outside the accepted bounds", async () => {
    const envelope = await fixtureEnvelope();
    const parsed = parsePasswordEnvelope(envelope.passwordWrap);
    const tooCheap = serializePasswordEnvelope({ ...parsed, params: { N: 1024, r: 8, p: 1 } });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: tooCheap, password: PASSWORD }),
    ).rejects.toThrow("malformed");
    const tooCostly = serializePasswordEnvelope({ ...parsed, params: { N: 2 ** 20, r: 8, p: 1 } });
    await expect(
      unwrapDekWithPassword({ walletId: WALLET_ID, envelope: tooCostly, password: PASSWORD }),
    ).rejects.toThrow("malformed");
  });

  it("rejects the wrong server key", async () => {
    const envelope = await fixtureEnvelope();
    expect(() =>
      openWalletKeyWithServerKey({ walletId: WALLET_ID, envelope, serverKey: OTHER_SERVER_KEY }),
    ).toThrow("cannot open");
  });

  it("re-wraps under a new password without changing the key ciphertext or server wrap", async () => {
    const envelope = await fixtureEnvelope();
    const rewrapped = await rewrapWalletKeyEnvelope({
      walletId: WALLET_ID,
      envelope,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(rewrapped.keyCiphertext).toBe(envelope.keyCiphertext);
    expect(rewrapped.serverWrap).toBe(envelope.serverWrap);
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
      expect(error!.message).not.toContain(SERVER_KEY.toString("hex"));
    }
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
    const expected = await derive(PASSWORD, Buffer.from(payload.salt, "base64"), 32);
    expect(payload.hash).toBe(expected.toString("base64"));
  });

  it("never matches a malformed verifier", async () => {
    await expect(verifyPassword("pw-v1:not-json", PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword("garbage", PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword("", PASSWORD)).resolves.toBe(false);
  });
});
