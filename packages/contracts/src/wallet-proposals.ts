import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/**
 * Transaction proposals: the canonical description of one EVM transaction a
 * bot wants the owner to sign later. A proposal is immutable once stored —
 * any field that would change the transaction makes a new proposal — so the
 * owner can compare what they are asked to confirm with what was validated.
 *
 * Nothing here carries key material: proposals hold only the public fields
 * of a transaction, the chain it belongs to, and the fingerprint of the
 * canonical bytes.
 */

/**
 * How a proposal stands. PR 6 creates proposals and lets the owner cancel
 * them; confirmation, signing and broadcast are separate steps, so a
 * proposal never reaches "signed" or "broadcast" yet.
 */
export const WALLET_PROPOSAL_STATUSES = ["proposed", "expired", "cancelled"] as const;
export const WalletProposalStatusSchema = z.enum(WALLET_PROPOSAL_STATUSES);
export type WalletProposalStatus = z.infer<typeof WalletProposalStatusSchema>;

/** A proposal is short-lived: the owner has this long to confirm it. */
export const WALLET_PROPOSAL_TTL_MS = 15 * 60 * 1_000;

/**
 * The chains a proposal may name. The server maps each to one RPC profile;
 * a bot names a chain, never a URL, so a run cannot be steered at an
 * arbitrary endpoint. All three are public testnets.
 */
export const WALLET_CHAIN_IDS = [99801, 998, 11155111] as const;
export const WalletChainIdSchema = z.union([z.literal(99801), z.literal(998), z.literal(11155111)]);
export type WalletChainId = z.infer<typeof WalletChainIdSchema>;

/** The native currency of each allowlisted chain, for display only. */
export const WALLET_CHAIN_NATIVE_SYMBOLS: Record<WalletChainId, string> = {
  99801: "HYPE",
  998: "HYPE",
  11155111: "ETH",
};

/** The RPC profile the server uses for each allowlisted chain. */
export const WALLET_CHAIN_RPC_PROFILES: Record<WalletChainId, string> = {
  99801: "elysium-testnet",
  998: "hyperevm-testnet",
  11155111: "sepolia",
};

/** An EVM address: 20 bytes in hex, with or without the EIP-55 checksum. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Hex data with an even number of digits and no 0x prefix chrome of its own. */
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
/** Decimal wei amounts, never floats or exponent notation. */
const WEI = /^(?:0|[1-9][0-9]*)$/;
/** A decimal uint256 bound, as a string for the wire. */
const UINT256_MAX = (1n << 256n) - 1n;

export const WalletAddressSchema = z
  .string()
  .trim()
  .regex(EVM_ADDRESS, "Use a 0x-prefixed 20-byte address");

/** Hex-encoded calldata or creation bytecode; null when the call carries none. */
export const WalletHexDataSchema = z
  .string()
  .trim()
  .max(2 + 2 * 128 * 1_024)
  .regex(HEX_DATA, "Use 0x-prefixed hex with whole bytes");

/** A uint256 as a decimal string: exact wei, never a float. */
export const WalletWeiSchema = z
  .string()
  .trim()
  .max(78)
  .regex(WEI, "Use a decimal wei amount")
  .refine(
    (value) => /^[0-9]+$/.test(value) && BigInt(value) <= UINT256_MAX,
    "Amount exceeds uint256",
  );

/**
 * What a bot proposes: the general transaction shape, not a send-only one.
 * `to` is null for a contract deploy and the recipient or contract otherwise.
 * `data` carries a call, `value` carries native currency, and both may be set
 * for an arbitrary contract call that also transfers value.
 */
export const WalletProposeInput = z
  .object({
    walletId: Id,
    chainId: WalletChainIdSchema,
    to: WalletAddressSchema.nullable(),
    value: WalletWeiSchema.default("0"),
    data: WalletHexDataSchema.nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    // A deploy has no recipient and must carry bytecode; anything else needs a recipient.
    if (input.to === null && (!input.data || input.data === "0x")) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: "A contract deploy needs bytecode in data.",
      });
    }
    if (input.to !== null && input.data === "0x") {
      ctx.addIssue({ code: "custom", path: ["data"], message: "Use null for no calldata." });
    }
    if (input.to === null && input.value !== "0") {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "A contract deploy cannot send native currency.",
      });
    }
  });
export type WalletProposeInput = z.infer<typeof WalletProposeInput>;

/**
 * What the bot and the owner see of a proposal: the canonical transaction,
 * its chain and fee fields as the server filled them, and its fingerprint.
 * Never a private key, a password, or a signed transaction.
 */
export const WalletProposalSchema = z.object({
  id: Id,
  walletId: Id,
  walletName: z.string(),
  walletAddress: z.string(),
  chainId: WalletChainIdSchema,
  chainName: z.string(),
  nativeSymbol: z.string(),
  /** null for a contract deploy. */
  to: z.string().nullable(),
  asset: z.string(),
  amountWei: z.string(),
  data: z.string().nullable(),
  nonce: z.number().int().nonnegative(),
  gasLimit: z.string(),
  maxFeePerGas: z.string(),
  maxPriorityFeePerGas: z.string(),
  rpcProfile: z.string(),
  status: WalletProposalStatusSchema,
  canonicalHash: z.string(),
  createdAt: IsoDate,
  expiresAt: IsoDate,
});
export type WalletProposal = z.infer<typeof WalletProposalSchema>;

export const WalletProposalListSchema = z.object({
  proposals: z.array(WalletProposalSchema),
});
export type WalletProposalList = z.infer<typeof WalletProposalListSchema>;

export const WalletProposalIdInput = z.object({ proposalId: Id }).strict();
export type WalletProposalIdInput = z.infer<typeof WalletProposalIdInput>;

/** The summary a bot gets back from wallet_propose: enough to tell the owner what it asks. */
export const WalletProposalSummarySchema = WalletProposalSchema.pick({
  id: true,
  chainId: true,
  to: true,
  amountWei: true,
  nonce: true,
  gasLimit: true,
  maxFeePerGas: true,
  maxPriorityFeePerGas: true,
  canonicalHash: true,
  expiresAt: true,
}).extend({
  walletName: z.string(),
  chainName: z.string(),
  nativeSymbol: z.string(),
  /** The most the transaction can cost besides its value: gasLimit * maxFeePerGas. */
  maxTotalFeeWei: z.string(),
});
export type WalletProposalSummary = z.infer<typeof WalletProposalSummarySchema>;
