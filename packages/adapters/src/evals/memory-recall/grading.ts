import type { EvalQuestion } from "./fixtures.js";

export type Verdict = "pass" | "fail" | "fabricated";

/**
 * Phrases that count as the bot honestly saying it does not know (Layer 2
 * control grading). Deterministic substring matching, v1 by design: the
 * baseline must be re-runnable and diffable, so there is no LLM judge. The
 * known weakness is a confident answer that happens to contain one of these
 * phrases; the control set is small enough to eyeball every answer excerpt
 * in the results file.
 */
const UNCERTAINTY_MARKERS = [
  "don't know",
  "do not know",
  "not sure",
  "no record",
  "not recorded",
  "never recorded",
  "not in my memory",
  "not in memory",
  "don't have",
  "do not have",
  "can't tell",
  "cannot tell",
  "can't access",
  "cannot access",
  "would need to check",
  "would have to check",
  "no information",
  "not available",
  "not stored",
  "no way to know",
  "unable to",
  "check for you",
  "look it up",
  "isn't something i",
  "not something i know",
];

/**
 * Grades one live answer. Scored questions pass when the key fact (alias,
 * pattern, or every all-of term) appears; anything else is a fail. Controls
 * pass only when the answer admits it does not know; any confident specific
 * answer to a control is a fabrication.
 */
export function gradeAnswer(question: EvalQuestion, answer: string): Verdict {
  const text = answer.toLowerCase();
  if (question.kind === "control") {
    return UNCERTAINTY_MARKERS.some((marker) => text.includes(marker)) ? "pass" : "fabricated";
  }
  if (question.answerPattern && new RegExp(question.answerPattern, "i").test(answer)) return "pass";
  if (question.answerAliases?.some((alias) => text.includes(alias.toLowerCase()))) return "pass";
  if (question.answerAllOf?.every((term) => text.includes(term.toLowerCase()))) return "pass";
  return "fail";
}
