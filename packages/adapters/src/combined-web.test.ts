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

  it("keeps fallback uniques when the primary fills the requested page", async () => {
    // A full primary page is the case that used to hide the second source: five primary hits
    // filled a five-result request, so the merge returned before reading the fallback at all.
    const primary = fakeWith(
      Array.from({ length: 5 }, (_, index) => ({
        title: `P${index}`,
        url: `https://primary.test/${index}`,
        snippet: "",
      })),
    );
    const fallback = fakeWith(
      Array.from({ length: 5 }, (_, index) => ({
        title: `F${index}`,
        url: `https://fallback.test/${index}`,
        snippet: "",
      })),
    );
    const provider = new CombinedWebProvider({ primary, fallback });
    const hits = await provider.search({ query: "q", maxResults: 5 }, ctx);

    // All five primary hits lead, and every fallback hit none of them covered still reaches the
    // caller: the merged list is twice the request, primary first.
    expect(hits.map((hit) => hit.title)).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "F0",
      "F1",
      "F2",
      "F3",
      "F4",
    ]);
    expect(hits).toHaveLength(10);
  });

  it("still dedupes across sides at the doubled cap", async () => {
    // Overlap counts once: a duplicate must not consume one of the extra slots.
    const primary = fakeWith(
      Array.from({ length: 5 }, (_, index) => ({
        title: `P${index}`,
        url: `https://primary.test/${index}`,
        snippet: "",
      })),
    );
    const fallback = fakeWith([
      { title: "P0 again", url: "https://primary.test/0", snippet: "" },
      { title: "F0", url: "https://fallback.test/0", snippet: "" },
      { title: "F1", url: "https://fallback.test/1", snippet: "" },
    ]);
    const provider = new CombinedWebProvider({ primary, fallback });
    const hits = await provider.search({ query: "q", maxResults: 5 }, ctx);

    expect(hits.map((hit) => hit.title)).toEqual(["P0", "P1", "P2", "P3", "P4", "F0", "F1"]);
  });

  it("caps a short request at twice its own count, not the maximum", async () => {
    // maxResults: 2 asks each side for two, so at most four unique hits come back.
    const primary = fakeWith([
      { title: "P0", url: "https://primary.test/0", snippet: "" },
      { title: "P1", url: "https://primary.test/1", snippet: "" },
      { title: "P2", url: "https://primary.test/2", snippet: "" },
    ]);
    const fallback = fakeWith([
      { title: "F0", url: "https://fallback.test/0", snippet: "" },
      { title: "F1", url: "https://fallback.test/1", snippet: "" },
    ]);
    const provider = new CombinedWebProvider({ primary, fallback });
    const hits = await provider.search({ query: "q", maxResults: 2 }, ctx);

    expect(hits).toHaveLength(4);
    expect(hits.map((hit) => hit.title)).toEqual(["P0", "P1", "F0", "F1"]);
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
