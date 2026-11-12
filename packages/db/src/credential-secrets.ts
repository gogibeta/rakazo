import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type CredentialSecretClient = Pick<
  PrismaClient,
  "secret" | "userModelCredential" | "userModelCredentialKey" | "userVoiceCredential"
>;

export async function deleteUnreferencedCredentialSecret(
  prisma: CredentialSecretClient,
  input: {
    credentialKind: "model" | "voice";
    credentialId: string;
    secretId: string;
  },
): Promise<void> {
  const [modelReferences, keyReferences, voiceReferences] = await Promise.all([
    prisma.userModelCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "model" ? { id: { not: input.credentialId } } : {}),
      },
    }),
    // A pooled key can hold the same secret row as its connection's active
    // pointer; the row is only unreferenced once no entry points at it either.
    prisma.userModelCredentialKey.count({
      where: { secretId: input.secretId },
    }),
    prisma.userVoiceCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "voice" ? { id: { not: input.credentialId } } : {}),
      },
    }),
  ]);
  if (modelReferences + keyReferences + voiceReferences === 0) {
    await prisma.secret.deleteMany({ where: { id: input.secretId } });
  }
}

/**
 * Confirm that a model credential's stored OAuth material is the material that
 * just failed a terminal refresh. The credential row and every Space's model
 * choice are kept so signing in again renews this connection. The rejected
 * access and refresh tokens are not: when `replacementCiphertext` is set, the
 * secret row is overwritten with that ciphertext (a marker that contains no
 * tokens). Returns true when the failure is confirmed (the run fails without
 * retrying), false when newer material won a race.
 *
 * Two guards keep a stale failure from replacing newer material:
 * - `secretId`: a reconnect swaps the credential to a fresh secret row, so a
 *   mismatch means the retired material is already gone.
 * - `matchesFailedSecret`: a concurrent successful refresh rewrites the same
 *   secret row in place. The serializable check rereads its pointer and
 *   ciphertext and reports false on mismatch.
 */
export async function retireModelCredential(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    userId: string;
    credentialId: string;
    secretId?: string;
    /** Ciphertext that replaces the rejected tokens. It must not contain them. */
    replacementCiphertext?: string;
    matchesFailedSecret?: (secret: {
      id: string;
      ciphertext: string;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  if (!input.credentialId) return false;
  return withTransactionRetry(async () => {
    const checked = input.matchesFailedSecret
      ? await prisma.$transaction(async (tx) => {
          const credential = await tx.userModelCredential.findFirst({
            where: { id: input.credentialId, userId: input.userId },
          });
          if (!credential || (input.secretId && credential.secretId !== input.secretId))
            return undefined;
          return {
            credential,
            secret: await tx.secret.findFirst({
              where: { id: credential.secretId },
              select: { id: true, ciphertext: true },
            }),
          };
        })
      : undefined;
    if (
      input.matchesFailedSecret &&
      (!checked || (checked.secret && !(await input.matchesFailedSecret(checked.secret))))
    )
      return false;
    return prisma.$transaction(
      async (tx) => {
        const credential = await tx.userModelCredential.findFirst({
          where: { id: input.credentialId, userId: input.userId },
        });
        if (!credential || (input.secretId && credential.secretId !== input.secretId)) return false;
        const secret = await tx.secret.findFirst({
          where: { id: credential.secretId },
          select: { id: true, ciphertext: true },
        });
        if (
          input.matchesFailedSecret &&
          (credential.secretId !== checked?.credential.secretId ||
            secret?.ciphertext !== checked?.secret?.ciphertext)
        )
          return false;
        // The connection and its model choices stay. The rejected tokens do not:
        // a marker ciphertext replaces them so a later run cannot present them
        // to the provider or the model. Signing in again renews this same row.
        if (
          secret &&
          input.replacementCiphertext &&
          secret.ciphertext !== input.replacementCiphertext
        ) {
          await tx.secret.update({
            where: { id: secret.id },
            data: { ciphertext: input.replacementCiphertext },
          });
        }
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
}

/**
 * The pooled-key twin of {@link retireModelCredential}: confirm that one pool
 * entry's stored OAuth material is the material that just failed a terminal
 * refresh, and overwrite that entry's secret row with the reconnect marker.
 * The fence is the entry row, not the connection: a sibling account refreshing
 * fine, or the connection's active pointer moving, must not stop this entry
 * from retiring, and retiring this entry must not touch the active secret.
 * Same race guards as the connection-level retire, scoped to the entry.
 */
export async function retireModelCredentialKey(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    userId: string;
    credentialId: string;
    keyId: string;
    secretId?: string;
    /** Ciphertext that replaces the rejected tokens. It must not contain them. */
    replacementCiphertext?: string;
    matchesFailedSecret?: (secret: {
      id: string;
      ciphertext: string;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  if (!input.credentialId || !input.keyId) return false;
  return withTransactionRetry(async () => {
    const checked = input.matchesFailedSecret
      ? await prisma.$transaction(async (tx) => {
          const entry = await tx.userModelCredentialKey.findFirst({
            where: { id: input.keyId, credentialId: input.credentialId, userId: input.userId },
          });
          if (!entry || (input.secretId && entry.secretId !== input.secretId)) return undefined;
          return {
            entry,
            secret: await tx.secret.findFirst({
              where: { id: entry.secretId },
              select: { id: true, ciphertext: true },
            }),
          };
        })
      : undefined;
    if (
      input.matchesFailedSecret &&
      (!checked || (checked.secret && !(await input.matchesFailedSecret(checked.secret))))
    )
      return false;
    return prisma.$transaction(
      async (tx) => {
        const entry = await tx.userModelCredentialKey.findFirst({
          where: { id: input.keyId, credentialId: input.credentialId, userId: input.userId },
        });
        if (!entry || (input.secretId && entry.secretId !== input.secretId)) return false;
        const secret = await tx.secret.findFirst({
          where: { id: entry.secretId },
          select: { id: true, ciphertext: true },
        });
        if (
          input.matchesFailedSecret &&
          (entry.secretId !== checked?.entry.secretId ||
            secret?.ciphertext !== checked?.secret?.ciphertext)
        )
          return false;
        if (
          secret &&
          input.replacementCiphertext &&
          secret.ciphertext !== input.replacementCiphertext
        ) {
          await tx.secret.update({
            where: { id: secret.id },
            data: { ciphertext: input.replacementCiphertext },
          });
        }
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
}
