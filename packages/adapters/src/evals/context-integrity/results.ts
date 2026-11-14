import type { EvalCase } from "./fixtures.js";
import type { Verdict } from "./grading.js";

/** One run's results file: a header plus one entry per case. */
export type EvalRunRecord = {
  gitSha: string;
  mode: "layer1" | "layer2" | "layer1+layer2";
  corpus: "fixture";
  date: string;
  cases: CaseResult[];
  summary: EvalSummary;
};

export type CaseResult = {
  id: string;
  layer1: {
    /** Every truth needle reached the assembled context. */
    truthInContext: boolean;
    /** The seeded falsehood reached the assembled context (false when the case seeds none). */
    falsehoodInContext: boolean;
    /** The truth's last occurrence follows the falsehood: the current run's tool result is the final word on it. */
    truthAfterFalsehood: boolean;
    contextBytes: number;
  };
  layer2?: {
    verdict: Verdict;
    answerExcerpt: string;
    model: string;
  };
};

export type EvalSummary = {
  layer1: {
    /** Cases whose assembly matches the fixture design (truth and falsehood presence as designed). */
    asDesigned: number;
    /** Cases whose assembly drifted from the design — a fact or falsehood the production path dropped or shortened away. */
    drifted: number;
  };
  layer2?: {
    pass: number;
    fail: number;
    fabricated: number;
  };
};

export function summarize(results: readonly CaseResult[], cases: readonly EvalCase[]): EvalSummary {
  const caseById = new Map(cases.map((entry) => [entry.id, entry]));
  const summary: EvalSummary = { layer1: { asDesigned: 0, drifted: 0 } };
  let layer2: EvalSummary["layer2"];
  for (const result of results) {
    const evalCase = caseById.get(result.id);
    if (
      evalCase &&
      result.layer1.truthInContext === evalCase.expect.truthInContext &&
      result.layer1.falsehoodInContext === evalCase.expect.falsehoodInContext
    ) {
      summary.layer1.asDesigned += 1;
    } else {
      summary.layer1.drifted += 1;
    }
    if (result.layer2) {
      layer2 ??= { pass: 0, fail: 0, fabricated: 0 };
      layer2[result.layer2.verdict] += 1;
    }
  }
  if (layer2) summary.layer2 = layer2;
  return summary;
}

/** Renders the summary table the chat report quotes: one row per case plus counts. */
export function formatSummary(record: EvalRunRecord, cases: readonly EvalCase[]): string {
  const kindById = new Map(cases.map((entry) => [entry.id, entry.kind]));
  const lines = [
    `context-integrity eval — corpus=${record.corpus} mode=${record.mode} gitSha=${record.gitSha} date=${record.date}`,
    "",
    "| case | kind | layer1 truth | layer1 falsehood | layer2 verdict |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const result of record.cases) {
    const layer2 = result.layer2 ? result.layer2.verdict : "—";
    lines.push(
      `| ${result.id} | ${kindById.get(result.id) ?? ""} | ${result.layer1.truthInContext ? "yes" : "no"} | ${result.layer1.falsehoodInContext ? "yes" : "no"} | ${layer2} |`,
    );
  }
  const { layer1, layer2 } = record.summary;
  lines.push(
    "",
    `Layer 1: ${layer1.asDesigned} cases assembled as designed, ${layer1.drifted} drifted.`,
  );
  if (layer2)
    lines.push(
      `Layer 2: ${layer2.pass} pass, ${layer2.fail} fail, ${layer2.fabricated} fabricated.`,
    );
  return lines.join("\n");
}
