import { recordAuditEvent } from "./audit-events.js";
import type { Prisma, PrismaClient } from "./client.js";

/**
 * Sessions. A Thread is a session: a bot may have many, exactly one of them
 * primary (the partial unique index threads_one_primary_per_bot enforces it).
 * Code that needs "the bot's thread" resolves the primary session through
 * these helpers — never through an unfiltered first match, which stops
 * meaning anything once a bot has more than one session.
 */

type ThreadRow = Prisma.ThreadGetPayload<object>;
type ThreadDb = Pick<PrismaClient, "thread">;
type ThreadTx = Pick<Prisma.TransactionClient, "thread">;

export type ThreadSessionKind =
  | "direct"
  | "group"
  | "helper"
  | "external"
  | "routine"
  | "delegation";

export type ThreadSessionOrigin =
  | "web"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "sendblue"
  | "lark"
  | "photon"
  | "routine"
  | "delegation"
  | "import";

/** The bot's primary session: where its DMs and default routing land. */
export async function getPrimaryThread(db: ThreadDb, botId: string): Promise<ThreadRow | null> {
  return db.thread.findFirst({ where: { botId, isPrimary: true } });
}

export interface CreateSessionInput {
  spaceId: string;
  userId: string;
  botId?: string;
  groupId?: string;
  kind: ThreadSessionKind;
  origin: ThreadSessionOrigin;
  title?: string;
  parentThreadId?: string;
  /**
   * Only bot creation passes this: a bot's first direct session is its
   * primary one. Later direct sessions are never primary.
   */
  primary?: boolean;
}

/** Insert a session with fresh sequence counters. */
export async function createSession(
  db: ThreadDb | ThreadTx,
  input: CreateSessionInput,
): Promise<ThreadRow> {
  return db.thread.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      kind: input.kind,
      origin: input.origin,
      title: input.title,
      parentThreadId: input.parentThreadId,
      isPrimary: input.primary ?? false,
    },
  });
}

/**
 * The session a messaging identity's DMs land in: its active session when it
 * still names a live session of the identity's bot, else the primary session
 * (and the identity is repaired to point at it). Routing wires this in F4;
 * until then nothing reads activeThreadId.
 */
export async function resolveMessagingSession(
  db: Pick<PrismaClient, "thread" | "messagingIdentity">,
  identity: { id: string; botId: string; activeThreadId: string | null },
): Promise<ThreadRow | null> {
  if (identity.activeThreadId) {
    const active = await db.thread.findFirst({
      where: { id: identity.activeThreadId, botId: identity.botId, archivedAt: null },
    });
    if (active) return active;
  }
  const primary = await getPrimaryThread(db, identity.botId);
  if (primary && primary.id !== identity.activeThreadId) {
    await db.messagingIdentity.update({
      where: { id: identity.id },
      data: { activeThreadId: primary.id },
    });
  }
  return primary;
}

/** Archive is a flag, never a delete: the session stays fully readable. */
export async function archiveSession(
  db: ThreadDb,
  input: { threadId: string; actorUserId: string },
): Promise<ThreadRow> {
  const thread = await db.thread.update({
    where: { id: input.threadId },
    data: { archivedAt: new Date() },
  });
  await recordAuditEvent({
    action: "session.archived",
    actor: { type: "user", id: input.actorUserId },
    spaceId: thread.spaceId,
    threadId: thread.id,
    target: { type: "thread", id: thread.id },
  });
  return thread;
}

export async function unarchiveSession(
  db: ThreadDb,
  input: { threadId: string; actorUserId: string },
): Promise<ThreadRow> {
  const thread = await db.thread.update({
    where: { id: input.threadId },
    data: { archivedAt: null },
  });
  await recordAuditEvent({
    action: "session.unarchived",
    actor: { type: "user", id: input.actorUserId },
    spaceId: thread.spaceId,
    threadId: thread.id,
    target: { type: "thread", id: thread.id },
  });
  return thread;
}
