import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MessagingAction,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  isApprovalAskBlock,
  isSecretAskBlock,
  isTerminal,
  MESSAGING_ASK_ACTION_ID,
  messagingAskActionValue,
  nextBotMessageHop,
  pageLinksAsTitles,
  TAKEOVER_COMPUTER_PENDING_STATE,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  accountDeactivated,
  appendEventInTransaction,
  CrossSpaceCommunicationBlockedError,
  createThreadMessageInTransaction,
  crossSpaceCommunicationAllowed,
  runAsSystem,
  SpaceDeletionInProgressError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { truncate } from "./approval-ask.js";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";
import { isUserProgressClientNonce, narrationStatusLine } from "./user-progress.js";

/**
 * Margin under vendor consecutive-outbound caps (sendblue enforces one hard):
 * past this many DMs without a reply from the owner, mirror rows stay pending
 * until the next inbound resets the counter.
 */
export const MESSAGING_DM_OUTBOUND_CAP = 140;

/** Provider-send attempts before a mirrored row is declared lost. */
export const MESSAGING_OUTBOUND_MAX_ATTEMPTS = 5;

/** Minimum spacing between edits of one run's activity message. */
export const MESSAGING_ACTIVITY_EDIT_INTERVAL_MS = 5_000;

/**
 * The send order every drain agrees on: mirrored rows carry explicit
 * per-part createdAt values, and id breaks the ties that remain (separate
 * inserts can share a timestamp) so two concurrent drains never order one
 * conversation's rows differently.
 */
const SEND_ORDER: Prisma.MessagingOutboundOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/** The outbox columns a drain reads and updates. */
type MessagingOutboundRow = {
  id: string;
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  threadId: string | null;
  body: string;
  attempts: number | null;
  nextAttemptAt: Date | null;
  providerHandle: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
};

export interface MessagingDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingSurface;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  artifacts: Pick<ArtifactStore, "get">;
  /**
   * The deployment's public web origin (its WEB_ORIGIN), when known. Ask and
   * takeover notices deep-link into the app from it; without it they still
   * send, just without the link.
   */
  appOrigin?: string;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
};

/**
 * Automatic mirror, not a send tool, so delivery does not depend on prompt
 * compliance. Agent-to-agent fan-out stays internal and never transits the
 * messaging provider. Also drains outbox rows the channels slice enqueued.
 */
export async function deliverMessagingOutbound(
  deps: MessagingDeliveryDeps,
  input: { runId?: string },
  context: AdapterContext,
): Promise<void> {
  if (input.runId) {
    await mirrorMessagingOutbound(deps, input.runId);
  }
  await drain(deps, context);
}

export async function mirrorMessagingOutbound(
  deps: MessagingDeliveryDeps,
  runId: string,
): Promise<void> {
  await mirrorRun(deps, runId);
  await deps.prisma.run.updateMany({
    where: { id: runId, trigger: "messaging" },
    data: { messagingMirroredAt: new Date() },
  });
}

/**
 * Queues the interim messages a running 1:1 chat run has posted so far, such as a message_user
 * update. Cards and files wait for the end-of-run mirror, which sees the whole reply (a page the
 * reply links goes with the reply, not as its own title), and so does everything posted after
 * them, to keep the app's order. The run is not marked mirrored, which still means its reply is
 * out, and the outbox keys rows by message, so the end-of-run mirror never sends these twice.
 * Group runs post once, when they end.
 */
export async function mirrorMessagingProgress(
  deps: MessagingDeliveryDeps,
  runId: string,
): Promise<void> {
  await mirrorRun(deps, runId, true);
}

async function mirrorRun(
  deps: MessagingDeliveryDeps,
  runId: string,
  progress = false,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { sourceMessage: true },
  });
  if (!run) return;

  if (run.trigger === "messaging") {
    const sourceBlocks = (run.sourceMessage?.blocks ?? []) as MessageBlock[];
    const channelBlock = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
        block.kind === "channel_message",
    );
    if (channelBlock) {
      if (!progress) await mirrorChannelRun(deps, run, channelBlock);
      return;
    }
  } else if (progress || run.trigger !== "bot_message") {
    // Mirror inbound messaging runs and, once they end, delegated bot_message replies only.
    // Do not push in-app user runs out to the linked chat; a finished routine
    // run is the one exception, and only when its routine opted in.
    if (!progress && run.trigger === "routine") {
      await mirrorRoutineResult(deps, run);
    }
    return;
  }

  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  // The linked DM is one person's chat. In a shared Space another member's run on this bot, such
  // as a reply to their message_bot, stays in the app instead of reaching that person's chat app.
  if (!identity || identity.userId !== run.userId) return;

  // bot_message runs can carry the bot's user-facing reply after a delegate wake.
  // extractText keeps only text and page titles, so inter-bot chatter blocks never leak out.

  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  const sendsFiles = deps.messaging
    .platforms()
    .some((platform) => platform.provider === identity.provider && platform.capabilities.files);
  // One row per platform-sized part, then one per image or file, so a retry
  // re-sends only the parts that failed and never repeats delivered text.
  // The whole reply takes one explicit, non-overlapping range, like a group
  // reply, so a concurrent DM mirror cannot interleave its parts.
  const linkedPages = linkedPageIds(messages);
  const rowsByMessage = messages.map((message) => {
    // A computer waiting on its person travels as its own takeover notice
    // (with the link that opens the app) instead of a plain status line.
    const takeover = pendingTakeoverBlock(message.blocks);
    const ask = pendingAskBlock(message.blocks);
    const body = extractText(
      takeover ? withoutBlock(message.blocks, takeover) : message.blocks,
      linkedPages,
    );
    const parts = body ? splitOutboundBody(identity.provider, body) : [];
    return [
      ...parts.map((part, index) => ({
        idempotencyKey: index === 0 ? `msg:${message.id}` : `msg:${message.id}:${index + 1}`,
        kind: "dm",
        identityId: identity.id,
        body: part,
        sourceMessageId: message.id,
      })),
      ...(sendsFiles ? extractArtifactIds(message.blocks) : []).map((artifactId) => ({
        idempotencyKey: `msg:${message.id}:file:${artifactId}`,
        kind: "dm",
        identityId: identity.id,
        body: "",
        sourceMessageId: message.id,
      })),
      ...(takeover
        ? [
            {
              idempotencyKey: `takeover:${message.id}`,
              kind: "dm",
              identityId: identity.id,
              body: takeoverNoticeBody(deps, run.botId, takeover),
              sourceMessageId: message.id,
            },
          ]
        : []),
      // A question the run is paused on travels as its own ask row: the
      // drain re-checks it is still pending and attaches the tappable
      // options, so a question answered in the app never goes out stale.
      ...(ask
        ? [
            {
              idempotencyKey: `ask:${message.id}`,
              kind: "dm",
              identityId: identity.id,
              body: askNoticeBody(deps, run.botId, ask),
              sourceMessageId: message.id,
            },
          ]
        : []),
    ];
  });
  // While the run is going, send its interim messages up to the first other message that sends
  // anything, such as a card or a file: it waits for the whole reply, and nothing posted after it
  // goes ahead of it.
  const held = progress
    ? rowsByMessage.findIndex(
        (rows, index) =>
          rows.length > 0 && !isUserProgressClientNonce(messages[index]!.clientNonce),
      )
    : -1;
  const rows = (held === -1 ? rowsByMessage : rowsByMessage.slice(0, held)).flat();
  if (rows.length > 0) {
    // Atomic dedupe: a concurrent messaging.deliver for the same run loses on
    // the idempotencyKey unique key instead of throwing P2002.
    await insertOutboundRows(deps.prisma, { identityId: identity.id }, rows);
  }
  await mirrorRunActivity(deps, run, identity, messages, !progress);
}

/** Chat-sized cap for a routine result sent as one message. */
const ROUTINE_RESULT_MAX_LENGTH = 2_000;

/**
 * A finished routine run's result for the owner's linked DM, queued as one
 * outbox row the drain sends like any other DM. Only the end-of-run mirror
 * calls this, and only for a run that is actually over: a run paused on a
 * question or still going has no result yet, and its later mirrors queue
 * nothing. The row's key is the run, so a re-mirror after a crash queues
 * nothing twice. No identity for the bot, or an identity that belongs to
 * someone else (a shared Space), means no delivery — the same guard as the
 * bot_message mirror.
 */
async function mirrorRoutineResult(
  deps: MessagingDeliveryDeps,
  run: {
    id: string;
    botId: string;
    userId: string;
    status: string;
    error: string | null;
    routineId: string | null;
  },
): Promise<void> {
  if (!run.routineId) return;
  if (run.status !== "completed" && run.status !== "failed") return;
  const routine = await deps.prisma.routine.findUnique({
    where: { id: run.routineId },
    select: { name: true, deliverResultToChat: true },
  });
  if (!routine?.deliverResultToChat) return;
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity || identity.userId !== run.userId) return;
  // A proactive WhatsApp message outside the 24-hour window needs a template
  // this deployment does not have, so WhatsApp identities wait for that.
  if (identity.provider === "whatsapp") return;
  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  const linkedPages = linkedPageIds(messages);
  const text = messages
    .map((message) => extractText(message.blocks, linkedPages))
    .filter((part) => part.length > 0)
    .join("\n\n");
  await insertOutboundRows(deps.prisma, { identityId: identity.id }, [
    {
      idempotencyKey: `routine:${run.id}`,
      kind: "dm",
      identityId: identity.id,
      body: routineResultBody(deps, routine.name, run, text),
      sourceMessageId: null,
    },
  ]);
}

/**
 * The routine result as one chat message: how the run ended, what it
 * produced, and the way back into the app. The middle is clipped first, so
 * the status line and the link survive a long result.
 */
function routineResultBody(
  deps: MessagingDeliveryDeps,
  name: string,
  run: { status: string; error: string | null; botId: string },
  text: string,
): string {
  const head = run.status === "failed" ? `${name} failed.` : `${name} finished.`;
  const link = appBotUrl(deps.appOrigin, run.botId);
  const tail = link ? `View in Rakazo: ${link}` : "View it in the Rakazo app.";
  const middle = [
    ...(run.status === "failed" && run.error ? [run.error] : []),
    ...(text ? [text] : []),
  ].join("\n\n");
  const budget = ROUTINE_RESULT_MAX_LENGTH - head.length - tail.length - 4;
  const clipped = middle ? truncate(middle, Math.max(0, budget)) : "";
  return [head, ...(clipped ? [clipped] : []), tail].join("\n\n");
}

/** Step lines an activity message shows; older steps collapse into a count. */
const ACTIVITY_MAX_STEP_LINES = 6;

/** Chat-sized cap for an activity message, which is a summary, not the reply. */
const ACTIVITY_BODY_MAX_LENGTH = 1_000;

type ActivityRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
};

type ActivityMessage = { blocks: unknown; clientNonce?: string | null };

/**
 * One evolving message per run on platforms that can edit: opened by the
 * progress mirror, refreshed in place as the run's steps accumulate, and
 * finalized by the end-of-run mirror. The outbox row is the whole state —
 * its body is the summary the platform currently shows, and the next one
 * is recomputed from the run's messages at every mirror, so a burst inside
 * the edit interval queues nothing and a stale summary is never sent after
 * a newer one exists. Platforms without the `edits` capability never get a
 * row: their only channel message stays the end-of-run delivery.
 */
async function mirrorRunActivity(
  deps: MessagingDeliveryDeps,
  run: ActivityRun,
  identity: { id: string; provider: string },
  messages: ActivityMessage[],
  final: boolean,
): Promise<void> {
  const supported =
    typeof deps.messaging.editMessage === "function" &&
    deps.messaging
      .platforms()
      .some((platform) => platform.provider === identity.provider && platform.capabilities.edits);
  if (!supported) return;
  const idempotencyKey = `activity:${run.id}`;
  const existing = await deps.prisma.messagingOutbound.findFirst({
    where: { idempotencyKey },
  });
  const body = activityBody(run, messages, final);
  if (!existing) {
    // Open the message only while the run is still going: a progress mirror
    // that lands after the run ended must not post activity behind the
    // reply it was announcing, and the end-of-run mirror never opens one.
    if (!body || final || isTerminal(run.status)) return;
    await insertOutboundRows(deps.prisma, { identityId: identity.id }, [
      {
        idempotencyKey,
        kind: "activity",
        identityId: identity.id,
        body,
        sourceMessageId: null,
      },
    ]);
    return;
  }
  if (existing.status === "failed") return;
  if (!body) {
    // Nothing left to summarize: an activity message that never posted is
    // dropped instead of sending a stale line at the end of the run; one
    // already showing keeps its last state.
    if (final && !existing.providerHandle) {
      await deps.prisma.messagingOutbound.update({
        where: { id: existing.id },
        data: { status: "failed" },
      });
    }
    return;
  }
  if (existing.status === "pending") {
    // Not posted yet: the newest summary simply replaces the queued one.
    if (existing.body !== body) {
      await deps.prisma.messagingOutbound.update({
        where: { id: existing.id },
        data: { body },
      });
    }
    return;
  }
  const updatedAtMs = existing.updatedAt?.getTime() ?? Date.now();
  if (!existing.providerHandle) {
    // Claimed by a drain that has not recorded its handle: leave an
    // in-flight send alone; an abandoned claim reopens for the drain.
    if (Date.now() - updatedAtMs < MESSAGING_ROW_IN_FLIGHT_MS) return;
    await reopenActivityRow(deps, existing.id, body);
    return;
  }
  // Posted: the platform shows the stored body. Inside the edit interval
  // the row is left untouched — the summary is recomputed from the run's
  // messages at every mirror, so nothing is lost: the first mirror past
  // the interval reopens the row with the then-latest body, and a burst
  // collapses into at most one edit per interval.
  if (existing.body === body) return;
  if (!final && Date.now() - updatedAtMs < MESSAGING_ACTIVITY_EDIT_INTERVAL_MS) return;
  await reopenActivityRow(deps, existing.id, body);
}

/** Hands a posted activity row back to the drain for one more edit. */
async function reopenActivityRow(
  deps: MessagingDeliveryDeps,
  rowId: string,
  body: string,
): Promise<void> {
  await deps.prisma.messagingOutbound.updateMany({
    where: { id: rowId, status: "sent" },
    data: { status: "pending", body, nextAttemptAt: null },
  });
}

/**
 * The activity message's text: the run's step lines so far, its latest
 * progress line when it adds anything new, and how long the run has been
 * going. Null while the run has produced no steps worth summarizing —
 * interim text already reaches the channel as its own message, so activity
 * opens only once there is an evolving summary to show.
 */
function activityBody(
  run: ActivityRun,
  messages: ActivityMessage[],
  final: boolean,
): string | null {
  const lines = messages
    .flatMap((message) => {
      if (!Array.isArray(message.blocks)) return [];
      return (message.blocks as RenderableBlock[]).flatMap((block) =>
        block?.kind === "steps" ? stepLines(block.steps) : [],
      );
    })
    .flatMap((joined) => joined.split("\n"))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const shown = lines.slice(-ACTIVITY_MAX_STEP_LINES);
  const progress = latestActivityLine(messages);
  const parts = [
    ...(lines.length > shown.length ? [`(${lines.length - shown.length} earlier steps)`] : []),
    ...shown,
    ...(progress && !shown.includes(progress) ? [progress] : []),
  ];
  const startedAt = run.startedAt ?? run.createdAt;
  const endedAt = final ? (run.completedAt ?? new Date()) : new Date();
  const elapsed = formatActivityDuration(endedAt.getTime() - startedAt.getTime());
  parts.push(final ? `Finished in ${elapsed}` : `Working for ${elapsed}`);
  return truncate(parts.join("\n"), ACTIVITY_BODY_MAX_LENGTH);
}

/** The newest progress line the run has shown: a progress block, else its latest interim update. */
function latestActivityLine(messages: ActivityMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of [...(message.blocks as RenderableBlock[])].reverse()) {
      if (block?.kind === "progress" && typeof block.text === "string" && block.text.trim()) {
        return narrationStatusLine(block.text);
      }
    }
    if (isUserProgressClientNonce(message.clientNonce)) {
      const text = extractText(message.blocks, new Set());
      if (text) return narrationStatusLine(text);
    }
  }
  return null;
}

/** "45s", "2m 05s", "1h 03m": compact elapsed time for an activity line. */
function formatActivityDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Inserts outbox rows for one conversation with a non-overlapping position
 * range: under the conversation row lock, every writer of a conversation
 * (mirrors, intros) takes timestamps starting past the newest committed row,
 * so no writer's rows interleave with another's — not even on a clock tie or
 * a delayed commit. Only rows are read and written here; sends stay in the
 * drain.
 */
export async function insertOutboundRows(
  prisma: PrismaClient,
  conversation: Conversation,
  rows: Array<Omit<Prisma.MessagingOutboundCreateManyInput, "createdAt">>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversation);
    const latest = await tx.messagingOutbound.aggregate({
      _max: { createdAt: true },
      where: conversation,
    });
    const base = Math.max(Date.now(), (latest._max.createdAt?.getTime() ?? 0) + 1);
    await tx.messagingOutbound.createMany({
      data: rows.map((row, index) => ({ ...row, createdAt: new Date(base + index) })),
      skipDuplicates: true,
    });
  });
}

/**
 * Channel runs post to the group with an attribution prefix, then fan the
 * post out internally to peer approved bots: context only by default, a
 * waking run on @-mention, bounded by the shared bot-message hop budget.
 */
async function mirrorChannelRun(
  deps: MessagingDeliveryDeps,
  run: { id: string; botId: string },
  channelBlock: Extract<MessageBlock, { kind: "channel_message" }>,
): Promise<void> {
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  // A deactivated person's bot neither posts to the group nor reaches its other bots.
  if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) return;
  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { id: channelBlock.channelId },
  });
  if (!channel) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: identity.userId },
    select: { name: true },
  });
  const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
  const fromLabel = `${firstName}'s agent`;

  const replies = await deps.prisma.message.findMany({
    select: { id: true, blocks: true },
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  // Ask answers are entered privately in the app. Check the same snapshot as
  // the replies so a resumed run cannot publish an answer-influenced response.
  if (
    replies.some((message) =>
      (message.blocks as MessageBlock[]).some(
        (block) => block.kind === "ask" && block.status === "answered",
      ),
    )
  )
    return;
  const linkedPages = linkedPageIds(replies);
  const messages = replies
    .map((message) => ({ message, text: extractText(message.blocks, linkedPages) }))
    .filter((entry) => entry.text);
  if (messages.length === 0) return;

  // One row per platform-sized part, like the DM path: the adapter truncates
  // an oversized body instead of failing, which would drop the reply's tail.
  // The whole reply takes one explicit, non-overlapping range.
  await insertOutboundRows(
    deps.prisma,
    { identityId: null, threadId: channel.threadId },
    messages.flatMap(({ message, text }) =>
      splitOutboundBody(identity.provider, `${fromLabel}: ${text}`).map((part, index) => ({
        idempotencyKey: index === 0 ? `msg:${message.id}` : `msg:${message.id}:${index + 1}`,
        kind: "group",
        threadId: channel.threadId,
        body: part,
        sourceMessageId: message.id,
      })),
    ),
  );

  const hop = nextBotMessageHop(channelBlock.hop);
  const peers = await deps.prisma.messagingChannelMember.findMany({
    where: {
      channelId: channel.id,
      status: "approved",
      identityId: { not: null },
      NOT: { identityId: identity.id },
    },
  });
  // Peer bots belong to other members, usually in other Spaces.
  await runAsSystem("fan a group post out to peer bots in other Spaces", () =>
    fanOutToPeers(deps, { identity, channel, channelBlock, fromLabel, hop, peers, messages }),
  );
}

async function fanOutToPeers(
  deps: MessagingDeliveryDeps,
  {
    identity,
    channel,
    channelBlock,
    fromLabel,
    hop,
    peers,
    messages,
  }: {
    identity: { provider: string; address: string; botId: string };
    channel: { id: string; name: string | null };
    channelBlock: Extract<MessageBlock, { kind: "channel_message" }>;
    fromLabel: string;
    hop: number;
    peers: Array<{ identityId: string | null }>;
    messages: Array<{ message: { id: string }; text: string }>;
  },
): Promise<void> {
  for (const { message, text } of messages) {
    for (const peer of peers) {
      const peerIdentity = await deps.prisma.messagingIdentity.findUnique({
        where: { id: peer.identityId! },
      });
      if (!peerIdentity || (await accountDeactivated(deps.prisma, peerIdentity.userId))) continue;
      if (!(await crossSpaceCommunicationAllowed(deps.prisma, identity.botId, peerIdentity.botId)))
        continue;
      const peerThread = await deps.prisma.thread.findFirst({
        where: { botId: peerIdentity.botId },
      });
      if (!peerThread) continue;
      const peerBot = await deps.prisma.bot.findUnique({
        where: { id: peerIdentity.botId },
        select: { name: true },
      });
      const block: MessageBlock = {
        kind: "channel_message",
        provider: identity.provider,
        ...(channelBlock.transport ? { transport: channelBlock.transport } : {}),
        channelId: channel.id,
        fromAddress: identity.address,
        fromLabel,
        text,
        hop,
      };
      const clientNonce = `messaging-peer:${message.id}:${peerIdentity.botId}`;
      const mentioned = peerBot?.name
        ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(text)
        : false;
      if (mentioned && !botMessageHopExhausted(hop)) {
        const sent = await deps.events
          .sendUserMessage({
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            userId: peerIdentity.userId,
            blocks: [block],
            prompt: `[Group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
            trigger: "messaging",
            clientNonce,
            crossSpaceSenderBotId: identity.botId,
          })
          .catch((error: unknown) => {
            if (
              error instanceof CrossSpaceCommunicationBlockedError ||
              error instanceof SpaceDeletionInProgressError
            )
              return null;
            throw error;
          });
        if (sent?.runId) {
          await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
            getLogger().error("messaging peer wake enqueue error", error);
          });
        }
        continue;
      }
      // Context only: the peer sees the post in history without a wake.
      const existing = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
      });
      if (existing) continue;
      const event = await deps.prisma
        .$transaction(async (tx) => {
          const created = await createThreadMessageInTransaction(tx, {
            threadId: peerThread.id,
            role: "user",
            blocks: [block],
            clientNonce,
          });
          if (!(await crossSpaceCommunicationAllowed(tx, identity.botId, peerIdentity.botId)))
            throw new CrossSpaceCommunicationBlockedError();
          return appendEventInTransaction(tx, {
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            type: "thread.message.created",
            payload: { messageId: created.id, role: "user", blocks: [block] },
          });
        }, THREAD_LOCK_TRANSACTION_OPTIONS)
        .catch((error: unknown) => {
          if (error instanceof CrossSpaceCommunicationBlockedError) return null;
          throw error;
        });
      if (event) await deps.events.notify(peerThread.id, event.seq).catch(() => undefined);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type ComputerBlock = Extract<MessageBlock, { kind: "computer" }>;

/** Chat-sized cap for a question or a takeover notice sent as one message. */
const ASK_NOTICE_MAX_LENGTH = 2_000;

/** The first question in the message the bot is still waiting on, if any. */
function pendingAskBlock(blocks: unknown): AskBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<MessageBlock | null>) {
    if (block?.kind !== "ask") continue;
    if (block.status !== "answered" && typeof block.text === "string") return block;
  }
  return null;
}

/** The message's computer block while it waits for its person, if any. */
function pendingTakeoverBlock(blocks: unknown): ComputerBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<MessageBlock | null>) {
    if (block?.kind !== "computer") continue;
    if (block.state === TAKEOVER_COMPUTER_PENDING_STATE) return block;
  }
  return null;
}

function withoutBlock(blocks: unknown, excluded: ComputerBlock): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.filter((block) => block !== excluded);
}

/** The app's page for one bot, or null when no public origin is configured. */
function appBotUrl(appOrigin: string | undefined, botId: string): string | null {
  if (!appOrigin) return null;
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}/app/${botId}`;
  } catch {
    return null;
  }
}

/**
 * The body an ask row carries. Approvals and choices show the question (and
 * its detail); their options ride as actions at send time instead. A secret
 * request is never answerable in chat, so its row is only a notice pointing
 * at the app, where the value goes into the masked card.
 */
function askNoticeBody(deps: MessagingDeliveryDeps, botId: string, ask: AskBlock): string {
  if (isSecretAskBlock(ask)) {
    const link = appBotUrl(deps.appOrigin, botId);
    return truncate(
      link
        ? `${ask.text}\n\nAnswer securely in Rakazo: ${link}`
        : `${ask.text}\n\nAnswer securely in the Rakazo app.`,
      ASK_NOTICE_MAX_LENGTH,
    );
  }
  return truncate(ask.detail ? `${ask.text}\n\n${ask.detail}` : ask.text, ASK_NOTICE_MAX_LENGTH);
}

/** A takeover wait as a chat notice: what the bot is waiting on, plus the way in. */
function takeoverNoticeBody(
  deps: MessagingDeliveryDeps,
  botId: string,
  block: ComputerBlock,
): string {
  const waiting = block.text || block.state;
  const link = appBotUrl(deps.appOrigin, botId);
  return truncate(
    link ? `${waiting}\n\nTake control: ${link}` : `${waiting}\n\nTake control in the Rakazo app.`,
    ASK_NOTICE_MAX_LENGTH,
  );
}

/**
 * The tappable options for a pending ask, one per option in order. Every
 * option shares the ask action id and carries the ask's message plus its own
 * position as the value, so a tap names exactly one pending question.
 * Approvals mark Allow primary and Deny danger; choices stay neutral.
 * Secret requests and free-text questions get no actions at all.
 */
function askActionsFor(ask: AskBlock, messageId: string): MessagingAction[] | undefined {
  if (isSecretAskBlock(ask) || !ask.actions?.length) return undefined;
  const approval = isApprovalAskBlock(ask);
  return ask.actions.map((action, index) => ({
    id: MESSAGING_ASK_ACTION_ID,
    label: action.label,
    value: messagingAskActionValue(messageId, index),
    ...(approval && action.id === "allow" ? { style: "primary" as const } : {}),
    ...(approval && action.id === "deny" ? { style: "danger" as const } : {}),
  }));
}

/**
 * Sends one ask row. The question is re-read at send time: answered in the
 * app (or gone) before the drain reached it, the row is dropped instead of
 * posting a stale card — the same live re-check the connect invites do.
 * A live question sends with its options attached; a secret or free-text
 * question sends as the plain notice its row already carries.
 */
async function deliverAskRow(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  row: MessagingOutboundRow,
  threadId: string,
): Promise<"sent" | "skipped"> {
  const message = await deps.prisma.message.findUnique({
    where: { id: row.sourceMessageId! },
    select: { role: true, blocks: true },
  });
  const ask = message && message.role === "bot" ? pendingAskBlock(message.blocks) : null;
  if (!ask) {
    await deps.prisma.messagingOutbound.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    return "skipped";
  }
  const actions = askActionsFor(ask, row.sourceMessageId!);
  const sent = await deps.messaging.sendToThread(
    { threadId, body: row.body, ...(actions ? { actions } : {}) },
    context,
  );
  await deps.prisma.messagingOutbound.updateMany({
    where: { id: row.id },
    data: { providerHandle: sent.handle },
  });
  return "sent";
}

/** `connect:{requesterBotId}:{targetBotId}` — agent-connection approval DMs. */
function connectInvitePair(
  idempotencyKey: string,
): { requesterBotId: string; targetBotId: string } | null {
  const match = /^connect:([^:]+):([^:]+)$/.exec(idempotencyKey);
  if (!match) return null;
  return { requesterBotId: match[1]!, targetBotId: match[2]! };
}

/**
 * Deliver a connect invite while holding the connection row lock.
 * Revoke's status update blocks behind this lock, so it cannot commit
 * (and delete the claim) between the pending check and the send.
 * Only used for rare approval DMs, not for ordinary mirrored traffic.
 *
 * At-most-once: any failure after the provider call (or an ambiguous
 * transport error) keeps the outer claim as `sent` so drain does not
 * restore pending and duplicate the YES/NO DM. A lost invite is fine;
 * reconnect starts a fresh cycle.
 */
async function sendConnectInvite(
  deps: MessagingDeliveryDeps,
  row: { id: string; body: string },
  threadId: string,
  pair: { requesterBotId: string; targetBotId: string },
  context: AdapterContext,
): Promise<"delivered" | "skipped" | "held"> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const communicationAllowed = await crossSpaceCommunicationAllowed(
          tx,
          pair.requesterBotId,
          pair.targetBotId,
        );
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections
          WHERE "requesterBotId" = ${pair.requesterBotId}
            AND "targetBotId" = ${pair.targetBotId}
          FOR UPDATE
        `;
        // An invite queued before its requester was deactivated is not sent for them.
        const requester = await tx.bot.findUnique({
          where: { id: pair.requesterBotId },
          select: { userId: true },
        });
        const requesterDeactivated = requester && (await accountDeactivated(tx, requester.userId));
        if (locked[0]?.status !== "pending" || !communicationAllowed || requesterDeactivated) {
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { status: "failed" },
          });
          return "skipped";
        }
        const outbound = await tx.messagingOutbound.findUnique({
          where: { id: row.id },
          select: { id: true },
        });
        if (!outbound) return "skipped";
        try {
          const sent = await deps.messaging.sendToThread({ threadId, body: row.body }, context);
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { providerHandle: sent.handle },
          });
          return "delivered";
        } catch {
          // Provider error or lost response is ambiguous without an
          // idempotency key. Do not ask drain to retry.
          return "held";
        }
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch {
    // Lock/timeout after a possible accept: keep the outer claim as sent.
    return "held";
  }
}

async function drain(deps: MessagingDeliveryDeps, context: AdapterContext): Promise<void> {
  const pending = await deps.prisma.messagingOutbound.findMany({
    where: { status: "pending" },
    orderBy: SEND_ORDER,
  });
  // Each conversation is its own lane, so a slow provider holds back only
  // the replies queued behind it.
  const heads = new Map<string, MessagingOutboundRow>();
  for (const row of pending) {
    const key = row.identityId ?? row.threadId ?? row.id;
    if (!heads.has(key)) heads.set(key, row);
  }
  const lanes = await Promise.allSettled(
    [...heads.values()].map((head) => deliverLane(deps, context, head)),
  );
  const failed = lanes.find((lane) => lane.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

type Conversation = { identityId: string } | { identityId: null; threadId: string };

function conversationOf(row: MessagingOutboundRow): Conversation | null {
  if (row.identityId) return { identityId: row.identityId };
  if (row.threadId) return { identityId: null, threadId: row.threadId };
  return null;
}

/**
 * Takes the per-conversation lock every outbox-row writer allocates under:
 * the channel row for a group, the identity row for a direct message.
 */
async function lockConversation(tx: Prisma.TransactionClient, conversation: Conversation) {
  if ("threadId" in conversation) {
    await tx.$queryRaw`SELECT id FROM messaging_channels WHERE "threadId" = ${conversation.threadId} FOR UPDATE`;
    return;
  }
  await tx.$queryRaw`SELECT id FROM messaging_identities WHERE id = ${conversation.identityId} FOR UPDATE`;
}

/**
 * Claims the row for sending, or returns false when the conversation must
 * wait. The blocker check and the claim commit together under the
 * conversation's lock, so a row another writer commits in between (an intro
 * landing mid-flight) cannot put two sends of one conversation on the wire.
 * The lock is released before any provider call.
 */
async function claimForSend(
  deps: MessagingDeliveryDeps,
  conversation: Conversation,
  row: MessagingOutboundRow,
): Promise<boolean> {
  return deps.prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversation);
    if (await hasBlockingRow(tx, conversation, row, Date.now())) return false;
    const claim = await tx.messagingOutbound.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sent", nextAttemptAt: null },
    });
    return claim.count === 1;
  });
}

/**
 * Sends one conversation's rows in order, reading each next row after the
 * previous send so a reply queued meanwhile is not left behind. Stops at the
 * first row that has to wait, or that another drain already owns.
 */
async function deliverLane(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  head: MessagingOutboundRow,
): Promise<void> {
  const conversation = conversationOf(head);
  let row: MessagingOutboundRow | null = head;
  while (row) {
    const now = Date.now();
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) return;
    if (conversation) {
      // Claim before sending: concurrent drains and crash retries must never
      // deliver the same message twice.
      if (!(await claimForSend(deps, conversation, row))) return;
    } else {
      const claim = await deps.prisma.messagingOutbound.updateMany({
        where: { id: row.id, status: "pending" },
        data: { status: "sent", nextAttemptAt: null },
      });
      if (claim.count === 0) return;
    }
    if (!(await deliverRow(deps, context, row))) return;
    row = conversation
      ? await deps.prisma.messagingOutbound.findFirst({
          where: { status: "pending", ...conversation },
          orderBy: SEND_ORDER,
        })
      : null;
  }
}

/** Sends one claimed row. Returns false when later rows to the same place must wait. */
async function deliverRow(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  row: MessagingOutboundRow,
): Promise<boolean> {
  let attachmentName: string | null = null;
  let accepted = false;
  try {
    if (row.kind === "group" || row.kind === "intro") {
      // A reply a deactivated person's bot queued for a group is not posted after all.
      const source = row.sourceMessageId
        ? await deps.prisma.message.findUnique({
            where: { id: row.sourceMessageId },
            select: { thread: { select: { userId: true } } },
          })
        : null;
      if (
        !row.threadId ||
        (source && (await accountDeactivated(deps.prisma, source.thread.userId)))
      ) {
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        return true;
      }
      const sent = await deps.messaging.sendToThread(
        { threadId: row.threadId, body: row.body },
        context,
      );
      accepted = true;
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { providerHandle: sent.handle },
      });
      return true;
    }
    const identity = row.identityId
      ? await deps.prisma.messagingIdentity.findUnique({ where: { id: row.identityId } })
      : null;
    // Nothing more reaches a deactivated person's chat app, including what was queued before.
    if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) {
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { status: "failed" },
      });
      return true;
    }
    // Sendblue's consecutive-outbound vendor cap; other providers have no
    // equivalent limit, so do not hold Slack/WhatsApp/Telegram DMs.
    if (
      identity.provider === "sendblue" &&
      identity.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP
    ) {
      // Cap holds are not failures: release the claim back to pending.
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { status: "pending" },
      });
      return false;
    }
    const threadId = await resolveDirectThread(deps, identity, context);
    if (row.kind === "activity") {
      return deliverActivityRow(deps, context, row, identity, threadId);
    }
    const invitePair = connectInvitePair(row.idempotencyKey);
    if (invitePair) {
      const result = await sendConnectInvite(
        deps,
        { id: row.id, body: row.body },
        threadId,
        invitePair,
        context,
      );
      if (result === "delivered") {
        accepted = true;
        await deps.prisma.messagingIdentity.update({
          where: { id: identity.id },
          data: { outboundSinceInbound: { increment: 1 } },
        });
      }
      return true;
    }
    if (row.idempotencyKey.startsWith("ask:") && row.sourceMessageId) {
      if ((await deliverAskRow(deps, context, row, threadId)) === "sent") {
        accepted = true;
        await deps.prisma.messagingIdentity.update({
          where: { id: identity.id },
          data: { outboundSinceInbound: { increment: 1 } },
        });
      }
      return true;
    }
    let attachment: MessagingOutboundAttachment | undefined;
    const artifactId = fileArtifactId(row.idempotencyKey);
    if (artifactId) {
      // Scoped to the identity's Space: the drain runs across every Space.
      const artifact = await deps.prisma.artifact.findFirst({
        where: { id: artifactId, spaceId: identity.spaceId },
        select: { name: true, mimeType: true, storageKey: true, userId: true },
      });
      if (!artifact) {
        // Deleted since the reply was mirrored, or not in this Space.
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        return true;
      }
      attachmentName = artifact.name;
      const data = await deps.artifacts.get(artifact.storageKey, {
        ...context,
        spaceId: identity.spaceId,
        userId: artifact.userId,
      });
      attachment = { name: artifact.name, mimeType: artifact.mimeType, data };
    }
    const sent = await deps.messaging.sendToThread(
      { threadId, body: row.body, ...(attachment ? { attachment } : {}) },
      context,
    );
    accepted = true;
    await deps.prisma.messagingOutbound.updateMany({
      where: { id: row.id },
      data: { providerHandle: sent.handle },
    });
    await deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { outboundSinceInbound: { increment: 1 } },
    });
    return true;
  } catch (error) {
    if (accepted) {
      // Keep the sent claim even if saving the handle or counter fails.
      getLogger().error("messaging outbound bookkeeping error", error);
      return true;
    }
    // Transient provider errors go back to pending with a backed-off
    // retry (no sooner than the provider's retry-after); a permanent error
    // or an exhausted budget is terminal.
    const failure = error instanceof MessagingSendError ? error : null;
    const attempts = (row.attempts ?? 0) + 1;
    const exhausted = failure?.permanent || attempts >= MESSAGING_OUTBOUND_MAX_ATTEMPTS;
    const delayMs = Math.max(messagingOutboundRetryDelayMs(attempts), failure?.retryAfterMs ?? 0);
    const retryAt = exhausted ? null : new Date(Date.now() + delayMs);
    const outcome = {
      where: { id: row.id },
      data: {
        attempts,
        status: exhausted ? "failed" : "pending",
        nextAttemptAt: retryAt,
      },
    };
    if (exhausted && attachmentName) {
      // The reply's text went out on its own rows; say the file did not
      // follow instead of dropping it silently. Saved with the failure so
      // one cannot land without the other, keyed so it is queued once, and
      // given the file's place so later replies wait behind it.
      const name = attachmentName;
      await deps.prisma.$transaction(async (tx) => {
        await tx.messagingOutbound.updateMany(outcome);
        await tx.messagingOutbound.createMany({
          data: [
            {
              idempotencyKey: `${row.idempotencyKey}:notice`,
              kind: row.kind,
              identityId: row.identityId,
              threadId: row.threadId,
              body: `Could not send "${name}".`,
              sourceMessageId: row.sourceMessageId,
              createdAt: row.createdAt,
            },
          ],
          skipDuplicates: true,
        });
      });
      await deps.jobs.enqueue(messagingDeliverJob());
      return false;
    }
    await deps.prisma.messagingOutbound.updateMany(outcome);
    if (!exhausted && retryAt) {
      // Propagate an enqueue failure: the messaging.deliver job then fails
      // and the queue's own retry re-runs the drain. Swallowing it would
      // strand the row in pending — no reconciler reclaims outbox rows.
      // Re-entry is safe: the row is pending again and nextAttemptAt keeps
      // other drains from racing the backoff window.
      await deps.jobs.enqueue(messagingDeliverJob(undefined, retryAt));
    }
    return false;
  }
}

/**
 * Posts the run's activity message, or edits it to the row's newest body.
 * Activity decorates the reply, so a provider failure is dropped here
 * instead of entering the outbox retry path: a lost first post marks the
 * row failed (no handle exists for the run's later steps to edit), a lost
 * edit keeps the summary the platform already shows, and neither holds
 * back the rows queued behind this one.
 */
async function deliverActivityRow(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  row: MessagingOutboundRow,
  identity: IdentityRow,
  threadId: string,
): Promise<boolean> {
  try {
    if (row.providerHandle) {
      await deps.messaging.editMessage?.(
        threadId,
        row.providerHandle,
        { threadId, body: row.body },
        context,
      );
      return true;
    }
    const sent = await deps.messaging.sendToThread({ threadId, body: row.body }, context);
    if (!sent.handle) throw new Error("Messaging send returned no handle to edit later");
    await deps.prisma.messagingOutbound.updateMany({
      where: { id: row.id },
      data: { providerHandle: sent.handle },
    });
    await deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { outboundSinceInbound: { increment: 1 } },
    });
    return true;
  } catch (error) {
    getLogger().warn("messaging activity delivery failed", { error });
    if (!row.providerHandle) {
      await deps.prisma.messagingOutbound
        .updateMany({ where: { id: row.id }, data: { status: "failed" } })
        .catch(() => undefined);
    }
    return true;
  }
}

/** A claimed row still without a handle after this long is treated as abandoned. */
const MESSAGING_ROW_IN_FLIGHT_MS = 2 * 60_000;

/**
 * True while the conversation must not start another send: a row that sorts
 * earlier is still pending, or any row is in flight. A row can commit after a
 * later-ordered row already left (a range allocated before it existed), and a
 * second send beside it would arrive unordered, so in flight blocks
 * regardless of order — bounded by the abandoned-claim deadline.
 */
async function hasBlockingRow(
  client: Prisma.TransactionClient,
  conversation: Conversation,
  row: Pick<MessagingOutboundRow, "id" | "createdAt">,
  now: number,
): Promise<boolean> {
  const blocking = await client.messagingOutbound.findFirst({
    where: {
      ...conversation,
      OR: [
        {
          status: "pending",
          // SEND_ORDER's notion of earlier, so an equal-createdAt row from a
          // separate insert still holds its place instead of being overtaken.
          OR: [
            { createdAt: { lt: row.createdAt } },
            { createdAt: row.createdAt, id: { lt: row.id } },
          ],
        },
        {
          status: "sent",
          providerHandle: null,
          updatedAt: { gt: new Date(now - MESSAGING_ROW_IN_FLIGHT_MS) },
        },
      ],
    },
    select: { id: true },
  });
  return blocking !== null;
}

/**
 * DM rows address the identity, not a thread: the conversation id is learned
 * from inbound webhooks and cached, with a provider lookup as fallback for
 * identities that predate the cache (or the multi-platform migration).
 */
async function resolveDirectThread(
  deps: MessagingDeliveryDeps,
  identity: IdentityRow,
  context: AdapterContext,
): Promise<string> {
  if (identity.dmThreadId) return identity.dmThreadId;
  const threadId = await deps.messaging.openDirectThread(
    identity.provider,
    identity.address,
    context,
  );
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { dmThreadId: threadId },
  });
  return threadId;
}

function messagingOutboundRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

/** Outbound status webhooks update outbox rows by provider handle. */
export async function applyMessagingOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
): Promise<void> {
  const status = ["ERROR", "DECLINED", "FAILED"].includes(event.status)
    ? "failed"
    : ["SENT", "DELIVERED", "READ"].includes(event.status)
      ? "sent"
      : null;
  if (!status) return;
  await prisma.messagingOutbound.updateMany({
    where: { providerHandle: event.handle },
    data: { status },
  });
}

/** The artifact a reply's file row sends, from its `msg:<message>:file:<artifact>` key. */
function fileArtifactId(idempotencyKey: string): string | null {
  return /^msg:[^:]+:file:([^:]+)$/.exec(idempotencyKey)?.[1] ?? null;
}

/** Artifacts of the message's image and file blocks, in block order. */
function extractArtifactIds(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; artifactId?: unknown } | null) =>
    (block?.kind === "image" || block?.kind === "file") && typeof block.artifactId === "string"
      ? [block.artifactId]
      : [],
  );
}

function textBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; text?: unknown } | null) =>
    block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Pages the run's replies already link by name, so their cards add nothing more. */
function linkedPageIds(messages: readonly { blocks: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const text of textBlocks(message.blocks)) {
      // Only links the conversion names count; one inside a code example stays as written, so a
      // page counts when fewer of its links remain after converting than were written.
      const converted = pageLinksAsTitles(text);
      const count = (source: string, link: string) => source.split(link).length - 1;
      for (const match of text.matchAll(/\]\(page:([A-Za-z0-9_-]{1,64})\)/g))
        if (count(converted, match[0]) < count(text, match[0])) ids.add(match[1]!);
    }
  return ids;
}

/** The block fields the text mirror reads, beyond text and page blocks. */
type RenderableBlock = {
  kind?: unknown;
  text?: unknown;
  pageId?: unknown;
  title?: unknown;
  lines?: unknown;
  steps?: unknown;
  state?: unknown;
  name?: unknown;
  data?: unknown;
};

/**
 * The text other channels get. A page card cannot travel, so a page the reply does not name goes
 * as its title. Structured blocks travel as compact text: a card as its
 * key/value lines, steps as one line each, a computer block as its status
 * text, a chart as its name over a small table of its data.
 */
function extractText(blocks: unknown, linkedPages: ReadonlySet<string>): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block: RenderableBlock | null) => {
      if (block?.kind === "text" && typeof block.text === "string")
        return [pageLinksAsTitles(block.text)];
      if (
        block?.kind === "page" &&
        typeof block.title === "string" &&
        typeof block.pageId === "string" &&
        !linkedPages.has(block.pageId)
      )
        return [block.title];
      if (block?.kind === "card") return cardLines(block.lines);
      if (block?.kind === "steps") return stepLines(block.steps);
      if (block?.kind === "computer") {
        const line = typeof block.text === "string" && block.text ? block.text : block.state;
        return typeof line === "string" && line ? [line] : [];
      }
      if (block?.kind === "chart") return chartLines(block);
      return [];
    })
    .join("\n")
    .trim();
}

/** A card block as one "key: value" line per entry. */
function cardLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const rendered = lines.flatMap((line: { k?: unknown; v?: unknown } | null) =>
    typeof line?.k === "string" && typeof line?.v === "string" ? [`${line.k}: ${line.v}`] : [],
  );
  return rendered.length ? [rendered.join("\n")] : [];
}

/** A steps block as one line per step, with its call count when it ran more than once. */
function stepLines(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const rendered = steps.flatMap((step: { label?: unknown; count?: unknown } | null) => {
    if (typeof step?.label !== "string") return [];
    return [
      typeof step.count === "number" && step.count > 1
        ? `${step.label} ×${step.count}`
        : step.label,
    ];
  });
  return rendered.length ? [rendered.join("\n")] : [];
}

/** Data rows shown under a chart's name in the text mirror. */
const CHART_MIRROR_MAX_ROWS = 10;

/** A chart block as its name over a plain table of its first rows, when the data is flat. */
function chartLines(block: { name?: unknown; data?: unknown }): string[] {
  if (typeof block.name !== "string") return [];
  const rows = Array.isArray(block.data) ? block.data : [];
  const first = rows[0] as Record<string, unknown> | null;
  if (!first || typeof first !== "object" || Array.isArray(first)) return [block.name];
  const columns = Object.keys(first);
  if (columns.length === 0 || columns.some((column) => !isChartCell(first[column])))
    return [block.name];
  const lines = [block.name, columns.join(" | ")];
  for (const row of rows.slice(0, CHART_MIRROR_MAX_ROWS)) {
    const record = row as Record<string, unknown>;
    lines.push(
      columns
        .map((column) => (isChartCell(record[column]) ? String(record[column] ?? "") : ""))
        .join(" | "),
    );
  }
  if (rows.length > CHART_MIRROR_MAX_ROWS)
    lines.push(`(${rows.length - CHART_MIRROR_MAX_ROWS} more rows)`);
  return [lines.join("\n")];
}

function isChartCell(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
