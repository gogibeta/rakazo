import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import type { ResolveHostname } from "./web-ssrf.js";
import { assertSafeWebUrl } from "./web-ssrf.js";

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;

const searchSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      snippet: z.string().nullable().optional(),
    }),
  ),
});

const fetchSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().max(8_192),
        final_url: z.string().max(8_192).nullable().optional(),
        title: z.string().nullable().optional(),
        text: z.string(),
      }),
    )
    .optional(),
  errors: z.array(z.object({ url: z.string().max(8_192), error: z.string() })).optional(),
});

export type TinyFishWebOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  apiKey?: string;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/**
 * TinyFish backend for the builtin web tools: browser-rendered live search and
 * page extraction over HTTPS. Needs TINYFISH_API_KEY (free at agent.tinyfish.ai);
 * search and fetch are free endpoints.
 */
export class TinyFishWebProvider implements WebProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly apiKey?: string;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(options: TinyFishWebOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.resolveHostname = options.resolveHostname;
    this.apiKey = options.apiKey ?? process.env.TINYFISH_API_KEY?.trim();
    this.searchTimeoutMs = options.searchTimeoutMs ?? 20_000;
    // Fetch renders pages in a real browser, which takes longer than a plain GET.
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 60_000;
  }

  describe() {
    return {
      id: "tinyfish",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: false, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("query", query);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.searchTimeoutMs,
    );
    const payload = searchSchema.parse(await this.requestJson(url, { method: "GET" }, signal));
    return payload.results
      .filter((page) => publicPageUrl(page.url) !== undefined)
      .slice(0, maxResults)
      .map((page) => {
        const pageUrl = publicPageUrl(page.url)!;
        return {
          url: pageUrl,
          title: page.title?.trim().slice(0, 1_000) || pageUrl,
          snippet: (page.snippet ?? "").slice(0, MAX_SNIPPET_CHARS),
        };
      });
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const signal = this.signal(combineSignals(request.signal, context.signal), this.fetchTimeoutMs);
    // Validate before disclosing the requested URL to the remote extraction service.
    const url = await assertSafeWebUrl(request.url, this.resolveHostname, signal);
    const payload = fetchSchema.parse(
      await this.requestJson(
        new URL(FETCH_ENDPOINT),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ urls: [url.href], format: "markdown" }),
        },
        signal,
      ),
    );
    const page = payload.results?.[0];
    if (!page) {
      const reason = payload.errors?.[0]?.error ?? "no content returned";
      throw new Error(`TinyFish could not fetch ${url.href}: ${reason}`);
    }
    if (!page.text.trim()) throw new Error(`Failed to fetch content from ${url.href}`);
    const finalUrl = page.final_url ? publicPageUrl(page.final_url) : undefined;
    return {
      url: finalUrl ?? url.href,
      title: page.title?.trim().slice(0, 1_000) || "Untitled",
      ...pageWindow(page.text.slice(offset), maxChars, offset),
    };
  }

  private signal(signal: AbortSignal, timeoutMs: number | undefined): AbortSignal {
    return timeoutMs ? combineSignals(signal, AbortSignal.timeout(timeoutMs)) : signal;
  }

  private async requestJson(url: URL, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    if (!this.apiKey) throw new Error("TINYFISH_API_KEY is not set");
    const response = await this.fetchImpl(url, {
      ...init,
      signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "x-api-key": this.apiKey,
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`TinyFish request failed with HTTP ${response.status}`);
    return response.json();
  }
}

/** Keep citations public HTTP(S) URLs without embedded credentials. */
function publicPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
      return url.href;
  } catch {
    /* Malformed provider URLs are not usable citations. */
  }
  return undefined;
}
