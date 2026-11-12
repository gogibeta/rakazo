import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebProvider } from "./web-provider-factory.js";

const ORIGINAL_TINYFISH_KEY = process.env.TINYFISH_API_KEY;

beforeEach(() => {
  delete process.env.TINYFISH_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_TINYFISH_KEY === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = ORIGINAL_TINYFISH_KEY;
});

describe("createWebProvider tinyfish-ddg", () => {
  it("stays keyless when no key is configured anywhere", () => {
    const provider = createWebProvider("tinyfish-ddg");
    expect(provider.describe().id).toBe("tinyfish-ddg");
    expect(provider.describe().capabilities.keyless).toBe(true);
  });

  it("joins the TinyFish primary with the key saved in Settings", () => {
    const provider = createWebProvider("tinyfish-ddg", { tinyfishApiKey: "saved-key" });
    expect(provider.describe().capabilities.keyless).toBe(false);
  });

  it("ignores a blank saved key", () => {
    const provider = createWebProvider("tinyfish-ddg", { tinyfishApiKey: "   " });
    expect(provider.describe().capabilities.keyless).toBe(true);
  });

  it("joins the TinyFish primary with the environment key", () => {
    process.env.TINYFISH_API_KEY = "env-key";
    const provider = createWebProvider("tinyfish-ddg");
    expect(provider.describe().capabilities.keyless).toBe(false);
  });

  it("routes the saved key through Monid's free endpoints", async () => {
    const seen: { url: string; authorization: string | null; body: unknown }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://api.monid.ai/")) throw new Error("offline");
      seen.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify({
          runId: "run-1",
          status: "COMPLETED",
          output: { results: [{ url: "https://example.com/a", title: "A", snippet: "first" }] },
          providerResponse: { httpStatus: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = createWebProvider("tinyfish-ddg", {
      tinyfishApiKey: "saved-key",
      fetch: fetchStub,
      searchBackend: { id: "test", endpoint: "https://search.example.test/html/", parse: () => [] },
    });
    const hits = await provider.search(
      { query: "rakazo" },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    );
    expect(hits).toEqual([{ url: "https://example.com/a", title: "A", snippet: "first" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe("Bearer saved-key");
    expect(seen[0]?.body).toMatchObject({ provider: "tinyfish", endpoint: "/free/search" });
  });

  it("routes the environment key to TinyFish directly", async () => {
    process.env.TINYFISH_API_KEY = "env-key";
    const seen: { url: string; key: string | null }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://api.search.tinyfish.ai")) throw new Error("offline");
      seen.push({ url, key: new Headers(init?.headers).get("x-api-key") });
      return new Response(
        JSON.stringify({ results: [{ url: "https://example.com/a", title: "A", snippet: "s" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = createWebProvider("tinyfish-ddg", {
      tinyfishApiKey: "saved-key",
      fetch: fetchStub,
      searchBackend: { id: "test", endpoint: "https://search.example.test/html/", parse: () => [] },
    });
    const hits = await provider.search(
      { query: "rakazo" },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    );
    expect(hits).toEqual([{ url: "https://example.com/a", title: "A", snippet: "s" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe("env-key");
  });
});
