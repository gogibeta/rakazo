import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("memory search (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-search-test",
    traceId: "memory-search-test",
    spaceId: "memory-search-space",
    userId: "memory-search-user",
    signal: new AbortController().signal,
  };
  const otherContext: AdapterContext = {
    ...context,
    operationId: "memory-search-test-other",
    spaceId: "memory-search-space-b",
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  async function save(ctx: AdapterContext, path: string, content: string, bot = false) {
    await runAsSystem("memory search test", () =>
      store.commit(
        {
          scope: bot ? "bot" : "user",
          ...(bot ? { botId: "memory-search-bot" } : {}),
          path,
          content,
        },
        ctx,
      ),
    );
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).organization.create({
      data: {
        id: "memory-search-org",
        name: "Memory Search Test Organization",
        slug: "memory-search-org",
        createdAt: new Date(),
        spaces: {
          create: {
            id: "memory-search-space",
            name: "Memory Search Test Space",
            bots: {
              create: {
                id: "memory-search-bot",
                userId: context.userId,
                name: "Memory Search Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
    await asSystem(prisma).organization.create({
      data: {
        id: "memory-search-org-b",
        name: "Memory Search Test Organization B",
        slug: "memory-search-org-b",
        createdAt: new Date(),
        spaces: {
          create: {
            id: "memory-search-space-b",
            name: "Memory Search Test Space B",
          },
        },
      },
    });
    await save(
      context,
      "strong.md",
      "Budget budget budget budget. The quarterly budget plan sets the budget for " +
        "travel, and every budget line needs a second budget review before sign-off.",
    );
    await save(
      context,
      "weak.md",
      "Notes from the planning offsite. We walked through hiring, venues, catering, " +
        "travel days, catering tastings, and the draft agenda for the winter retreat, " +
        "and someone mentioned the budget once while listing open questions for the " +
        "finance review next month.",
    );
    await save(
      context,
      "identifier.md",
      "The deploy token rkz-deploy-9f2 is rotated on the first Monday of each month.",
    );
    await save(context, "bot-budget.md", "Budget reminders the bot keeps for itself.", true);
    await save(otherContext, "other.md", "Budget budget budget budget budget budget.");
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await asSystem(prisma).organization.deleteMany({
        where: { id: { in: ["memory-search-org", "memory-search-org-b"] } },
      });
    } finally {
      await close();
    }
  });

  async function search(ctx: AdapterContext, query: string, scope: "user" | "bot" | "all") {
    return runAsSystem("memory search test", () =>
      store.search(
        {
          query,
          scope,
          ...(scope === "bot" ? { botId: "memory-search-bot" } : {}),
        },
        ctx,
      ),
    );
  }

  it("ranks a dense match above a passing mention, with real scores", async () => {
    const results = await search(context, "budget", "user");
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[1]!.score).toBeGreaterThan(0);
  });

  it("stems, so a plural query finds the singular word", async () => {
    const results = await search(context, "budgets", "user");
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
  });

  it("requires every word of a multi-word query", async () => {
    const results = await search(context, "quarterly budget", "user");
    expect(results.map((result) => result.path)).toEqual(["strong.md"]);
  });

  it("still finds an exact identifier verbatim", async () => {
    const results = await search(context, "rkz-deploy-9f2", "user");
    expect(results.map((result) => result.path)).toEqual(["identifier.md"]);
    expect(results[0]!.snippet).toContain("rkz-deploy-9f2");
  });

  it("keeps scopes apart and honours the bot filter", async () => {
    const user = await search(context, "budget", "user");
    expect(user.map((result) => result.path)).not.toContain("bot-budget.md");
    const bot = await search(context, "budget", "bot");
    expect(bot.map((result) => result.path)).toEqual(["bot-budget.md"]);
    const all = await search(context, "budget", "all");
    expect(all.map((result) => result.path)).toContain("bot-budget.md");
    expect(all.map((result) => result.path)).toContain("strong.md");
  });

  it("never returns another space's documents", async () => {
    const results = await search(otherContext, "budget", "user");
    expect(results.map((result) => result.path)).toEqual(["other.md"]);
    const own = await search(context, "budget", "all");
    expect(own.map((result) => result.path)).not.toContain("other.md");
  });

  it("an empty query still lists the scope's documents", async () => {
    const results = await search(context, "", "user");
    expect(results.map((result) => result.path).sort()).toEqual([
      "identifier.md",
      "strong.md",
      "weak.md",
    ]);
    expect(results.every((result) => result.score === 1)).toBe(true);
  });

  it("tolerates a typo through trigram similarity", async () => {
    const results = await search(context, "budjet", "user");
    expect(results.map((result) => result.path)).toEqual(["strong.md", "weak.md"]);
  });

  it("finds a note through a curated synonym, below the direct hits, without leaking scopes", async () => {
    await save(context, "spend.md", "Set a spend limit for travel and stick to it.");
    try {
      const results = await search(context, "budget", "user");
      const synonym = results.find((result) => result.path === "spend.md");
      const direct = results.find((result) => result.path === "strong.md");
      expect(synonym).toBeDefined();
      expect(direct).toBeDefined();
      expect(synonym!.score).toBeLessThan(direct!.score);
      const bot = await search(context, "budget", "bot");
      expect(bot.map((result) => result.path)).toEqual(["bot-budget.md"]);
    } finally {
      await runAsSystem("memory search test", () =>
        store.remove({ scope: "user", path: "spend.md" }, context),
      );
    }
  });
});
