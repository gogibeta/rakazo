import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Button } from "@rakazo/ui-web";
import { memo, useCallback, useState } from "react";
import { COLLAPSED_PREVIEW_CHARS, collapsesByDefault } from "../../lib/transcript-fold";

/**
 * The head of a long block, cut at a line boundary so a folded block does not end mid-word
 * and an open code fence is left for the renderer to close. `…` marks it as cut.
 */
export function foldedPreview(text: string): string {
  if (text.length <= COLLAPSED_PREVIEW_CHARS) return text;
  const slice = text.slice(0, COLLAPSED_PREVIEW_CHARS);
  const line = slice.lastIndexOf("\n");
  // A very long single line (a JSON dump) has no boundary to keep: cut where the budget ends.
  const cut = line > COLLAPSED_PREVIEW_CHARS / 2 ? slice.slice(0, line) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * A long text block: the first stretch of it, and the rest behind a control.
 *
 * A bot that dumps a browser snapshot or a search result into its reply otherwise makes the
 * page parse and lay out thousands of nodes for a message nobody reads in full. Short replies
 * never reach the threshold and render exactly as before, with no control.
 *
 * The truncated text is not rendered at all rather than hidden with CSS: the point is to keep
 * the nodes out of the DOM. Find-in-page therefore cannot reach the folded part, which is the
 * trade for a thread that stays responsive; expanding restores the whole block, and the state
 * is per block so a re-render does not fold an expanded block again.
 */
export const LongTextBlock = memo(function LongTextBlock({
  text,
  renderMention,
  onOpenPage,
}: {
  text: string;
  renderMention?: Parameters<typeof ChatMarkdown>[0]["renderMention"];
  onOpenPage?: Parameters<typeof ChatMarkdown>[0]["onOpenPage"];
}) {
  const [expanded, setExpanded] = useState(false);
  const foldable = collapsesByDefault(text);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const shown = foldable && !expanded ? foldedPreview(text) : text;
  return (
    <>
      <ChatMarkdown renderMention={renderMention} onOpenPage={onOpenPage}>
        {shown}
      </ChatMarkdown>
      {foldable ? (
        <Button
          variant="text"
          size="xs"
          aria-expanded={expanded}
          data-testid="long-text-toggle"
          onClick={toggle}
          className="mt-1 font-normal text-muted-foreground"
        >
          {expanded ? <Trans>Show less</Trans> : <Trans>Show full output</Trans>}
        </Button>
      ) : null}
    </>
  );
});
