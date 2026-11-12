import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { clampMaxResults } from "./web-limits.js";

export type CombinedWebOptions = {
  /** Rendered/listed first when present (for example TinyFish with an API key). */
  primary?: WebProvider;
  /** Always-available fallback (the keyless HTTP provider). */
  fallback: WebProvider;
};

/**
 * Combined web backend: with a primary configured, search merges primary and
 * fallback hits (primary first, duplicates removed) and fetch prefers the
 * primary, falling back on error. Without a primary it behaves exactly like
 * the fallback alone.
 */
export class CombinedWebProvider implements WebProvider {
  private readonly primary?: WebProvider;
  private readonly fallback: WebProvider;

  constructor(options: CombinedWebOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
  }

  describe() {
    return {
      id: "tinyfish-ddg",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: !this.primary,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    if (!this.primary) return this.fallback.search(request, context);
    const maxResults = clampMaxResults(request.maxResults);
    const [primary, fallback] = await Promise.allSettled([
      this.primary.search(request, context),
      this.fallback.search(request, context),
    ]);
    if (primary.status === "rejected" && fallback.status === "rejected") throw fallback.reason;
    const merged: WebSearchHit[] = [];
    const seen = new Set<string>();
    for (const result of [primary, fallback]) {
      if (result.status !== "fulfilled") continue;
      for (const hit of result.value) {
        const key = dedupeKey(hit.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(hit);
        if (merged.length >= maxResults) return merged;
      }
    }
    return merged;
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    if (!this.primary) return this.fallback.fetch(request, context);
    try {
      return await this.primary.fetch(request, context);
    } catch {
      return this.fallback.fetch(request, context);
    }
  }
}

function dedupeKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return value;
  }
}
