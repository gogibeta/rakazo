import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  activateModelCredentialKey,
  addModelCredentialKey,
  listModelCredentialKeys,
  markModelCredentialKeyFailed,
  orderModelCredentialKeysForUse,
  removeModelCredentialKey,
} from "./model-credential-keys.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("model credential keys (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `model-credential-keys-user-${suffix}`;
  const credentialId = `model-credential-keys-connection-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  const connect = async (secretId: string) => {
    await prisma.secret.create({
      data: { id: secretId, userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await prisma.userModelCredential.create({
      data: { id: credentialId, userId, provider: "openai", label: "OpenAI", secretId },
    });
    // What the connect path writes: the connection's secret is pool entry #1.
    await addModelCredentialKey(prisma, {
      userId,
      credentialId,
      label: "",
      secretId,
    });
  };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Keys", email: `${userId}@rakazo.test`, emailVerified: false },
    });
  });

  beforeEach(async () => {
    await prisma.userModelCredential.deleteMany({ where: { userId } });
    await prisma.secret.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("keeps a legacy single key working: one entry, active, in order", async () => {
    await connect("secret-legacy");
    const keys = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.secretId).toBe("secret-legacy");
    expect(orderModelCredentialKeysForUse(keys, "secret-legacy").map((key) => key.id)).toEqual(
      keys.map((key) => key.id),
    );
  });

  it("appends entries in pool order and orders the active one first", async () => {
    await connect("secret-1");
    await prisma.secret.create({
      data: { id: "secret-2", userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    const second = await addModelCredentialKey(prisma, {
      userId,
      credentialId,
      label: "Spare",
      secretId: "secret-2",
    });
    const keys = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(keys.map((key) => key.secretId)).toEqual(["secret-1", "secret-2"]);
    expect(second.position).toBe(1);
    // Activating the second entry makes it the first a run tries (sticky).
    await activateModelCredentialKey(prisma, { userId, credentialId, keyId: second.id });
    const credential = await prisma.userModelCredential.findUnique({
      where: { id: credentialId },
    });
    expect(credential?.secretId).toBe("secret-2");
    expect(orderModelCredentialKeysForUse(keys, credential!.secretId)[0]?.id).toBe(second.id);
  });

  it("marks failures and clears the mark when the entry activates", async () => {
    await connect("secret-1");
    const [entry] = await listModelCredentialKeys(prisma, { userId, credentialId });
    await markModelCredentialKeyFailed(prisma, { userId, keyId: entry!.id });
    const [marked] = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(marked?.lastFailedAt).toBeInstanceOf(Date);
    await activateModelCredentialKey(prisma, { userId, credentialId, keyId: entry!.id });
    const [cleared] = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(cleared?.lastFailedAt).toBeNull();
  });

  it("removing the active entry promotes the next one; the last entry stays", async () => {
    await connect("secret-1");
    await prisma.secret.create({
      data: { id: "secret-2", userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await addModelCredentialKey(prisma, {
      userId,
      credentialId,
      label: "",
      secretId: "secret-2",
    });
    const keys = await listModelCredentialKeys(prisma, { userId, credentialId });
    const removed = await removeModelCredentialKey(prisma, {
      userId,
      credentialId,
      keyId: keys[0]!.id,
    });
    expect(removed?.secretId).toBe("secret-1");
    const credential = await prisma.userModelCredential.findUnique({
      where: { id: credentialId },
    });
    expect(credential?.secretId).toBe("secret-2");
    const remaining = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(remaining).toHaveLength(1);
    await expect(
      removeModelCredentialKey(prisma, { userId, credentialId, keyId: remaining[0]!.id }),
    ).rejects.toThrow("at least one key");
  });

  it("scopes every operation to the owning user", async () => {
    await connect("secret-1");
    const [entry] = await listModelCredentialKeys(prisma, { userId, credentialId });
    expect(await listModelCredentialKeys(prisma, { userId: "someone-else", credentialId })).toEqual(
      [],
    );
    expect(
      await activateModelCredentialKey(prisma, {
        userId: "someone-else",
        credentialId,
        keyId: entry!.id,
      }),
    ).toBe(false);
    expect(
      await removeModelCredentialKey(prisma, {
        userId: "someone-else",
        credentialId,
        keyId: entry!.id,
      }),
    ).toBeNull();
  });
});
