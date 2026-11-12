import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";

/** Memory is the Space's: every member's runs read and write the same documents. */
export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const where = {
      spaceId: context.spaceId,
      ...(request.scope === "all" ? {} : { scope: request.scope }),
      ...(request.botId ? { botId: request.botId } : {}),
    };
    const query = request.query.trim();
    if (!query) {
      // An empty search lists the space's memory, as it always has.
      const documents = await this.prisma.memoryDocument.findMany({ where });
      return documents.map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, ""),
        score: 1,
      }));
    }
    // Ranked full-text matches fused with the literal substring match the store
    // has always done, so exact phrases and identifiers still hit even when
    // stemming or tokenising would miss them. Both sides are parameterised:
    // websearch_to_tsquery parses the query as data, and the ILIKE pattern
    // escapes its wildcards so the query stays literal there too.
    const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const tsquery = Prisma.sql`websearch_to_tsquery('english', ${query})`;
    const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      SELECT path, content,
        ts_rank(${SEARCH_VECTOR}, ${tsquery})
          + CASE WHEN content ILIKE ${pattern} OR path ILIKE ${pattern} THEN 1 ELSE 0 END AS score
      FROM memory_documents
      WHERE "spaceId" = ${context.spaceId}
        ${request.scope === "all" ? Prisma.empty : Prisma.sql`AND scope = ${request.scope}`}
        ${request.botId ? Prisma.sql`AND "botId" = ${request.botId}` : Prisma.empty}
        AND (${SEARCH_VECTOR} @@ ${tsquery} OR content ILIKE ${pattern} OR path ILIKE ${pattern})
      ORDER BY score DESC, "updatedAt" DESC, path ASC`);
    return rows.map((row) => ({
      path: row.path,
      snippet: snippet(row.content, query.toLowerCase()),
      score: row.score,
    }));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.memoryDocument.findFirst({
            where: {
              spaceId: context.spaceId,
              scope: request.scope,
              botId: request.botId ?? null,
              path: request.path,
            },
          });
          if (request.expectedRevision !== undefined) {
            const live = existing?.revision ?? 0;
            if (live !== request.expectedRevision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
          }
          const doc = existing
            ? await tx.memoryDocument.update({
                where: { id: existing.id },
                data: { content: request.content, revision: existing.revision + 1 },
              })
            : await tx.memoryDocument.create({
                data: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  botId: request.botId,
                  scope: request.scope,
                  path: request.path,
                  content: request.content,
                },
              });
          await tx.memoryRevision.create({
            data: {
              documentId: doc.id,
              revision: doc.revision,
              content: request.content,
              sourceRunId: request.sourceRunId,
              sourceThreadId: request.sourceThreadId,
            },
          });
          return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async remove(
    request: MemoryRemoveRequest,
    context: AdapterContext,
  ): Promise<{ removed: boolean }> {
    // Revisions cascade with the document row.
    const { count } = await this.prisma.memoryDocument.deleteMany({
      where: {
        ...(request.id ? { id: request.id } : {}),
        spaceId: context.spaceId,
        scope: request.scope,
        botId: request.botId ?? null,
        path: request.path,
      },
    });
    return { removed: count > 0 };
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

/**
 * Matches the expression of memory_documents_search_idx: the content plus the
 * path with its separators as spaces, so "notes/q3-report.pdf" tokenises into
 * words. The 'english' config stems, so "budgets" finds "budget".
 */
const SEARCH_VECTOR = Prisma.sql`to_tsvector('english', content || ' ' || translate(path, '/._-', '    '))`;

interface SearchRow {
  path: string;
  content: string;
  score: number;
}

function snippet(content: string, q: string): string {
  const lower = content.toLowerCase();
  let idx = lower.indexOf(q);
  let probe = q;
  if (idx < 0) {
    // A stemmed hit (query "budgets", text "budget") has no literal match for
    // the whole query; centre on the first query word that does appear.
    for (const word of q.split(/\s+/)) {
      const at = word ? lower.indexOf(word) : -1;
      if (at >= 0) {
        idx = at;
        probe = word;
        break;
      }
    }
  }
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + probe.length + 80);
}
