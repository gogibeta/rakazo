import { createHash } from "node:crypto";
import type { WalletChainId, WalletProposal, WalletProposalStatus } from "@rakazo/contracts";
import {
  WALLET_PROPOSAL_TTL_MS,
  WalletChainIdSchema,
  WalletHexDataSchema,
  WalletProposeInput,
  WalletWeiSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient, SecurityEventInput } from "@rakazo/db";
import type { WalletChainDefinition } from "./wallet-chains.js";
import { walletChain } from "./wallet-chains.js";
import type { WalletRpcClient } from "./wallet-rpc.js";
import { WalletRpcError } from "./wallet-rpc.js";

/**
 * Transaction proposals, server side: validate a bot's intent against the
 * chain, store the canonical result, and never sign anything.
 *
 * The bot proposes in the general transaction shape — `to`, `value`, `data` —
 * which covers a native send, an ERC-20 transfer, a mint, a contract deploy
 * (`to` null plus bytecode), and an arbitrary contract call. The server is
 * what turns that into a signable transaction: it picks the RPC profile from
 * the allowlisted chain registry, reads the nonce, suggests EIP-1559 fees
 * under fixed ceilings, estimates gas under a fixed cap, and checks the
 * balance covers value plus the maximum fee. Only then is a proposal row
 * written, and the row is immutable in every field that defines the
 * transaction, so what the owner is later asked to confirm is exactly what
 * was validated here.
 *
 * Validation order is deliberate:
 *
 * 1. Shape (zod): addresses, hex, exact decimal wei. No floats anywhere.
 * 2. Chain is allowlisted; the wallet exists, is the caller's, and is
 *    password-protected. A legacy wallet refuses with a typed code, because
 *    only the password envelope can be signed by the vault later.
 * 3. The chain answers for itself (`eth_chainId`) before any value is read.
 * 4. Nonce, fees and gas come from the node; the caller's ceilings are
 *    applied after, and a suggestion above them refuses rather than clamps.
 * 5. The balance must cover value + gasLimit * maxFeePerGas.
 *
 * Nothing here can sign or broadcast: the RPC client has no such method, and
 * this module writes only proposal rows. A refusal is a typed error carrying
 * a stable code, never a partially persisted proposal.
 */

/** The machine-readable reason a proposal was refused. */
export type WalletProposalErrorCode =
  | "invalid_request"
  | "chain_not_allowed"
  | "wallet_not_found"
  | "wallet_not_migrated"
  | "rpc_unavailable"
  | "chain_mismatch"
  | "insufficient_balance"
  | "gas_limit_too_high"
  | "fee_cap_exceeded"
  | "proposal_not_found"
  | "proposal_not_cancellable"
  | "proposal_expired";

const ERROR_MESSAGES: Record<WalletProposalErrorCode, string> = {
  invalid_request: "The transaction could not be read. Check the address, amount and data.",
  chain_not_allowed: "That chain is not available for proposals.",
  wallet_not_found: "Wallet not found.",
  wallet_not_migrated:
    "This wallet is not protected by the wallet password yet, so it cannot be proposed for signing.",
  rpc_unavailable: "The chain could not be reached, so nothing was proposed.",
  chain_mismatch: "The chain endpoint is not the expected chain, so nothing was proposed.",
  insufficient_balance: "The wallet does not have enough for the amount plus the maximum fee.",
  gas_limit_too_high: "The transaction needs more gas than a proposal may use.",
  fee_cap_exceeded: "The chain's fee suggestion is above the cap for a proposal.",
  proposal_not_found: "Proposal not found.",
  proposal_not_cancellable: "Only a proposed transaction can be cancelled.",
  proposal_expired: "This proposal has expired.",
};

export class WalletProposalError extends Error {
  readonly code: WalletProposalErrorCode;
  constructor(code: WalletProposalErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WalletProposalError";
    this.code = code;
  }
}

/**
 * Server ceilings. Gas is capped well above a plain transfer (21,000) and a
 * token mint, but low enough that a runaway estimate refuses instead of
 * proposing a transaction that could burn an unbounded fee. Fees are capped
 * per gas in wei at 500 gwei, several orders of magnitude above what the
 * testnets this ships with ask for.
 */
export const WALLET_PROPOSAL_GAS_LIMIT_MAX = 1_500_000n;
export const WALLET_PROPOSAL_MAX_FEE_PER_GAS_MAX = 500_000_000_000n;

/** The canonical fields a proposal's hash covers, in one fixed order. */
export type WalletProposalCanonicalFields = {
  chainId: number;
  from: string;
  to: string | null;
  value: string;
  data: string | null;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

/**
 * The canonical serialization a proposal's hash is taken over: the fields a
 * signature would cover (everything except the hash itself and display-only
 * data), lowercased addresses and hex, with `from` bound in so a signed
 * transaction cannot be replayed from another wallet. `stableJsonValue` sorts
 * keys, so the serialization is deterministic wherever a field is inserted.
 */
export function walletProposalCanonicalJson(fields: WalletProposalCanonicalFields): string {
  return stableJsonValue({
    chainId: fields.chainId,
    from: fields.from.toLowerCase(),
    to: fields.to === null ? null : fields.to.toLowerCase(),
    value: fields.value,
    data: fields.data === null ? null : fields.data.toLowerCase(),
    nonce: fields.nonce,
    gasLimit: fields.gasLimit,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
  });
}

/** sha256 over the canonical serialization; stable for identical fields. */
export function walletProposalCanonicalHash(fields: WalletProposalCanonicalFields): string {
  return createHash("sha256").update(walletProposalCanonicalJson(fields)).digest("hex");
}

/** The maximum a transaction can cost in fees: gasLimit * maxFeePerGas. */
export function walletProposalMaxTotalFeeWei(fields: {
  gasLimit: string;
  maxFeePerGas: string;
}): string {
  return (BigInt(fields.gasLimit) * BigInt(fields.maxFeePerGas)).toString(10);
}

/**
 * One proposal's life in the security event log: created by a run's tool,
 * expired unsent, or cancelled by its owner. Identifiers and the outcome only
 * — the transaction's own fields live on the proposal row it names, and no
 * key material or signature exists at this stage. Built here so the worker
 * (which creates proposals) and the API (which expires and cancels them)
 * record the same event.
 */
export function walletProposalSecurityEvent(
  actor: { userId: string; spaceId: string },
  info: { proposalId: string; outcome: "created" | "expired" | "cancelled"; count?: number },
): SecurityEventInput {
  return {
    type: "credential.changed",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: {
      procedure: "wallets.proposals",
      kind: "wallet_proposal",
      proposalId: info.proposalId,
      outcome: info.outcome,
      ...(info.count === undefined ? {} : { count: info.count }),
    },
  };
}

/** A stored row, as the read paths select it. */
export type WalletProposalRow = {
  id: string;
  userId: string;
  walletId: string;
  chainId: number;
  to: string | null;
  asset: string;
  amountWei: string;
  data: string | null;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  rpcProfile: string;
  status: string;
  canonicalHash: string;
  createdAt: Date;
  expiresAt: Date;
};

/**
 * The wire shape of a proposal. Display-only fields (chain and wallet names)
 * come from the caller, which already loaded the wallet; everything else is
 * the stored row, so a read never recomputes what was validated.
 */
export function walletProposalView(input: {
  row: WalletProposalRow;
  walletName: string;
  walletAddress: string;
  chain: WalletChainDefinition;
}): WalletProposal {
  return {
    id: input.row.id,
    walletId: input.row.walletId,
    walletName: input.walletName,
    walletAddress: input.walletAddress,
    chainId: input.row.chainId as WalletChainId,
    chainName: input.chain.name,
    nativeSymbol: input.chain.nativeSymbol,
    to: input.row.to,
    asset: input.row.asset,
    amountWei: input.row.amountWei,
    data: input.row.data,
    nonce: input.row.nonce,
    gasLimit: input.row.gasLimit,
    maxFeePerGas: input.row.maxFeePerGas,
    maxPriorityFeePerGas: input.row.maxPriorityFeePerGas,
    rpcProfile: input.row.rpcProfile,
    status: input.row.status as WalletProposalStatus,
    canonicalHash: input.row.canonicalHash,
    createdAt: input.row.createdAt.toISOString(),
    expiresAt: input.row.expiresAt.toISOString(),
  };
}

type WalletRowForProposal = {
  id: string;
  userId: string;
  name: string;
  address: string;
  migrationStatus: string;
};

/**
 * Validate one proposal and store it. The RPC client is built by the caller
 * from the allowlisted chain, so this module cannot reach an endpoint a bot
 * named. `now` and `ttlMs` are injectable so expiry is testable without
 * waiting; production calls pass neither.
 *
 * The insert is a plain create: a proposal's identity is its content, so two
 * identical proposals are two rows the owner can cancel independently, and
 * nothing about this path is idempotent by accident.
 */
export async function createWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  runId?: string;
  proposed: unknown;
  rpcFor: (chain: WalletChainDefinition) => WalletRpcClient;
  now?: () => Date;
  ttlMs?: number;
}): Promise<{
  row: WalletProposalRow;
  wallet: WalletRowForProposal;
  chain: WalletChainDefinition;
}> {
  const parsed = WalletProposeInput.safeParse(input.proposed);
  // The chain allowlist is checked before the rest of the shape, so a caller naming
  // an unsupported chain learns that rather than a generic shape error.
  const rawChainId = (input.proposed as { chainId?: unknown } | null)?.chainId;
  if (typeof rawChainId !== "number" || !walletChain(rawChainId)) {
    throw new WalletProposalError("chain_not_allowed");
  }
  if (!parsed.success) throw new WalletProposalError("invalid_request");
  const proposal = parsed.data;
  const chain = walletChain(proposal.chainId);
  if (!chain) throw new WalletProposalError("chain_not_allowed");
  if (!WalletChainIdSchema.safeParse(proposal.chainId).success) {
    throw new WalletProposalError("chain_not_allowed");
  }
  // Re-validate every amount-shaped field after parsing: zod's refinements are
  // the contract, and this path must not depend on a caller having applied them.
  if (!WalletWeiSchema.safeParse(proposal.value).success) {
    throw new WalletProposalError("invalid_request");
  }
  if (proposal.data !== null && !WalletHexDataSchema.safeParse(proposal.data).success) {
    throw new WalletProposalError("invalid_request");
  }

  const wallet = await input.prisma.userWallet.findFirst({
    where: { id: proposal.walletId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      name: true,
      address: true,
      migrationStatus: true,
    },
  });
  if (!wallet) throw new WalletProposalError("wallet_not_found");
  // Signing opens the password envelope inside the vault; a legacy wallet has
  // no envelope, so proposing against it would queue work that can never run.
  if (wallet.migrationStatus !== "password_protected") {
    throw new WalletProposalError("wallet_not_migrated");
  }

  const rpc = input.rpcFor(chain);
  let nonce: number;
  let fees: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  let gasEstimate: string;
  let balance: string;
  try {
    // The chain id is verified inside the client before any of these reads.
    [nonce, fees, gasEstimate, balance] = await Promise.all([
      rpc.nonce(wallet.address),
      rpc.fees(),
      rpc.estimateGas({
        from: wallet.address,
        to: proposal.to,
        value: proposal.value,
        data: proposal.data,
      }),
      rpc.balanceWei(wallet.address),
    ]);
  } catch (error) {
    if (error instanceof WalletRpcError) {
      throw new WalletProposalError(
        error.code === "chain_mismatch" ? "chain_mismatch" : "rpc_unavailable",
      );
    }
    throw error;
  }

  if (BigInt(gasEstimate) > WALLET_PROPOSAL_GAS_LIMIT_MAX) {
    throw new WalletProposalError("gas_limit_too_high");
  }
  if (
    BigInt(fees.maxFeePerGas) > WALLET_PROPOSAL_MAX_FEE_PER_GAS_MAX ||
    BigInt(fees.maxPriorityFeePerGas) > WALLET_PROPOSAL_MAX_FEE_PER_GAS_MAX
  ) {
    throw new WalletProposalError("fee_cap_exceeded");
  }
  if (BigInt(fees.maxPriorityFeePerGas) > BigInt(fees.maxFeePerGas)) {
    throw new WalletProposalError("fee_cap_exceeded");
  }

  // A small headroom on the node's estimate covers state drift between estimate
  // and send; it stays inside the same cap above.
  const gasLimit = ((BigInt(gasEstimate) * 12n) / 10n + 1n).toString(10);
  const maxTotal = BigInt(proposal.value) + BigInt(gasLimit) * BigInt(fees.maxFeePerGas);
  if (BigInt(balance) < maxTotal) throw new WalletProposalError("insufficient_balance");

  const canonicalHash = walletProposalCanonicalHash({
    chainId: proposal.chainId,
    from: wallet.address,
    to: proposal.to,
    value: proposal.value,
    data: proposal.data,
    nonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const now = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? WALLET_PROPOSAL_TTL_MS));

  const row = await input.prisma.walletProposal.create({
    data: {
      userId: input.userId,
      walletId: wallet.id,
      chainId: proposal.chainId,
      to: proposal.to,
      asset: chain.nativeSymbol,
      amountWei: proposal.value,
      data: proposal.data,
      nonce,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      rpcProfile: chain.rpcProfile,
      status: "proposed",
      canonicalHash,
      expiresAt,
      runId: input.runId ?? null,
    },
    select: {
      id: true,
      userId: true,
      walletId: true,
      chainId: true,
      to: true,
      asset: true,
      amountWei: true,
      data: true,
      nonce: true,
      gasLimit: true,
      maxFeePerGas: true,
      maxPriorityFeePerGas: true,
      rpcProfile: true,
      status: true,
      canonicalHash: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  return { row, wallet, chain };
}

/** A proposal owned by this user, with the wallet fields its view needs. */
export async function findWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  proposalId: string;
}): Promise<{
  row: WalletProposalRow;
  walletName: string;
  walletAddress: string;
  chain: WalletChainDefinition;
} | null> {
  const row = await input.prisma.walletProposal.findFirst({
    where: { id: input.proposalId, userId: input.userId },
    include: { wallet: { select: { name: true, address: true } } },
  });
  if (!row) return null;
  const chain = walletChain(row.chainId);
  if (!chain) return null;
  return {
    row,
    walletName: row.wallet.name,
    walletAddress: row.wallet.address,
    chain,
  };
}

/** The owner's proposals, newest first. */
export async function listWalletProposals(input: {
  prisma: PrismaClient;
  userId: string;
}): Promise<WalletProposal[]> {
  const rows = await input.prisma.walletProposal.findMany({
    where: { userId: input.userId },
    include: { wallet: { select: { name: true, address: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.flatMap((row) => {
    const chain = walletChain(row.chainId);
    if (!chain) return [];
    return [
      walletProposalView({
        row,
        walletName: row.wallet.name,
        walletAddress: row.wallet.address,
        chain,
      }),
    ];
  });
}

/**
 * Cancel one proposal. Only a proposal still `proposed` and not yet expired
 * can be cancelled; expiry is applied first, so a stale row cannot be
 * resurrected into "cancelled" and read as a deliberate decision.
 * The conditional update is what makes this safe against a concurrent sweep.
 */
export async function cancelWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  proposalId: string;
  now?: () => Date;
}): Promise<{ status: "cancelled" }> {
  const now = (input.now ?? (() => new Date()))();
  const existing = await input.prisma.walletProposal.findFirst({
    where: { id: input.proposalId, userId: input.userId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!existing) throw new WalletProposalError("proposal_not_found");
  if (existing.status !== "proposed") throw new WalletProposalError("proposal_not_cancellable");
  if (existing.expiresAt.getTime() <= now.getTime()) {
    await expireWalletProposal({
      prisma: input.prisma,
      userId: input.userId,
      proposalId: existing.id,
      now: () => now,
    });
    throw new WalletProposalError("proposal_expired");
  }
  const updated = await input.prisma.walletProposal.updateMany({
    where: {
      id: input.proposalId,
      userId: input.userId,
      status: "proposed",
      expiresAt: { gt: now },
    },
    data: { status: "cancelled" },
  });
  if (updated.count !== 1) throw new WalletProposalError("proposal_not_cancellable");
  return { status: "cancelled" };
}

/**
 * Move one overdue proposal to `expired`. Conditional on the row still being
 * `proposed`, so a cancel that landed first is never overwritten.
 */
export async function expireWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  proposalId: string;
  now?: () => Date;
}): Promise<boolean> {
  const now = (input.now ?? (() => new Date()))();
  const updated = await input.prisma.walletProposal.updateMany({
    where: {
      id: input.proposalId,
      userId: input.userId,
      status: "proposed",
      expiresAt: { lte: now },
    },
    data: { status: "expired" },
  });
  return updated.count === 1;
}

/**
 * Expire every overdue proposal the owner has. Called on reads so a list
 * never shows a stale `proposed`, and by the worker sweep; both are cheap and
 * conditional, so running both is harmless.
 */
export async function expireOverdueWalletProposals(input: {
  prisma: PrismaClient;
  userId: string;
  now?: () => Date;
}): Promise<number> {
  const now = (input.now ?? (() => new Date()))();
  const updated = await input.prisma.walletProposal.updateMany({
    where: { userId: input.userId, status: "proposed", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  return updated.count;
}
