import { z } from "zod";

/**
 * Keys for outside services that a deployment admin can save in Settings
 * instead of setting environment variables. The values are sealed in the
 * deployment's own record; RPC only ever reports which keys are set.
 */
const serviceCredentialKeySchema = z.enum([
  "tinyfishApiKey",
  "naceApiKey",
  "telegramBotToken",
  "telegramWebhookSecret",
  "whatsappAccessToken",
  "whatsappPhoneNumberId",
  "whatsappAppSecret",
  "whatsappVerifyToken",
]);

export type ServiceCredentialKey = z.infer<typeof serviceCredentialKeySchema>;

export const SERVICE_CREDENTIAL_KEYS: readonly ServiceCredentialKey[] =
  serviceCredentialKeySchema.options;

/** The saved values, as unsealed from the deployment's record. Never exposed over RPC. */
export type StoredServiceCredentials = Partial<Record<ServiceCredentialKey, string>>;

export const ServiceCredentialsStatusSchema = z.object({
  tinyfishApiKey: z.boolean(),
  naceApiKey: z.boolean(),
  telegramBotToken: z.boolean(),
  telegramWebhookSecret: z.boolean(),
  whatsappAccessToken: z.boolean(),
  whatsappPhoneNumberId: z.boolean(),
  whatsappAppSecret: z.boolean(),
  whatsappVerifyToken: z.boolean(),
  /** Owner Telegram user IDs (not a secret, so unlike the keys it is returned in full). */
  telegramOwnerUserIds: z.array(z.string()),
  /** Whether new accounts are currently admitted, as the signup gate sees it. */
  signupsEnabled: z.boolean(),
});
export type ServiceCredentialsStatus = z.infer<typeof ServiceCredentialsStatusSchema>;

/**
 * Parses the owner Telegram user ID list (comma-separated, as typed in
 * Settings or stored on the deployment record) into clean numeric IDs.
 * Entries that are not plain numbers are dropped rather than rejected, so a
 * damaged stored value can never break the bots: it simply matches nobody
 * it does not parse to.
 */
export function parseTelegramOwnerUserIds(value: string): string[] {
  const ids: string[] = [];
  for (const entry of value.split(",")) {
    const id = entry.trim();
    if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A blank value keeps the key already saved, so an admin never has to see it again. */
const credentialValue = z.string().max(1024);

export const ServiceCredentialsUpdateSchema = z.object({
  tinyfishApiKey: credentialValue.optional(),
  naceApiKey: credentialValue.optional(),
  telegramBotToken: credentialValue.optional(),
  telegramWebhookSecret: credentialValue.optional(),
  whatsappAccessToken: credentialValue.optional(),
  whatsappPhoneNumberId: credentialValue.optional(),
  whatsappAppSecret: credentialValue.optional(),
  whatsappVerifyToken: credentialValue.optional(),
  /**
   * The owner Telegram user IDs as one comma-separated value. Unlike the
   * keys above this is not a secret: it is stored in the clear, the status
   * returns it, and an empty value turns the allowlist off.
   */
  telegramOwnerUserIds: z
    .string()
    .max(2048)
    .regex(/^[\d,\s]*$/, "Telegram user IDs must be numbers separated by commas")
    .optional(),
  /**
   * Allow or close new account creation. Stored on the deployment record in
   * the clear; once saved it, not the environment, decides who may register.
   */
  signupsEnabled: z.boolean().optional(),
});
export type ServiceCredentialsUpdate = z.infer<typeof ServiceCredentialsUpdateSchema>;

export const ServiceCredentialsClearSchema = z.object({
  keys: z.array(serviceCredentialKeySchema).min(1),
});
export type ServiceCredentialsClear = z.infer<typeof ServiceCredentialsClearSchema>;
