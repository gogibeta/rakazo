import { getLogger } from "@rakazo/logging";
import { walletChain } from "./wallet-chains.js";

/**
 * The read-only JSON-RPC the proposal path needs, and nothing else.
 *
 * A proposal is validated against the chain before it is stored: the chain id
 * must answer for itself, the wallet's nonce comes from the node, fees and gas
 * are estimated there, and the balance must cover value plus the maximum fee.
 * That is all this client can do — it has no method for signing and none for
 * sending, so a validation path can never broadcast by accident.
 *
 * Every call runs under ONE absolute deadline that covers the entire exchange:
 * the request, the response headers, draining the body, and parsing it. A
 * deadline is a point in time, not a duration restarted by each step, so a node
 * that sends headers promptly and then stalls cannot extend the call by
 * spending its own timeout twice. The byte cap is checked as the body arrives,
 * before any parsing. A call that runs out of time fails as `rpc_unavailable`;
 * it never guesses a nonce, a fee, or a balance, and never falls back to
 * another endpoint.
 */

/** The RPC names this client may call. A new name must be a read. */
const READ_METHODS = [
  "eth_chainId",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_getBlockByNumber",
] as const;
export type WalletRpcMethod = (typeof READ_METHODS)[number];

/** Why a chain read failed. Stable codes the proposal path maps to refusals. */
export type WalletRpcErrorCode = "rpc_unavailable" | "chain_mismatch" | "rpc_error";

/**
 * The JSON-RPC error codes that mean "this node does not implement the method",
 * the only condition under which `fees()` may fall back to another method. A
 * timeout, a transport failure, an oversized body, or a malformed envelope is
 * never a reason to try something else.
 */
const METHOD_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([-32601, -32004]);

export class WalletRpcError extends Error {
  readonly code: WalletRpcErrorCode;
  /** The node's own JSON-RPC error code, when the refusal came from one. */
  readonly rpcCode: number | undefined;
  constructor(code: WalletRpcErrorCode, message: string, rpcCode?: number) {
    super(message);
    this.name = "WalletRpcError";
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** The fee suggestion a node gave, in wei as decimal strings. */
export type WalletFeeSuggestion = {
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export type WalletRpcClient = {
  chainId(): Promise<number>;
  balanceWei(address: string): Promise<string>;
  nonce(address: string): Promise<number>;
  /** Gas units for the call, as the node estimated them. */
  estimateGas(input: {
    from: string;
    to: string | null;
    value: string;
    data: string | null;
  }): Promise<string>;
  fees(): Promise<WalletFeeSuggestion>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
/** No real JSON-RPC answer is this big; a larger body is refused, never buffered. */
const MAX_RESPONSE_BYTES = 1_048_576;
/**
 * A canonical JSON-RPC quantity: `0x` then lowercase hex with no leading zero,
 * except `0x0` itself. The node's own answers are canonical, so anything else is
 * a malformed answer rather than a value to be normalized into acceptance.
 */
const CANONICAL_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
/** 32 bytes of hex: a uint256 has at most this many significant hex digits. */
const MAX_QUANTITY_HEX_DIGITS = 64;
/** The largest safe integer a nonce may be; also Postgres INTEGER's ceiling. */
const MAX_SAFE_NONCE = 2_147_483_647;

/** A deadline shared by every step of one call. */
type Deadline = { at: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deadlineError(): WalletRpcError {
  return new WalletRpcError("rpc_unavailable", "The chain did not answer in time.");
}

/**
 * A JSON-RPC quantity as a decimal string.
 *
 * The syntax is checked strictly and the digit count is bounded in HEX before
 * BigInt sees anything: a uint256 is at most 64 significant hex digits, and a
 * value longer than that is out of range however it is written. Only the
 * normalized digits are converted, so a zero-padded value is rejected rather
 * than silently accepted through a decimal-digit bound that does not describe
 * hex.
 */
function quantityToDecimal(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_QUANTITY.test(value)) {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable number.");
  }
  const digits = value.slice(2);
  if (digits.length > MAX_QUANTITY_HEX_DIGITS) {
    throw new WalletRpcError("rpc_error", "The chain returned a number out of range.");
  }
  return BigInt(value).toString(10);
}

function decimalToQuantity(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new WalletRpcError("rpc_error", "The amount is not a decimal quantity.");
  }
  return `0x${BigInt(value).toString(16)}`;
}

/** A nonce that fits both JavaScript's safe integer and Postgres INTEGER. */
function nonceFromQuantity(value: unknown): number {
  const decimal = quantityToDecimal(value);
  const nonce = Number(decimal);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > MAX_SAFE_NONCE) {
    throw new WalletRpcError("rpc_error", "The chain returned a transaction count out of range.");
  }
  return nonce;
}

/**
 * Read a response body under the call's own deadline, refusing a body larger
 * than any real JSON-RPC answer before it is parsed. `response.json()` would
 * read the body after the caller's abort timer had been cleared, so a node that
 * streams headers and then stalls could hold the call open; this reads the
 * stream itself and stops at the deadline.
 */
async function readJsonBody(
  response: Response,
  signal: AbortSignal,
  deadline: Deadline,
  remaining: () => number,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new WalletRpcError("rpc_error", "The chain's answer was too large.");
  }
  const body = response.body;
  if (!body) throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // The cancel timer is the only thing this function owns; it is set from what is
  // LEFT of the call's deadline, never from a fresh full timeout.
  const left = remaining();
  if (left <= 0) throw deadlineError();
  const cancelAtDeadline = setTimeout(() => {
    reader.cancel().catch(() => undefined);
  }, left);
  try {
    for (;;) {
      if (signal.aborted || Date.now() >= deadline.at) throw deadlineError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WalletRpcError("rpc_error", "The chain's answer was too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WalletRpcError) throw error;
    // A body read that fails or is cancelled at the deadline is a timeout, not a
    // protocol error: the caller refuses the proposal either way.
    throw deadlineError();
  } finally {
    clearTimeout(cancelAtDeadline);
  }
  // The body may have completed exactly at the deadline; the call is still over.
  if (signal.aborted || Date.now() >= deadline.at) throw deadlineError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  }
}

/**
 * The response envelope, strictly: JSON-RPC 2.0, the id this client sent, and
 * EXACTLY ONE of `result` or `error` — judged by key presence alone, so an
 * answer that carries both (even with `error: null`) is refused rather than
 * read as whichever field the check happened to look at first. A mismatched id
 * is another request's answer and a missing method is not this client's; both
 * fail closed.
 */
function envelopeResult(body: unknown, id: number): unknown {
  if (!isRecord(body) || body.jsonrpc !== "2.0") {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  }
  if (body.id !== id) {
    throw new WalletRpcError("rpc_error", "The chain answered a different request.");
  }
  const hasResult = Object.hasOwn(body, "result");
  const hasError = Object.hasOwn(body, "error");
  if (hasResult === hasError) {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  }
  if (hasError) {
    const error = body.error;
    const rpcCode =
      isRecord(error) && typeof error.code === "number" && Number.isInteger(error.code)
        ? error.code
        : undefined;
    throw new WalletRpcError("rpc_error", "The chain refused the request.", rpcCode);
  }
  return body.result;
}

/**
 * A client for one allowlisted chain. The chain id is verified once, lazily,
 * before any other call: an endpoint that answers for a different chain is a
 * deployment mistake, and every later call would validate against the wrong
 * network.
 */
export function createWalletRpcClient(options: {
  chainId: number;
  rpcUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): WalletRpcClient {
  const chain = walletChain(options.chainId);
  if (!chain) throw new WalletRpcError("chain_mismatch", "That chain is not allowed.");
  const rpcProfile = chain.rpcProfile;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  let verified: Promise<void> | undefined;

  async function call(method: WalletRpcMethod, params: unknown[]): Promise<unknown> {
    const id = nextId++;
    const deadline: Deadline = { at: Date.now() + timeoutMs };
    const remaining = () => deadline.at - Date.now();
    const controller = new AbortController();
    // ONE timer for the whole call. Nothing below resets it or starts another.
    const abortAtDeadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
      }
      const result = envelopeResult(
        await readJsonBody(response, controller.signal, deadline, remaining),
        id,
      );
      // Time can run out during parsing, or abort can land as the body completes.
      if (controller.signal.aborted || Date.now() >= deadline.at) throw deadlineError();
      return result;
    } catch (error) {
      if (error instanceof WalletRpcError) throw error;
      if (controller.signal.aborted || Date.now() >= deadline.at) throw deadlineError();
      throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
    } finally {
      clearTimeout(abortAtDeadline);
    }
  }

  async function verifyChain(): Promise<void> {
    verified ??= (async () => {
      const reported = quantityToDecimal(await call("eth_chainId", []));
      if (reported !== String(options.chainId)) {
        getLogger().warn("wallet.rpc_chain_mismatch", {
          expectedChainId: options.chainId,
          reportedChainId: reported,
          rpcProfile,
        });
        throw new WalletRpcError("chain_mismatch", "The chain endpoint is not the expected chain.");
      }
    })();
    try {
      await verified;
    } catch (error) {
      // A failed verification is not cached: the next call tries again.
      verified = undefined;
      throw error;
    }
  }

  return {
    async chainId() {
      await verifyChain();
      return options.chainId;
    },
    async balanceWei(address) {
      await verifyChain();
      return quantityToDecimal(await call("eth_getBalance", [address, "latest"]));
    },
    async nonce(address) {
      await verifyChain();
      return nonceFromQuantity(await call("eth_getTransactionCount", [address, "pending"]));
    },
    async estimateGas(input) {
      await verifyChain();
      const tx: Record<string, string> = {
        from: input.from,
        value: decimalToQuantity(input.value),
      };
      if (input.to !== null) tx.to = input.to;
      if (input.data !== null) tx.data = input.data;
      const gas = quantityToDecimal(await call("eth_estimateGas", [tx]));
      if (BigInt(gas) <= 0n) {
        throw new WalletRpcError("rpc_error", "The chain returned no gas estimate.");
      }
      return gas;
    },
    async fees() {
      await verifyChain();
      // EIP-1559 fields when the node offers them, else a legacy gas price split
      // across base and tip. The priority-fee fallback is only for a node that
      // does not implement the method: a timeout, a transport failure, an
      // oversized body or a malformed envelope refuses the proposal instead of
      // being retried through another method that would hide it.
      const priorityFee = call("eth_maxPriorityFeePerGas", []).catch((error: unknown) => {
        if (
          error instanceof WalletRpcError &&
          error.code === "rpc_error" &&
          error.rpcCode !== undefined &&
          METHOD_UNSUPPORTED_CODES.has(error.rpcCode)
        ) {
          return undefined;
        }
        throw error;
      });
      const [block, priority] = await Promise.all([
        call("eth_getBlockByNumber", ["latest", false]),
        priorityFee,
      ]);
      const baseFee =
        isRecord(block) && block.baseFeePerGas !== undefined && block.baseFeePerGas !== null
          ? quantityToDecimal(block.baseFeePerGas)
          : undefined;
      const tipWei =
        priority !== undefined
          ? quantityToDecimal(priority)
          : quantityToDecimal(await call("eth_gasPrice", []));
      const maxFeePerGas = baseFee ? (BigInt(baseFee) * 2n + BigInt(tipWei)).toString(10) : tipWei;
      return { maxFeePerGas, maxPriorityFeePerGas: tipWei };
    },
  };
}
