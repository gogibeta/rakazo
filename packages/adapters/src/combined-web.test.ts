import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CombinedWebProvider } from "./combined-web.js";
import { FakeWebProvider } from "./fake-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

function fakeWith(hits: { title: string; url: string; snippet: string }[]): FakeWebProvider {
  const fake = new FakeWebProvider();
  fake.searchHits = hits;
  return fake;
}

describe("CombinedWebProvider", () => {
  it("behaves like the fallback alone without a primary", async () => {
    const fallback = fakeWith([{ title: "A", url: "https://a.test/", snippet: "" }]);
    const provider = new CombinedWebProvider({ fallback });
    expect(provider.describe().capabilities.keyless).toBe(true);
    const hits = await provider.search({ query: "q" }, ctx);
    expect(hits.map((hit) => hit.url)).toEqual(["https://a.test/"]);
  });

  it("merges primary hits first and removes duplicates", async () => {
    const primary = fakeWith([
      { title: "A", url: "https://a.test/", snippet: "" },
      { title: "B", url: "https://b.test/page", snippet: "" },
    ]);
    const fallback = fakeWith([
      { title: "B again", url: "https://b.test/page/", snippet: "" },
      { title: "C", url: "https://c.test/", snippet: "" },
    ]);
    const provider = new CombinedWebProvider({ primary, fallback });
    const hits = await provider.search({ query: "q", maxResults: 10 }, ctx);
    expect(hits.map((hit) => hit.title)).toEqual(["A", "B", "C"]);
  });

  it("uses fallback hits when the primary search fails", async () => {
    const primary = fakeWith([]);
    primary.searchError = new Error("primary down");
    const fallback = fakeWith([{ title: "A", url: "https://a.test/", snippet: "" }]);
    const provider = new CombinedWebProvider({ primary, fallback });
    const hits = await provider.search({ query: "q" }, ctx);
    expect(hits.map((hit) => hit.url)).toEqual(["https://a.test/"]);
  });

  it("falls back for fetch when the primary fetch fails", async () => {
    const primary = fakeWith([]);
    primary.fetchError = new Error("render failed");
    const fallback = fakeWith([]);
    const provider = new CombinedWebProvider({ primary, fallback });
    const page = await provider.fetch({ url: "https://a.test/" }, ctx);
    expect(page.text).toBe("Hello from fake web");
  });
});
