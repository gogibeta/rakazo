import type { WalletChainId } from "@rakazo/contracts";

/**
 * The chains a transaction proposal may name, and the server's RPC for each.
 *
 * A bot names a chain id, never a URL: the registry below is the only place
 * an endpoint lives, so a run (or a page it read) cannot point validation at
 * an arbitrary node. Every entry is a public testnet; a production chain is
 * added by extending this map, not by accepting a caller-supplied endpoint.
 *
 * The RPC profiles are server-selected names, recorded on each proposal so an
 * audit can tell which endpoint family validated it. The chain id is checked
 * against `eth_chainId` before anything else is read, so an endpoint that
 * answers for another chain refuses rather than validating the wrong network.
 */

export type WalletChainDefinition = {
  chainId: WalletChainId;
  name: string;
  nativeSymbol: string;
  rpcProfile: string;
  rpcUrl: string;
  /** Block explorers build a transaction link from this; display only. */
  explorerTxUrl: (txHash: string) => string;
};

export const WALLET_CHAINS: ReadonlyMap<WalletChainId, WalletChainDefinition> = new Map([
  [
    99801,
    {
      chainId: 99801,
      name: "Elysium Testnet",
      nativeSymbol: "HYPE",
      rpcProfile: "elysium-testnet",
      rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
      explorerTxUrl: (txHash) => `https://explorer.elysium.kinetiq.xyz/tx/${txHash}`,
    },
  ],
  [
    998,
    {
      chainId: 998,
      name: "HyperEVM Testnet",
      nativeSymbol: "HYPE",
      rpcProfile: "hyperevm-testnet",
      rpcUrl: "https://api.hyperliquid-testnet.xyz/evm",
      explorerTxUrl: (txHash) => `https://app.hyperliquid-testnet.xyz/explorer/tx/${txHash}`,
    },
  ],
  [
    11155111,
    {
      chainId: 11155111,
      name: "Sepolia",
      nativeSymbol: "ETH",
      rpcProfile: "sepolia",
      rpcUrl: "https://rpc.sepolia.org",
      explorerTxUrl: (txHash) => `https://sepolia.etherscan.io/tx/${txHash}`,
    },
  ],
]);

/** The chain definition for an allowlisted id, or undefined for any other. */
export function walletChain(chainId: number): WalletChainDefinition | undefined {
  return WALLET_CHAINS.get(chainId as WalletChainId);
}
