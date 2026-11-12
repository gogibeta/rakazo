import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";
import { chunkContent } from "./ranking.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });

  it("removes one document by scope, bot and path inside the caller's space", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove(
        { id: "memory-9", scope: "bot", botId: "bot-1", path: "projects/retired.md" },
        context,
      ),
    ).resolves.toEqual({ removed: true });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "memory-9",
        spaceId: "workspace-1",
        scope: "bot",
        botId: "bot-1",
        path: "projects/retired.md",
      },
    });
  });

  it("lists every document in scope for an empty search, as before", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "memory-1", path: "facts.md", content: "A fact", revision: 1, updatedAt: new Date() },
      { id: "memory-2", path: "notes.md", content: "A note", revision: 1, updatedAt: new Date() },
    ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    const results = await store.search({ query: "  ", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["facts.md", "notes.md"]);
    expect(results.every((result) => result.score === 1)).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1", scope: "user" },
    });
  });

  // The search fixtures mirror the Postgres suite in search.postgres.test.ts.
  const searchDocs = [
    {
      id: "memory-weak",
      path: "weak.md",
      content:
        "Notes from the planning offsite. We walked through hiring, venues, catering, " +
        "travel days, catering tastings, and the draft agenda for the winter retreat, " +
        "and someone mentioned the budget once while listing open questions for the " +
        "finance review next month.",
      revision: 1,
      updatedAt: new Date("2026-08-16T10:00:00.000Z"),
    },
    {
      id: "memory-strong",
      path: "strong.md",
      content:
        "Budget budget budget budget. The quarterly budget plan sets the budget for " +
        "travel, and every budget line needs a second budget review before sign-off.",
      revision: 1,
      updatedAt: new Date("2026-08-16T11:00:00.000Z"),
    },
    {
      id: "memory-identifier",
      path: "identifier.md",
      content: "The deploy token rkz-deploy-9f2 is rotated on the first Monday of each month.",
      revision: 1,
      updatedAt: new Date("2026-08-16T12:00:00.000Z"),
    },
  ];

  function searchStore(docs = searchDocs) {
    const findMany = vi.fn().mockResolvedValue(docs);
    return {
      findMany,
      store: new MarkdownMemoryStore({ memoryDocument: { findMany } } as never),
    };
  }

  it("ranks a dense match above a passing mention, with real scores", async () => {
    const { findMany, store } = searchStore();
    const results = await store.search({ query: "budget", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[1]!.score).toBeGreaterThan(0);
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1", scope: "user" },
    });
  });

  it("stems, so a plural query finds the singular word", async () => {
    const { store } = searchStore();
    const results = await store.search({ query: "budgets", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
  });

  it("requires every word of a multi-word query", async () => {
    const { store } = searchStore();
    const results = await store.search({ query: "quarterly budget", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["strong.md"]);
  });

  it("still finds an exact identifier verbatim", async () => {
    const { store } = searchStore();
    const results = await store.search({ query: "rkz-deploy-9f2", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["identifier.md"]);
    expect(results[0]!.snippet).toContain("rkz-deploy-9f2");
  });

  it("searches bot memory through the bot filter", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "memory-bot",
        path: "bot-budget.md",
        content: "Budget reminders the bot keeps for itself.",
        revision: 1,
        updatedAt: new Date("2026-08-16T10:00:00.000Z"),
      },
    ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);
    const results = await store.search({ query: "budget", scope: "bot", botId: "bot-1" }, context);
    expect(results.map((result) => result.path)).toEqual(["bot-budget.md"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1", scope: "bot", botId: "bot-1" },
    });
  });

  // Phase 2 acceptance test: the curated synonym list (synonyms.ts) names
  // "budget" and "spend limit" as the same topic, so the chunk channel finds
  // this note. Anything the list does not name still gets no expansion —
  // ranking stays lexical, stemming plus fuzzy plus this fixed dictionary.
  it("finds a note through a curated synonym: 'budget' matches text that only says 'spend limit'", async () => {
    const { store } = searchStore([
      {
        id: "memory-spend",
        path: "spend.md",
        content: "Set a spend limit for travel and stick to it.",
        revision: 1,
        updatedAt: new Date("2026-08-16T10:00:00.000Z"),
      },
    ]);
    const results = await store.search({ query: "budget", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["spend.md"]);
  });

  it("ranks a synonym-only match below a direct hit on the same query", async () => {
    const { store } = searchStore([
      {
        id: "memory-direct",
        path: "direct.md",
        content: "The budget is set for the year and the team follows it closely.",
        revision: 1,
        updatedAt: new Date("2026-08-16T10:00:00.000Z"),
      },
      {
        id: "memory-synonym",
        path: "synonym.md",
        content: "Set a spend limit for travel and stick to it this year.",
        revision: 1,
        updatedAt: new Date("2026-08-16T11:00:00.000Z"),
      },
    ]);
    const results = await store.search({ query: "budget", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["direct.md", "synonym.md"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("tolerates a typo through trigram similarity, and only for near words", async () => {
    const { store } = searchStore();
    const results = await store.search({ query: "budjet", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
    const { store: identifierOnly } = searchStore([searchDocs[2]!]);
    await expect(
      identifierOnly.search({ query: "budjet", scope: "user" }, context),
    ).resolves.toEqual([]);
  });

  it("surfaces a long document whose one dense section carries the term", async () => {
    // Six mentions sit in a short Costs section of a long planning note.
    // Whole-document scoring dilutes them below the short memo's single
    // mention; the best-chunk score is what lifts the note back on top.
    const filler = Array.from(
      { length: 16 },
      () =>
        "The group talked about venues and catering and travel days and the draft agenda for the retreat.",
    ).join(" ");
    const { store } = searchStore([
      {
        id: "memory-long",
        path: "long.md",
        content:
          `# Planning notes\n\n${filler}\n\n## Costs\n\n` +
          "budget budget budget budget budget budget for the whole team this quarter." +
          `\n\n## Wrap up\n\n${filler}`,
        revision: 1,
        updatedAt: new Date("2026-08-16T10:00:00.000Z"),
      },
      {
        id: "memory-short",
        path: "short.md",
        content: "Budget is noted in this short memo for the team.",
        revision: 1,
        updatedAt: new Date("2026-08-16T11:00:00.000Z"),
      },
    ]);
    const results = await store.search({ query: "budget", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["long.md", "short.md"]);
  });

  it("keeps every phase 1 result on the phase 1 fixtures (recall floor)", async () => {
    // Expected orders are what the phase-1 scorer returned for these
    // fixtures; the fused scorer must return the same documents, with the
    // phase-1 winner still first and no widening on the strict queries.
    const expectations: Array<[string, string[]]> = [
      ["budget", ["strong.md", "weak.md"]],
      ["budgets", ["strong.md", "weak.md"]],
      ["budget review", ["strong.md", "weak.md"]],
      ["quarterly budget", ["strong.md"]],
      ["rkz-deploy-9f2", ["identifier.md"]],
    ];
    const { store } = searchStore();
    for (const [query, paths] of expectations) {
      const results = await store.search({ query, scope: "user" }, context);
      expect(results.map((result) => result.path)).toEqual(paths);
    }
  });

  it("lists the fixtures untouched for an empty search in phase 2 as well", async () => {
    const { store } = searchStore();
    const results = await store.search({ query: "   ", scope: "user" }, context);
    expect(results.map((result) => result.path)).toEqual(["weak.md", "strong.md", "identifier.md"]);
    expect(results.every((result) => result.score === 1)).toBe(true);
  });

  it("chunks on headings, and packs heading-less text by paragraphs under the cap", () => {
    const headed = chunkContent("# Alpha\n\nfirst section\n\n## Beta\n\nsecond section");
    expect(headed).toHaveLength(2);
    expect(headed[0]).toContain("Alpha");
    expect(headed[1]).toContain("Beta");
    const paragraph = "word ".repeat(100).trim();
    const packed = chunkContent(Array.from({ length: 6 }, () => paragraph).join("\n\n"));
    expect(packed.length).toBeGreaterThan(1);
    expect(packed.every((chunk) => chunk.length <= 1200)).toBe(true);
  });

  it("returns false for a missing user document without touching bot memory", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove({ id: "missing", scope: "user", path: "projects/retired.md" }, context),
    ).resolves.toEqual({ removed: false });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "missing",
        spaceId: "workspace-1",
        scope: "user",
        botId: null,
        path: "projects/retired.md",
      },
    });
  });
});
