/**
 * Minimal EVM transaction decoder for proposal previews (step 29, B3).
 *
 * Decodes a proposed transaction's calldata into a short human-readable
 * summary a person can approve. Only well-known selectors are decoded; anything
 * else is reported as an opaque contract call so nothing is ever presented as
 * understood when it is not.
 */

export type DecodedTransaction = {
  kind:
    | "native_transfer"
    | "erc20_transfer"
    | "erc20_approve"
    | "erc20_transfer_from"
    | "contract_call"
    | "unknown";
  summary: string;
};

const SELECTORS: Readonly<
  Record<string, "erc20_transfer" | "erc20_approve" | "erc20_transfer_from">
> = {
  "0xa9059cbb": "erc20_transfer",
  "0x095ea7b3": "erc20_approve",
  "0x23b872dd": "erc20_transfer_from",
};

function word(hex: string, index: number): string {
  return hex.slice(2 + index * 64, 2 + (index + 1) * 64);
}

function toAddress(wordHex: string): string {
  return `0x${wordHex.slice(24)}`;
}

function toUint256(wordHex: string): bigint {
  return BigInt(`0x${wordHex}`);
}

export function decodeTransaction(input: {
  to: string | null;
  value: string;
  data: string | null;
}): DecodedTransaction {
  const data = (input.data ?? "").toLowerCase();
  const value = input.value ?? "0";
  if (!data || data === "0x") {
    return {
      kind: "native_transfer",
      summary: `Native transfer of ${value} wei to ${input.to ?? "(none)"}`,
    };
  }
  if (data.length < 10) {
    return { kind: "unknown", summary: `Malformed calldata (${data.length} hex chars)` };
  }
  const selector = data.slice(0, 10);
  const kind = SELECTORS[selector];
  if (kind === "erc20_transfer" && data.length >= 10 + 2 * 64) {
    const to = toAddress(word(data, 0));
    const amount = toUint256(word(data, 1));
    return { kind, summary: `ERC-20 transfer ${amount} to ${to} via ${input.to}` };
  }
  if (kind === "erc20_approve" && data.length >= 10 + 2 * 64) {
    const spender = toAddress(word(data, 0));
    const amount = toUint256(word(data, 1));
    return { kind, summary: `ERC-20 approve ${spender} for ${amount} via ${input.to}` };
  }
  if (kind === "erc20_transfer_from" && data.length >= 10 + 3 * 64) {
    const from = toAddress(word(data, 0));
    const to = toAddress(word(data, 1));
    const amount = toUint256(word(data, 2));
    return {
      kind,
      summary: `ERC-20 transferFrom ${from} -> ${to} amount ${amount} via ${input.to}`,
    };
  }
  if (kind) {
    return { kind, summary: `${kind} via ${input.to} (truncated calldata)` };
  }
  return {
    kind: "contract_call",
    summary: `Contract call to ${input.to ?? "(none)"} with ${Math.floor((data.length - 2) / 2)} bytes of calldata (selector ${selector})`,
  };
}
