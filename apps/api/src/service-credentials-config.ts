import type { SecretStore } from "@rakazo/adapter-kit";
import {
  DEPLOYMENT_SERVICE_CREDENTIALS_RECORD,
  loadServiceCredentials,
  loadTelegramOwnerUserIds,
} from "@rakazo/adapters";
import type {
  Actor,
  ServiceCredentialKey,
  ServiceCredentialsClear,
  ServiceCredentialsStatus,
  ServiceCredentialsUpdate,
  StoredServiceCredentials,
} from "@rakazo/contracts";
import { parseTelegramOwnerUserIds, SERVICE_CREDENTIAL_KEYS } from "@rakazo/contracts";
import { signupPolicyFromEnv } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export interface ServiceCredentialsConfigDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
  env: Pick<RouterDeps["env"], "adminEmails" | "signupsEnabled" | "signupAllowlist">;
}

/** Which keys are saved. The values themselves never leave the server. */
function keyStatusOf(credentials: StoredServiceCredentials): Record<ServiceCredentialKey, boolean> {
  const status = {} as Record<ServiceCredentialKey, boolean>;
  for (const key of SERVICE_CREDENTIAL_KEYS) status[key] = Boolean(credentials[key]);
  return status;
}

/** The full settings view: which keys are set, plus the owner allowlist (not a secret). */
async function statusOf(
  deps: ServiceCredentialsConfigDeps,
  credentials: StoredServiceCredentials,
): Promise<ServiceCredentialsStatus> {
  return {
    ...keyStatusOf(credentials),
    telegramOwnerUserIds: await loadTelegramOwnerUserIds(deps.prisma),
    signupsEnabled: await loadSignupsEnabled(deps),
  };
}

/**
 * Whether new accounts are admitted, as the signup gate decides it: the
 * deployment record once a policy has been saved there, the environment
 * until then.
 */
async function loadSignupsEnabled(deps: ServiceCredentialsConfigDeps): Promise<boolean> {
  const stored = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupPolicyInitialized: true },
  });
  if (stored?.signupPolicyInitialized) return stored.signupsEnabled;
  return signupPolicyFromEnv({
    signupsEnabled: deps.env.signupsEnabled,
    signupAllowlist: deps.env.signupAllowlist,
  }).enabled;
}

export async function getServiceCredentials(
  deps: ServiceCredentialsConfigDeps,
  actor: Actor,
): Promise<ServiceCredentialsStatus> {
  await requireAdmin(deps, actor.userId);
  return statusOf(deps, await loadServiceCredentials(deps.prisma, deps.secrets));
}

export async function updateServiceCredentials(
  deps: ServiceCredentialsConfigDeps,
  actor: Actor,
  input: ServiceCredentialsUpdate,
): Promise<ServiceCredentialsStatus> {
  await requireAdmin(deps, actor.userId);
  const current = await loadServiceCredentials(deps.prisma, deps.secrets);
  const next: StoredServiceCredentials = { ...current };
  // Blank fields keep the saved key, so an admin never has to see it again.
  for (const key of SERVICE_CREDENTIAL_KEYS) {
    const value = input[key]?.trim();
    if (value) next[key] = value;
  }
  await storeServiceCredentials(deps, actor, next);
  // The allowlist is not a key: it is stored in the clear, and a present
  // field replaces it — an empty one turns the allowlist off.
  if (input.telegramOwnerUserIds !== undefined) {
    await storeTelegramOwnerUserIds(deps, parseTelegramOwnerUserIds(input.telegramOwnerUserIds));
  }
  // Saved on the deployment record like the allowlist; saving it marks the
  // record as the signup policy in force, so the gate stops following the
  // environment from then on.
  if (input.signupsEnabled !== undefined) {
    await storeSignupsEnabled(deps, input.signupsEnabled);
  }
  return statusOf(deps, next);
}

export async function clearServiceCredentials(
  deps: ServiceCredentialsConfigDeps,
  actor: Actor,
  input: ServiceCredentialsClear,
): Promise<ServiceCredentialsStatus> {
  await requireAdmin(deps, actor.userId);
  const current = await loadServiceCredentials(deps.prisma, deps.secrets);
  const next: StoredServiceCredentials = { ...current };
  for (const key of input.keys) delete next[key];
  await storeServiceCredentials(deps, actor, next);
  return statusOf(deps, next);
}

/** Saves the account-creation switch on the deployment record, in the clear. */
async function storeSignupsEnabled(
  deps: ServiceCredentialsConfigDeps,
  signupsEnabled: boolean,
): Promise<void> {
  await runAsSystem("an admin changes whether new accounts may be created", () =>
    deps.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", signupsEnabled, signupPolicyInitialized: true },
      update: { signupsEnabled, signupPolicyInitialized: true },
    }),
  );
}

/** Saves the owner allowlist on the deployment record, normalized to clean numeric IDs. */
async function storeTelegramOwnerUserIds(
  deps: ServiceCredentialsConfigDeps,
  ownerUserIds: string[],
): Promise<void> {
  const value = ownerUserIds.join(",");
  await runAsSystem("an admin saves the Telegram owner allowlist", () =>
    deps.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", telegramOwnerUserIds: value },
      update: { telegramOwnerUserIds: value },
    }),
  );
}

async function storeServiceCredentials(
  deps: ServiceCredentialsConfigDeps,
  actor: Actor,
  credentials: StoredServiceCredentials,
): Promise<void> {
  const forget = (ciphertext: string) =>
    deps.secrets.delete(ciphertext, DEPLOYMENT_SERVICE_CREDENTIALS_RECORD).catch(() => undefined);
  if (Object.keys(credentials).length === 0) {
    // Nothing left: clear the record and forget the sealed value it held.
    const removed = await runAsSystem("an admin clears the saved service keys", () =>
      deps.prisma.$transaction(async (tx) => {
        const current = await tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { serviceCredentialsCipher: true },
        });
        await tx.deploymentSettings.upsert({
          where: { id: "default" },
          create: { id: "default", serviceCredentialsCipher: null },
          update: { serviceCredentialsCipher: null },
        });
        return current?.serviceCredentialsCipher;
      }),
    );
    if (removed) await forget(removed);
    return;
  }
  // Owned by the deployment row, not a user or space, so no account deletion removes it.
  const stored = await deps.secrets.put(
    JSON.stringify(credentials),
    {
      operationId: "service-credentials-config",
      traceId: "service-credentials-config",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
    { recordId: DEPLOYMENT_SERVICE_CREDENTIALS_RECORD },
  );
  let replaced: string | null | undefined;
  try {
    // Read what this save replaces in the same transaction, so concurrent saves each remove theirs.
    replaced = await withTransactionRetry(() =>
      runAsSystem("an admin saves service keys", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { serviceCredentialsCipher: true },
            });
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: { id: "default", serviceCredentialsCipher: stored.ciphertext },
              update: { serviceCredentialsCipher: stored.ciphertext },
            });
            return current?.serviceCredentialsCipher;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await forget(stored.ciphertext);
    throw error;
  }
  if (replaced && replaced !== stored.ciphertext) await forget(replaced);
}
