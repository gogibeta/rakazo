/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

/** "Stop" in each app language, so people can stop work in their own words. */
const STOP_WORDS = new Set([
  "STOP",
  "STOP NOW",
  // German
  "STOPP",
  "STOPP JETZT",
  // Spanish ("para" alone is too often just "for")
  "DETENTE",
  // Dutch
  "STOP NU",
  // Polish
  "ZATRZYMAJ",
  "PRZESTAŃ",
  // Russian
  "СТОП",
  "ОСТАНОВИСЬ",
  // Japanese
  "停止",
  "ストップ",
  "止めて",
  // Chinese
  "停下",
  // French
  "ARRÊTE",
  // Portuguese
  "PARE",
  // Korean
  "멈춰",
  "중지",
  // Turkish
  "DUR",
  // Hindi
  "रुको",
  // Hebrew
  "עצור",
  "תפסיק",
]);

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  const bare = normalized
    .replace(/\s+/g, " ")
    .replace(/^[¡¿]+/u, "")
    .replace(/[.!?…。！？।]+$/u, "")
    .trim();
  if (STOP_WORDS.has(bare)) return "stop";
  return null;
}

/**
 * The action id every ask-card button carries. A pending question's options
 * all share it; the value names the ask's message and the option's position
 * (`<messageId>:<index>`), so a tap is unambiguous, can never collide with
 * the owner command words above, and stays well inside the tightest
 * platform callback budget (a 25-char message id plus a short index).
 */
export const MESSAGING_ASK_ACTION_ID = "ask";

export function messagingAskActionValue(messageId: string, actionIndex: number): string {
  return `${messageId}:${actionIndex}`;
}

export function parseMessagingAskActionValue(
  value: string | undefined,
): { messageId: string; actionIndex: number } | null {
  if (!value) return null;
  const match = /^([^:]+):(\d{1,3})$/.exec(value);
  if (!match) return null;
  return { messageId: match[1]!, actionIndex: Number(match[2]) };
}
