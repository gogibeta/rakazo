import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

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

  // Phase 2 acceptance test, skipped on purpose: ranking here is lexical, so
  // it cannot know "budget" and "spend limit" are the same topic. Chunked
  // retrieval with curated synonym expansion (memory phase 2) owns this case;
  // unskip it there.
  it.skip("finds a note by meaning: 'budget' matches text that only says 'spend limit'", async () => {
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
