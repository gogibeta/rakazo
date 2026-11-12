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
import { stem } from "./stem.js";

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
    // Ranking happens here, not in SQL: memory content is sealed at rest, so
    // the database only ever holds ciphertext and no index over it can match
    // words. The typed client returns this scope's documents decrypted (the
    // same set read() loads), and they are scored in process — stemmed term
    // frequency, length-normalised, fused with the literal substring match
    // the store has always done so exact phrases and identifiers still hit
    // even when stemming or tokenising would miss them.
    const documents = await this.prisma.memoryDocument.findMany({ where });
    const terms = [...new Set(tokenize(query).map(stem))];
    const scored: Array<MemorySearchResult & { updatedAt: Date }> = [];
    for (const doc of documents) {
      const score = scoreDocument(doc, terms, query.toLowerCase());
      if (score !== undefined)
        scored.push({
          path: doc.path,
          snippet: snippet(doc.content, query.toLowerCase()),
          score,
          updatedAt: doc.updatedAt,
        });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        a.path.localeCompare(b.path),
    );
    return scored.map(({ path, snippet: text, score }) => ({ path, snippet: text, score }));
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
 * Words of a text, with the same normalisation the content blind index uses
 * (NFKC, lowercased, runs of letters and digits): "notes/q3-report.pdf"
 * tokenises into words, and a hyphenated identifier into its parts.
 */
function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Relevance of one document to a search, or undefined when it does not match.
 * A document matches when every query term appears among its stemmed words
 * (content or path) — or when the query appears verbatim, so an exact phrase
 * or identifier hits even if tokenising splits it differently on each side.
 * The score is the matched terms' frequency, dampened by document length,
 * plus a flat bonus for a verbatim hit: in the content first, then the path.
 */
function scoreDocument(
  doc: { path: string; content: string },
  terms: string[],
  queryLower: string,
): number | undefined {
  const contentHit = doc.content.toLowerCase().includes(queryLower);
  const pathHit = doc.path.toLowerCase().includes(queryLower);
  if (!terms.length) return contentHit ? 1 : pathHit ? 0.5 : undefined;
  const frequencies = new Map<string, number>();
  const contentWords = tokenize(doc.content).map(stem);
  for (const word of contentWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  for (const word of tokenize(doc.path).map(stem))
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  let frequency = 0;
  for (const term of terms) {
    const count = frequencies.get(term) ?? 0;
    if (count === 0 && !contentHit && !pathHit) return undefined;
    frequency += count;
  }
  return (
    frequency / Math.sqrt(Math.max(1, contentWords.length)) +
    (contentHit ? 1 : 0) +
    (pathHit ? 0.5 : 0)
  );
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
