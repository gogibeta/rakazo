import type { EvalQuestion } from "./fixtures.js";
import { gradeAnswer } from "./grading.js";
import type { EvalRunRecord, QuestionResult } from "./results.js";
import { summarize } from "./results.js";

/**
 * The live side of the harness, injected by the driver script. One instance
 * talks to one scratch bot on a real deployment path (real executor, real
 * model); `reset` starts a fresh session so each question is answered from
 * durable memory alone, never from an earlier question's conversation.
 */
export type LiveAnswerer = {
  /** The model the answers came from, recorded per question (e.g. the production choice). */
  model: string;
  reset(): Promise<void>;
  ask(question: string): Promise<string>;
};

const EXCERPT_CHARS = 280;

/**
 * Layer 2: put every question to the bot, grade each reply against the
 * answer key, and merge the verdicts into the Layer 1 results (when given)
 * as one run record. Building the record is all this function does — the
 * driver script owns the answerer and writes the file.
 */
export async function runLiveEval(input: {
  answerer: LiveAnswerer;
  questions: readonly EvalQuestion[];
  layer1Results?: readonly QuestionResult[];
  corpus: EvalRunRecord["corpus"];
  gitSha: string;
  date: string;
}): Promise<EvalRunRecord> {
  const layer1ById = new Map(
    (input.layer1Results ?? []).map((result) => [result.id, result.layer1]),
  );
  const results: QuestionResult[] = [];
  for (const question of input.questions) {
    await input.answerer.reset();
    const answer = await input.answerer.ask(question.question);
    results.push({
      id: question.id,
      layer1: layer1ById.get(question.id) ?? {
        factInContext: false,
        includedDocs: [],
        omittedDocs: [],
        usedBytes: 0,
      },
      layer2: {
        verdict: gradeAnswer(question, answer),
        answerExcerpt: answer.slice(0, EXCERPT_CHARS),
        model: input.answerer.model,
      },
    });
  }
  return {
    gitSha: input.gitSha,
    mode: input.layer1Results ? "layer1+layer2" : "layer2",
    corpus: input.corpus,
    date: input.date,
    questions: results,
    summary: summarize(results, input.questions),
  };
}
