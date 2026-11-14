import type {
  JobPublisher,
  MessagingInboundAction,
  MessagingInboundMessage,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import { insertOutboundRows } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, isAttachmentAudioMimeType } from "@rakazo/contracts";
import type { MessagingCommand, MessagingSlashCommand } from "@rakazo/core";
import {
  displayName,
  isApprovalAskBlock,
  isSecretAskBlock,
  MESSAGING_ASK_ACTION_ID,
  MESSAGING_BOT_PICKER_ACTION_ID,
  MESSAGING_COMMANDS_HELP,
  MESSAGING_MODEL_PICKER_ACTION_ID,
  messageBlockForArtifact,
  normalizeVoiceTranscript,
  parseMessagingAskActionValue,
  parseMessagingBotPickerValue,
  parseMessagingCommand,
  parseMessagingModelPickerValue,
  parseMessagingSlashCommand,
  promptTextForAttachments,
  resolveAskChoice,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type {
  MessagingIdentityRequest,
  Prisma,
  PrismaClient,
  ProvisionedMessagingIdentity,
  SignupPolicyEnv,
  ThreadEvents,
} from "@rakazo/db";
import {
  accountDeactivated,
  createThreadMessage,
  crossSpaceCommunicationAllowed,
  getPrimaryThread,
  insertMessagingSteeringMessage,
  isUniqueViolation,
  normalizeMessagingLinkCode,
  redeemMessagingLinkCode,
  SpaceDeletionInProgressError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { storeInboundAttachments } from "./inbound-attachments.js";
import type { MessagingReceipts } from "./messaging-receipts.js";
import {
  MESSAGE_ROUTING_REARMED_REASON,
  MESSAGE_ROUTING_REASON,
  MESSAGE_ROUTING_RESERVATION_MS,
} from "./team-chat-startup.js";
import { cancelThreadRuns, finishThreadStop, STOPPED_BY_MESSAGE_NOTE } from "./thread-stop.js";
import {
  deliverWebhookEvent,
  formatUntrustedDeliveryPayload,
  inboundEventName,
  messagingWakeIdempotencyKey,
} from "./webhook-inbound.js";

/** One model the /model command can offer: a configured connection's catalog entry. */
export interface MessagingModelChoice {
  provider: string;
  id: string;
  label: string;
}

/**
 * The /model command's seam onto the same catalog and bot-update path
 * the app's model picker uses, narrowed to what a chat command needs.
 */
export interface MessagingInboundModels {
  /** The models the person's configured connections can run, in picker order. */
  choices(scope: { userId: string; spaceId: string }): Promise<MessagingModelChoice[]>;
  /** Resolve a typed name or id against those models; null when nothing matches. */
  resolve(
    scope: { userId: string; spaceId: string },
    query: string,
    preferredProvider: string | null,
  ): Promise<{ provider: string; model: string } | null>;
  /** Validate and persist a bot's model, exactly as the app's picker saves it. */
  apply(
    scope: { userId: string; spaceId: string },
    bot: {
      id: string;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    },
    choice: { provider: string; model: string },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface MessagingInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify" | "answerRunInput" | "clearThread">;
  jobs: Pick<JobPublisher, "enqueue">;
  /**
   * The deployment's public web origin, when known. Notices that must send
   * the person into the app (a secret answer) deep-link from it.
   */
  webOrigin?: string;
  sandbox: SandboxProvider;
  provision: (
    request: MessagingIdentityRequest,
    env: SignupPolicyEnv,
  ) => Promise<ProvisionedMessagingIdentity>;
  /**
   * Poke-style open line: unknown senders auto-provision their own account.
   * Off by default — strangers' runs would bill the deployment model key.
   */
  openSignup: boolean;
  signupPolicy: SignupPolicyEnv;
  acknowledge?: MessagingReceipts["acknowledge"];
  storeAttachment?: InboundAttachmentStore;
  /**
   * Transcribes inbound audio with the bot owner's voice provider. On null or
   * a throw only the file reference is delivered. `signal` aborts when the
   * budget runs out.
   */
  transcribe?: (input: {
    spaceId: string;
    userId: string;
    audio: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
  /**
   * Model listing and switching for /model, wired in the composition
   * root to the app model picker's own catalog and update path. Absent,
   * /model answers that switching is unavailable on this line.
   */
  models?: MessagingInboundModels;
  /**
   * Opens a forum topic in a group conversation and returns its thread
   * id, for /new in group chats. Absent — or null — when the platform
   * cannot (no topics, topics off, not a forum group).
   */
  createTopic?: (provider: string, threadId: string, name: string) => Promise<string | null>;
  /**
   * The best-effort follow-through after /new clears a conversation —
   * cancel the cleared runs' jobs and purge conversation-derived memory —
   * mirroring what the app's Clear conversation does once the clear
   * commits. The clear itself never waits on it.
   */
  afterThreadClear?: (input: {
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    cancelledRunIds: string[];
    historyCompactionGeneration: number;
  }) => Promise<void>;
}

/** A stored inbound attachment, with spoken words when audio was transcribed. */
type StoredAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  transcript?: string;
};

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 messages are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE/STOP owner commands).
 * Group messages drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createMessagingInboundHandler(deps: MessagingInboundDeps) {
  return async (event: MessagingInboundMessage): Promise<void> => {
    if (!event.isDirect) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, event).catch(droppedWhileDeleting);
  };
}

/**
 * A button tap enters the same path as a message: the tap is the person's
 * answer to the message that offered the actions, so it becomes a message
 * whose text is the chosen action — its payload when the send set one,
 * else its id. The tap's handle keeps the delivery nonce (and with it,
 * redelivery dedupe) stable per message and action.
 */
export function messagingMessageForAction(event: MessagingInboundAction): MessagingInboundMessage {
  return {
    type: "message",
    provider: event.provider,
    handle: event.handle,
    threadId: event.threadId,
    isDirect: event.isDirect,
    from: event.from,
    fromLabel: event.fromLabel,
    channelName: null,
    participants: [],
    content: event.value ?? event.actionId,
    mediaUrl: null,
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    ...(event.installationId ? { installationId: event.installationId } : {}),
    ...(event.installationSpaceId ? { installationSpaceId: event.installationSpaceId } : {}),
    ...(event.installationBotId ? { installationBotId: event.installationBotId } : {}),
  };
}

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** The first question in the message the bot is still waiting on, if any. */
function pendingAskOf(blocks: unknown): AskBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<MessageBlock | null>) {
    if (block?.kind !== "ask") continue;
    if (block.status !== "answered" && typeof block.text === "string") return block;
  }
  return null;
}

/**
 * Answers a tap on an ask card the mirror sent to a chat app. Returns true
 * when the tap was one of ours — fully handled here, answered or not — and
 * false when it belongs to the normal message path. The tap names the ask's
 * message and the chosen option, so it resolves directly, before any
 * command-word or message routing can misread its payload. Resolution goes
 * through the same answer path as the app: whichever surface answers first
 * wins, and a later tap only earns a short "already answered" note.
 */
export async function answerMessagingAskAction(
  deps: MessagingInboundDeps,
  event: MessagingInboundAction,
): Promise<boolean> {
  if (event.actionId !== MESSAGING_ASK_ACTION_ID) return false;
  const target = parseMessagingAskActionValue(event.value);
  if (!target) return false;
  try {
    await resolveAskTap(deps, event, target);
  } catch (error) {
    if (!(error instanceof SpaceDeletionInProgressError)) throw error;
    getLogger().info("messaging ask tap dropped", { reason: "space being deleted" });
  }
  return true;
}

async function resolveAskTap(
  deps: MessagingInboundDeps,
  event: MessagingInboundAction,
  target: { messageId: string; actionIndex: number },
): Promise<void> {
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
  });
  // An unlinked address has no pending question to answer, and a tap never provisions.
  if (!identity) return;
  if (event.installationSpaceId && identity.spaceId !== event.installationSpaceId) return;
  // A deactivated person's chat apps act for nobody.
  if (await accountDeactivated(deps.prisma, identity.userId)) return;
  // A tap is a reply like any other: it ends the consecutive-outbound streak
  // and refreshes the conversation the receipts go back to.
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { outboundSinceInbound: 0, lastInboundAt: new Date(), dmThreadId: event.threadId },
  });
  const thread = await getPrimaryThread(deps.prisma, identity.botId);
  if (!thread) return;
  const message = await deps.prisma.message.findFirst({
    where: { id: target.messageId, threadId: thread.id, role: "bot" },
    select: { id: true, runId: true, blocks: true },
  });
  if (!message?.runId) return;
  const ask = pendingAskOf(message.blocks);
  if (!ask) {
    await writeAskReceipt(deps, identity, message.id, "That question was already answered.");
    return;
  }
  if (isSecretAskBlock(ask)) {
    // Secret asks carry no buttons, so this is unreachable in practice; if a
    // payload ever names one, the answer still never happens in chat.
    await writeAskReceipt(deps, identity, message.id, secretAskNotice(deps, identity.botId, ask));
    return;
  }
  const action = ask.actions?.[target.actionIndex];
  if (!action || typeof action.id !== "string" || typeof action.label !== "string") return;
  await commitAskAnswer(deps, identity, {
    threadId: thread.id,
    runId: message.runId,
    messageId: message.id,
    answer: action.id,
    label: action.label,
  });
}

/**
 * A plain-text answer to the bot's pending choice question: a bare number
 * picks from the same numbered list the chat card showed, and an option's
 * own words pick it too. Only choices — approvals and secrets are never
 * answered from chat text, the same rule the app composer follows — and
 * anything else stays an ordinary message to the bot.
 */
async function tryAnswerPendingChoiceFromText(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  threadId: string,
  text: string,
): Promise<boolean> {
  const content = text.trim();
  if (!content) return false;
  const run = await deps.prisma.run.findFirst({
    where: { threadId, userId: identity.userId, status: "waiting_input" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const messages = await deps.prisma.message.findMany({
    where: { threadId, runId: run.id, role: "bot" },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const ask = pendingAskOf(message.blocks);
    if (!ask) continue;
    // The newest waiting question decides, and only a choice can be answered here.
    if (isApprovalAskBlock(ask) || isSecretAskBlock(ask) || !ask.actions?.length) return false;
    const numbered = /^\d{1,3}$/.test(content) ? ask.actions[Number(content) - 1] : undefined;
    const action = numbered ?? resolveAskChoice(content, ask.actions);
    if (!action) return false;
    await commitAskAnswer(deps, identity, {
      threadId,
      runId: run.id,
      messageId: message.id,
      answer: action.id,
      label: action.label,
    });
    return true;
  }
  return false;
}

/**
 * Commits one chat answer through the app's own answer path and reports the
 * outcome back into the conversation. A false from the answer path means
 * the question was settled elsewhere first — never an error, never a
 * second apply.
 */
async function commitAskAnswer(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  input: { threadId: string; runId: string; messageId: string; answer: string; label: string },
): Promise<void> {
  const answered = await deps.events.answerRunInput({
    spaceId: identity.spaceId,
    threadId: input.threadId,
    runId: input.runId,
    messageId: input.messageId,
    answeredByUserId: identity.userId,
    answer: input.answer,
  });
  if (!answered) {
    await writeAskReceipt(deps, identity, input.messageId, "That question was already answered.");
    return;
  }
  await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
    // The answer is durable; the reconciler repairs a missed immediate wake.
    getLogger().error("messaging ask answer enqueue", error);
  });
  await writeAskReceipt(deps, identity, input.messageId, `✓ ${input.label}`);
}

/** The notice a secret request gets in chat: the question, then the way into the app. */
function secretAskNotice(deps: MessagingInboundDeps, botId: string, ask: AskBlock): string {
  return deps.webOrigin
    ? `${ask.text}\n\nAnswer securely in Rakazo: ${deps.webOrigin}/app/${botId}`
    : `${ask.text}\n\nAnswer securely in the Rakazo app.`;
}

/**
 * One short follow-up per ask in the DM, keyed by the ask's message: the
 * first outcome (an answer, a refusal, an already-answered note) is the one
 * that lands, and repeat taps or redeliveries stay silent.
 */
async function writeAskReceipt(
  deps: MessagingInboundDeps,
  identity: { id: string },
  messageId: string,
  body: string,
): Promise<void> {
  const { count } = await deps.prisma.messagingOutbound.createMany({
    data: [
      { idempotencyKey: `ask-receipt:${messageId}`, kind: "dm", identityId: identity.id, body },
    ],
    skipDuplicates: true,
  });
  if (count > 0) await enqueueDeliverJob(deps);
}

/** A Space being deleted takes no messages; failing would only make the provider redeliver. */
function droppedWhileDeleting(error: unknown): void {
  if (!(error instanceof SpaceDeletionInProgressError)) throw error;
  getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
}

async function handleDirectEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  // Media that only the provider can download (Telegram file_id fetches) rides
  // along in event.attachments; CDN media keeps riding along as text.
  const attachments = event.attachments ?? [];
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");

  const where = { provider_address: { provider: event.provider, address: event.from } } as const;
  const existing = await deps.prisma.messagingIdentity.findUnique({ where });
  if (existing && event.installationSpaceId && existing.spaceId !== event.installationSpaceId)
    return;
  // A deactivated person's chat apps act for nobody: no commands, messages or links.
  if (existing && (await accountDeactivated(deps.prisma, existing.userId))) return;
  if (existing) {
    // Any reply — even a content-free reaction — ends the consecutive-
    // outbound streak, but only real text wakes the bot. The conversation
    // id is refreshed from the webhook so outbound always has a thread.
    await deps.prisma.messagingIdentity.update({
      where: { id: existing.id },
      data: { outboundSinceInbound: 0, lastInboundAt: new Date(), dmThreadId: event.threadId },
    });
    if (!text && attachments.length === 0) return;
    // Owner commands are only parsed in the verified 1:1 conversation.
    const command = parseMessagingCommand(event.content);
    if (command === "stop") {
      // Only a bare "stop" is the command; one carrying media is delivered as a message.
      if (attachments.length === 0 && !event.mediaUrl) {
        await stopOwnerWork(deps, existing, event);
        return;
      }
    } else if (command && (await applyOwnerCommand(deps, existing, command))) return;
    // A linked sender pasting a fresh code re-points this address at another
    // of their bots (only their own codes apply).
    if (await tryRedeemLinkCode(deps, event)) return;
  } else {
    // Unlinked senders: a valid link code binds this address to its issuer's
    // account and bot; otherwise the line is silent unless the deployment
    // explicitly runs as an open Poke-style signup line.
    if (await tryRedeemLinkCode(deps, event)) return;
    if (!deps.openSignup || event.installationSpaceId) return;
    // Media-only delivery is for linked identities; retain text-based signup.
    if (!text) return;
  }

  let ids: ProvisionedMessagingIdentity;
  if (existing) {
    const thread = await getPrimaryThread(deps.prisma, existing.botId);
    if (!thread) throw new Error(`messaging identity ${existing.id} has no thread`);
    ids = {
      provider: existing.provider,
      address: existing.address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    ids = await deps.provision(
      {
        provider: event.provider,
        address: event.from,
        dmThreadId: event.threadId,
        displayName: event.fromLabel ? sanitizeMessagingLabel(event.fromLabel) : null,
      },
      deps.signupPolicy,
    );
  }

  // Slash commands (/bot, /new, /queue, /steer, /model, /help) act on the
  // sender's own line and never reach the bot as messages. Only a linked
  // sender has any, and a message carrying media stays a message.
  if (existing && attachments.length === 0 && !event.mediaUrl) {
    const slash = parseMessagingSlashCommand(event.content);
    if (slash && (await applyDirectSlashCommand(deps, existing, ids, event, slash))) return;
  }

  // A bare number or an option's own words answers the bot's pending choice
  // question instead of starting a new turn. Only a linked sender can have
  // one waiting, and a message carrying media stays a message.
  if (existing && attachments.length === 0 && !event.mediaUrl) {
    if (await tryAnswerPendingChoiceFromText(deps, existing, ids.threadId, text)) return;
  }

  const stored = await storeInboundMedia(deps, ids, event);

  // Message-trigger routines own the delivery when configured. Do not also
  // start a normal messaging continue for the same inbound handle.
  if (
    await wakeMessageRoutines(deps, ids, event, {
      artifacts: stored.artifacts,
      unavailable: stored.unavailable,
    })
  )
    return;
  const body = [text, ...stored.unavailable].filter(Boolean).join("\n");
  const sent = await deps.events.sendUserMessage({
    spaceId: ids.spaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    // The address is verified as this person\'s, so the line is theirs.
    authorUserId: ids.userId,
    blocks: [
      ...(body ? [{ kind: "text" as const, text: body }] : []),
      ...stored.artifacts.map((artifact) => messageBlockForArtifact(artifact)),
    ],
    prompt: promptTextForAttachments(body, stored.artifacts),
    trigger: "messaging",
    clientNonce: `messaging:${event.provider}:${event.handle}`,
  });
  if (sent.runId) {
    const runId = sent.runId;
    deps.acknowledge?.(event.threadId, event.handle, async () => {
      const run = await deps.prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, messagingMirroredAt: true },
      });
      if (!run) return false;
      // A failed or cancelled run may never be mirrored, and no reply is coming.
      if (run.status === "failed" || run.status === "cancelled") return true;
      if (!run.messagingMirroredAt) return false;
      // Mirroring only queues the reply in the outbox. It has gone out once
      // none of this run's queued rows are still waiting to be sent.
      const replies = await deps.prisma.message.findMany({
        where: { runId, role: "bot" },
        select: { id: true },
      });
      if (replies.length === 0) return true;
      const unsent = await deps.prisma.messagingOutbound.count({
        where: {
          sourceMessageId: { in: replies.map((reply) => reply.id) },
          status: { not: "sent" },
        },
      });
      return unsent === 0;
    });
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("messaging inbound run enqueue error", error);
    });
  }
}

/** Time for all voice note transcripts of one inbound message; files are delivered without them after it. */
const VOICE_TRANSCRIBE_BUDGET_MS = 20_000;

/**
 * How far a roster's platform time may run ahead of the server's clock and still count
 * as the roster's version; further ahead the event applies its membership unversioned.
 */
const ROSTER_TIME_SKEW_MS = 5 * 60_000;

/** Download provider-held files into thread artifacts, then transcribe voice notes. */
async function storeInboundMedia(
  deps: MessagingInboundDeps,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
) {
  const { stored, unavailable } = await storeInboundAttachments(
    deps.storeAttachment,
    ids,
    event.attachments ?? [],
    {
      clientNonce: (index) => `messaging-attachment:${event.provider}:${event.handle}:${index}`,
      limit: ATTACHMENT_MAX_COUNT,
      downloadDeadline: Date.now() + 2_000,
    },
  );
  // Transcribe only after every download, so a slow transcription cannot use up the
  // download deadline of the attachments that follow it. One short budget covers all
  // transcripts, so the webhook is answered before the provider retries it.
  const transcribeDeadline = Date.now() + VOICE_TRANSCRIBE_BUDGET_MS;
  const artifacts: StoredAttachment[] = [];
  for (const { artifact, bytes } of stored) {
    artifacts.push(await withVoiceTranscript(deps, ids, artifact, bytes, transcribeDeadline));
  }
  return { artifacts, unavailable };
}

/**
 * Best-effort transcript for a stored audio attachment. No provider, oversize
 * audio or a failed call leaves the artifact unchanged, so the message is
 * still delivered with the file reference.
 */
async function withVoiceTranscript(
  deps: MessagingInboundDeps,
  ids: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId">,
  artifact: StoredAttachment,
  bytes: Uint8Array | undefined,
  deadline: number,
): Promise<StoredAttachment> {
  if (!deps.transcribe || !bytes || !isAttachmentAudioMimeType(artifact.mimeType)) return artifact;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return artifact;
  // The timer both stops waiting and cancels the provider call, so a stalled
  // request does not keep running after the message is delivered without it.
  const cancel = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      cancel.abort();
      resolve(null);
    }, remaining);
  });
  const call = deps
    .transcribe({
      spaceId: ids.spaceId,
      userId: ids.userId,
      audio: bytes,
      mimeType: artifact.mimeType,
      signal: cancel.signal,
    })
    .catch((error) => {
      // Reason only: the audio and the transcript never reach the log.
      getLogger().warn("messaging attachment transcription failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const transcript = await Promise.race([call, timedOut]).finally(() => clearTimeout(timer));
  // Normalized once here, so the direct prompt and the routine payload carry the same bounded text.
  const normalized = normalizeVoiceTranscript(transcript);
  return normalized ? { ...artifact, transcript: normalized } : artifact;
}

/** Wake provider-neutral message routines through the same approval boundary as webhooks. */
export async function wakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma" | "events" | "jobs">,
  target: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId" | "botId" | "threadId">,
  event: MessagingInboundMessage,
  options?: {
    /** Wake clientNonce prefix; must match TeamChatBridge.providerId when event.provider differs. */
    deliveryProvider?: string;
    artifacts?: StoredAttachment[];
    unavailable?: string[];
    /**
     * TeamChat external message id. When set, atomically reassert routine
     * ownership before creating a run so a concurrent TeamChat agent claim
     * cannot also deliver for the same provider event.
     */
    externalMessageId?: string;
  },
): Promise<boolean> {
  const routines = await deps.prisma.routine.findMany({
    where: {
      botId: target.botId,
      spaceId: target.spaceId,
      // The wake runs as the identity's person, so only their own routines may ride on it.
      userId: target.userId,
      active: true,
      messageProvider: event.provider,
    },
    select: {
      id: true,
      name: true,
      prompt: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (routines.length === 0) return false;

  if (options?.externalMessageId) {
    // CAS: only deliver when agent ownership has not claimed the row. Holding
    // message_routine_routing blocks TeamChat queue() from creating a parallel run.
    const reserved = await deps.prisma.externalMessage.updateMany({
      where: {
        id: options.externalMessageId,
        status: { in: ["deferred", "received", "observed"] },
        OR: [
          { engagementReason: null },
          {
            engagementReason: {
              in: [MESSAGE_ROUTING_REASON, MESSAGE_ROUTING_REARMED_REASON],
            },
          },
        ],
      },
      data: {
        engagementReason: MESSAGE_ROUTING_REASON,
        // Outlive a dead heartbeat so reconcile cannot promote to agent mid-wake.
        nextAttemptAt: new Date(Date.now() + MESSAGE_ROUTING_RESERVATION_MS),
      },
    });
    if (reserved.count !== 1) return false;
  }

  const provider = inboundEventName(event.provider);
  const prompt = formatUntrustedDeliveryPayload(`[Messaging Event: ${provider}]`, {
    provider: event.provider,
    kind: event.isDirect ? "direct" : "channel",
    handle: event.handle,
    from: event.from,
    fromLabel: event.fromLabel,
    channelName: event.channelName,
    content: event.content,
    mediaUrl: event.mediaUrl,
    ...(options?.unavailable?.length ? { unavailable: options.unavailable } : {}),
    ...(event.attachments?.length
      ? {
          files: event.attachments.map(({ name, mimeType, size }) => ({
            name,
            mimeType,
            size,
          })),
        }
      : {}),
    ...(options?.artifacts?.some((artifact) => artifact.transcript)
      ? {
          voiceTranscripts: options.artifacts
            .filter((artifact) => artifact.transcript)
            .map((artifact) => ({ name: artifact.name, transcript: artifact.transcript })),
        }
      : {}),
  });
  await deliverWebhookEvent(
    { events: deps.events, jobs: deps.jobs },
    {
      bot: { id: target.botId, spaceId: target.spaceId, userId: target.userId },
      threadId: target.threadId,
    },
    {
      prompt,
      artifacts: options?.artifacts,
      routines,
      source: "messaging",
      idempotencyKey: messagingWakeIdempotencyKey(
        options?.deliveryProvider ?? event.provider,
        event.handle,
      ),
      // TeamChat channel wakes may share a live thread with an active chat run.
      allowParallelRun: true,
    },
  );
  return true;
}

/**
 * TeamChat engagement can still receive the message, but unattended
 * message-routine wakes reuse the personal-line approval boundary:
 * linked identity for DMs; approved channel member when we have membership
 * state; otherwise a linked identity so public-channel strangers cannot start
 * active routines.
 */
export async function teamChatSenderCanWakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma">,
  event: MessagingInboundMessage,
): Promise<boolean> {
  if (event.senderIsBot) return false;

  const linkedIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { id: true, userId: true },
  });
  // A deactivated person counts as unlinked: like anyone in the workspace, never as themselves.
  if (linkedIdentity && (await accountDeactivated(deps.prisma, linkedIdentity.userId)))
    return false;

  if (event.isDirect) return Boolean(linkedIdentity);

  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { threadId: event.threadId },
    select: { id: true },
  });
  if (channel) {
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address: event.from } },
      select: { status: true },
    });
    return member?.status === "approved";
  }

  // Pure TeamChat workspace rooms have no personal membership ledger.
  // Still require a linked sender before waking message routines.
  return Boolean(linkedIdentity);
}

/**
 * Returns true when the message was exactly a link code that redeemed:
 * the address is now bound to the issuer's chosen bot and a confirmation
 * DM is on its way. An invalid or expired code falls through silently —
 * for linked senders it reads as a normal message, for strangers nothing
 * happens (no oracle, no reply spam).
 */
async function tryRedeemLinkCode(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<boolean> {
  const code = normalizeMessagingLinkCode(event.content);
  if (!code) return false;
  const redeemed = await redeemMessagingLinkCode(
    deps.prisma,
    {
      code,
      provider: event.provider,
      address: event.from,
      dmThreadId: event.threadId,
      spaceId: event.installationSpaceId,
      installationId: event.installationId,
    },
    async (tx, linked) => {
      const bot = await tx.bot.findUnique({
        where: { id: linked.botId },
        select: { name: true },
      });
      await writeConfirmation(
        tx,
        { id: linked.identityId },
        linked.confirmationKey,
        `Linked. Messages here now reach "${bot?.name ?? "your agent"}".`,
      );
    },
  );
  if (!redeemed) return false;
  await enqueueDeliverJob(deps);
  return true;
}

/**
 * The owner's "stop", an owner command like YES/NO/LEAVE: Stop for their bot's chat, always
 * answered by text. The answer's row, written first, is this delivery's receipt, so a
 * redelivered or concurrent copy finds it and changes nothing.
 */
async function stopOwnerWork(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  event: MessagingInboundMessage,
): Promise<void> {
  const thread = await deps.prisma.thread.findFirstOrThrow({
    where: { botId: identity.botId, isPrimary: true },
    select: { id: true },
  });
  const key = `command:stop:${identity.id}:${event.handle}`;
  const target = { kind: "bot", botId: identity.botId, threadId: thread.id } as const;
  const stop = await deps.prisma.$transaction(async (tx) => {
    const receipt = await tx.messagingOutbound.createMany({
      data: [
        { idempotencyKey: key, kind: "dm", identityId: identity.id, body: "Nothing is running." },
      ],
      skipDuplicates: true,
    });
    if (receipt.count === 0) return null;
    const stop = await cancelThreadRuns(identity, target, { botId: identity.botId })(tx);
    if (stop.runIds.length) {
      await tx.messagingOutbound.update({
        where: { idempotencyKey: key },
        data: { body: STOPPED_BY_MESSAGE_NOTE },
      });
    }
    return stop;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await enqueueDeliverJob(deps);
  if (stop?.runIds.length) await finishThreadStop(deps, identity, target, stop);
}

/** How long a channel invite or connection request can be answered by text. */
export const TEXT_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one request a bare YES or NO answers: the request whose prompt is the newest message this
 * line delivered to the person, sent within the answer window and still pending. Anything said since,
 * by the bot or the product, makes the reply an ordinary message.
 */
async function answeredRequest(deps: MessagingInboundDeps, identity: IdentityRow) {
  const latest = await deps.prisma.messagingOutbound.findFirst({
    where: { identityId: identity.id, kind: "dm", status: { in: ["pending", "sent"] } },
    orderBy: { createdAt: "desc" },
    select: { idempotencyKey: true, createdAt: true, status: true },
  });
  if (
    latest?.status !== "sent" ||
    Date.now() - latest.createdAt.getTime() > TEXT_ANSWER_WINDOW_MS
  ) {
    return null;
  }
  const [kind, first, second] = latest.idempotencyKey.split(":");
  if (kind === "invite" && first && second === identity.id) {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { channelId: first, identityId: identity.id, status: "invited" },
    });
    return membership ? ({ kind: "channel", membership } as const) : null;
  }
  if (kind === "connect" && first && second === identity.botId) {
    const connection = await deps.prisma.agentConnection.findFirst({
      where: { requesterBotId: first, targetBotId: identity.botId, status: "pending" },
    });
    return connection ? ({ kind: "connection", connection } as const) : null;
  }
  return null;
}

/** Returns true when the command matched a pending item and was handled. */
async function applyOwnerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  command: Exclude<MessagingCommand, "stop">,
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    // One transaction, so a failed confirmation leaves the membership as it
    // was and a redelivered LEAVE cannot move on to the next group.
    const claimed = await deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: membership.id, status: "approved" },
        data: { status: "left" },
      });
      // State changed under us (e.g. swept out and re-invited): treat the
      // text as a normal message rather than overwriting the newer state.
      if (count === 0) return false;
      await writeConfirmation(
        tx,
        identity,
        `command:leave:${membership.id}`,
        "You've left the channel. Your agent will no longer post there. The group chat itself is unchanged.",
      );
      return true;
    });
    if (!claimed) return false;
    await enqueueDeliverJob(deps);
    return true;
  }

  const target = await answeredRequest(deps, identity);
  if (!target) return false;
  const approved = command === "approve";

  if (target.kind === "channel") {
    const key = `command:${command}:${target.membership.id}`;
    const claimed = await deps.prisma.$transaction(async (tx) => {
      // The claim holds the membership row lock through commit, so the
      // participant sweep can never interleave with the confirmation write.
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) return false;
      await writeConfirmation(
        tx,
        identity,
        key,
        approved
          ? "You're in. Your agent will now see and reply to that group."
          : "No problem, your agent will stay out of that group.",
      );
      return true;
    });
    if (!claimed) return false;
    await enqueueDeliverJob(deps);
    return true;
  }

  const connectedKey = `command:connected:${target.connection.id}`;
  const requesterIdentity = approved
    ? await deps.prisma.messagingIdentity.findUnique({
        where: { botId: target.connection.requesterBotId },
      })
    : null;
  const key = `command:${command}:${target.connection.id}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    // The claim holds the connection row lock through commit, so a revoke
    // can never interleave with the confirmation writes.
    if (
      approved &&
      !(await crossSpaceCommunicationAllowed(tx, target.connection.requesterBotId, identity.botId))
    )
      return false;
    const { count } = await tx.agentConnection.updateMany({
      where: { id: target.connection.id, status: "pending" },
      data: { status: approved ? "approved" : "declined" },
    });
    // Revoked or answered elsewhere since the read: not ours to write.
    if (count === 0) return false;
    await writeConfirmation(
      tx,
      identity,
      key,
      approved
        ? "Connection approved. Your agents can now message each other."
        : "Connection declined.",
    );
    if (requesterIdentity) {
      await writeConfirmation(
        tx,
        requesterIdentity,
        connectedKey,
        "Your connection request was accepted. Your agents can now message each other.",
      );
    }
    return true;
  });
  if (!claimed) return false;
  await enqueueDeliverJob(deps);
  return true;
}

/** Delete-then-insert so the prior cycle's row cannot suppress the new confirmation. */
async function writeConfirmation(
  tx: Pick<Prisma.TransactionClient, "messagingOutbound">,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
  await tx.messagingOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    skipDuplicates: true,
  });
}

async function enqueueDeliverJob(deps: MessagingInboundDeps): Promise<void> {
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging confirmation enqueue error", error);
  });
}

/** A command's short answer into the conversation it was sent in, keyed so a redelivery lands once. */
type CommandReplier = (key: string, body: string) => Promise<void>;

function dmReplier(deps: MessagingInboundDeps, identity: { id: string }): CommandReplier {
  return async (key, body) => {
    const { count } = await deps.prisma.messagingOutbound.createMany({
      data: [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
      skipDuplicates: true,
    });
    if (count > 0) await enqueueDeliverJob(deps);
  };
}

function channelReplier(deps: MessagingInboundDeps, threadId: string): CommandReplier {
  return async (key, body) => {
    await insertOutboundRows(deps.prisma, { identityId: null, threadId }, [
      { idempotencyKey: key, kind: "group", threadId, body },
    ]);
    await enqueueDeliverJob(deps);
  };
}

/** The person's own bots in the identity's Space, oldest first — the /bot command's universe. */
async function botsForIdentity(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
): Promise<Array<{ id: string; name: string }>> {
  return deps.prisma.bot.findMany({
    where: { userId: identity.userId, spaceId: identity.spaceId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
}

type BotSwitchOutcome =
  | { status: "switched"; bot: { id: string; name: string } }
  | { status: "already"; bot: { id: string; name: string } }
  | { status: "linked-elsewhere" }
  | { status: "not-found" };

/**
 * The /bot switch: the same write the app's chat-app settings make
 * (identities.setBot) with the same checks — the bot must be the person's
 * own, live, and in the identity's Space, and botId's uniqueness is the
 * database's, so a bot linked to another of their lines refuses here
 * exactly as it refuses there.
 */
async function switchIdentityBot(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  botId: string,
): Promise<BotSwitchOutcome> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, userId: identity.userId, spaceId: identity.spaceId, archivedAt: null },
    select: { id: true, name: true, spaceId: true },
  });
  if (!bot) return { status: "not-found" };
  if (identity.botId === bot.id) return { status: "already", bot };
  try {
    await deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { botId: bot.id, spaceId: bot.spaceId },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "linked-elsewhere" };
    throw error;
  }
  return { status: "switched", bot };
}

function botSwitchText(outcome: BotSwitchOutcome, argument?: string): string {
  switch (outcome.status) {
    case "switched":
      return `This chat now talks to ${outcome.bot.name}.`;
    case "already":
      return `This chat already talks to ${outcome.bot.name}.`;
    case "linked-elsewhere":
      return "That bot is already linked to a chat app.";
    case "not-found":
      return argument
        ? `No bot named "${argument}" here. Send /bot to see your bots.`
        : "That bot isn't available anymore. Send /bot for a fresh list.";
  }
}

/** A typed bot name: an exact (case-insensitive) match, else one unambiguous prefix. */
async function resolveNamedBot(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  argument: string,
): Promise<
  | { status: "one"; bot: { id: string; name: string } }
  | { status: "ambiguous"; bots: Array<{ id: string; name: string }> }
  | { status: "none" }
> {
  const bots = await botsForIdentity(deps, identity);
  const wanted = argument.toLowerCase();
  const exact = bots.filter((bot) => bot.name.toLowerCase() === wanted);
  if (exact.length === 1) return { status: "one", bot: exact[0]! };
  if (exact.length > 1) return { status: "ambiguous", bots: exact };
  const prefix = bots.filter((bot) => bot.name.toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return { status: "one", bot: prefix[0]! };
  if (prefix.length > 1) return { status: "ambiguous", bots: prefix };
  return { status: "none" };
}

async function applyBotCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  argument: string | null,
  reply: CommandReplier,
  keyBase: string,
  withPicker: boolean,
): Promise<void> {
  if (!argument) {
    const bots = await botsForIdentity(deps, identity);
    const current = bots.find((bot) => bot.id === identity.botId);
    if (bots.length <= 1) {
      await reply(
        `command:bot:${keyBase}`,
        current
          ? `This chat talks to ${current.name} — your only bot in this space.`
          : "You have no bots in this space yet.",
      );
      return;
    }
    if (withPicker) {
      await reply(
        `picker:bot:${identity.id}:${keyBase}`,
        "Which bot should this chat talk to? Tap one, or send /bot <name>.",
      );
    } else {
      await reply(
        `command:bot:${keyBase}`,
        `Bots in this space: ${bots.map((bot) => bot.name).join(", ")}. Send /bot <name> to switch this chat.`,
      );
    }
    return;
  }
  const resolved = await resolveNamedBot(deps, identity, argument);
  if (resolved.status === "none") {
    await reply(`command:bot:${keyBase}`, botSwitchText({ status: "not-found" }, argument));
    return;
  }
  if (resolved.status === "ambiguous") {
    if (withPicker) {
      await reply(
        `picker:bot:${identity.id}:${keyBase}`,
        `More than one bot matches "${argument}". Tap the one you mean, or send its full name.`,
      );
    } else {
      await reply(
        `command:bot:${keyBase}`,
        `More than one bot matches "${argument}": ${resolved.bots.map((bot) => bot.name).join(", ")}. Send the full name to switch.`,
      );
    }
    return;
  }
  const outcome = await switchIdentityBot(deps, identity, resolved.bot.id);
  await reply(`command:bot:${keyBase}`, botSwitchText(outcome, argument));
}

/** A bot's model-relevant state, as the app's model picker reads it. */
async function botModelState(deps: MessagingInboundDeps, botId: string) {
  return deps.prisma.bot.findFirst({
    where: { id: botId },
    select: { id: true, name: true, modelProvider: true, modelId: true, thinkingLevel: true },
  });
}

type BotModelState = NonNullable<Awaited<ReturnType<typeof botModelState>>>;

/** How many models a plain-text /model answer lists; the picker and the app show the rest. */
const MODEL_LIST_LIMIT = 12;

function currentModelLabel(choices: MessagingModelChoice[], bot: BotModelState): string | null {
  if (!bot.modelId) return null;
  return (
    choices.find((choice) => choice.provider === bot.modelProvider && choice.id === bot.modelId)
      ?.label ?? `${bot.modelProvider}/${bot.modelId}`
  );
}

/** Persist a chosen model through the command's model seam and say so, or say why not. */
async function applyModelChoice(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  bot: BotModelState,
  choice: { provider: string; model: string },
  label: string,
  reply: CommandReplier,
  keyBase: string,
): Promise<void> {
  if (!deps.models) return;
  const result = await deps.models.apply(
    { userId: identity.userId, spaceId: identity.spaceId },
    bot,
    choice,
  );
  if (!result.ok) {
    await reply(`command:model:${keyBase}`, `Couldn't switch the model: ${result.error}`);
    return;
  }
  await reply(`command:model:${keyBase}`, `Model set to ${label}.`);
}

async function applyModelCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  argument: string | null,
  reply: CommandReplier,
  keyBase: string,
  withPicker: boolean,
): Promise<void> {
  if (!deps.models) {
    await reply(`command:model:${keyBase}`, "Model switching isn't available on this line.");
    return;
  }
  const scope = { userId: identity.userId, spaceId: identity.spaceId };
  const bot = await botModelState(deps, identity.botId);
  if (!bot) {
    await reply(`command:model:${keyBase}`, "This chat has no bot to switch.");
    return;
  }
  if (!argument) {
    const choices = await deps.models.choices(scope);
    const current = currentModelLabel(choices, bot);
    if (choices.length === 0) {
      await reply(
        `command:model:${keyBase}`,
        `${bot.name} uses ${current ?? "the deployment default model"}. No models are connected yet — add one in Settings → Models.`,
      );
      return;
    }
    if (withPicker) {
      await reply(
        `picker:model:${identity.id}:${keyBase}`,
        `${bot.name} currently uses ${current ?? "the deployment default"}. Which model should it use? Tap one, or send /model <id>.`,
      );
    } else {
      const listed = choices
        .slice(0, MODEL_LIST_LIMIT)
        .map((choice) => `${choice.label} (${choice.provider}/${choice.id})`)
        .join(", ");
      await reply(
        `command:model:${keyBase}`,
        `${bot.name} currently uses ${current ?? "the deployment default"}.\nModels: ${listed}.\nSend /model <id> to switch.`,
      );
    }
    return;
  }
  const resolved = await deps.models.resolve(scope, argument, bot.modelProvider);
  if (!resolved) {
    await reply(
      `command:model:${keyBase}`,
      `I couldn't find a connected model called "${argument}". Send /model to see the list.`,
    );
    return;
  }
  const choices = await deps.models.choices(scope);
  const label =
    choices.find((choice) => choice.provider === resolved.provider && choice.id === resolved.model)
      ?.label ?? `${resolved.provider}/${resolved.model}`;
  await applyModelChoice(deps, identity, bot, resolved, label, reply, keyBase);
}

/**
 * /queue and /steer: the text joins the thread through the executor's own
 * steering store — addressed to the run holding the thread, or held for
 * the follow-up that run's finish starts. With nothing running, the
 * command's text simply goes as the message it would have been.
 */
async function applyQueueSteerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  input: {
    threadId: string;
    mode: "queue" | "steer";
    text: string;
    reply: CommandReplier;
    keyBase: string;
    clientNonce: string;
    sendAsMessage: (text: string) => Promise<void>;
  },
): Promise<void> {
  if (!input.text) {
    await input.reply(
      `command:${input.mode}:${input.keyBase}`,
      input.mode === "queue"
        ? "Send /queue <message> — it goes right after the current run finishes."
        : "Send /steer <message> — it reaches the run in progress.",
    );
    return;
  }
  const inserted = await insertMessagingSteeringMessage(deps.prisma, {
    spaceId: identity.spaceId,
    threadId: input.threadId,
    botId: identity.botId,
    userId: identity.userId,
    authorUserId: identity.userId,
    blocks: [{ kind: "text", text: input.text }],
    clientNonce: input.clientNonce,
    mode: input.mode,
  });
  if (inserted.eventSeq != null) {
    await deps.events.notify(input.threadId, inserted.eventSeq).catch(() => undefined);
  }
  switch (inserted.outcome) {
    case "steered":
      await input.reply(
        `command:steer:${input.keyBase}`,
        "Steering noted — it joins the current run.",
      );
      return;
    case "queued":
      await input.reply(
        `command:queue:${input.keyBase}`,
        "Queued — it goes right after the current run finishes.",
      );
      return;
    case "duplicate":
      // A redelivery: the first copy already wrote and answered.
      return;
    case "no-active-run":
      await input.sendAsMessage(input.text);
      return;
  }
}

/** /new in a DM: the app's own Clear conversation, then its best-effort follow-through. */
async function applyNewConversationCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  threadId: string,
  reply: CommandReplier,
  keyBase: string,
): Promise<void> {
  const cleared = await deps.events.clearThread({
    spaceId: identity.spaceId,
    threadId,
    botId: identity.botId,
  });
  if (deps.afterThreadClear) {
    await deps
      .afterThreadClear({
        spaceId: identity.spaceId,
        userId: identity.userId,
        threadId,
        botId: identity.botId,
        cancelledRunIds: cleared.cancelledRunIds,
        historyCompactionGeneration: cleared.historyCompactionGeneration,
      })
      .catch((error) => {
        getLogger().error("messaging /new follow-through failed", error);
      });
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: identity.botId },
    select: { name: true },
  });
  await reply(
    `command:new:${keyBase}`,
    `Started a fresh conversation with ${bot?.name ?? "your bot"}.`,
  );
}

/**
 * /new in a group: the fresh conversation gets its own forum topic where
 * the platform has topics — the topic is a channel of its own, bound by
 * its channel row like any topic the group made itself. Everywhere else
 * the group keeps one shared conversation, and the command says so.
 */
async function applyNewTopicCommand(
  deps: MessagingInboundDeps,
  input: {
    event: MessagingInboundMessage;
    channel: { id: string; threadId: string };
    identity: IdentityRow;
    reply: CommandReplier;
    keyBase: string;
  },
): Promise<void> {
  const { event, channel, identity, reply, keyBase } = input;
  if (!deps.createTopic) {
    await reply(
      `command:new:${keyBase}`,
      "Separate threads aren't available in this chat — topics only exist in Telegram groups with Topics turned on.",
    );
    return;
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: identity.botId },
    select: { name: true },
  });
  const topicName = `New chat · ${bot?.name ?? "your bot"}`;
  const created = await deps
    .createTopic(event.provider, event.threadId, topicName)
    .catch((error) => {
      getLogger().error("messaging /new topic creation failed", error);
      return null;
    });
  if (!created) {
    await reply(
      `command:new:${keyBase}`,
      "I couldn't open a topic here. Topics need a Telegram group with Topics turned on, with me as an admin.",
    );
    return;
  }
  await deps.prisma.messagingChannel.upsert({
    where: { threadId: created },
    create: { provider: event.provider, threadId: created, name: topicName },
    update: {},
  });
  await channelReplier(deps, created)(
    `command:new:${channel.id}:${event.handle}:topic`,
    "Fresh conversation started here. This topic is its own thread — messages here stay here.",
  );
  await reply(
    `command:new:${keyBase}`,
    `Started a fresh conversation in a new topic: "${topicName}".`,
  );
}

/** Slash commands in the owner's DM. Always handled: a command is never a message. */
async function applyDirectSlashCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
  slash: MessagingSlashCommand,
): Promise<boolean> {
  const reply = dmReplier(deps, identity);
  switch (slash.name) {
    case "help":
      await reply(`command:help:${event.handle}`, MESSAGING_COMMANDS_HELP);
      return true;
    case "bot":
      await applyBotCommand(deps, identity, slash.argument, reply, event.handle, true);
      return true;
    case "model":
      await applyModelCommand(deps, identity, slash.argument, reply, event.handle, true);
      return true;
    case "new":
      await applyNewConversationCommand(deps, identity, ids.threadId, reply, event.handle);
      return true;
    case "queue":
    case "steer":
      await applyQueueSteerCommand(deps, identity, {
        threadId: ids.threadId,
        mode: slash.name,
        text: slash.text,
        reply,
        keyBase: event.handle,
        clientNonce: `messaging:${event.provider}:${event.handle}`,
        sendAsMessage: async (text) => {
          const sent = await deps.events.sendUserMessage({
            spaceId: ids.spaceId,
            threadId: ids.threadId,
            botId: ids.botId,
            userId: ids.userId,
            authorUserId: ids.userId,
            blocks: [{ kind: "text" as const, text }],
            prompt: text,
            trigger: "messaging",
            clientNonce: `messaging:${event.provider}:${event.handle}`,
          });
          if (sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("messaging command fallback enqueue error", error);
            });
          }
        },
      });
      return true;
  }
}

/**
 * Slash commands in a linked group, for the sender's own line only.
 * Pickers degrade to text here (the group's outbox rows carry no
 * buttons); everything else behaves as in a DM.
 */
async function applyChannelSlashCommand(
  deps: MessagingInboundDeps,
  input: {
    event: MessagingInboundMessage;
    channel: { id: string; threadId: string; name: string | null };
    identity: IdentityRow;
    fromLabel: string;
    slash: MessagingSlashCommand;
  },
): Promise<boolean> {
  const { event, channel, identity, fromLabel, slash } = input;
  const reply = channelReplier(deps, channel.threadId);
  const keyBase = `${channel.id}:${event.handle}`;
  switch (slash.name) {
    case "help":
      await reply(`command:help:${keyBase}`, MESSAGING_COMMANDS_HELP);
      return true;
    case "bot":
      await applyBotCommand(deps, identity, slash.argument, reply, keyBase, false);
      return true;
    case "model":
      await applyModelCommand(deps, identity, slash.argument, reply, keyBase, false);
      return true;
    case "new":
      await applyNewTopicCommand(deps, { event, channel, identity, reply, keyBase });
      return true;
    case "queue":
    case "steer": {
      const thread = await getPrimaryThread(deps.prisma, identity.botId);
      if (!thread) return true;
      await applyQueueSteerCommand(deps, identity, {
        threadId: thread.id,
        mode: slash.name,
        text: slash.text,
        reply,
        keyBase,
        clientNonce: `messaging:${event.provider}:${event.handle}`,
        sendAsMessage: async (text) => {
          const target = {
            spaceId: identity.spaceId,
            userId: identity.userId,
            botId: identity.botId,
            threadId: thread.id,
          };
          // Message-trigger routines own the delivery when configured,
          // exactly as they do for a plain group message to this bot.
          if (await wakeMessageRoutines(deps, target, event)) return;
          const block: MessageBlock = {
            kind: "channel_message",
            provider: event.provider,
            ...(event.transport ? { transport: event.transport } : {}),
            channelId: channel.id,
            fromAddress: event.from,
            fromLabel,
            text,
            hop: 0,
          };
          const sent = await deps.events.sendUserMessage({
            ...target,
            blocks: [block],
            prompt: `[Group "${channel.name ?? "group"}", ${fromLabel}]: ${text}`,
            trigger: "messaging",
            clientNonce: `messaging:${event.provider}:${event.handle}`,
          });
          if (sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("messaging command fallback enqueue error", error);
            });
          }
        },
      });
      return true;
    }
  }
}

/**
 * Answers a tap on a /bot or /model picker card. Returns true when the
 * tap was one of ours — fully handled here, applied or not — and false
 * when it belongs to the normal message path. Like an ask tap, a picker
 * tap resolves against the tapper's own identity: the card may sit in a
 * conversation anyone can read, but the switch it performs is always
 * the tapper's own.
 */
export async function answerMessagingPickerAction(
  deps: MessagingInboundDeps,
  event: MessagingInboundAction,
): Promise<boolean> {
  if (
    event.actionId !== MESSAGING_BOT_PICKER_ACTION_ID &&
    event.actionId !== MESSAGING_MODEL_PICKER_ACTION_ID
  )
    return false;
  try {
    await resolvePickerTap(deps, event);
  } catch (error) {
    if (!(error instanceof SpaceDeletionInProgressError)) throw error;
    getLogger().info("messaging picker tap dropped", { reason: "space being deleted" });
  }
  return true;
}

async function resolvePickerTap(
  deps: MessagingInboundDeps,
  event: MessagingInboundAction,
): Promise<void> {
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
  });
  // An unlinked address has nothing to switch, and a tap never provisions.
  if (!identity) return;
  if (event.installationSpaceId && identity.spaceId !== event.installationSpaceId) return;
  if (await accountDeactivated(deps.prisma, identity.userId)) return;
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { outboundSinceInbound: 0, lastInboundAt: new Date(), dmThreadId: event.threadId },
  });
  const reply = dmReplier(deps, identity);
  if (event.actionId === MESSAGING_BOT_PICKER_ACTION_ID) {
    const botId = parseMessagingBotPickerValue(event.value);
    if (!botId) return;
    const outcome = await switchIdentityBot(deps, identity, botId);
    await reply(`command:bot:${event.handle}`, botSwitchText(outcome));
    return;
  }
  const index = parseMessagingModelPickerValue(event.value);
  if (index === null || !deps.models) return;
  const scope = { userId: identity.userId, spaceId: identity.spaceId };
  const choices = await deps.models.choices(scope);
  const choice = choices[index];
  if (!choice) {
    await reply(
      `command:model:${event.handle}`,
      "That model list has changed — send /model for a fresh list.",
    );
    return;
  }
  const bot = await botModelState(deps, identity.botId);
  if (!bot) return;
  await applyModelChoice(
    deps,
    identity,
    bot,
    { provider: choice.provider, model: choice.id },
    choice.label,
    reply,
    event.handle,
  );
}

async function handleChannelEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const channelName = event.channelName ? sanitizeMessagingLabel(event.channelName) : null;
  const channel = await deps.prisma.messagingChannel.upsert({
    where: { threadId: event.threadId },
    create: { provider: event.provider, threadId: event.threadId, name: channelName },
    update: channelName ? { name: channelName } : {},
  });

  // Telegram reports departures one service message at a time; a rosterless
  // platform has no sweep, so this delta is the only removal signal. Our own
  // bot leaving ends every membership: nothing more is delivered there. The
  // event itself carries no conversation — no intro, no run — and it runs before
  // member discovery, so a departing sender is never invited or announced.
  if (event.departures) {
    // Leaving the chat ends membership in every conversation of it: forum topics
    // are channels of their own (`<provider>:<chat>:<topic>`) on the same mount.
    const chat = event.threadId.split(":").slice(0, 2).join(":");
    const chatChannels = await deps.prisma.messagingChannel.findMany({
      where: {
        provider: event.provider,
        OR: [{ threadId: chat }, { threadId: { startsWith: `${chat}:` } }],
      },
      select: { id: true },
    });
    // The query includes this channel: its thread id is the chat or one of its topics.
    const channelIds = chatChannels.map((row) => row.id);
    await deps.prisma.messagingChannelMember.updateMany({
      where: event.departures.botLeft
        ? { channelId: { in: channelIds }, status: { in: ["invited", "approved"] } }
        : {
            channelId: { in: channelIds },
            address: { in: event.departures.addresses },
            status: { in: ["invited", "approved"] },
          },
      data: { status: "left" },
    });
    return;
  }

  // A deactivated sender's message does nothing: no invitations, memberships or relays.
  const sender = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { userId: true },
  });
  if (sender && (await accountDeactivated(deps.prisma, sender.userId))) return;

  const participants = [...event.participants];
  if (!participants.includes(event.from)) participants.push(event.from);

  // Roster membership changes go with the roster's own version, under the channel's
  // row lock. A webhook retry can deliver a roster older than one a newer event
  // already settled, and without the lock an older handler could pass the version
  // check, pause, and then sweep members the newer roster had just settled. Whichever
  // handler takes the lock first records its roster time — equal times conflict too —
  // and a handler whose roster is not newer than the recorded one changes no
  // membership at all: no sweep, no re-invite, no discovery. Invitations are
  // announced only after the transaction commits.
  // The roster time is the platform's clock, which can run ahead of ours. Within a
  // small skew it stays the version, so ordering and redeliveries behave as usual.
  // Further ahead the time is bogus and the event's roster is distrusted whole, on
  // every delivery alike: it changes no membership — no discovery, no invites, no
  // sweep — and records no time, so it can never settle or unsettle members, and a
  // far-future time can never sit ahead of every later real roster and freeze it.
  const eventRosterAt = event.participants.length > 0 ? event.rosterAt : undefined;
  const rosterTimeRejected =
    eventRosterAt !== undefined && eventRosterAt.getTime() > Date.now() + ROSTER_TIME_SKEW_MS;
  const rosterAt = rosterTimeRejected ? undefined : eventRosterAt;
  const invited: IdentityRow[] = [];
  let hasUnlinked = false;
  await deps.prisma.$transaction(async (tx) => {
    // A rejected time distrusts the event's membership entirely; its message content,
    // if any, still flows below as for any message.
    if (rosterTimeRejected) return;
    await tx.$queryRaw`SELECT id FROM messaging_channels WHERE id = ${channel.id} FOR UPDATE`;
    if (rosterAt) {
      const settled = await tx.messagingChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { rosterSeenAt: true },
      });
      if (settled.rosterSeenAt && rosterAt <= settled.rosterSeenAt) return;
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { rosterSeenAt: rosterAt },
      });
    }
    for (const address of participants) {
      const identity = await tx.messagingIdentity.findUnique({
        where: { provider_address: { provider: event.provider, address } },
      });
      const member = await tx.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address } },
      });
      if (member) {
        // Compare against the current identity, not just null: unlinking
        // deletes the identity row but leaves this FK-free column pointing at
        // the dead id, so a re-link would otherwise never reattach and the
        // member would sit in the channel unreachable by every lookup.
        if (identity && member.identityId !== identity.id) {
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { identityId: identity.id },
          });
          if (member.status === "invited") {
            if (await queueInvite(tx, channel, identity)) invited.push(identity);
          }
        }
        if (member.status === "left") {
          // Back in the group: restart the approval cycle.
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { status: "invited" },
          });
          if (identity) {
            if (await queueInvite(tx, channel, identity)) invited.push(identity);
          }
        }
        if (!identity) hasUnlinked = true;
        continue;
      }
      // Upsert, not create: concurrent group webhooks race on the unique key.
      await tx.messagingChannelMember.upsert({
        where: { channelId_address: { channelId: channel.id, address } },
        create: {
          channelId: channel.id,
          address,
          identityId: identity?.id ?? null,
          status: "invited",
        },
        update: {},
      });
      if (identity) {
        if (await queueInvite(tx, channel, identity)) invited.push(identity);
      } else hasUnlinked = true;
    }

    // Someone removed from the group must stop receiving its content.
    // A webhook without a participants roster says nothing about membership —
    // never sweep on partial data.
    if (event.participants.length > 0) {
      await tx.messagingChannelMember.updateMany({
        where: {
          channelId: channel.id,
          address: { notIn: participants },
          status: { in: ["invited", "approved"] },
        },
        data: { status: "left" },
      });
    }
  });
  for (const identity of invited) await announceInvite(deps, channel, identity);

  if (hasUnlinked && !channel.introPostedAt) {
    // Under the channel lock, so the intro never takes a position inside a
    // mirrored reply's range and the drain's claim stays serialised with it.
    await insertOutboundRows(deps.prisma, { identityId: null, threadId: channel.threadId }, [
      {
        idempotencyKey: `intro:${channel.id}`,
        kind: "intro",
        threadId: channel.threadId,
        body: "Hi. This line hosts Rakazo personal agents. Some people in this group haven't messaged it yet; send any message to this line first if you want your own agent here.",
      },
    ]);
    await deps.prisma.messagingChannel.update({
      where: { id: channel.id },
      data: { introPostedAt: new Date() },
    });
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("messaging intro enqueue error", error);
    });
  }

  // A service message (a pin, a join) carries nothing for a bot to read.
  if (!event.content.trim() && !event.mediaUrl && !event.attachments?.length) return;

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.messagingChannelMember.findUnique({
    where: { channelId_address: { channelId: channel.id, address: event.from } },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.messagingIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  const fromLabel = senderIdentity
    ? await ownerFirstName(deps.prisma, senderIdentity.userId, event.from)
    : event.from;

  // A slash command from an approved member acts on their own line and is
  // never fanned out to the other members' bots as conversation. Anyone
  // else's command-shaped text is just a group message.
  if (senderIdentity && !event.attachments?.length && !event.mediaUrl) {
    const slash = parseMessagingSlashCommand(event.content);
    if (
      slash &&
      (await applyChannelSlashCommand(deps, {
        event,
        channel,
        identity: senderIdentity,
        fromLabel,
        slash,
      }))
    )
      return;
  }

  const approved = await deps.prisma.messagingChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "channel_message",
    provider: event.provider,
    ...(event.transport ? { transport: event.transport } : {}),
    channelId: channel.id,
    fromAddress: event.from,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const prompt = `[Group "${channel.name ?? "group"}", ${fromLabel}]: ${event.content}`;
  for (const member of approved) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) continue;
    const thread = await getPrimaryThread(deps.prisma, identity.botId);
    if (!thread) continue;
    const target = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      threadId: thread.id,
    };
    // One member's Space being deleted must not keep the message from the others.
    try {
      if (await wakeMessageRoutines(deps, target, event)) continue;
      // Group runs carry only text; a bare photo would start an empty prompt.
      if (!event.content.trim()) continue;

      const sent = await deps.events.sendUserMessage({
        spaceId: identity.spaceId,
        threadId: thread.id,
        botId: identity.botId,
        userId: identity.userId,
        blocks: [block],
        prompt,
        trigger: "messaging",
        clientNonce: `messaging:${event.provider}:${event.handle}`,
      });
      if (sent.runId) {
        await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
          getLogger().error("messaging channel fan-out enqueue error", error);
        });
      }
    } catch (error) {
      droppedWhileDeleting(error);
    }
  }
}

async function queueInvite(
  db: Pick<PrismaClient, "messagingOutbound" | "user">,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<boolean> {
  // A deactivated person is not invited anywhere.
  if (await accountDeactivated(db, identity.userId)) return false;
  const name = channel.name ?? "a group chat";
  // A returning member restarts the approval cycle; clear the prior invite
  // row or skipDuplicates would leave them with no prompt to answer.
  await db.messagingOutbound.deleteMany({
    where: { idempotencyKey: `invite:${channel.id}:${identity.id}` },
  });
  await db.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey: `invite:${channel.id}:${identity.id}`,
        kind: "dm",
        identityId: identity.id,
        body: `"${name}" was linked to your Rakazo agent. Reply YES to let your agent join the conversation there, or NO to stay out.`,
      },
    ],
    skipDuplicates: true,
  });
  return true;
}

async function announceInvite(
  deps: MessagingInboundDeps,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<void> {
  const name = channel.name ?? "a group chat";
  const thread = await getPrimaryThread(deps.prisma, identity.botId);
  if (thread) {
    const note = await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: `You were added to the group chat "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging invite enqueue error", error);
  });
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = displayName(user?.name, "").split(/\s+/)[0];
  return first ? sanitizeMessagingLabel(first) : fallback;
}
