import { readFileSync } from "node:fs";
import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { MemoryPromptDocument } from "../../memory-context.js";
import { AGENT_MEMORY_MAX_BYTES } from "../../memory-context.js";
import { assembleLayer1, assembleLayer1FromStore } from "./assembly.js";
import { CONTROL_QUESTIONS, FIXTURE_DOCUMENTS, QUESTIONS, SCORED_QUESTIONS } from "./fixtures.js";
import { gradeAnswer } from "./grading.js";
import type { EvalRunRecord } from "./results.js";
import { formatSummary } from "./results.js";
import { runLiveEval } from "./run-live.js";

const baseline = JSON.parse(
  readFileSync(new URL("./baseline/fixture-layer1.json", import.meta.url), "utf8"),
) as EvalRunRecord;

describe("layer 1 — fixture corpus baseline", () => {
  const outcome = assembleLayer1(FIXTURE_DOCUMENTS, QUESTIONS);

  it("puts every scored fact in the assembled context", () => {
    for (const result of outcome.results) {
      const question = QUESTIONS.find((entry) => entry.id === result.id)!;
      if (question.kind === "scored") {
        expect(result.layer1.factInContext, result.id).toBe(true);
      }
    }
    expect(outcome.summary.layer1.factsPresent).toBe(SCORED_QUESTIONS.length);
    expect(outcome.summary.layer1.factsAbsent).toBe(0);
  });

  it("leaves every control question unanswerable from memory", () => {
    expect(outcome.summary.layer1.controlsClean).toBe(CONTROL_QUESTIONS.length);
    expect(outcome.summary.layer1.controlsLeaking).toBe(0);
  });

  it("includes both fixture documents, omits none, and stays within the production budget", () => {
    const [first] = outcome.results;
    expect(first?.layer1.includedDocs).toEqual(["bot:wallet-notes.md", "user:deployment-facts.md"]);
    expect(first?.layer1.omittedDocs).toEqual([]);
    expect(first?.layer1.usedBytes).toBeLessThanOrEqual(AGENT_MEMORY_MAX_BYTES);
  });

  it("matches the recorded baseline, question for question", () => {
    expect(outcome.results).toEqual(baseline.questions);
    expect(outcome.summary).toEqual(baseline.summary);
  });

  it("records what truncation drops instead of letting it pass silently", () => {
    const filler: MemoryPromptDocument = {
      scope: "user",
      path: "filler.md",
      revision: 1,
      updatedAt: "2026-11-14T02:00:00.000Z",
      content: `filler\n${"x".repeat(40_000)}`,
    };
    const crowded = assembleLayer1([filler, ...FIXTURE_DOCUMENTS], QUESTIONS);
    expect(crowded.summary.layer1.factsAbsent).toBeGreaterThan(0);
    expect(crowded.results[0]?.layer1.omittedDocs.length).toBeGreaterThan(0);
    expect(crowded.results[0]?.layer1.usedBytes).toBeLessThanOrEqual(AGENT_MEMORY_MAX_BYTES);
  });

  it("assembles the same result through a memory store", async () => {
    const context: AdapterContext = {
      operationId: "eval-1",
      traceId: "eval-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      runId: "eval-1",
      signal: new AbortController().signal,
    };
    const read = vi.fn(
      async ({ scope }: { scope: "bot" | "user" }): Promise<MemorySnapshot> => ({
        documents: FIXTURE_DOCUMENTS.filter((document) => document.scope === scope).map(
          (document) => ({
            id: document.path,
            path: document.path,
            content: document.content,
            revision: document.revision,
            updatedAt: document.updatedAt,
          }),
        ),
      }),
    );
    const store: MemoryStore = {
      describe: vi.fn<MemoryStore["describe"]>(),
      read,
      search: vi.fn<MemoryStore["search"]>(),
      commit: vi.fn<MemoryStore["commit"]>(),
      remove: vi.fn<MemoryStore["remove"]>(),
      exportMarkdown: vi.fn<MemoryStore["exportMarkdown"]>(),
      importMarkdown: vi.fn<MemoryStore["importMarkdown"]>(),
    };

    const fromStore = await assembleLayer1FromStore(store, "bot-1", context, QUESTIONS);

    expect(fromStore.results).toEqual(outcome.results);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("layer 2 — grading", () => {
  const byId = (id: string) => QUESTIONS.find((question) => question.id === id)!;

  it("passes scored answers that carry the key fact", () => {
    expect(gradeAnswer(byId("q1-wallet-count"), "You have 1 wallet stored.")).toBe("pass");
    expect(gradeAnswer(byId("q3-wallet-network"), "It is on the Elysium testnet (Kinetiq).")).toBe(
      "pass",
    );
    expect(gradeAnswer(byId("q7-bot-names"), "The bots are Chief and grok.")).toBe("pass");
    expect(gradeAnswer(byId("q11-connection-count"), "Four connections are configured.")).toBe(
      "pass",
    );
  });

  it("fails scored answers that miss or contradict the key fact", () => {
    expect(gradeAnswer(byId("q1-wallet-count"), "You have 8 wallets stored.")).toBe("fail");
    expect(gradeAnswer(byId("q10-chief-model"), "Chief uses Sage-A1.5.")).toBe("fail");
    expect(gradeAnswer(byId("q12-public-address"), "I don't know the address.")).toBe("fail");
  });

  it("passes controls only when the bot admits it does not know", () => {
    expect(
      gradeAnswer(byId("c1-wallet-balance"), "I don't know — the balance isn't in my memory."),
    ).toBe("pass");
    expect(
      gradeAnswer(byId("c3-telegram-password"), "That was never recorded, and I do not have it."),
    ).toBe("pass");
  });

  it("marks confident control answers as fabricated", () => {
    expect(gradeAnswer(byId("c1-wallet-balance"), "The balance is 0.119 HYPE.")).toBe("fabricated");
    expect(
      gradeAnswer(byId("c2-grok-yesterday"), "grok spent yesterday fixing the deploy pipeline."),
    ).toBe("fabricated");
    expect(gradeAnswer(byId("c3-telegram-password"), "The password is hunter2.")).toBe(
      "fabricated",
    );
  });
});

describe("layer 2 — runner", () => {
  it("resets per question, grades every reply, and records the run", async () => {
    let resets = 0;
    const answerer = {
      model: "test-model",
      reset: async () => {
        resets += 1;
      },
      ask: async (question: string) =>
        question.includes("balance") ? "The balance is 3.5 HYPE." : "Chief",
    };

    const record = await runLiveEval({
      answerer,
      questions: QUESTIONS,
      corpus: "fixture",
      gitSha: "test-sha",
      date: "2026-11-14",
    });

    expect(resets).toBe(QUESTIONS.length);
    expect(record.mode).toBe("layer2");
    expect(record.summary.layer2?.fabricated).toBe(3);
    expect(
      record.questions.find((result) => result.id === "q8-telegram-bot")?.layer2?.verdict,
    ).toBe("pass");
    expect(record.questions.find((result) => result.id === "q8-telegram-bot")?.layer2?.model).toBe(
      "test-model",
    );
    expect(formatSummary(record, QUESTIONS)).toContain("Layer 2:");
  });
});
