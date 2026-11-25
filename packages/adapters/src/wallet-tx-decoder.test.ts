import { describe, expect, it } from "vitest";
import { decodeTransaction } from "./wallet-tx-decoder.js";

describe("wallet tx decoder", () => {
  it("decodes native transfer", () => {
    const r = decodeTransaction({ to: "0xabc", value: "100", data: null });
    expect(r.kind).toBe("native_transfer");
  });
  it("decodes erc20 transfer", () => {
    const to = `0x${"1".repeat(40)}`;
    const amt = `0x${1000n.toString(16).padStart(64, "0")}`;
    const data = `0xa9059cbb${to.slice(2).padStart(64, "0")}${amt.slice(2).padStart(64, "0")}`;
    const r = decodeTransaction({ to: "0xtoken", value: "0", data });
    expect(r.kind).toBe("erc20_transfer");
  });
  it("reports contract call for unknown selector", () => {
    const r = decodeTransaction({ to: "0xabc", value: "0", data: `0xdeadbeef${"00".repeat(32)}` });
    expect(r.kind).toBe("contract_call");
  });
  it("reports malformed calldata", () => {
    const r = decodeTransaction({ to: "0xabc", value: "0", data: "0x12" });
    expect(r.kind).toBe("unknown");
  });
});
