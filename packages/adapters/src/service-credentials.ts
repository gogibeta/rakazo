import type { SecretStore } from "@rakazo/adapter-kit";
import type { ServiceCredentialKey, StoredServiceCredentials } from "@rakazo/contracts";
import { SERVICE_CREDENTIAL_KEYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { MessagingEnvironmentValues } from "./messaging-platforms.js";

/** Record id binding the deployment's encrypted service keys to its settings row. */
export const DEPLOYMENT_SERVICE_CREDENTIALS_RECORD = "deployment-service-credentials";

/** Reads a sealed service-credentials payload defensively: anything unexpected is dropped. */
export function parseServiceCredentials(plaintext: string): StoredServiceCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const credentials: StoredServiceCredentials = {};
  for (const key of SERVICE_CREDENTIAL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) credentials[key] = value.trim();
  }
  return credentials;
}

/**
 * The service keys an admin saved in Settings, unsealed. Reads forgive: a
 * record that cannot be read means no saved keys, so a damaged record never
 * takes the deployment's bots down.
 */
export async function loadServiceCredentials(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): Promise<StoredServiceCredentials> {
  const row = await runAsSystem("read the deployment's service credentials", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { serviceCredentialsCipher: true },
    }),
  );
  if (!row?.serviceCredentialsCipher) return {};
  try {
    return parseServiceCredentials(
      await secrets.load(row.serviceCredentialsCipher, DEPLOYMENT_SERVICE_CREDENTIALS_RECORD),
    );
  } catch {
    return {};
  }
}

type MessagingCredentialField =
  | "telegramBotToken"
  | "telegramWebhookSecret"
  | "whatsappAccessToken"
  | "whatsappPhoneNumberId"
  | "whatsappAppSecret"
  | "whatsappVerifyToken";

/** Which saved keys belong to a messaging platform, and the environment field each one fills. */
const MESSAGING_CREDENTIAL_FIELDS: Partial<Record<ServiceCredentialKey, MessagingCredentialField>> =
  {
    telegramBotToken: "telegramBotToken",
    telegramWebhookSecret: "telegramWebhookSecret",
    whatsappAccessToken: "whatsappAccessToken",
    whatsappPhoneNumberId: "whatsappPhoneNumberId",
    whatsappAppSecret: "whatsappAppSecret",
    whatsappVerifyToken: "whatsappVerifyToken",
  };

/**
 * Saved messaging keys fill only the fields the environment leaves unset:
 * an environment variable always wins over a key saved in Settings.
 */
export function mergeServiceCredentialsIntoMessagingEnv(
  env: MessagingEnvironmentValues,
  credentials: StoredServiceCredentials,
): MessagingEnvironmentValues {
  const merged = { ...env };
  for (const key of SERVICE_CREDENTIAL_KEYS) {
    const field = MESSAGING_CREDENTIAL_FIELDS[key];
    const saved = credentials[key]?.trim();
    if (!field || !saved) continue;
    if (!merged[field]?.trim()) merged[field] = saved;
  }
  return merged;
}
