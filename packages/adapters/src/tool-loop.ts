import { createHash } from "node:crypto";
import type { ToolCallStreak } from "@rakazo/core";
import { trackToolCallStreak } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { toolResultError } from "./tool-result-error.js";

const LOOP_GUARD_STOP_PREFIX = "I got stuck calling ";
const LOOP_GUARD_STOP_COUNT_PATTERN = " with (?:(?:nearly )?the same input|too many actions) ";
const LOOP_GUARD_STOP_SUFFIX =
  " times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
// The windowed stop text says "times" without "in a row": its repeats are interleaved.
const LOOP_GUARD_STOP_PATTERN = new RegExp(
  `^${LOOP_GUARD_STOP_PREFIX}.+${LOOP_GUARD_STOP_COUNT_PATTERN}\\d+ times(?: in a row)? without making progress, so I stopped early\\. Try rephrasing this, or ask me to try a different approach\\.$`,
);

/** Whether the run stopped on one call repeated exactly, and the count its stop message gives. */
export function loopGuardStop(streak: ToolCallStreak): { identical: boolean; count: number } {
  // Short of the similar limit, only a repeated failure stops a run, and that is an identical one.
  const identical =
    streak.count >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS ||
    (streak.shapeCount ?? 0) < MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS;
  return { identical, count: identical ? streak.count : toolCallStreakLength(streak) };
}

export function loopGuardStopText(toolName: string, streak: ToolCallStreak): string {
  const { identical, count } = loopGuardStop(streak);
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with ${identical ? "" : "nearly "}the same input ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function overLimitStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with too many actions ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function windowedLoopGuardStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with the same input ${count} times without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.`;
}

export function isLoopGuardStopText(text: string): boolean {
  return LOOP_GUARD_STOP_PATTERN.test(text);
}

// Same tool, same arguments, failing this many times in a row means the agent is stuck.
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6;
// Arguments that differ only by digits in their text (`echo noop-1`, `echo noop-2`) can be a real
// sequence such as reading a file in chunks or paging through a site, so they get more room. So
// does an identical call that keeps succeeding with the same answer: it may be waiting on a page.
// Exported because the per-turn fuse's default must sit above it: a fuse lower than
// the loosest shape check would stop ordinary work before the loop guard could decide.
export const MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS = 25;
const FAILED_RESULT = "failed:";

// A batch over the action limit is refused unrun. Sending another one is a loop the model rarely
// leaves on its own, so it is told on the repeat and the run ends on this one.
export const MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS = 4;
/** The most actions one `computer_act` or `browser_act` call may carry. */
export const MAX_ACTIONS_PER_CALL = 24;

/** A double click expands to two computer actions; every other action stays as one. */
export function computerActionCount(action: unknown): number {
  if (!action || typeof action !== "object") return 1;
  const { kind, double } = action as { kind?: unknown; double?: unknown };
  return kind === "click" && double === true ? 2 : 1;
}

/** Counts consecutive over-limit `computer_act`/`browser_act` batches; other calls leave it alone. */
export function advanceOverLimitActionCalls(count: number, name: string, args: unknown): number {
  if (name !== "computer_act" && name !== "browser_act") return count;
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return 0;
  const actionCount =
    name === "computer_act"
      ? actions.reduce((total, action) => total + computerActionCount(action), 0)
      : actions.length;
  return actionCount > MAX_ACTIONS_PER_CALL ? count + 1 : 0;
}

/** The longer of the two runs, for the stop message. */
export function toolCallStreakLength(streak: ToolCallStreak): number {
  return Math.max(streak.count, streak.shapeCount ?? 0);
}

/**
 * `executionId` and `response` are the streak's last call and the model response that made it;
 * `results` are the distinct answers this identical run has had, up to the similar limit, and
 * `failures` how many answers in a row failed.
 */
export type LoopGuardStreak = ToolCallStreak & {
  executionId?: string;
  response?: number;
  results?: string[];
  failures?: number;
};

/**
 * What the model saw: content rather than details, which can carry timings. Failures are marked
 * so a repeat of one stops sooner.
 */
export function toolResultFingerprint(result: unknown, error?: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  // Screen results compare by frame: their text carries the capture time.
  const frameId = (record.details as { frameId?: unknown } | undefined)?.frameId;
  const seen =
    error !== undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : typeof frameId === "string"
        ? frameId
        : "content" in record
          ? record.content
          : result;
  const failed = error !== undefined || toolResultError(result) !== undefined;
  return `${failed ? FAILED_RESULT : ""}${createHash("sha256")
    .update(JSON.stringify(seen) ?? "")
    .digest("hex")}`;
}

/**
 * `previousResult` is the fingerprint of the streak's last call, once it has finished. A repeat
 * whose last answer is new to the run is polling something that changes, so the identical run
 * starts over from that call; answers it has seen before (a blinking cursor) keep counting. A
 * repeat stops early only when its answers keep failing. Matching calls from one model response
 * are one step, so they return the streak unchanged.
 */
/** Preserve JSON's optional-field handling, then compare objects independently of field order. */
function canonicalToolArgs(args: unknown): unknown {
  const serialized = JSON.stringify(args);
  return serialized === undefined ? undefined : JSON.parse(stableJsonValue(JSON.parse(serialized)));
}

export function advanceToolCallLoopGuard(
  streak: LoopGuardStreak,
  name: string,
  args: unknown,
  previousResult?: string,
  response?: number,
): { streak: LoopGuardStreak; stuck: boolean } {
  const canonicalArgs = canonicalToolArgs(args);
  let next = trackToolCallStreak(streak, name, canonicalArgs);
  if (response !== undefined && response === streak.response && next.shape === streak.shape)
    return { streak, stuck: false };
  const same = next.key === streak.key;
  const seen = (same && streak.results) || [];
  const fresh = previousResult !== undefined && !seen.includes(previousResult);
  const restart = same && fresh && seen.length > 0;
  if (restart)
    next = trackToolCallStreak({ ...streak, count: 1, shapeCount: 1 }, name, canonicalArgs);
  const results = fresh
    ? [...seen, previousResult].slice(-MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS)
    : seen;
  const failures =
    same && previousResult?.startsWith(FAILED_RESULT)
      ? (restart ? 0 : (streak.failures ?? 0)) + 1
      : 0;
  return {
    streak: { ...next, response, ...(same ? { results, failures } : {}) },
    // The first call has no answer yet, so six identical failing calls have five failures.
    stuck:
      failures >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS - 1 ||
      (next.shapeCount ?? 0) >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS,
  };
}

// The streak guard only sees consecutive repeats, so an A/B/A/B cycle of two alternating
// calls escapes it. The window keeps the run's last calls so a repeat interleaved with
// other calls is caught too. Only interleaved recurrences count toward the windowed
// stop: a run of identical calls in a row stays the streak guard's call to make, with
// its own calibrated limits (a successful repeat may be waiting on something).
export const TOOL_CALL_WINDOW_SIZE = 32;
export const MAX_WINDOWED_REPEATED_TOOL_CALLS = 8;

export interface ToolCallWindowEntry {
  /** `tool:argsHash` — the call's identity, hashed from the canonical args. */
  key: string;
  /** The same identity with digits in text arguments blanked, like the streak's shape. */
  shapeKey: string;
  /** sha256 hex of the canonical args — the same hash tool events record as `argsHash`. */
  argsHash: string;
  executionId: string;
  /** The model response the call came from; matching calls in one response count once. */
  response?: number;
  /** The gate's read-only classification, set when the call is recorded. */
  readOnly: boolean;
  /** Fingerprint of the call's answer once it has finished; undefined until then. */
  result?: string;
}

function canonicalDigest(canonicalArgs: unknown): string {
  // Args are JSON-parsed before this, so the canonical form always exists; a call with
  // no arguments at all hashes the same placeholder its streak key would carry.
  const canonical = canonicalArgs === undefined ? "undefined" : stableJsonValue(canonicalArgs);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A call's window identity: tool name plus the canonical-args hash tool events record. */
export function toolCallWindowKeys(
  name: string,
  args: unknown,
): { key: string; shapeKey: string; argsHash: string } {
  const canonicalArgs = canonicalToolArgs(args);
  const argsHash = canonicalDigest(canonicalArgs);
  const shapeArgs =
    canonicalArgs === undefined
      ? undefined
      : (JSON.parse(
          JSON.stringify(canonicalArgs, (_, value: unknown) =>
            typeof value === "string" ? value.replace(/\d+/g, "#") : value,
          ),
        ) as unknown);
  return {
    key: `${name}:${argsHash}`,
    shapeKey: `${name}:${canonicalDigest(shapeArgs)}`,
    argsHash,
  };
}

/** Fills in the answers of window entries whose calls have finished since they were recorded. */
export function settleToolCallWindow(
  window: ToolCallWindowEntry[],
  results: ReadonlyMap<string, string>,
): void {
  for (const entry of window) {
    if (entry.result === undefined) {
      const result = results.get(entry.executionId);
      if (result !== undefined) entry.result = result;
    }
  }
}

const windowEntryFailed = (entry: ToolCallWindowEntry): boolean =>
  entry.result?.startsWith(FAILED_RESULT) === true;
const windowEntrySucceeded = (entry: ToolCallWindowEntry): boolean =>
  entry.result !== undefined && !windowEntryFailed(entry);

/**
 * The interleaved recurrences of the newest call's key, back to the last progress in the
 * window. Progress is a settled call that changed state — approximated, as in the gate,
 * by a successful call that is not read-only — or the newest call's own answer changing
 * since its previous occurrence: polling something that changes is not a loop.
 */
function windowedRepeat(window: readonly ToolCallWindowEntry[]): {
  count: number;
  failures: number;
} {
  const current = window.at(-1);
  if (!current) return { count: 0, failures: 0 };
  let spanStart = 0;
  let previousOccurrence: ToolCallWindowEntry | undefined;
  for (const [index, entry] of window.entries()) {
    if (windowEntrySucceeded(entry) && !entry.readOnly && entry !== current) {
      spanStart = index + 1;
      previousOccurrence = undefined;
    }
    if (entry.key !== current.key) continue;
    if (
      previousOccurrence &&
      windowEntrySucceeded(previousOccurrence) &&
      windowEntrySucceeded(entry) &&
      previousOccurrence.result !== entry.result
    ) {
      spanStart = index;
      previousOccurrence = undefined;
    }
    if (index >= spanStart) previousOccurrence = entry;
  }
  let count = 0;
  let failures = 0;
  for (const [index, entry] of window.entries()) {
    if (index < spanStart || entry.key !== current.key) continue;
    // A recurrence is a call whose predecessor in the window is a different call; the
    // first entry has none, so it counts. Consecutive repeats are the streak's domain.
    if (index > 0 && window[index - 1]?.key === current.key) continue;
    count += 1;
    if (windowEntryFailed(entry)) failures += 1;
  }
  return { count, failures };
}

/**
 * Records one call in the window and reports whether it is the
 * MAX_WINDOWED_REPEATED_TOOL_CALLS-th interleaved recurrence of its key since the last
 * progress. Entries settle through settleToolCallWindow as their answers land.
 */
export function advanceToolCallWindow(
  window: readonly ToolCallWindowEntry[],
  name: string,
  args: unknown,
  call: { executionId: string; response?: number; readOnly: boolean },
): {
  window: ToolCallWindowEntry[];
  stuck: boolean;
  count: number;
  failures: number;
  argsHash: string;
} {
  const keys = toolCallWindowKeys(name, args);
  const last = window.at(-1);
  // Matching calls from one model response are one step, as for the streak guard.
  if (
    call.response !== undefined &&
    last &&
    call.response === last.response &&
    keys.key === last.key
  ) {
    return { window: [...window], stuck: false, count: 0, failures: 0, argsHash: keys.argsHash };
  }
  const entry: ToolCallWindowEntry = {
    ...keys,
    executionId: call.executionId,
    ...(call.response !== undefined ? { response: call.response } : {}),
    readOnly: call.readOnly,
  };
  const next = [...window.slice(-(TOOL_CALL_WINDOW_SIZE - 1)), entry];
  const { count, failures } = windowedRepeat(next);
  return {
    window: next,
    stuck: count >= MAX_WINDOWED_REPEATED_TOOL_CALLS,
    count,
    failures,
    argsHash: keys.argsHash,
  };
}
