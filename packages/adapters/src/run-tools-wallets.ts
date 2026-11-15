import type { WalletProposalSummary } from "@rakazo/contracts";
import { WalletProposeInput } from "@rakazo/contracts";
import { recordSecurityEvent } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { auditToolCall } from "./run-tool-gate.js";
import { refusal } from "./tool-refusal.js";
import { listUserWallets } from "./user-wallets.js";
import {
  createWalletProposal,
  WalletProposalError,
  walletProposalMaxTotalFeeWei,
  walletProposalSecurityEvent,
} from "./wallet-proposals.js";
import { createWalletRpcClient } from "./wallet-rpc.js";

/** Wallet tools: what a bot may see of the person's wallets, and what it may propose. Secrets are never among it. */
export const walletTools: ToolHandlers = {
  async list_wallets(ctx) {
    const { deps, run } = ctx;
    return { wallets: await listUserWallets(deps.prisma, run.userId) };
  },
  async wallet_propose(ctx, call) {
    return proposeTransaction(ctx, call.args);
  },
};

/** Refusal codes a proposal failure maps to, so the model learns what to change. */
const PROPOSAL_REFUSAL_CODES: Record<string, string> = {
  invalid_request: "wallet_proposal_invalid",
  chain_not_allowed: "wallet_proposal_chain_not_allowed",
  wallet_not_found: "wallet_proposal_wallet_not_found",
  wallet_not_migrated: "wallet_proposal_wallet_not_migrated",
  rpc_unavailable: "wallet_proposal_rpc_unavailable",
  chain_mismatch: "wallet_proposal_chain_mismatch",
  insufficient_balance: "wallet_proposal_insufficient_balance",
  gas_limit_too_high: "wallet_proposal_gas_too_high",
  fee_cap_exceeded: "wallet_proposal_fee_too_high",
};

/**
 * Turn a bot's intent into a stored, validated proposal. The server owns every
 * value the transaction needs beyond the bot's intent — chain endpoint, nonce,
 * fees, gas — and refuses rather than guesses. The bot gets a deterministic
 * summary back and never any key material, because none is ever here.
 */
async function proposeTransaction(ctx: RunContext, args: Record<string, unknown>) {
  const { deps, run } = ctx;
  // Owner-started-ness comes from the server's own run record, never a bot-supplied flag.
  if (!ctx.source.ownerStartedRun) {
    return refusal(
      "wallet_proposal_not_owner_started",
      "Proposing a transaction needs a run the owner started.",
    );
  }
  const parsed = WalletProposeInput.safeParse(args);
  if (!parsed.success) {
    return refusal(
      "wallet_proposal_invalid",
      "Check the proposal: walletId from list_wallets, an allowlisted chainId, a 0x address (null to deploy), decimal wei value, and 0x data.",
    );
  }
  const rpcFor =
    deps.walletRpc ??
    ((chain) => createWalletRpcClient({ chainId: chain.chainId, rpcUrl: chain.rpcUrl }));
  let created: Awaited<ReturnType<typeof createWalletProposal>>;
  try {
    created = await createWalletProposal({
      prisma: deps.prisma,
      userId: run.userId,
      runId: run.id,
      proposed: parsed.data,
      rpcFor,
    });
  } catch (error) {
    if (error instanceof WalletProposalError) {
      const code = PROPOSAL_REFUSAL_CODES[error.code] ?? "wallet_proposal_invalid";
      await auditToolCall(ctx, "wallet_propose", "denied", {
        reason: error.code,
        chainId: parsed.data.chainId,
      });
      return refusal(code, error.message);
    }
    throw error;
  }
  const { row, wallet, chain } = created;
  await auditToolCall(ctx, "wallet_propose", "success", {
    proposalId: row.id,
    walletId: wallet.id,
    chainId: row.chainId,
    canonicalHash: row.canonicalHash,
  });
  // The security log records the creation too, so a proposal is traceable even
  // when the organization's audit log is not what an operator reads.
  await recordSecurityEvent(
    walletProposalSecurityEvent(
      { userId: run.userId, spaceId: run.spaceId },
      { proposalId: row.id, outcome: "created" },
    ),
  );
  const summary: WalletProposalSummary = {
    id: row.id,
    walletName: wallet.name,
    chainId: row.chainId as WalletProposalSummary["chainId"],
    chainName: chain.name,
    nativeSymbol: chain.nativeSymbol,
    to: row.to,
    amountWei: row.amountWei,
    nonce: row.nonce,
    gasLimit: row.gasLimit,
    maxFeePerGas: row.maxFeePerGas,
    maxPriorityFeePerGas: row.maxPriorityFeePerGas,
    maxTotalFeeWei: walletProposalMaxTotalFeeWei(row),
    canonicalHash: row.canonicalHash,
    expiresAt: row.expiresAt.toISOString(),
  };
  return summary;
}
