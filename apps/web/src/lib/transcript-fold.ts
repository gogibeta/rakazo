import type { ThreadMessage } from "@rakazo/contracts";

/**
 * How much text a transcript block may show before it starts folded.
 *
 * A bot that dumps a browser snapshot or a search result into a reply makes the page parse
 * and lay out thousands of nodes for a message nobody reads in full — that is what freezes a
 * long thread, not the number of messages. Short replies never reach the threshold.
 */
export const COLLAPSE_AFTER_CHARS = 1_200;

/** How much of a folded block stays visible, so the reader can tell what it is. */
export const COLLAPSED_PREVIEW_CHARS = 400;

/** Whether a block's text is long enough to start folded. */
export function collapsesByDefault(text: string): boolean {
  return text.length > COLLAPSE_AFTER_CHARS;
}

/** Total characters of message text: the measure a thread's weight is judged by. */
export function transcriptTextChars(messages: readonly ThreadMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "text" || block.kind === "progress") total += block.text.length;
    }
  }
  return total;
}
