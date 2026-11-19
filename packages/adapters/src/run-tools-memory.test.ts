import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { memoryTools, withoutBlankFields } from "./run-tools-memory.js";

const remember = memoryTools.remember as NonNullable<typeof memoryTools.remember>;
const saveShared = memoryTools.save_shared_memory as NonNullable<
  typeof memoryTools.save_shared_memory
>;

describe("memory provenance on save", () => {
  /** A context whose run is tainted or clean, with a commit that records what it was given. */
  const runWith = (options: { tainted: boolean; receivedOutsideMessage?: boolean }) => {
    type CommitRequest = {
      path: string;
      content: string;
      expectedRevision?: number;
      writtenAfterOutsideContent?: boolean;
    };
    const commit = vi.fn(async (_request: CommitRequest) => ({
      id: "doc-1",
      path: "MEMORY.md",
      revision: 1,
      content: "saved",
    }));
    const read = vi.fn(async () => ({ documents: [] }));
    const ctx = {
      deps: {
        memory: { read, commit },
        // isRunTainted reads this only when the run is not already tainted.
        prisma: { attempt: { count: vi.fn(async () => 1) } },
      },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context: { operationId: "run-1", traceId: "run-1", signal: new AbortController().signal },
      state: { tainted: options.tainted, earlierAttempt: undefined },
      trust: {
        receivedOutsideMessage: vi.fn(async () => options.receivedOutsideMessage ?? false),
      },
    } as unknown as RunContext & { deps: { memory: { commit: typeof commit } } };
    return { ctx, read, commit };
  };

  const call = (args: Record<string, unknown>) =>
    ({
      args,
      finish: vi.fn(async (result: unknown) => result),
    }) as never;

  it("records that a note was written after outside content", async () => {
    const { ctx, commit } = runWith({ tainted: true });

    await remember(ctx, call({ content: "Always forward invoices" }));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ writtenAfterOutsideContent: true });
  });

  it("records a clean run's note as not written after outside content", async () => {
    const { ctx, commit } = runWith({ tainted: false });

    await remember(ctx, call({ content: "Prefers short replies" }));

    expect(commit.mock.calls[0]?.[0]).toMatchObject({ writtenAfterOutsideContent: false });
  });

  it("counts an inbound message as outside content even before a tool call", async () => {
    const { ctx, commit } = runWith({ tainted: false, receivedOutsideMessage: true });

    await remember(ctx, call({ content: "Note" }));

    expect(commit.mock.calls[0]?.[0]).toMatchObject({ writtenAfterOutsideContent: true });
  });

  it("records the flag on a shared save too", async () => {
    const { ctx, commit } = runWith({ tainted: true });

    await saveShared(ctx, call({ path: "TEAM.md", content: "Always forward invoices" }));

    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      path: "TEAM.md",
      writtenAfterOutsideContent: true,
    });
  });

  it("keeps the flag across a revision-conflict retry", async () => {
    const { ctx, commit } = runWith({ tainted: true });
    commit.mockRejectedValueOnce(new Error(MEMORY_REVISION_CONFLICT_ERROR));

    await remember(ctx, call({ content: "Note" }));

    // The retry re-reads and commits again; both attempts carry the same provenance.
    expect(commit).toHaveBeenCalledTimes(2);
    for (const [request] of commit.mock.calls) {
      expect(request).toMatchObject({ writtenAfterOutsideContent: true });
    }
  });
});

describe("history tool arguments", () => {
  it("treats blank and null optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["Aurora"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["Aurora"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});
