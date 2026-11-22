import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

/**
 * Keep mid-turn progress beats short; prefer a few high-signal updates. Mid-turn
 * narration always uses this cap; message_user uses messageUserMaxLength().
 */
export const USER_PROGRESS_MESSAGE_MAX_LENGTH = 500;

/** Durable interim chat messages wait until a turn is genuinely long. */
export const MID_TURN_PROGRESS_MIN_TURN_AGE_MS = 60_000;

/** A note shown as the working line instead of a message is cut to this length. */
export const NARRATION_STATUS_MAX_LENGTH = 60;

/** One short line for the working indicator: whitespace collapsed, cut with "…". */
export function narrationStatusLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= NARRATION_STATUS_MAX_LENGTH
    ? line
    : `${line.slice(0, NARRATION_STATUS_MAX_LENGTH).trimEnd()}…`;
}

/**
 * A step that runs this long without finishing is indistinguishable from a hang: the thread
 * shows the same working line the whole time. Past it the run says what it is still doing.
 */
export const PROGRESS_HEARTBEAT_AFTER_MS = 2 * 60_000;

/** Once beats start they repeat on this gap, so a long step keeps reporting without flooding. */
export const PROGRESS_HEARTBEAT_EVERY_MS = 5 * 60_000;

/**
 * The working line for a step that has outrun `PROGRESS_HEARTBEAT_AFTER_MS`: what is running and
 * how long it has been. Undefined while the step is young enough that the ordinary working line
 * is honest, and when nothing is running at all (a model call with no tool in flight still gets
 * a beat from the caller's own silence, with no activity text).
 *
 * `elapsedMs` is the age of the step, not of the run: a run that spent ten minutes on earlier
 * steps does not report a step that started a moment ago.
 */
export function progressHeartbeatLine(
  activity: string | undefined,
  elapsedMs: number,
): string | undefined {
  if (!activity || elapsedMs < PROGRESS_HEARTBEAT_AFTER_MS) return undefined;
  return narrationStatusLine(`${activity} · ${formatElapsed(elapsedMs)}`);
}

/** "3m 20s" — long steps are read in minutes, so no tenths below them. */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Whether a step that has been running for `elapsedMs` owes a beat now, given when the last one
 * went out. `lastBeatElapsedMs` is the step's age when the previous beat was sent, or undefined
 * when none has. The first beat is due at `PROGRESS_HEARTBEAT_AFTER_MS`; later ones are spaced
 * `PROGRESS_HEARTBEAT_EVERY_MS` apart, so a long step keeps reporting without flooding.
 */
export function progressHeartbeatDue(
  elapsedMs: number,
  lastBeatElapsedMs: number | undefined,
): boolean {
  if (elapsedMs < PROGRESS_HEARTBEAT_AFTER_MS) return false;
  if (lastBeatElapsedMs === undefined) return true;
  return elapsedMs - lastBeatElapsedMs >= PROGRESS_HEARTBEAT_EVERY_MS;
}

/**
 * How a message the person sends while the bot works reaches the model: it knows the message
 * came mid-task. The answer goes through message_user, because a plain-text answer ends the
 * turn and the task with it; without that tool it is only asked to take the message into account.
 */
export function midTaskMessagePrompt(text: string, canMessageUser: boolean): string {
  const next = canMessageUser
    ? "If it asks something or changes the plan, answer briefly with message_user, then continue the task."
    : "Take it into account and continue the task.";
  return `The person sent this while you were working:\n\n${text}\n\n${next}`;
}

const MID_TASK_SOURCES = {
  member: "another member of this chat",
  messaging: "a connected chat",
  webhook: "a webhook",
} as const;

/** A message from anyone else arrives labelled with where it came from, with no call to reply. */
export function midTaskMessageFromPrompt(
  text: string,
  origin: keyof typeof MID_TASK_SOURCES | undefined,
): string {
  return `A message arrived from ${MID_TASK_SOURCES[origin ?? "member"]} while you were working:\n\n${text}`;
}

/** A mid-task message from the run's person restarts the interim budget at most this often. */
export const STEERING_RESETS_MAX_PER_RUN = 3;
export const STEERING_RESET_MIN_GAP_MS = 60_000;

/** Cap on durable interim chat messages (message_user + promoted narration) per run. */
export const MID_TURN_PROGRESS_MAX_PER_RUN = 3;

/**
 * Whether the run may post another durable interim chat message right now.
 * Short turns stay silent in durable chat; long turns keep a few replyable
 * beats without flooding the thread.
 */
export function midTurnProgressBudgetAllows(publishedCount: number, turnAgeMs: number): boolean {
  return (
    !midTurnProgressBudgetUsed(publishedCount) && turnAgeMs >= MID_TURN_PROGRESS_MIN_TURN_AGE_MS
  );
}

/** Whether the run has posted every durable interim message it may, however long it runs. */
export function midTurnProgressBudgetUsed(publishedCount: number): boolean {
  return publishedCount >= MID_TURN_PROGRESS_MAX_PER_RUN;
}

/**
 * The message_user cap: `RAKAZO_MESSAGE_USER_MAX_CHARS` when it is a positive integer,
 * else USER_PROGRESS_MESSAGE_MAX_LENGTH.
 */
export function messageUserMaxLength(): number {
  const value = process.env.RAKAZO_MESSAGE_USER_MAX_CHARS?.trim();
  if (!value || !/^\d+$/.test(value)) return USER_PROGRESS_MESSAGE_MAX_LENGTH;
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : USER_PROGRESS_MESSAGE_MAX_LENGTH;
}

export function clampUserProgressMessage(
  text: string,
  maxLength = USER_PROGRESS_MESSAGE_MAX_LENGTH,
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * True when the raw text a caller tried to post as a mid-turn progress update
 * would not fit and got cut off by clampUserProgressMessage. Callers should
 * surface this back to the model (it gets no other signal that its message
 * was mangled) rather than reporting a silent success.
 */
export function isProgressMessageTruncated(
  text: string,
  maxLength = USER_PROGRESS_MESSAGE_MAX_LENGTH,
): boolean {
  return text.trim().length > maxLength;
}

/**
 * Text to put between the text of two assistant turns that end up in one reply,
 * so they do not run together ("…/drafts/42Nothing has changed…").
 * Empty when there is no earlier text or either side already has whitespace.
 */
export function assistantTurnSeparator(previous: string, next: string): string {
  if (!previous || !next) return "";
  if (/\s$/.test(previous) || /^\s/.test(next)) return "";
  return "\n\n";
}

/** clientNonce prefix for mid-turn progress messages (reconciler uses this). */
export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function userProgressClientNonce(runId: string, index = 0): string {
  // Include entropy so a resumed executor turn cannot reuse an earlier nonce
  // (threadId + clientNonce is unique).
  return `${USER_PROGRESS_CLIENT_NONCE_PREFIX}${runId}:${index}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

export function extractNarrationText(
  segments: readonly MessageBlock[],
  currentText: string,
): { text: string; remaining: MessageBlock[] } {
  const parts: string[] = [];
  const remaining: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    remaining.push(block);
  }
  if (currentText) parts.push(currentText);
  return { text: parts.join(""), remaining };
}

/**
 * After mid-turn progress messages were already posted, skip a hollow final
 * message that would only carry hidden tool-activity blocks (or nothing).
 */
export function finalBlocksAfterMidTurnProgress(
  blocks: MessageBlock[],
  publishedMidTurn: boolean,
): MessageBlock[] {
  if (!publishedMidTurn || blocks.length === 0) return blocks;
  if (blocks.every((block) => isToolActivityBlock(block))) return [];
  return blocks;
}

/** Outcome to return for a bot_message run after mid-turn progress posts. */
export function botMessageOutcomeFromMidTurn(
  finalText: string,
  midTurnTexts: readonly string[],
): { text: string; intent: "result" | "status" } | null {
  const trimmed = finalText.trim();
  if (trimmed) return { text: trimmed, intent: "result" };
  const midTurn = midTurnTexts.map((part) => part.trim()).filter(Boolean);
  if (midTurn.length === 0) return null;
  return { text: midTurn.join("\n\n"), intent: "status" };
}
