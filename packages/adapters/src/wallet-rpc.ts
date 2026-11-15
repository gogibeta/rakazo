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
 * Every call is a single attempt with a short timeout. A validation that
 * cannot reach the node refuses the proposal with `rpc_unavailable`; it never
 * guesses a nonce, a fee, or a balance, and never falls back to another
 * endpoint. Numbers are returned as decimal strings, exactly as the node
 * reported them, so no float ever touches a wei amount.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-RPC quantity ("0x1a") as a decimal string. */
function quantityToDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new WalletRpcError("rpc_error", "The chain returned an unreadable number.");
  }
  return BigInt(value).toString(10);
}

function decimalToQuantity(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: controller.signal,
      });
    } catch {
      throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new WalletRpcError("rpc_unavailable", "The chain could not be reached.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
    }
    if (!isRecord(body)) {
      throw new WalletRpcError("rpc_error", "The chain returned an unreadable answer.");
    }
    if (body.error !== undefined && body.error !== null) {
      throw new WalletRpcError("rpc_error", "The chain refused the request.");
    }
    return body.result;
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
      return Number(quantityToDecimal(await call("eth_getTransactionCount", [address, "pending"])));
    },
    async estimateGas(input) {
      await verifyChain();
      const tx: Record<string, string> = {
        from: input.from,
        value: decimalToQuantity(input.value),
      };
      if (input.to !== null) tx.to = input.to;
      if (input.data !== null) tx.data = input.data;
      return quantityToDecimal(await call("eth_estimateGas", [tx]));
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
