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
 * Every call is a single attempt with one deadline that covers the whole
 * exchange: the request, the response headers, and reading and parsing the
 * body. A node that sends headers and then stalls cannot hold a run open, and
 * a body larger than any real JSON-RPC answer is refused before it is parsed.
 * A validation that cannot reach the node refuses the proposal with
 * `rpc_unavailable`; it never guesses a nonce, a fee, or a balance, and never
 * falls back to another endpoint. Numbers are returned as decimal strings,
 * exactly as the node reported them, so no float ever touches a wei amount.
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

export class WalletRpcError extends Error {
  readonly code: WalletRpcErrorCode;
  constructor(code: WalletRpcErrorCode, message: string) {
    super(message);
    this.name = "WalletRpcError";
    this.code = code;
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
/** A decimal quantity longer than this cannot be a uint256 and is refused before BigInt. */
const MAX_QUANTITY_DIGITS = 78;
/** The largest safe integer a nonce may be; also Postgres INTEGER's ceiling. */
const MAX_SAFE_NONCE = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON-RPC quantity ("0x1a") as a decimal string. The length is bounded
 * before BigInt sees it: BigInt would happily parse a megabyte of digits, and
 * a wei amount that long is not a uint256 in any case.
 */
function quantityToDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable number.");
  }
  const digits = value.slice(2);
  // Leading zeros carry no value; strip them before the length check.
  const significant = digits.replace(/^0+/, "");
  if (significant.length > MAX_QUANTITY_DIGITS) {
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
 * Read a response body under the same deadline as the request, refusing a body
 * larger than any real JSON-RPC answer before it is parsed. `response.json()`
 * would read the body after the caller's abort timer had been cleared, so a
 * node that streams headers and then stalls could hold the run open forever.
 */
async function readJsonBody(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
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
  const deadline = setTimeout(() => reader.cancel().catch(() => undefined), timeoutMs);
  try {
    for (;;) {
      if (signal.aborted) {
        throw new WalletRpcError("rpc_unavailable", "The chain did not answer in time.");
      }
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
    // A body read that fails or is cancelled by the deadline is a timeout, not a
    // protocol error: the caller refuses the proposal either way.
    throw new WalletRpcError("rpc_unavailable", "The chain did not answer in time.");
  } finally {
    clearTimeout(deadline);
  }
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
 * exactly one of `result` or `error`. A mismatched id is another request's
 * answer and a missing method is not this client's; both fail closed rather
 * than being read as a result.
 */
function envelopeResult(body: unknown, id: number): unknown {
  if (!isRecord(body) || body.jsonrpc !== "2.0") {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  }
  if (body.id !== id) {
    throw new WalletRpcError("rpc_error", "The chain answered a different request.");
  }
  const hasResult = Object.hasOwn(body, "result");
  const hasError = Object.hasOwn(body, "error") && body.error !== null;
  if (hasResult === hasError) {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
  }
  if (hasError) throw new WalletRpcError("rpc_error", "The chain refused the request.");
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // The deadline covers headers and body alike; readJsonBody re-checks the
      // same signal while it drains the stream.
      const response = await doFetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
      }
      return envelopeResult(await readJsonBody(response, controller.signal, timeoutMs), id);
    } catch (error) {
      if (error instanceof WalletRpcError) throw error;
      if (controller.signal.aborted) {
        throw new WalletRpcError("rpc_unavailable", "The chain did not answer in time.");
      }
      throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
    } finally {
      clearTimeout(timer);
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
      // across base and tip. Either way the two numbers are exactly what the node
      // answered; the caller applies its own ceilings.
      const [block, priority] = await Promise.all([
        call("eth_getBlockByNumber", ["latest", false]),
        call("eth_maxPriorityFeePerGas", []).catch(() => undefined),
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
