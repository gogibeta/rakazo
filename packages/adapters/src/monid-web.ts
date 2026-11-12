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
import { fetchThroughProxy } from "./proxy-dispatcher.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import type { ResolveHostname } from "./web-ssrf.js";
import { assertSafeWebUrl } from "./web-ssrf.js";

const RUN_ENDPOINT = "https://api.monid.ai/v1/run";
const RUNS_ENDPOINT = "https://api.monid.ai/v1/runs";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;
const SEARCH_PATH = "/free/search";
const FETCH_PATH = "/free/fetch";
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

// Monid returns the provider's response body as the run output, so the output
// schemas mirror the TinyFish output contract. Fetch error entries are read
// leniently: they carry a machine code alongside (or instead of) a message.
const searchOutputSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      snippet: z.string().nullable().optional(),
    }),
  ),
});

const fetchOutputSchema = z.object({
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
  errors: z
    .array(
      z.object({
        url: z.string().max(8_192).optional(),
        code: z.string().optional(),
        error: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
});

const runSchema = z.object({
  runId: z.string().optional(),
  status: z.string(),
  output: z.unknown().optional(),
  reason: z.string().optional(),
  providerResponse: z
    .object({
      httpStatus: z.number().optional(),
      error: z.unknown().optional(),
    })
    .optional(),
});

const errorSchema = z.object({
  message: z.string().optional(),
  errorCode: z.string().optional(),
});

type MonidRun = z.infer<typeof runSchema>;

type RunInput = {
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
};

export type MonidWebOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  apiKey?: string;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /** Delay between run-status polls when Monid accepts a run asynchronously. */
  pollIntervalMs?: number;
  /** Route this provider's own API calls through this proxy. */
  proxyUrl?: string;
};

/**
 * TinyFish through Monid: the configured key is a Monid API key and search and
 * fetch run on Monid's free TinyFish endpoints, so the calls cost nothing.
 * Every run is sent with `maxCost: 0`, which makes Monid reject it outright if
 * an endpoint ever stops being free. Monid may answer synchronously with the
 * finished run or accept it (HTTP 202) and be polled until it completes.
 */
export class MonidWebProvider implements WebProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly apiKey?: string;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: MonidWebOptions = {}) {
    this.fetchImpl =
      options.fetch ?? (options.proxyUrl ? fetchThroughProxy(options.proxyUrl) : globalThis.fetch);
    this.resolveHostname = options.resolveHostname;
    this.apiKey = options.apiKey?.trim() || undefined;
    // Monid adds run orchestration (and possibly a poll) on top of the
    // provider's own latency, so allow more than the direct provider does.
    this.searchTimeoutMs = options.searchTimeoutMs ?? 30_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  describe() {
    return {
      id: "monid-tinyfish",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: false, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.searchTimeoutMs,
    );
    const output = await this.run(SEARCH_PATH, { queryParams: { query } }, signal);
    const payload = searchOutputSchema.parse(output);
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
    const output = await this.run(
      FETCH_PATH,
      { body: { urls: [url.href], format: "markdown" } },
      signal,
    );
    const payload = fetchOutputSchema.parse(output);
    const page = payload.results?.[0];
    if (!page) {
      const failure = payload.errors?.[0];
      const reason = failure?.error ?? failure?.message ?? failure?.code ?? "no content returned";
      throw new Error(`TinyFish via Monid could not fetch ${url.href}: ${reason}`);
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

  private async run(endpoint: string, input: RunInput, signal: AbortSignal): Promise<unknown> {
    if (!this.apiKey) throw new Error("Monid API key is not set");
    const response = await this.fetchImpl(RUN_ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ provider: "tinyfish", endpoint, input, maxCost: 0 }),
    });
    let run = await this.readRun(response);
    while (!TERMINAL_RUN_STATUSES.has(run.status)) {
      if (!run.runId) throw new Error("Monid accepted the run without an id");
      await sleep(this.pollIntervalMs, signal);
      run = await this.poll(run.runId, signal);
    }
    return runOutput(run);
  }

  private async poll(runId: string, signal: AbortSignal): Promise<MonidRun> {
    if (!this.apiKey) throw new Error("Monid API key is not set");
    const response = await this.fetchImpl(`${RUNS_ENDPOINT}/${encodeURIComponent(runId)}`, {
      method: "GET",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": USER_AGENT,
      },
    });
    return this.readRun(response);
  }

  /** A run body wins over the HTTP status: Monid answers some terminal runs (timeouts, provider payment failures) with a non-200 status and the run in the body. */
  private async readRun(response: Response): Promise<MonidRun> {
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = runSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    const error = errorSchema.safeParse(body);
    const message = error.success ? error.data.message : undefined;
    throw new Error(
      `Monid request failed with HTTP ${response.status}${message ? `: ${message}` : ""}`,
    );
  }
}

function runOutput(run: MonidRun): unknown {
  switch (run.status) {
    case "COMPLETED": {
      const status = run.providerResponse?.httpStatus;
      if (status !== undefined && status >= 400) {
        const detail = providerErrorText(run.providerResponse?.error);
        throw new Error(
          `TinyFish via Monid failed with HTTP ${status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (run.output === undefined || run.output === null)
        throw new Error("Monid run completed without output");
      return run.output;
    }
    case "BLOCKED":
      throw new Error(`Monid blocked the run: ${run.reason ?? "a workspace control rejected it"}`);
    case "FAILED":
      throw new Error(`Monid run failed${run.reason ? `: ${run.reason}` : ""}`);
    case "TIMED_OUT":
      throw new Error("Monid run timed out");
    case "STOPPED":
      throw new Error("Monid run was stopped");
    default:
      throw new Error(`Monid run ended in status ${run.status}`);
  }
}

function providerErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["error", "message", "code"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
