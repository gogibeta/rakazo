import { vi } from "vitest";

/**
 * Records the outbound requests the connector transport makes and answers the success
 * endpoint with a 200, so a connection test can run to completion inside a test.
 *
 * This exists because the adapter (`testUserConnection`) loads the sealed key itself and
 * injects it into the outbound request — the secret is never a function argument, so the
 * only place the DECRYPTED key is observable is the wire. Capturing the request here is
 * what turns "the secret store was read" into "the key reached the adapter".
 *
 * The mock is registered from this package (not from the test that imports it) because a
 * pnpm workspace resolves a bare specifier per package: `undici` must resolve to the copy
 * THIS package imports, or the patch lands on a different instance and the real transport
 * runs anyway.
 *
 * The state is `vi.hoisted` so the mock factory can close over it before any import runs;
 * the exported wrapper is a plain object over that state, because vitest refuses to export
 * a hoisted binding directly.
 */
const state = vi.hoisted(() => ({
  // A documentation-range literal IP: public, so the SSRF gate allows it; never routed
  // anywhere; and an IP literal, so the safe fetch needs no DNS to answer.
  successUrl: "https://203.0.113.1",
  requests: [] as Array<{ url: string; headers: Record<string, string> }>,
}));

export const connectorTransport = {
  successUrl: state.successUrl,
  requests: state.requests,
};

vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof import("undici")>();
  return {
    ...undici,
    fetch: vi.fn(async (input: unknown, init?: { headers?: HeadersInit }) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => {
        headers[key] = value;
      });
      state.requests.push({ url, headers });
      // Only the recorded success endpoint answers. Anything else that reaches the
      // transport fails the way a network would, so an unexpected call cannot quietly
      // turn a failure-path test into a passing one.
      if (!url.startsWith(state.successUrl)) {
        throw new Error("connect EHOSTUNREACH (test transport stub)");
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }),
  };
});
