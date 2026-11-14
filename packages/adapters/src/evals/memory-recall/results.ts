import type { EvalQuestion } from "./fixtures.js";
import type { Verdict } from "./grading.js";

/** One run's results file: a header plus one entry per question. */
export type EvalRunRecord = {
  gitSha: string;
  mode: "layer1" | "layer2" | "layer1+layer2";
  corpus: "fixture" | "production";
  date: string;
  questions: QuestionResult[];
  summary: EvalSummary;
};

export type QuestionResult = {
  id: string;
  layer1: {
    factInContext: boolean;
    includedDocs: string[];
    omittedDocs: string[];
    usedBytes: number;
  };
  layer2?: {
    verdict: Verdict;
    answerExcerpt: string;
    model: string;
  };
};

export type EvalSummary = {
  layer1: {
    /** Scored questions whose fact reached the assembled context. */
    factsPresent: number;
    factsAbsent: number;
    /** Control questions with no answerable fact in context (the healthy outcome). */
    controlsClean: number;
    /** Control questions whose would-be fact strings appear in context (leakage). */
    controlsLeaking: number;
  };
  layer2?: {
    pass: number;
    fail: number;
    fabricated: number;
  };
};

export function summarize(
  results: readonly QuestionResult[],
  questions: readonly EvalQuestion[],
): EvalSummary {
  const kindById = new Map(questions.map((question) => [question.id, question.kind]));
  const summary: EvalSummary = {
    layer1: { factsPresent: 0, factsAbsent: 0, controlsClean: 0, controlsLeaking: 0 },
  };
  let layer2: EvalSummary["layer2"];
  for (const result of results) {
    if (kindById.get(result.id) === "control") {
      if (result.layer1.factInContext) summary.layer1.controlsLeaking += 1;
      else summary.layer1.controlsClean += 1;
    } else if (result.layer1.factInContext) {
      summary.layer1.factsPresent += 1;
    } else {
      summary.layer1.factsAbsent += 1;
    }
    if (result.layer2) {
      layer2 ??= { pass: 0, fail: 0, fabricated: 0 };
      layer2[result.layer2.verdict] += 1;
    }
  }
  if (layer2) summary.layer2 = layer2;
  return summary;
}

/** Renders the summary table the chat report quotes: one row per question plus counts. */
export function formatSummary(record: EvalRunRecord, questions: readonly EvalQuestion[]): string {
  const factById = new Map(questions.map((question) => [question.id, question.fact]));
  const lines = [
    `memory-recall eval — corpus=${record.corpus} mode=${record.mode} gitSha=${record.gitSha} date=${record.date}`,
    "",
    "| question | layer1 fact in context | layer2 verdict |",
    "| --- | --- | --- |",
  ];
  for (const result of record.questions) {
    const fact = factById.get(result.id);
    const layer1 = result.layer1.factInContext ? "yes" : "no";
    const layer2 = result.layer2 ? result.layer2.verdict : "—";
    lines.push(`| ${result.id}${fact ? ` (${fact})` : ""} | ${layer1} | ${layer2} |`);
  }
  const { layer1, layer2 } = record.summary;
  lines.push(
    "",
    `Layer 1: ${layer1.factsPresent} facts present, ${layer1.factsAbsent} absent, ` +
      `${layer1.controlsClean} controls clean, ${layer1.controlsLeaking} controls leaking.`,
  );
  if (layer2)
    lines.push(
      `Layer 2: ${layer2.pass} pass, ${layer2.fail} fail, ${layer2.fabricated} fabricated.`,
    );
  return lines.join("\n");
}
