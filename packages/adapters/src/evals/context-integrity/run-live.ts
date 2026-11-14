import type { EvalCase } from "./fixtures.js";
import { gradeAnswer } from "./grading.js";
import type { CaseResult, EvalRunRecord } from "./results.js";
import { summarize } from "./results.js";

/**
 * The live side of the harness, injected by the driver script. One instance
 * talks to one scratch bot on a real deployment path (real executor, real
 * model). `reset` starts a fresh thread; `stage` then replays the case's
 * setup into that thread — the seeded history through the app's own message
 * path, and the scratch state arranged so the bot's real tool calls return
 * the case's results (a scratch space holding exactly the fixture wallet,
 * a search provider stubbed to fail, and so on) — and `ask` sends the
 * case's question as the next user message. Staging is the operator
 * module's half of the protocol; the fixtures and grading never change
 * between Layer 1 and Layer 2.
 */
export type ScenarioAnswerer = {
  /** The model the answers came from, recorded per case (e.g. the production choice). */
  model: string;
  reset(): Promise<void>;
  stage(evalCase: EvalCase): Promise<void>;
  ask(question: string): Promise<string>;
};

const EXCERPT_CHARS = 280;

/**
 * Layer 2: stage every case, put its question to the bot, grade each reply
 * against the case's answer key, and merge the verdicts into the Layer 1
 * results (when given) as one run record. Building the record is all this
 * function does — the driver script owns the answerer and writes the file.
 */
export async function runLiveEval(input: {
  answerer: ScenarioAnswerer;
  cases: readonly EvalCase[];
  layer1Results?: readonly CaseResult[];
  gitSha: string;
  date: string;
}): Promise<EvalRunRecord> {
  const layer1ById = new Map(
    (input.layer1Results ?? []).map((result) => [result.id, result.layer1]),
  );
  const results: CaseResult[] = [];
  for (const evalCase of input.cases) {
    await input.answerer.reset();
    await input.answerer.stage(evalCase);
    const answer = await input.answerer.ask(evalCase.question);
    results.push({
      id: evalCase.id,
      layer1: layer1ById.get(evalCase.id) ?? {
        truthInContext: false,
        falsehoodInContext: false,
        truthAfterFalsehood: false,
        contextBytes: 0,
      },
      layer2: {
        verdict: gradeAnswer(evalCase, answer),
        answerExcerpt: answer.slice(0, EXCERPT_CHARS),
        model: input.answerer.model,
      },
    });
  }
  return {
    gitSha: input.gitSha,
    mode: input.layer1Results ? "layer1+layer2" : "layer2",
    corpus: "fixture",
    date: input.date,
    cases: results,
    summary: summarize(results, input.cases),
  };
}
