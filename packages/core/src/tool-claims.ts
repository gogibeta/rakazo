import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { humanizeToolName } from "./events.js";

/**
 * Guards against a bot claiming it did something it never called a tool for.
 *
 * The failure this closes: every earlier bot message reaches the model as an
 * assistant turn, and a `steps` block is rendered by `toolStepsHistoryText` as
 * `[tool calls this reply made]` followed by lines like `- Web fetch (succeeded)`.
 * The model therefore sees the app's own step wording in its own history and, on
 * a weak provider, writes that wording itself — a reply announcing work with no
 * tool call behind it. See AGENTX-BUILDER-REVIEW-R3.md §3.10.
 *
 * The rule is structural, not a prose heuristic: a claim is only a claim when the
 * text names one of the app's own tools in one of the app's own step shapes. Open
 * prose is never matched, so honest speech is never touched, and a paraphrase that
 * does not name a tool is left to the instruction rule rather than guessed at.
 */

/** The closed set of names a step can show: every built-in tool, humanized. */
export const TOOL_STEP_LABELS: readonly string[] = BUILTIN_TOOL_NAMES.map(humanizeToolName);

/** Outcomes the app itself prints after a step label, in `toolStepOutcomeText`. */
const OUTCOME_WORDS = ["succeeded", "failed", "stopped"] as const;

/**
 * The outcome text the app prints inside the parentheses. Two shapes exist:
 * a single word (`succeeded`), and the counted form for mixed results
 * (`2 succeeded, 1 failed`). Both must be matched or the guard misses the exact
 * lines `toolStepsHistoryText` teaches the model.
 */
const OUTCOME_IN_PARENS = `(?:\\d+\\s+)?(?:${OUTCOME_WORDS.join("|")})(?:\\s*,\\s*(?:\\d+\\s+)?(?:${OUTCOME_WORDS.join("|")}))*`;

/**
 * A count the app prints between the label and its outcome: `Web fetch ×3 (succeeded)`.
 * The multiplication sign is the one `toolStepsHistoryText` uses; `x` is accepted too
 * because a model retyping the line often substitutes it.
 */
const STEP_COUNT = `(?:\\s*[×x]\\s*\\d+)?`;

/**
 * Words that flip a step-shaped phrase into an honest report of failure. A reply
 * that says "Web fetch failed" or "could not save the file" is telling the truth
 * about a failure; matching it would punish exactly the behaviour we want.
 */
const NEGATIONS = [
  "not",
  "n't",
  "cannot",
  "can't",
  "unable",
  "failed",
  "failure",
  "unsuccessful",
  "refused",
  "blocked",
  "denied",
  "rejected",
  "error",
  "errored",
  "timed out",
  "timeout",
] as const;

export type ToolClaim = {
  /** The humanized label that was claimed, e.g. "Web fetch". */
  label: string;
  /** The tool name it came from, e.g. "web_fetch". */
  toolName: string;
};

/**
 * Text with fenced and inline code removed: a reply quoting an example must not
 * be read as claiming it. Also strips blockquote markers, which a model uses
 * when it is reproducing history rather than reporting its own work.
 */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>[^\n]*$/gm, " ");
}

/**
 * Whether the sentence around `at` denies that the action happened.
 *
 * The step's own outcome text is removed first: `(2 succeeded, 1 failed)` is a result
 * count, not a denial, and its "failed" would otherwise protect a fabricated step.
 */
function isNegated(text: string, at: number, length: number): boolean {
  // Look at the sentence the label sits in: a negation in a neighbouring
  // sentence ("Nothing worked. Web fetch (succeeded)") belongs to the other one.
  const start = Math.max(0, text.lastIndexOf(".", at) + 1);
  const endAt = text.indexOf(".", at + length);
  const end = endAt === -1 ? text.length : endAt;
  const sentence = text
    .slice(start, end)
    .replace(new RegExp(`\\(\\s*${OUTCOME_IN_PARENS}\\s*\\)`, "gi"), " ")
    .toLowerCase();
  return NEGATIONS.some((word) => sentence.includes(word));
}

/**
 * Every tool the reply claims to have used, given what this run actually called.
 *
 * `claimed` is `label` matched in one of the app's own step shapes; `called` is the
 * set of humanized labels this run's tool events produced. A claim whose label never
 * ran is unsupported — the caller blocks the reply rather than shipping it.
 */
export function unsupportedToolClaims(text: string, calledLabels: Iterable<string>): ToolClaim[] {
  const called = new Set(calledLabels);
  const prose = proseOnly(text);
  const claims: { claim: ToolClaim; at: number }[] = [];
  for (const toolName of BUILTIN_TOOL_NAMES) {
    const label = humanizeToolName(toolName);
    // The app's step shape: the label followed by an outcome in parentheses, or
    // the label at the head of a list line, which is how `toolStepsHistoryText`
    // prints a step whose outcome was not recorded.
    const patterns = [
      new RegExp(
        `\\b${escapeRegex(label)}${STEP_COUNT}\\s*\\(\\s*${OUTCOME_IN_PARENS}\\s*\\)`,
        "i",
      ),
      new RegExp(`^\\s*[-*]\\s+${escapeRegex(label)}\\b`, "im"),
    ];
    const hits = patterns
      .map((pattern) => pattern.exec(prose))
      .filter((hit): hit is RegExpExecArray => hit !== null);
    if (hits.length === 0) continue;
    const at = Math.min(...hits.map((hit) => hit.index));
    const hit = hits.find((candidate) => candidate.index === at) as RegExpExecArray;
    if (isNegated(prose, hit.index, hit[0].length)) continue;
    if (called.has(label)) continue;
    claims.push({ claim: { label, toolName }, at });
  }
  // Report in the order the reply wrote them, so the retry text reads like its own reply.
  return claims.sort((left, right) => left.at - right.at).map(({ claim }) => claim);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the bot is told when its reply is held back. Names the tools it claimed and
 * points at the fix without accusing it of lying — a weak provider usually lost
 * track of the turn rather than deciding to deceive.
 */
export function unsupportedToolClaimText(claims: readonly ToolClaim[]): string {
  const names = claims.map((claim) => `\`${claim.label}\``).join(", ");
  return `This reply says ${names} happened, but no such tool call is in this run. A step line only appears when the tool actually ran. Answer again without claiming that work, or make the calls now.`;
}
