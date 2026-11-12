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

/**
 * Slash commands for linked chats (`/bot`, `/new`, `/queue`, `/steer`,
 * `/model`, `/help`), parsed only at the very start of a message and only
 * for the linked owner — everything else is a normal message to the bot.
 * Deliberately separate from the YES/NO/LEAVE/STOP vocabulary above: those
 * are bare words a person types in reply, these are explicit commands, and
 * the two grammars never overlap (a slash command is never an owner
 * command word, and an owner command never starts with a slash).
 */
export type MessagingSlashCommand =
  | { name: "bot"; argument: string | null }
  | { name: "new" }
  | { name: "queue"; text: string }
  | { name: "steer"; text: string }
  | { name: "model"; argument: string | null }
  | { name: "help" };

const SLASH_COMMAND_PATTERN = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i;

export function parseMessagingSlashCommand(text: string): MessagingSlashCommand | null {
  const match = SLASH_COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const argument = match[2]?.trim() ? match[2].trim() : null;
  switch (name) {
    case "bot":
      return { name, argument };
    case "new":
      return { name };
    case "queue":
      return { name, text: argument ?? "" };
    case "steer":
      return { name, text: argument ?? "" };
    case "model":
      return { name, argument };
    case "help":
      return { name };
    default:
      return null;
  }
}

/** The command list chat platforms can register as a menu, and /help shows. */
export const MESSAGING_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "bot", description: "Switch the bot this chat talks to" },
  { name: "new", description: "Start a fresh conversation" },
  { name: "queue", description: "Queue a message for after the current run" },
  { name: "steer", description: "Steer the run in progress" },
  { name: "model", description: "Switch the model this bot uses" },
  { name: "help", description: "List the chat commands" },
];

export const MESSAGING_COMMANDS_HELP = [
  "Commands you can use here:",
  "/bot — switch the bot this chat talks to (or /bot <name>)",
  "/new — start a fresh conversation",
  "/queue <message> — queue a follow-up for after the current run",
  "/steer <message> — steer the run in progress",
  "/model — switch the model (or /model <id>)",
  "/help — show this list",
].join("\n");

/**
 * The action ids the /bot and /model picker cards carry. A bot picker's
 * value is the bot's own id (a tap is re-checked against the tapper's
 * bots, so a stale or foreign value switches nothing); a model picker's
 * value is the option's position in the connected-model list, recomputed
 * when the tap lands — positions keep every value a few bytes long, well
 * inside the tightest platform callback budget, however long a model id
 * runs. Neither id nor value shape can collide with the ask action or the
 * owner command words.
 */
export const MESSAGING_BOT_PICKER_ACTION_ID = "bot";
export const MESSAGING_MODEL_PICKER_ACTION_ID = "model";

export function parseMessagingBotPickerValue(value: string | undefined): string | null {
  if (!value || value.length > 64 || /[\s:]/.test(value)) return null;
  return value;
}

export function parseMessagingModelPickerValue(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null;
  return Number(value);
}
