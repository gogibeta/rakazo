import { createHash, randomBytes } from "node:crypto";
import type { WalletChainId, WalletProposal, WalletProposalStatus } from "@rakazo/contracts";
import {
  WALLET_PROPOSAL_TTL_MS,
  WalletChainIdSchema,
  WalletHexDataSchema,
  WalletProposeInput,
  WalletWeiSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient, SecurityEventInput } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";
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
 * the allowlisted chain registry, reads the nonce, suggests fees under fixed
 * ceilings, estimates gas under a fixed cap, and checks the balance covers
 * value plus the maximum fee. Only then is a proposal row written.
 *
 * Immutability has two halves. The row's canonical payload, its sender, its
 * owner, its wallet binding and its lifetime are written once; the database
 * enforces that with a trigger, so neither a bug here nor a stray statement
 * from the application's own login can rewrite a transaction the owner may
 * later be asked to sign (see migration 20261222130000). The only change this
 * module ever makes to an existing row is the status transition
 * `proposed -> cancelled | expired`, through a conditional update that names
 * the expected current status, so exactly one writer wins a transition.
 *
 * Validation order is deliberate:
 *
 * 1. Shape (zod): addresses, hex, exact decimal wei. No floats anywhere.
 * 2. Chain is allowlisted; the wallet exists, is the caller's, and is
 *    password-protected. A legacy wallet refuses with a typed code, because
 *    only the password envelope can be signed by the vault later.
 * 3. The chain answers for itself (`eth_chainId`) before any value is read.
 * 4. Nonce, fees and gas come from the node; the caller's ceilings are
 *    applied to the value that is stored, not to a pre-padding estimate, and
 *    a suggestion above them refuses rather than clamps.
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
  | "nonce_out_of_range"
  | "proposal_not_found"
  | "proposal_not_cancellable"
  | "proposal_expired"
  | "proposal_not_writable";

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
  nonce_out_of_range: "The chain's transaction count for this wallet is out of range.",
  proposal_not_found: "Proposal not found.",
  proposal_not_cancellable: "Only a proposed transaction can be cancelled.",
  proposal_expired: "This proposal has expired.",
  proposal_not_writable: "The proposal could not be stored.",
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
 *
 * The gas cap applies to the value that is stored — the padded limit — so an
 * estimate cannot pass the check and then be padded past it.
 */
export const WALLET_PROPOSAL_GAS_LIMIT_MAX = 1_500_000n;
export const WALLET_PROPOSAL_MAX_FEE_PER_GAS_MAX = 500_000_000_000n;
/** Postgres INTEGER and JavaScript's safe integer both hold a nonce below this. */
export const WALLET_PROPOSAL_NONCE_MAX = 2_147_483_647;
/** The longest life a proposal may have; the migration's CHECK says the same. */
export const WALLET_PROPOSAL_MAX_TTL_MS = 60 * 60 * 1_000;

/**
 * The gas limit stored for a node's estimate: a 20% headroom for state drift
 * between estimate and send, rounded up. Exported so the cap is applied to
 * this number, not to the raw estimate.
 */
export function walletProposalGasLimit(estimate: bigint): bigint {
  return (estimate * 12n) / 10n + 1n;
}

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
 * record the same event, and callers pass it to the same transaction that
 * performed the transition.
 */
export function walletProposalSecurityEvent(input: {
  userId: string;
  spaceId: string | null;
  proposalId: string;
  outcome: "created" | "expired" | "cancelled";
}): SecurityEventInput {
  return {
    type: "credential.changed",
    userId: input.userId,
    spaceId: input.spaceId,
    metadata: {
      procedure: "wallets.proposals",
      kind: "wallet_proposal",
      proposalId: input.proposalId,
      outcome: input.outcome,
    },
  };
}

/**
 * The security-event row for a transition, as a statement the caller runs in
 * the same transaction as the transition. `recordSecurityEvent` is
 * best-effort by design (it never throws, so a lost log line cannot undo an
 * action); a state change that must not outlive its own audit record needs
 * the opposite, so this builds the insert and the caller commits them
 * together. The metadata is normalized by the same rules as any event.
 */
export function securityEventInsert(input: SecurityEventInput): {
  type: string;
  userId: string | null;
  spaceId: string | null;
  metadata: Record<string, string | number | boolean | null>;
} {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string") metadata[key] = value.slice(0, 200);
    else if (typeof value === "number" && !Number.isFinite(value)) continue;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    }
  }
  return {
    type: input.type,
    userId: input.userId ?? null,
    spaceId: input.spaceId ?? null,
    metadata,
  };
}

/**
 * A proposal id in the same shape Prisma's `cuid()` produces: "c" followed by 24
 * lowercase base-36 characters. Generated here because the row's id is needed
 * before an insert whose timestamps come from the database.
 */
function newWalletProposalId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(24);
  let id = "c";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

/** A stored row, as the read paths select it. */
export type WalletProposalRow = {
  id: string;
  userId: string;
  walletId: string;
  fromAddress: string;
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
 * come from the caller, which already loaded the wallet; the sender is the
 * stored `fromAddress`, never the wallet's current address, so a wallet change
 * cannot alter what an existing proposal appears to be. Everything else is the
 * stored row, so a read never recomputes what was validated.
 */
export function walletProposalView(input: {
  row: WalletProposalRow;
  walletName: string;
  chain: WalletChainDefinition;
}): WalletProposal {
  return {
    id: input.row.id,
    walletId: input.row.walletId,
    walletName: input.walletName,
    walletAddress: input.row.fromAddress,
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

/** The columns a read path selects, so a view never depends on a wider row shape. */
const WALLET_PROPOSAL_COLUMNS = {
  id: true,
  userId: true,
  walletId: true,
  fromAddress: true,
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
} as const;

/**
 * Validate one proposal and store it, with its creation event in the same
 * transaction. The RPC client is built by the caller from the allowlisted
 * chain, so this module cannot reach an endpoint a bot named.
 *
 * The insert is a plain create: a proposal's identity is its content, so two
 * identical proposals are two rows the owner can cancel independently, and
 * nothing about this path is idempotent by accident.
 */
export async function createWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
  runId?: string;
  proposed: unknown;
  rpcFor: (chain: WalletChainDefinition) => WalletRpcClient;
  ttlMs?: number;
}): Promise<{
  row: WalletProposalRow;
  wallet: WalletRowForProposal;
  chain: WalletChainDefinition;
}> {
  // The chain allowlist is checked before the rest of the shape, so a caller naming
  // an unsupported chain learns that rather than a generic shape error.
  const rawChainId = (input.proposed as { chainId?: unknown } | null)?.chainId;
  if (typeof rawChainId !== "number" || !walletChain(rawChainId)) {
    throw new WalletProposalError("chain_not_allowed");
  }
  const parsed = WalletProposeInput.safeParse(input.proposed);
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
  const ttlMs = input.ttlMs ?? WALLET_PROPOSAL_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > WALLET_PROPOSAL_MAX_TTL_MS) {
    throw new WalletProposalError("invalid_request");
  }

  const wallet = await input.prisma.userWallet.findFirst({
    where: { id: proposal.walletId, userId: input.userId },
    select: { id: true, userId: true, name: true, address: true, migrationStatus: true },
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

  // A nonce that cannot be stored exactly is refused here rather than failing
  // later as an untyped database error.
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > WALLET_PROPOSAL_NONCE_MAX) {
    throw new WalletProposalError("nonce_out_of_range");
  }
  // The cap is applied to the value that is stored: padding happens first, and
  // the padded limit is what must fit. Never clamp — a limit that does not fit
  // is a refusal, not a smaller transaction.
  const gasEstimateWei = BigInt(gasEstimate);
  if (gasEstimateWei <= 0n) throw new WalletProposalError("gas_limit_too_high");
  const gasLimitWei = walletProposalGasLimit(gasEstimateWei);
  if (gasLimitWei > WALLET_PROPOSAL_GAS_LIMIT_MAX) {
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
  const gasLimit = gasLimitWei.toString(10);
  const maxTotal = BigInt(proposal.value) + gasLimitWei * BigInt(fees.maxFeePerGas);
  if (BigInt(balance) < maxTotal) throw new WalletProposalError("insufficient_balance");

  const fromAddress = wallet.address.toLowerCase();
  const canonicalHash = walletProposalCanonicalHash({
    chainId: proposal.chainId,
    from: fromAddress,
    to: proposal.to,
    value: proposal.value,
    data: proposal.data,
    nonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  // The database's clock creates the row and sets its lifetime: `createdAt` and
  // `expiresAt` are both written by the same `now()`, so the lifetime check the
  // migration enforces compares two values from one clock, and an application
  // host whose clock or time zone differs cannot mint a row that outlives the
  // rule. The id is generated here so the row's identity is known before the
  // insert, and the insert is parameterized throughout.
  const proposalId = newWalletProposalId();
  const created = await input.prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<
      Array<{ id: string; createdAt: Date; expiresAt: Date }>
    >`INSERT INTO "wallet_proposals" (
        "id", "userId", "walletId", "fromAddress", "chainId", "to", "asset", "amountWei",
        "data", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rpcProfile",
        "status", "canonicalHash", "expiresAt", "runId"
      ) VALUES (
        ${proposalId}, ${input.userId}, ${wallet.id}, ${fromAddress}, ${proposal.chainId},
        ${proposal.to}, ${chain.nativeSymbol}, ${proposal.value}, ${proposal.data}, ${nonce},
        ${gasLimit}, ${fees.maxFeePerGas}, ${fees.maxPriorityFeePerGas}, ${chain.rpcProfile},
        'proposed', ${canonicalHash}, now() + ${`${ttlMs} milliseconds`}::interval,
        ${input.runId ?? null}
      )
      RETURNING "id", "createdAt", "expiresAt"`;
    const row = inserted[0];
    if (!row) throw new WalletProposalError("proposal_not_writable");
    await writeProposalEvent(tx, {
      userId: input.userId,
      spaceId: input.spaceId,
      proposalId: row.id,
      outcome: "created",
    });
    return row;
  });

  return {
    row: {
      id: created.id,
      userId: input.userId,
      walletId: wallet.id,
      fromAddress,
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
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    },
    wallet,
    chain,
  };
}

/** A proposal owned by this user, with the wallet name its view needs. */
/**
 * One proposal owned by this user, read AFTER the owner's overdue proposals are
 * expired, with the sweep and the read in the SAME transaction.
 *
 * The single-get path needs the same guarantee the list has: a row returned as
 * `proposed` must have been live at the moment it was read. Sweeping and then
 * reading in two transactions allows a deadline to pass in between, so the
 * caller sees `proposed` for a proposal the database would already call
 * expired. Here both statements see one snapshot, and the sweep's conditional
 * UPDATE is what makes the status the read returns the real one.
 */
export async function findWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  proposalId: string;
  spaceId?: string | null;
}): Promise<{ row: WalletProposalRow; walletName: string; chain: WalletChainDefinition } | null> {
  const found = await input.prisma.$transaction(async (tx) => {
    // Passing a spaceId opts into the sweep; the pure lookup used by write paths
    // does not need it, and stays a plain read.
    if (input.spaceId !== undefined) {
      await expireOverdueInTransaction(tx, input.userId, input.spaceId);
    }
    return tx.walletProposal.findFirst({
      where: { id: input.proposalId, userId: input.userId },
      select: { ...WALLET_PROPOSAL_COLUMNS, wallet: { select: { name: true } } },
    });
  });
  if (!found) return null;
  const chain = walletChain(found.chainId);
  if (!chain) return null;
  return { row: found, walletName: found.wallet.name, chain };
}

/**
 * Read one proposal with expiry applied, for the owner's single-get path: the
 * sweep and the read share one transaction, so the status returned was true at
 * the snapshot the read saw.
 */
export async function getWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
  proposalId: string;
}): Promise<{ row: WalletProposalRow; walletName: string; chain: WalletChainDefinition } | null> {
  return findWalletProposal({
    prisma: input.prisma,
    userId: input.userId,
    proposalId: input.proposalId,
    spaceId: input.spaceId,
  });
}

/**
 * The owner's proposals, newest first, after applying expiry so no row reads
 * as live past its deadline. The sweep and the read run in one transaction, so
 * the list is a snapshot of a defined read time rather than two statements
 * that can disagree.
 */
export async function listWalletProposals(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
}): Promise<WalletProposal[]> {
  const rows = await input.prisma.$transaction(async (tx) => {
    await expireOverdueInTransaction(tx, input.userId, input.spaceId);
    return tx.walletProposal.findMany({
      where: { userId: input.userId },
      select: { ...WALLET_PROPOSAL_COLUMNS, wallet: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
  });
  return rows.flatMap((row) => {
    const chain = walletChain(row.chainId);
    if (!chain) return [];
    return [walletProposalView({ row, walletName: row.wallet.name, chain })];
  });
}

/**
 * One proposal event, committed with the row it describes. `security_events` is
 * readable and writable only by a system context, and the surrounding
 * transaction holds whatever settings it was checked out with, so the event
 * turns that context on for this statement and restores it afterwards — the
 * same step `runAsSystem` performs for a non-transactional write.
 */
function writeProposalEvent(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    spaceId: string | null;
    proposalId: string;
    outcome: "created" | "expired" | "cancelled";
  },
): Promise<unknown> {
  return runAsSystemInTransaction(tx, "record a wallet proposal transition", () =>
    tx.securityEvent.create({
      data: securityEventInsert(walletProposalSecurityEvent(input)),
    }),
  );
}

/**
 * Transition and audit in one transaction. The UPDATE names the expected
 * current status and compares the deadline against the database's own clock,
 * so exactly one writer wins and a stale client clock cannot cancel a
 * proposal that has already expired. The security event is written only when
 * the update reported a row, so an event never describes a transition that
 * did not happen.
 */
async function transitionInTransaction(
  prisma: PrismaClient,
  input: {
    userId: string;
    spaceId: string | null;
    proposalId: string;
    from: "proposed";
    to: "cancelled" | "expired";
    /** Cancelling also requires the proposal to still be live, by the database's clock. */
    requireLive?: boolean;
  },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "wallet_proposals"
      SET "status" = ${input.to}
      WHERE "id" = ${input.proposalId}
        AND "userId" = ${input.userId}
        AND "status" = ${input.from}
        AND (${!input.requireLive} OR "expiresAt" > now())
      RETURNING "id"`;
    const row = rows[0];
    if (!row) return false;
    await writeProposalEvent(tx, {
      userId: input.userId,
      spaceId: input.spaceId,
      proposalId: row.id,
      outcome: input.to,
    });
    return true;
  });
}

/** One owner's overdue proposals, expired and audited, each with its own event. */
async function expireOverdueInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  spaceId: string | null,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "wallet_proposals"
    SET "status" = 'expired'
    WHERE "userId" = ${userId}
      AND "status" = 'proposed'
      AND "expiresAt" <= now()
    RETURNING "id"`;
  // One event per row: the identities are what an operator needs to follow a
  // proposal's life, and a bulk count would lose them.
  for (const row of rows) {
    await writeProposalEvent(tx, {
      userId,
      spaceId,
      proposalId: row.id,
      outcome: "expired",
    });
  }
  return rows.map((row) => row.id);
}

/**
 * Cancel one proposal. Only a proposal still `proposed` and live by the
 * database's clock can be cancelled; an expired one is first persisted as
 * expired (with that event), so expiry is never rewritten into a decision the
 * owner did not make. The conditional update is what makes this safe against
 * the sweep and against a second cancel.
 */
export async function cancelWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
  proposalId: string;
}): Promise<{ status: "cancelled" }> {
  const existing = await input.prisma.walletProposal.findFirst({
    where: { id: input.proposalId, userId: input.userId },
    select: { id: true, status: true },
  });
  if (!existing) throw new WalletProposalError("proposal_not_found");
  if (existing.status !== "proposed") throw new WalletProposalError("proposal_not_cancellable");
  const cancelled = await transitionInTransaction(input.prisma, {
    userId: input.userId,
    spaceId: input.spaceId,
    proposalId: existing.id,
    from: "proposed",
    to: "cancelled",
    requireLive: true,
  });
  if (cancelled) return { status: "cancelled" };
  // Either the deadline passed between the read and the update, or another writer won.
  const expired = await expireWalletProposal({
    prisma: input.prisma,
    userId: input.userId,
    spaceId: input.spaceId,
    proposalId: existing.id,
  });
  if (expired) throw new WalletProposalError("proposal_expired");
  throw new WalletProposalError("proposal_not_cancellable");
}

/**
 * Move one overdue proposal to `expired`, at the database's clock, with its
 * event. Returns whether this call performed the transition; a caller that
 * sees false knows an earlier writer already moved the row and must not
 * record anything itself.
 */
export async function expireWalletProposal(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
  proposalId: string;
}): Promise<boolean> {
  return transitionInTransaction(input.prisma, {
    userId: input.userId,
    spaceId: input.spaceId,
    proposalId: input.proposalId,
    from: "proposed",
    to: "expired",
  });
}

/**
 * Expire every overdue proposal the owner has, persisting each transition and
 * its own event. Called inside the list read so the list reflects a defined
 * read time.
 */
export async function expireOverdueWalletProposals(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string | null;
}): Promise<string[]> {
  return input.prisma.$transaction((tx) =>
    expireOverdueInTransaction(tx, input.userId, input.spaceId),
  );
}
