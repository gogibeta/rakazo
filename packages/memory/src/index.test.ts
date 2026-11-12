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

  it("returns the ranked rows the database scored, best first", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([
      { path: "budgets.md", content: "The budget in full.", score: 1.42 },
      { path: "trips.md", content: "Travel notes.", score: 0.03 },
    ]);
    const store = new MarkdownMemoryStore({ $queryRaw } as never);

    await expect(store.search({ query: "budgets", scope: "all" }, context)).resolves.toEqual([
      { path: "budgets.md", snippet: "The budget in full.", score: 1.42 },
      { path: "trips.md", snippet: "Travel notes.", score: 0.03 },
    ]);
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
