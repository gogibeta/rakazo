import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { MonidWebProvider } from "./monid-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completedRun(output: unknown, endpoint = "/free/search"): Record<string, unknown> {
  return {
    runId: "run-1",
    provider: "tinyfish",
    endpoint,
    status: "COMPLETED",
    output,
    providerResponse: { httpStatus: 200 },
  };
}

type CapturedRequest = {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
};

function capture(handler: (request: CapturedRequest) => Response) {
  const seen: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    return handler(request);
  };
  return { seen, fetchImpl };
}

describe("MonidWebProvider", () => {
  it("runs the free search endpoint and maps results", async () => {
    const { seen, fetchImpl } = capture(() =>
      jsonResponse(
        completedRun({
          results: [
            { url: "https://example.com/a", title: "A", snippet: "first" },
            { url: "https://example.com/b", title: null, snippet: null },
          ],
        }),
      ),
    );
    const provider = new MonidWebProvider({ apiKey: "mk_test", fetch: fetchImpl });
    const hits = await provider.search({ query: "rakazo", maxResults: 5 }, ctx);
    expect(hits).toEqual([
      { url: "https://example.com/a", title: "A", snippet: "first" },
      { url: "https://example.com/b", title: "https://example.com/b", snippet: "" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.monid.ai/v1/run");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.authorization).toBe("Bearer mk_test");
    expect(seen[0]?.body).toEqual({
      provider: "tinyfish",
      endpoint: "/free/search",
      input: { queryParams: { query: "rakazo" } },
      maxCost: 0,
    });
  });

  it("runs the free fetch endpoint and returns page text with paging applied", async () => {
    const { seen, fetchImpl } = capture(() =>
      jsonResponse(
        completedRun(
          {
            results: [
              {
                url: "https://example.com/page",
                final_url: "https://example.com/page",
                title: "Page",
                text: `hello ${"rendered ".repeat(500)}`,
              },
            ],
            errors: [],
          },
          "/free/fetch",
        ),
      ),
    );
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      fetch: fetchImpl,
      resolveHostname: publicResolver,
    });
    const page = await provider.fetch({ url: "https://example.com/page", maxChars: 100 }, ctx);
    expect(page.title).toBe("Page");
    expect(page.text).toContain("hello");
    expect(page.truncated).toBe(true);
    expect(seen[0]?.body).toEqual({
      provider: "tinyfish",
      endpoint: "/free/fetch",
      input: { body: { urls: ["https://example.com/page"], format: "markdown" } },
      maxCost: 0,
    });
  });

  it("throws the provider error code when a fetch returns only errors", async () => {
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      resolveHostname: publicResolver,
      fetch: async () =>
        jsonResponse(
          completedRun(
            { results: [], errors: [{ url: "https://example.com/x", code: "bot_blocked" }] },
            "/free/fetch",
          ),
        ),
    });
    await expect(provider.fetch({ url: "https://example.com/x" }, ctx)).rejects.toThrow(
      "bot_blocked",
    );
  });

  it("validates the URL before disclosing it to Monid", async () => {
    let called = false;
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      resolveHostname: publicResolver,
      fetch: async () => {
        called = true;
        return jsonResponse(completedRun({ results: [], errors: [] }, "/free/fetch"));
      },
    });
    await expect(provider.fetch({ url: "http://127.0.0.1/admin" }, ctx)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("surfaces the provider error body when a completed run reports an HTTP failure", async () => {
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      fetch: async () =>
        jsonResponse({
          runId: "run-1",
          provider: "tinyfish",
          endpoint: "/free/search",
          status: "COMPLETED",
          output: null,
          providerResponse: { httpStatus: 429, error: { error: "rate limit exceeded" } },
        }),
    });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow("rate limit exceeded");
  });

  it("throws the reason when Monid blocks a run", async () => {
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      fetch: async () =>
        jsonResponse({
          runId: "run-1",
          provider: "tinyfish",
          endpoint: "/free/search",
          status: "BLOCKED",
          reason: "workspace budget exceeded",
          controls: [],
        }),
    });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow("workspace budget exceeded");
  });

  it("throws when a run fails", async () => {
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      fetch: async () =>
        jsonResponse({ runId: "run-1", status: "FAILED", reason: "provider unreachable" }),
    });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow("provider unreachable");
  });

  it("polls an accepted run until it completes", async () => {
    const { seen, fetchImpl } = capture((request) => {
      if (request.url.endsWith("/v1/runs/run-9")) {
        return jsonResponse({
          runId: "run-9",
          provider: "tinyfish",
          endpoint: "/free/search",
          status: "COMPLETED",
          output: { results: [{ url: "https://example.com/a", title: "A", snippet: "first" }] },
          providerResponse: { httpStatus: 200 },
        });
      }
      return jsonResponse(
        { runId: "run-9", provider: "tinyfish", endpoint: "/free/search", status: "RUNNING" },
        202,
      );
    });
    const provider = new MonidWebProvider({
      apiKey: "mk_test",
      fetch: fetchImpl,
      pollIntervalMs: 1,
    });
    const hits = await provider.search({ query: "rakazo" }, ctx);
    expect(hits).toEqual([{ url: "https://example.com/a", title: "A", snippet: "first" }]);
    expect(seen.map((request) => request.url)).toEqual([
      "https://api.monid.ai/v1/run",
      "https://api.monid.ai/v1/runs/run-9",
    ]);
    expect(seen[1]?.authorization).toBe("Bearer mk_test");
  });

  it("surfaces the Monid error envelope on API failures", async () => {
    const provider = new MonidWebProvider({
      apiKey: "mk_bad",
      fetch: async () =>
        jsonResponse({ code: 401, message: "Invalid API key", errorCode: "UNAUTHENTICATED" }, 401),
    });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow(
      "Monid request failed with HTTP 401: Invalid API key",
    );
  });

  it("fails clearly when no API key is configured", async () => {
    const provider = new MonidWebProvider({ apiKey: "", fetch: async () => jsonResponse({}) });
    await expect(provider.search({ query: "q" }, ctx)).rejects.toThrow("Monid API key");
  });
});
