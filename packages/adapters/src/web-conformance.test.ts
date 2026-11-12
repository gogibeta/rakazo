import type { AdapterContext, WebProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CombinedWebProvider } from "./combined-web.js";
import { FakeWebProvider } from "./fake-web.js";
import { KeenableWebProvider } from "./keenable-web.js";
import { keenableMcpFixture } from "./keenable-web.test-support.js";
import { KeylessHttpWebProvider, parseDuckDuckGoResults } from "./keyless-http-web.js";
import { ParallelWebProvider } from "./parallel-web.js";
import { parallelMcpFixture } from "./parallel-web.test-support.js";
import { TinyFishWebProvider } from "./tinyfish-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

/**
 * Offline conformance: every WebProvider must advertise search+fetch and honor
 * the request shape. Callers inject fetch/backends so this stays offline.
 */
async function assertWebConformance(provider: WebProvider) {
  const desc = provider.describe();
  expect(desc.capabilities.search).toBe(true);
  expect(desc.capabilities.fetch).toBe(true);
  expect(desc.capabilities.readability).toBe(true);
  expect(desc.contractVersion).toBe("1");

  const hits = await provider.search({ query: "q", maxResults: 3 }, ctx);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.url).toMatch(/^https?:\/\//);

  const page = await provider.fetch({ url: hits[0]!.url, maxChars: 500 }, ctx);
  expect(page.title).toBeTruthy();
  expect(page.text.length).toBeGreaterThan(0);
}

describe("web provider conformance", () => {
  it("holds for Parallel through the real MCP transport (offline)", async () => {
    await assertWebConformance(new ParallelWebProvider(parallelMcpFixture().network));
  });
  it("holds for Keenable through the real MCP transport (offline)", async () => {
    await assertWebConformance(new KeenableWebProvider(keenableMcpFixture().network));
  });
  it("holds for TinyFish with an injected transport (offline)", async () => {
    const fetchMock: typeof fetch = async (_input, init) => {
      const payload =
        init?.method === "POST"
          ? {
              results: [
                {
                  url: "https://example.test/page",
                  final_url: "https://example.test/page",
                  title: "Hit",
                  text: "Rendered body text for conformance.",
                },
              ],
              errors: [],
            }
          : {
              results: [{ url: "https://example.test/page", title: "Hit", snippet: "Snippet" }],
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await assertWebConformance(
      new TinyFishWebProvider({
        apiKey: "test-key",
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    );
  });
  it("holds for the combined provider (offline)", async () => {
    const primary = new FakeWebProvider();
    primary.searchHits = [{ title: "Hit", url: "https://example.test/page", snippet: "…" }];
    primary.fetchResult = {
      url: "https://example.test/page",
      title: "Hit",
      text: "body",
      truncated: false,
    };
    const fallback = new FakeWebProvider();
    await assertWebConformance(new CombinedWebProvider({ primary, fallback }));
  });
  it("holds for fake (offline)", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [{ title: "Hit", url: "https://example.test/page", snippet: "…" }];
    fake.fetchResult = {
      url: "https://example.test/page",
      title: "Hit",
      text: "body",
      truncated: false,
    };
    await assertWebConformance(fake);
  });

  it("holds for keyless HTTP with an injected backend (offline)", async () => {
    const searchEndpoint = "https://search.example.test/html/";
    const searchHtml = `
      <div class="result">
        <a class="result__a" href="https://example.test/a">Alpha</a>
        <div class="result__snippet">Snippet</div>
      </div>`;
    const pageHtml = `<html><title>Page</title><body><p>Readable body text for conformance.</p></body></html>`;
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href.startsWith(searchEndpoint)) {
        return new Response(searchHtml, { status: 200 });
      }
      return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html" } });
    };
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
      searchBackend: {
        id: "test-html",
        endpoint: searchEndpoint,
        parse: parseDuckDuckGoResults,
      },
    });
    await assertWebConformance(provider);
  });
});
