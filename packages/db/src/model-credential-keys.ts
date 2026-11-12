import type { PrismaClient, UserModelCredentialKey } from "./client.js";

export type ModelCredentialKeyRow = UserModelCredentialKey;

type KeyListClient = Pick<PrismaClient, "userModelCredentialKey">;
type KeyWriteClient = Pick<
  PrismaClient,
  "userModelCredential" | "userModelCredentialKey" | "$transaction"
>;

/** Every pooled key/account of one connection, in pool order. */
export async function listModelCredentialKeys(
  prisma: KeyListClient,
  input: { userId: string; credentialId: string },
): Promise<ModelCredentialKeyRow[]> {
  return prisma.userModelCredentialKey.findMany({
    where: { userId: input.userId, credentialId: input.credentialId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/** Pooled keys for several connections at once (settings list assembly). */
export async function listModelCredentialKeysForCredentials(
  prisma: KeyListClient,
  input: { userId: string; credentialIds: string[] },
): Promise<ModelCredentialKeyRow[]> {
  if (input.credentialIds.length === 0) return [];
  return prisma.userModelCredentialKey.findMany({
    where: { userId: input.userId, credentialId: { in: input.credentialIds } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * The order a run tries a connection's pool: the active entry first (the one
 * whose secret the connection itself points at — the last one that worked, so
 * per-account prompt caches stay warm), then the rest in pool order. A run
 * that names an entry explicitly starts from that entry instead.
 */
export function orderModelCredentialKeysForUse<T extends { secretId: string }>(
  keys: readonly T[],
  activeSecretId: string,
): T[] {
  const active = keys.filter((key) => key.secretId === activeSecretId);
  const rest = keys.filter((key) => key.secretId !== activeSecretId);
  return [...active, ...rest];
}

/** Append a key/account to a connection's pool. Runs inside the caller's tx. */
export async function addModelCredentialKey(
  prisma: Pick<PrismaClient, "userModelCredentialKey">,
  input: {
    userId: string;
    credentialId: string;
    label: string;
    secretId: string;
  },
): Promise<ModelCredentialKeyRow> {
  const last = await prisma.userModelCredentialKey.findFirst({
    where: { userId: input.userId, credentialId: input.credentialId },
    orderBy: [{ position: "desc" }],
    select: { position: true },
  });
  return prisma.userModelCredentialKey.create({
    data: {
      userId: input.userId,
      credentialId: input.credentialId,
      label: input.label,
      secretId: input.secretId,
      position: (last?.position ?? -1) + 1,
    },
  });
}

/**
 * Move the connection's active pointer to one of its pool entries (the entry
 * that just served a run) and clear that entry's failure mark. Returns false
 * when the entry is not part of this user's connection.
 */
export async function activateModelCredentialKey(
  prisma: KeyWriteClient,
  input: { userId: string; credentialId: string; keyId: string },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.userModelCredentialKey.findFirst({
      where: { id: input.keyId, credentialId: input.credentialId, userId: input.userId },
    });
    if (!entry) return false;
    await tx.userModelCredential.updateMany({
      where: { id: input.credentialId, userId: input.userId },
      data: { secretId: entry.secretId },
    });
    if (entry.lastFailedAt) {
      await tx.userModelCredentialKey.update({
        where: { id: entry.id },
        data: { lastFailedAt: null },
      });
    }
    return true;
  });
}

/** Best-effort failure mark; a stale mark only orders the settings list. */
export async function markModelCredentialKeyFailed(
  prisma: KeyListClient,
  input: { userId: string; keyId: string },
): Promise<void> {
  await prisma.userModelCredentialKey.updateMany({
    where: { id: input.keyId, userId: input.userId },
    data: { lastFailedAt: new Date() },
  });
}

/**
 * Remove one pool entry. Refuses to remove the connection's last entry. When
 * the removed entry was the active one, the next entry in pool order becomes
 * active so the connection always points at a pooled secret. Returns the
 * removed row (its secret may still need an unreferenced-secret cleanup), or
 * null when the entry does not exist.
 */
export async function removeModelCredentialKey(
  prisma: KeyWriteClient,
  input: { userId: string; credentialId: string; keyId: string },
): Promise<ModelCredentialKeyRow | null> {
  return prisma.$transaction(async (tx) => {
    const keys = await tx.userModelCredentialKey.findMany({
      where: { userId: input.userId, credentialId: input.credentialId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const removed = keys.find((key) => key.id === input.keyId);
    if (!removed) return null;
    if (keys.length <= 1) {
      throw new Error("A connection keeps at least one key or account.");
    }
    const credential = await tx.userModelCredential.findFirst({
      where: { id: input.credentialId, userId: input.userId },
      select: { secretId: true },
    });
    await tx.userModelCredentialKey.delete({ where: { id: removed.id } });
    if (credential && credential.secretId === removed.secretId) {
      const next = keys.find((key) => key.id !== removed.id);
      if (next) {
        await tx.userModelCredential.updateMany({
          where: { id: input.credentialId, userId: input.userId },
          data: { secretId: next.secretId },
        });
      }
    }
    return removed;
  });
}
