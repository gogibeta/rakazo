import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { TinyFishWebProvider } from "./tinyfish-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("TinyFishWebProvider", () => {
  it("maps search results and sends the API key header", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, key: new Headers(init?.headers).get("x-api-key") });
        return jsonResponse({
          results: [
            { url: "https://example.com/a", title: "A", snippet: "first" },
            { url: "https://example.com/b", title: null, snippet: null },
          ],
        });
      },
    });
    const hits = await provider.search({ query: "rakazo", maxResults: 5 }, ctx);
    expect(hits).toEqual([
      { url: "https://example.com/a", title: "A", snippet: "first" },
      { url: "https://example.com/b", title: "https://example.com/b", snippet: "" },
    ]);
    expect(seen[0]?.key).toBe("test-key");
    expect(seen[0]?.url).toContain("query=rakazo");
  });

  it("returns fetched page text with paging applied", async () => {
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      resolveHostname: publicResolver,
      fetch: async () =>
        jsonResponse({
          results: [
            {
              url: "https://example.com/page",
              final_url: "https://example.com/page",
              title: "Page",
              text: "hello world, rendered",
            },
          ],
          errors: [],
        }),
    });
    const page = await provider.fetch({ url: "https://example.com/page", maxChars: 5 }, ctx);
    expect(page.title).toBe("Page");
    expect(page.text).toContain("hello");
    expect(page.truncated).toBe(true);
  });

  it("throws the provider error when a fetch returns only errors", async () => {
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      resolveHostname: publicResolver,
      fetch: async () =>
        jsonResponse({ results: [], errors: [{ url: "https://example.com/x", error: "blocked" }] }),
    });
    await expect(provider.fetch({ url: "https://example.com/x" }, ctx)).rejects.toThrow("blocked");
  });

  it("fails clearly when no API key is configured", async () => {
    const provider = new TinyFishWebProvider({ apiKey: "", fetch: async () => jsonResponse({}) });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow("TINYFISH_API_KEY");
  });
});
