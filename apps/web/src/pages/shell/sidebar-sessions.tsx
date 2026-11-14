import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadSession } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { Archive, ArchiveRestore, Check, Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import type { createSpaceRpc } from "../../lib/rpc";

/**
 * The open bot's conversations, under the roster: every session of the bot,
 * most recent first, with the archived ones folded away at the bottom. The
 * primary session is the chat itself and cannot be archived; the rest open
 * alongside it.
 */
export function SidebarSessions({
  rpc,
  botId,
  botName,
  sessionId,
  onSelect,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  botId: string;
  botName: string;
  /** The open session's thread id; undefined while the primary session is open. */
  sessionId: string | undefined;
  onSelect: (threadId: string | null) => void;
}) {
  const { t } = useLingui();
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  // Loaded imperatively, like the archived-chats shelf: a query subscription
  // would cancel its fetch when the sidebar unmounts on a bot switch, and a
  // cancelled request reads as a failed one.
  const load = useCallback(async () => {
    try {
      setSessions(await rpc.threads.listSessions({ botId }));
    } catch {
      // Keep the last list; a failed refresh is not fatal.
    }
  }, [rpc, botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = async () => {
    const created = await rpc.threads.createSession({ botId });
    void load();
    if (created.threadId) onSelect(created.threadId);
  };

  const saveTitle = async (session: ThreadSession) => {
    const title = draftTitle.trim();
    setEditingId(null);
    if (!title || title === session.title) return;
    await rpc.threads.renameSession({ botId, threadId: session.id, title });
    void load();
  };

  const setArchived = async (session: ThreadSession, archived: boolean) => {
    if (archived) await rpc.threads.archiveSession({ botId, threadId: session.id });
    else await rpc.threads.unarchiveSession({ botId, threadId: session.id });
    void load();
    // Archiving the open session returns to the primary one.
    if (archived && sessionId === session.id) onSelect(null);
  };

  const row = (session: ThreadSession) => {
    const isOpen = session.isPrimary ? sessionId === undefined : sessionId === session.id;
    const title = session.title ?? botName;
    return (
      <div
        key={session.id}
        className={`group/session flex items-center gap-1 rounded-lg px-2.5 py-1.5 ${
          isOpen ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
        }`}
      >
        {editingId === session.id ? (
          <>
            <input
              className="min-w-0 flex-1 bg-transparent text-body outline-none"
              value={draftTitle}
              // biome-ignore lint/a11y/noAutofocus: the field appears because Rename was chosen.
              autoFocus
              aria-label={t`Conversation name`}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveTitle(session);
                if (event.key === "Escape") setEditingId(null);
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              aria-label={t`Save name`}
              onClick={() => void saveTitle(session)}
            >
              <Check />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t`Cancel`}
              onClick={() => setEditingId(null)}
            >
              <X />
            </Button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              aria-label={t`Conversation: ${title}`}
              onClick={() => onSelect(session.isPrimary ? null : session.id)}
            >
              <span className="block truncate text-body text-foreground/75" dir="auto">
                {title}
              </span>
              <span className="block text-caption text-muted-foreground">
                {session.kind === "routine"
                  ? t`Routine`
                  : session.kind === "delegation"
                    ? t`Delegated`
                    : formatRelativeTime(session.lastMessageAt ?? session.createdAt)}
              </span>
            </button>
            <Button
              variant="ghost"
              size="xs"
              className="sr-only focus-visible:not-sr-only group-hover/session:not-sr-only"
              aria-label={t`Rename ${title}`}
              onClick={() => {
                setDraftTitle(session.title ?? "");
                setEditingId(session.id);
              }}
            >
              <Pencil />
            </Button>
            {session.archivedAt ? (
              <Button
                variant="ghost"
                size="xs"
                className="sr-only focus-visible:not-sr-only group-hover/session:not-sr-only"
                aria-label={t`Restore ${title}`}
                onClick={() => void setArchived(session, false)}
              >
                <ArchiveRestore />
              </Button>
            ) : session.isPrimary ? null : (
              <Button
                variant="ghost"
                size="xs"
                className="sr-only focus-visible:not-sr-only group-hover/session:not-sr-only"
                aria-label={t`Archive ${title}`}
                onClick={() => void setArchived(session, true)}
              >
                <Archive />
              </Button>
            )}
          </>
        )}
      </div>
    );
  };

  const live = sessions.filter((session) => !session.archivedAt);
  const archived = sessions.filter((session) => session.archivedAt);
  return (
    <div className="flex flex-col px-1 pt-2">
      <SectionHeading variant="label">
        <span className="flex w-full items-center justify-between px-2.5 py-1.5">
          <span>
            <Trans>Conversations</Trans>
          </span>
          <Button variant="ghost" size="xs" aria-label={t`New conversation`} onClick={startNew}>
            <Plus />
          </Button>
        </span>
      </SectionHeading>
      {live.map(row)}
      {archived.length > 0 ? (
        <>
          <button
            type="button"
            className="px-2.5 py-1.5 text-left text-caption text-muted-foreground hover:text-foreground"
            onClick={() => setShowArchived((current) => !current)}
          >
            {showArchived ? t`Hide archived` : t`Archived (${archived.length})`}
          </button>
          {showArchived ? archived.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
