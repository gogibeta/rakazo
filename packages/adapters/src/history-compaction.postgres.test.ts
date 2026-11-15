import { randomUUID } from "node:crypto";
import type { AgentRuntime, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, searchHistory } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const SUMMARY = "The user shared an archive passphrase and the bot acknowledged it.";

describePostgres("history compaction provenance (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("records a continuation summary without touching the messages or events it covers", async () => {
    const id = randomUUID();
    users.push(id);
    const thread = await runAsSystem("compaction fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Compact test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Compact test", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Compact test", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Compact test", color: "test-color" },
      });
      const created = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id, nextMessageSeq: 4 },
      });
      const texts = [
        "The archive passphrase is quillphrase.",
        "Noted, I will keep it in the summary.",
        "Please also remember the deploy window.",
        "Done — both facts are saved.",
      ];
      for (const [seq, text] of texts.entries()) {
        await prisma.message.create({
          data: {
            threadId: created.id,
            seq,
            role: seq % 2 === 0 ? "user" : "bot",
            ...(seq % 2 === 0 ? { authorUserId: id } : { botId: bot.id }),
            blocks: [{ kind: "text", text }],
          },
        });
      }
      for (const seq of [0, 1]) {
        await prisma.event.create({
          data: {
            spaceId: id,
            threadId: created.id,
            botId: bot.id,
            seq,
            type: "thread.message.created",
            payload: {},
          },
        });
      }
      return created;
    });

    const runtime = {
      describe: () => ({ capabilities: { compaction: true } }),
      run: async function* () {
        yield { type: "done", text: SUMMARY };
      },
    } as unknown as AgentRuntime;
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: async () => undefined,
      close: async () => undefined,
    } as unknown as JobPublisher;
    const memoryProviders = {
      resolve: vi.fn(async () => null),
    } as unknown as MemoryProviderResolver;

    await runAsSystem("run compaction", () =>
      compactHistory(
        {
          prisma,
          runtime,
          jobs,
          memoryProviders,
          resolveModel: async () => ({ provider: "fake", id: "fake-model" }),
        },
        thread.id,
      ),
    );

    await runAsSystem("verify compaction", async () => {
      // The invariant: compaction replaces nothing. The rows it summarized are all still
      // there, byte for byte, and so are the thread's events.
      expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(4);
      expect(await prisma.event.count({ where: { threadId: thread.id } })).toBe(2);
      const after = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
      expect(after.historyCompactedUpToSeq).toBe(3);
      expect(after.historyCompactionSummary).toBe(SUMMARY);

      // And the batch left provenance: which generation, which seq range, how many
      // messages, and the compaction run that produced it.
      const provenance = await prisma.continuationSummary.findMany({
        where: { threadId: thread.id },
      });
      expect(provenance).toHaveLength(1);
      expect(provenance[0]).toMatchObject({
        generation: 0,
        fromSeq: -1,
        toSeq: 3,
        sourceMessageCount: 4,
        summary: SUMMARY,
        createdByRunId: `compact:${thread.id}:-1`,
      });

      // A fact from before the compaction is still findable in the original message.
      const found = await searchHistory(
        prisma,
        { spaceId: id, threadId: thread.id, botId: after.botId! },
        { query: "quillphrase" },
      );
      expect(found.messages.map((message) => message.seq)).toContain(0);
    });
  });
});
