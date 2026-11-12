import type { AdapterContext, DecisionQuestion } from "@rakazo/adapter-kit";
import type { ConfiguredDecision } from "./configured-decision.js";

const MAX_QUESTIONS = 20;

/**
 * Runs the `decide` builtin tool against the deployment's decision provider.
 * The bot names each question and the options to choose between; the provider
 * answers every question with a choice and a calibrated confidence.
 */
export async function decisionFromTool(
  decisions: ConfiguredDecision,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const state = parseState(args.state);
  if (state === undefined) return { error: "state is required" };
  const questions = parseQuestions(args.questions);
  if ("error" in questions) return questions;
  try {
    const result = await decisions.provider.decide(
      { model: decisions.model, state, questions: questions.record },
      context,
    );
    return { model: result.model, answers: result.answers };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A text state is wrapped so the provider always receives a JSON object. */
function parseState(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string" && raw.trim()) return { text: raw };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return undefined;
}

function parseQuestions(
  raw: unknown,
): { record: Record<string, DecisionQuestion> } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "questions are required" };
  if (raw.length > MAX_QUESTIONS) return { error: `at most ${MAX_QUESTIONS} questions per call` };
  const record: Record<string, DecisionQuestion> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "each question must be an object" };
    const { name, question, options } = item as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return { error: "each question needs a name" };
    if (Object.hasOwn(record, name)) return { error: `duplicate question name "${name}"` };
    if (typeof question !== "string" || !question.trim())
      return { error: `question "${name}" needs wording` };
    const criteria = parseCriteria(options);
    if (!criteria) return { error: `question "${name}" needs at least two options` };
    record[name] = { type: "choice", instructions: question, criteria };
  }
  return { record };
}

/** Options are plain labels, or { label, description } pairs that explain each label. */
function parseCriteria(raw: unknown): Record<string, string> | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined;
  const criteria: Record<string, string> = {};
  for (const option of raw) {
    if (typeof option === "string" && option.trim()) {
      criteria[option] = option;
    } else if (option && typeof option === "object") {
      const { label, description } = option as Record<string, unknown>;
      if (typeof label !== "string" || !label.trim()) return undefined;
      criteria[label] = typeof description === "string" && description.trim() ? description : label;
    } else {
      return undefined;
    }
  }
  return Object.keys(criteria).length >= 2 ? criteria : undefined;
}
