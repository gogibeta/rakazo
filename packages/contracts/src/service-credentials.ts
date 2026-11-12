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
});
export type ServiceCredentialsStatus = z.infer<typeof ServiceCredentialsStatusSchema>;

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
});
export type ServiceCredentialsUpdate = z.infer<typeof ServiceCredentialsUpdateSchema>;

export const ServiceCredentialsClearSchema = z.object({
  keys: z.array(serviceCredentialKeySchema).min(1),
});
export type ServiceCredentialsClear = z.infer<typeof ServiceCredentialsClearSchema>;
