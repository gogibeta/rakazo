import * as z from "zod";
import { Id } from "./ids.js";

/**
 * A person's named crypto wallets, for testnet and airdrop work. The secret —
 * a private key or a seed phrase — is sealed server-side on save and never
 * read back: lists and responses carry only the name, the chain and the
 * public address the server derived from it. Bots see the same summaries and
 * can ask, per use and with the person's approval, for the secret to be typed
 * into a page field by the trusted browser path; they never see the value.
 * `chain` names the family the secret belongs to; only EVM is supported, and
 * other families slot in by extending the enum and the derivation.
 */
export const WalletChainSchema = z.enum(["evm"]);
export type WalletChain = z.infer<typeof WalletChainSchema>;

export const WALLET_NAME_MAX_LENGTH = 80;
export const WALLET_SECRET_MAX_LENGTH = 1_024;
export const WALLET_PURPOSE_MAX_LENGTH = 200;

export const WalletName = z.string().trim().min(1).max(WALLET_NAME_MAX_LENGTH);

/** What the add form collects: a name and the secret itself, nothing else. */
export const WalletAddInput = z.object({
  name: WalletName,
  secret: z.string().min(1).max(WALLET_SECRET_MAX_LENGTH),
  chain: WalletChainSchema.optional(),
});
export type WalletAddInput = z.infer<typeof WalletAddInput>;

/** What lists and responses may show: never the secret, in any form. */
export const WalletSummarySchema = z.object({
  id: Id,
  name: z.string(),
  chain: WalletChainSchema,
  address: z.string(),
  createdAt: z.string(),
});
export type WalletSummary = z.infer<typeof WalletSummarySchema>;

export const WalletRemoveInput = z.object({ walletId: Id });
export type WalletRemoveInput = z.infer<typeof WalletRemoveInput>;

export const WALLET_PASSWORD_MIN_LENGTH = 8;
export const WALLET_PASSWORD_MAX_LENGTH = 1_024;

const WalletPassword = z.string().min(WALLET_PASSWORD_MIN_LENGTH).max(WALLET_PASSWORD_MAX_LENGTH);

/** Setting the wallet password: the password itself, nothing else. It is never stored or read back. */
export const WalletVaultPasswordSetupInput = z.object({ password: WalletPassword });
export type WalletVaultPasswordSetupInput = z.infer<typeof WalletVaultPasswordSetupInput>;

/** Changing the wallet password always takes the current one, even while the vault is unlocked. */
export const WalletVaultPasswordChangeInput = z.object({
  currentPassword: z.string().min(1).max(WALLET_PASSWORD_MAX_LENGTH),
  newPassword: WalletPassword,
});
export type WalletVaultPasswordChangeInput = z.infer<typeof WalletVaultPasswordChangeInput>;

/** What the settings surface may know about the wallet password: that it exists, and when it last changed. */
export const WalletVaultStatusSchema = z.object({
  configured: z.boolean(),
  changedAt: z.string().nullable(),
});
export type WalletVaultStatus = z.infer<typeof WalletVaultStatusSchema>;

export const WalletUsesInput = z.object({ walletId: Id });
export type WalletUsesInput = z.infer<typeof WalletUsesInput>;

/** One approved fill, as the wallet's history shows it: no secret material. */
export const WalletUseSummarySchema = z.object({
  id: Id,
  botName: z.string(),
  purpose: z.string(),
  site: z.string(),
  createdAt: z.string(),
});
export type WalletUseSummary = z.infer<typeof WalletUseSummarySchema>;
