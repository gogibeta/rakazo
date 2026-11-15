import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type {
  BotSecretDestination,
  LoginFieldInput,
  MessageBlock,
  OneTimeCodeTarget,
} from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_SECRET_VALUE_MAX_LENGTH,
  encodeLoginSecret,
  loginAnswerValue,
  MessageBlock as MessageBlockSchema,
  normalizeOneTimeCode,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  callIdFromClientNonce,
  instructionUpdateDiff,
  isApprovalAskBlock,
  isConversationalRun,
  isSecretAskBlock,
  messageReaction,
  resolveAskChoice,
  SITE_SENDING_TOOLS,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { saveApprovalRule, storedBatchActions } from "./approval-settings.js";
import { recordAuditEvent } from "./audit-events.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { notifyCommittedEvent, notifyRealtime } from "./event-stream.js";
import type { FinalizeRunResult } from "./events.js";
import { appendEventInTransaction, transientRunEventsWhere } from "./events.js";
import { createThreadMessageInTransaction, loadMessageAuthor } from "./messages.js";
import { runAsSystem } from "./row-security.js";
import { deleteRunSecretsInTransaction } from "./run-secrets.js";
import { RUN_TURN_CHECKPOINT_KIND } from "./run-turn-checkpoint.js";
import { recordSecurityEvent } from "./security-events.js";
import { createPendingSteeringRun } from "./thread-steering.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

export const STRATEGIC_INITIATIVE_NONCE_PREFIX = "strategic-initiative";

/** A one-time answer longer than a saved value may be. Nothing is stored or echoed. */
export class AnswerTooLongError extends Error {
  constructor() {
    super("This answer is too long.");
    this.name = "AnswerTooLongError";
  }
}

/**
 * The ask sat unanswered past its expiry, so the late answer was refused and the
 * run was resumed with the expiry instead. The expiry itself is committed; this
 * only tells the caller why the answer did not land.
 */
export class AnswerExpiredError extends Error {
  constructor() {
    super("This request expired before it was answered.");
    this.name = "AnswerExpiredError";
  }
}

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

/**
 * A conversational run's request and earlier answers stay in thread history, so its resumed
 * attempt gets just the answer. A background run's prompt never reaches the thread, so it keeps
 * its instructions and every earlier answer; otherwise the resumed attempt forgets them.
 */
function resumePrompt(
  run: { trigger: string; task?: { prompt: string } | null },
  question: string,
  answer: string,
): string {
  if (isConversationalRun(run.trigger)) return answer;
  return [run.task?.prompt.trim(), `${question.trim()}\nAnswer: ${answer}`]
    .filter(Boolean)
    .join("\n\n");
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: string;
  /** Identifies a spoken answer as part of a live voice call. */
  clientNonce?: string;
  /** A login card's answer, one per requested field. */
  fields?: LoginFieldInput[];
  /** A login card's answer from apps that predate `fields`; `answer` carries its password. */
  username?: string;
  /** Only for a login card: false uses the login for this run only instead of saving it. */
  remember?: false;
  /** Turns down a pending secret request; only the run's user can, and nothing is stored. */
  dismiss?: boolean;
  /** The surface the answer came through ("app", or a messaging provider), for the audit log. */
  surface?: string;
}

/** What request_secret returns to the bot once the user dismissed its card. */
const DISMISSED_SECRET_RESULT = { ok: false, dismissed: true } as const;
const DISMISSED_SECRET_PROMPT = "The user dismissed this request.";

/** The answer an expired ask is recorded with; cards render it as the expiry state. */
export const EXPIRED_ASK_ANSWER = "expired";
/** What request_secret returns to the bot once its card expired unanswered. */
const EXPIRED_SECRET_RESULT = { ok: false, expired: true } as const;
const EXPIRED_SECRET_PROMPT = "The request expired before it was answered.";

/** An ask resolution by expiry: the effect it denied, and the lifetime it waited out. */
export interface ExpiredApproval {
  effectId: string;
  effectKind: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RunSecretWriter {
  withPrepared?<T>(
    prisma: PrismaClient,
    input: AnswerRunInput,
    commit: (writer: RunSecretWriter) => Promise<T>,
  ): Promise<T>;
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    /** The site a code card was shown for. */
    oneTimeCode?: OneTimeCodeTarget;
    /** False for a login card answered with "Save to Vault" off. */
    remember: boolean;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

async function findPendingAsk(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const messages = await tx.message.findMany({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (pendingAsk?.kind === "ask") return { messageId: message.id, pendingAsk };
  }
  return null;
}

/**
 * Resolve a located ask by expiry, inside the caller's transaction: the run goes
 * back to queued, an approval's effect is denied (so the resumed run gets the
 * refusal result the answer path produces for a denial), a secret request settles
 * like a dismissal with an expired result, and the card is recorded answered with
 * the expiry so every surface renders it as expired. Returns null when the run
 * was no longer waiting — another resolution won the race.
 */
async function expireLocatedAsk(
  tx: Prisma.TransactionClient,
  located: {
    spaceId: string;
    threadId: string;
    runId: string;
    run: { botId: string; trigger: string; task?: { prompt: string } | null };
    message: { id: string };
    blocks: MessageBlock[];
    pendingAsk: Extract<MessageBlock, { kind: "ask" }>;
    effect: { id: string; kind: string; createdAt: Date; expiresAt: Date | null };
  },
): Promise<{ threadId: string; seq: number; expired: ExpiredApproval } | null> {
  const { spaceId, threadId, runId, run, message, blocks, pendingAsk, effect } = located;
  const queued = await tx.run.updateMany({
    where: { id: runId, spaceId, threadId, status: "waiting_input" },
    data: { status: "queued" },
  });
  if (queued.count !== 1) return null;
  if (isApprovalAskBlock(pendingAsk)) {
    await tx.externalEffect.update({ where: { id: effect.id }, data: { status: "denied" } });
  } else {
    await tx.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: EXPIRED_SECRET_RESULT },
    });
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: runId } } },
      data: { prompt: resumePrompt(run, pendingAsk.text, EXPIRED_SECRET_PROMPT) },
    });
    if (task.count !== 1) throw new Error("Run task was not available to expire");
  }
  const answeredBlocks = blocks.map((block) =>
    block === pendingAsk
      ? { ...block, status: "answered" as const, answer: EXPIRED_ASK_ANSWER }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks: answeredBlocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId,
    threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId,
    payload: { messageId: message.id, role: "bot", blocks: answeredBlocks },
  });
  return {
    threadId: updated.threadId,
    seq: updated.seq,
    expired: {
      effectId: effect.id,
      effectKind: effect.kind,
      createdAt: effect.createdAt,
      expiresAt: effect.expiresAt!,
    },
  };
}

/**
 * Locate a waiting run's pending approval or secret ask and resolve it by expiry
 * when its effect is past `expiresAt`. Anything else — a plain question (which has
 * no effect and so no expiry), an ask whose effect has no expiry or has not
 * reached it, a run that is not waiting — returns null untouched.
 */
async function commitExpireWaitingApproval(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; runId: string },
  now: Date,
): Promise<{ threadId: string; seq: number; expired: ExpiredApproval } | null> {
  // Thread row first, then run rows — the same order as the answer path, so a
  // concurrent answer or clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      trigger: true,
      task: { select: { prompt: true } },
    },
  });
  if (!run) return null;
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (pendingAsk?.kind !== "ask") continue;
    const approvalAsk = isApprovalAskBlock(pendingAsk);
    const secretAsk = isSecretAskBlock(pendingAsk);
    if (!approvalAsk && !secretAsk) return null;
    const effect = approvalAsk
      ? await tx.externalEffect.findFirst({
          where: {
            id: pendingAsk.approvalEffectId,
            spaceId: input.spaceId,
            runId: input.runId,
            status: "intended",
          },
          select: { id: true, kind: true, createdAt: true, expiresAt: true },
        })
      : await tx.externalEffect.findFirst({
          where: {
            runId: input.runId,
            spaceId: input.spaceId,
            kind: "request_secret",
            status: "intended",
          },
          select: { id: true, kind: true, createdAt: true, expiresAt: true },
        });
    if (!effect?.expiresAt || effect.expiresAt > now) return null;
    return expireLocatedAsk(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: input.runId,
      run,
      message,
      blocks: parsed.data,
      pendingAsk,
      effect,
    });
  }
  return null;
}

/** The expiry's row in the audit log: the system denied the effect by expiry. */
async function recordApprovalExpiry(input: {
  spaceId: string;
  runId: string;
  threadId: string;
  expired: ExpiredApproval;
  via: "sweep" | "answer";
  now: Date;
}): Promise<void> {
  await recordAuditEvent({
    action: "tool.approval_decision",
    actor: { type: "system" },
    spaceId: input.spaceId,
    target: { type: "effect", id: input.expired.effectId, label: input.expired.effectKind },
    outcome: "denied",
    runId: input.runId,
    threadId: input.threadId,
    metadata: {
      tool: input.expired.effectKind,
      decision: "expired",
      via: input.via,
      ageMs: input.now.getTime() - input.expired.createdAt.getTime(),
    },
  });
}

/**
 * Resolve one waiting run's ask by expiry when it is past due, writing the
 * decision to the audit log. Returns the expiry, or null when nothing was due.
 */
export async function expireWaitingApproval(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; runId: string },
  realtime?: RealtimeFanout,
  options: { now?: Date; via?: "sweep" | "answer" } = {},
): Promise<ExpiredApproval | null> {
  const now = options.now ?? new Date();
  const committed = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => commitExpireWaitingApproval(tx, input, now),
    THREAD_LOCK_TRANSACTION_OPTIONS,
  );
  if (!committed) return null;
  await recordApprovalExpiry({
    spaceId: input.spaceId,
    runId: input.runId,
    threadId: input.threadId,
    expired: committed.expired,
    via: options.via ?? "sweep",
    now,
  });
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return committed.expired;
}

/**
 * One sweep pass: every effect still intended past its expiry whose run waits on
 * the owner, oldest expiry first. The per-run transaction re-checks everything,
 * so a stale candidate (answered, cleared, resumed) is skipped, never forced.
 */
export async function expireWaitingApprovals(
  prisma: PrismaClient,
  options: { now?: Date; limit?: number } = {},
  realtime?: RealtimeFanout,
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  return runAsSystem("expire waiting approvals", async () => {
    const candidates = await prisma.externalEffect.findMany({
      where: { status: "intended", expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      take: limit,
      select: { runId: true, spaceId: true },
    });
    let expired = 0;
    for (const candidate of candidates) {
      const run = await prisma.run.findFirst({
        where: { id: candidate.runId, spaceId: candidate.spaceId, status: "waiting_input" },
        select: { threadId: true },
      });
      if (!run) continue;
      const result = await expireWaitingApproval(
        prisma,
        { spaceId: candidate.spaceId, threadId: run.threadId, runId: candidate.runId },
        realtime,
        { now, via: "sweep" },
      );
      if (result) expired += 1;
    }
    return expired;
  });
}

/** The job reconciler's approval-expiry pass, in the pruners' shape. */
export function createApprovalExpirySweeper(
  db: PrismaClient,
  options: { now?: () => Date; limit?: number } = {},
): () => Promise<void> {
  return async () => {
    await expireWaitingApprovals(db, { now: options.now?.(), limit: options.limit });
  };
}

async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{
  threadId: string;
  seq: number;
  approval?: { decision: string; effectKind: string; effectId: string };
  expired?: ExpiredApproval;
} | null> {
  // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
  // concurrent clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      userId: true,
      checkpoint: true,
      trigger: true,
      clientNonce: true,
      task: { select: { prompt: true } },
    },
  });
  // An answer resumes the run with its user's credentials and rules, so in a shared space only
  // that user answers its cards; anyone else's message starts a run of their own.
  if (!run || run.userId !== input.answeredByUserId) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  if (pendingAsk?.kind !== "ask") return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  const secretAsk = isSecretAskBlock(pendingAsk);
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk ? resolveAskChoice(input.answer, pendingAsk.actions) : undefined;
  const dismissed = Boolean(input.dismiss);
  // A secret request can be turned down; every other card needs an answer.
  if (dismissed && (!secretAsk || input.answer)) return null;
  const secretRequest = {
    runId: input.runId,
    spaceId: input.spaceId,
    kind: "request_secret",
    status: "intended",
  };
  if (
    dismissed &&
    !(await tx.externalEffect.findFirst({ where: secretRequest, select: { id: true } }))
  )
    return null;
  if (secretAsk && !dismissed && !runSecretWriter) return null;
  // A code is answered as the page will take it; anything that is not a code is not stored.
  const code =
    secretAsk && !dismissed && pendingAsk.oneTimeCode
      ? normalizeOneTimeCode(input.answer)
      : undefined;
  if (secretAsk && !dismissed && pendingAsk.oneTimeCode && !code) return null;
  const loginAsk = secretAsk && !dismissed && pendingAsk.credential?.auth.type === "login";
  const login = loginAsk ? loginAnswerValue(pendingAsk.loginFields, input) : undefined;
  // Login fields belong only to a login card, which cannot be saved without them.
  if (loginAsk ? !login : input.username !== undefined || input.fields !== undefined) return null;
  if (input.remember !== undefined && !loginAsk) return null;
  if (secretAsk && input.answer.length > BOT_SECRET_VALUE_MAX_LENGTH)
    throw new AnswerTooLongError();
  let approvalEffect: {
    id: string;
    kind: string;
    request: Prisma.JsonValue;
    batchActions: Prisma.JsonValue;
    createdAt: Date;
    expiresAt: Date | null;
  } | null = null;
  let editedInstructions: string | undefined;
  let approvalAnswer = input.answer;
  if (approvalAsk && pendingAsk.instructionUpdate && input.answer.startsWith("{")) {
    try {
      const edited = JSON.parse(input.answer);
      if (
        typeof edited.instructions !== "string" ||
        edited.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH ||
        Object.keys(edited).length !== 1
      )
        return null;
      editedInstructions = edited.instructions;
      approvalAnswer = "allow";
    } catch {
      return null;
    }
  }
  let approvalUserId: string | null = null;

  if (approvalAsk) {
    if (!pendingAsk.actions?.some((action) => action.id === approvalAnswer)) return null;
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect) return null;
    if (pendingAsk.instructionUpdate) {
      if (
        approvalEffect.kind !== "update_bot" ||
        pendingAsk.instructionUpdate.botId !== run.botId ||
        (approvalAnswer !== "allow" && approvalAnswer !== "deny") ||
        run.userId !== input.answeredByUserId
      )
        return null;
    }
    if (input.answer === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalUserId = input.answeredByUserId;
    }
  }

  // An ask that sat past its expiry is no longer the owner's to answer: resolve
  // it by expiry here under the thread lock, so a late answer is refused even
  // when the reconciler's sweep has not reached the run yet.
  const expiryEffect = approvalAsk
    ? approvalEffect
    : secretAsk && !dismissed
      ? await tx.externalEffect.findFirst({
          where: {
            runId: input.runId,
            spaceId: input.spaceId,
            kind: "request_secret",
            status: "intended",
          },
          select: { id: true, kind: true, createdAt: true, expiresAt: true },
        })
      : null;
  if (expiryEffect?.expiresAt && expiryEffect.expiresAt <= new Date()) {
    return expireLocatedAsk(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: input.runId,
      run,
      message,
      blocks: parsed.data,
      pendingAsk,
      effect: expiryEffect,
    });
  }

  // Answering the creation intro's or a daily check-in's question resumes as the user's
  // turn: with the conversation and every tool, to get going on that answer.
  const answersOpener =
    run.trigger === "created" ||
    (run.trigger === "routine" &&
      Boolean(run.clientNonce?.startsWith(`${STRATEGIC_INITIATIVE_NONCE_PREFIX}:`)));
  const resumedTrigger = answersOpener && !approvalAsk && !secretAsk ? "user" : run.trigger;
  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      ...(resumedTrigger !== run.trigger ? { trigger: resumedTrigger } : {}),
      ...(choiceAsk ? { checkpoint: null } : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (selectedChoice?.id ?? approvalAnswer);
  const callId = callIdFromClientNonce(input.clientNonce);
  const recordsCallUtterance = Boolean(callId && !secretAsk);

  // Give spoken answers the same durable, call-scoped user utterance as other voice turns.
  // Secret asks stay out of message history; the call UI requires those answers on screen.
  if (recordsCallUtterance) {
    const blocks = [{ kind: "text" as const, text: input.answer }];
    const utterance = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "user",
      blocks,
      botId: run.botId,
      authorUserId: input.answeredByUserId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    });
    const author = await loadMessageAuthor(tx, input.answeredByUserId);
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: utterance.id, role: "user", blocks, callId, author },
    });
  }

  if (approvalAsk) {
    if (pendingAsk.instructionUpdate) {
      if (editedInstructions !== undefined) {
        const stored = await tx.externalEffect.findUniqueOrThrow({
          where: { id: approvalEffect!.id },
        });
        const request = stored.request as Record<string, Prisma.InputJsonValue>;
        await tx.externalEffect.update({
          where: { id: approvalEffect!.id },
          data: {
            request: { ...request, instructions: editedInstructions },
            idempotencyKey: approvalEffectKey(input.runId, approvalEffect!.kind, {
              ...request,
              instructions: editedInstructions,
            }),
          },
        });
      }
    }
    const allowed = approvalAnswer === "allow" || approvalAnswer === "always";
    await tx.externalEffect.update({
      where: { id: approvalEffect!.id },
      data: { status: allowed ? "approved" : "denied" },
    });
    // "Always" on a card for a request to a site allows that site, never every site the tool can
    // reach, and on a batch allows each action in it, never every action the batch tool can run.
    const site = alwaysAllowedSite(approvalEffect!);
    const tools = storedBatchActions(approvalEffect!.batchActions) ?? [approvalEffect!.kind];
    if (input.answer === "always" && (site || approvalEffect!.kind !== "web_fetch")) {
      // Saved where the member's confirmations apply in this Space: the account or its override.
      for (const tool of site ? [site] : tools) {
        await saveApprovalRule(
          tx,
          { userId: approvalUserId!, spaceId: input.spaceId },
          { effect: "always_allow", matchKind: site ? "site" : "tool", matchValue: tool },
        );
      }
    }
  } else if (dismissed) {
    // Nothing is stored. The bot's request_secret call returns the dismissal, and the resumed
    // run is told why.
    await tx.externalEffect.updateMany({
      where: secretRequest,
      data: { status: "completed", result: DISMISSED_SECRET_RESULT },
    });
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: { prompt: resumePrompt(run, pendingAsk.text, DISMISSED_SECRET_PROMPT) },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      oneTimeCode: pendingAsk.oneTimeCode,
      remember: input.remember !== false,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login ? encodeLoginSecret(login) : (code ?? input.answer),
      tx,
    });
    await tx.externalEffect.updateMany({
      where: {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
      },
    });
  } else {
    const resumeLabel = selectedChoice
      ? resumeChoiceLabel(selectedChoice, run.checkpoint)
      : undefined;
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: {
        prompt: resumePrompt(
          { ...run, trigger: resumedTrigger },
          pendingAsk.text,
          selectedChoice ? `Selected choice ${selectedChoice.id}: ${resumeLabel}` : input.answer,
        ),
      },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  }

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
          ...(dismissed ? { dismissed: true as const } : {}),
          ...(input.remember === false ? { remembered: false as const } : {}),
          ...(editedInstructions !== undefined && pendingAsk.instructionUpdate
            ? {
                instructionUpdate: { ...pendingAsk.instructionUpdate, after: editedInstructions },
                detail: instructionUpdateDiff(
                  pendingAsk.instructionUpdate.before,
                  editedInstructions,
                ),
              }
            : {}),
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return {
    threadId: updated.threadId,
    seq: updated.seq,
    ...(approvalEffect
      ? {
          approval: {
            decision: approvalAnswer,
            effectKind: approvalEffect.kind,
            effectId: approvalEffect.id,
          },
        }
      : {}),
  };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const commit = (writer = runSecretWriter) =>
    prisma.$transaction(
      async (tx: Prisma.TransactionClient) => commitAnswerRunInput(tx, input, writer),
      THREAD_LOCK_TRANSACTION_OPTIONS,
    );
  // Unwrapping space keys can wait on the key manager; keep that wait outside the transaction.
  await contentEncryptionOf(prisma)?.ring.all(input.spaceId);
  // A dismissal has no secret to prepare.
  const committed =
    runSecretWriter?.withPrepared && !input.dismiss
      ? await runSecretWriter.withPrepared(prisma, input, commit)
      : await commit();

  if (!committed) return false;
  if (committed.expired) {
    // The commit already resolved the ask by expiry and resumed the run; this
    // throw only tells the caller the late answer itself was refused. It lands
    // before any secret from the answer is stored.
    await recordApprovalExpiry({
      spaceId: input.spaceId,
      runId: input.runId,
      threadId: input.threadId,
      expired: committed.expired,
      via: "answer",
      now: new Date(),
    });
    await notifyRealtime(realtime, committed.threadId, committed.seq);
    throw new AnswerExpiredError();
  }
  if (committed.approval) {
    await recordSecurityEvent({
      type: "approval.decided",
      userId: input.answeredByUserId,
      spaceId: input.spaceId,
      metadata: {
        decision: committed.approval.decision,
        effectKind: committed.approval.effectKind,
        runId: input.runId,
      },
    });
    // The decision's canonical row in the audit log, alongside the security
    // event: who decided, on which effect, through which surface. The audit
    // outcome vocabulary has no "approved", so the decision rides in metadata.
    await recordAuditEvent({
      action: "tool.approval_decision",
      actor: { type: "user", id: input.answeredByUserId },
      spaceId: input.spaceId,
      target: {
        type: "effect",
        id: committed.approval.effectId,
        label: committed.approval.effectKind,
      },
      outcome: committed.approval.decision === "deny" ? "denied" : "success",
      runId: input.runId,
      threadId: input.threadId,
      metadata: {
        tool: committed.approval.effectKind,
        decision: committed.approval.decision === "deny" ? "denied" : "approved",
        ...(input.surface ? { surface: input.surface } : {}),
      },
    });
  }
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/** The caller holds the thread row lock acquired while accepting the new user message. */
export async function retireWaitingQuestionInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; answer: string },
): Promise<boolean> {
  const answer = input.answer.trim();
  if (!answer) return false;
  const where = {
    id: input.runId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    status: "waiting_input",
  };
  const run = await tx.run.findFirst({ where, select: { taskId: true, userId: true } });
  if (!run) return false;
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  const questions = [];
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) return false;
    const pending = parsed.data.filter(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    // Never implicitly dismiss credentials or authorize an external effect, even on a mixed card.
    if (
      pending.some(
        (block) => block.kind === "ask" && (block.input === "secret" || block.approvalEffectId),
      )
    )
      return false;
    if (pending.length) {
      questions.push({
        id: message.id,
        blocks: parsed.data.map((block) =>
          pending.includes(block) ? { ...block, status: "answered" as const, answer } : block,
        ),
      });
    }
  }
  if (!questions.length) return false;
  const now = new Date();
  const retired = await tx.run.updateMany({
    where,
    data: {
      status: "cancelled",
      completedAt: now,
      checkpoint: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (retired.count !== 1) return false;
  await tx.externalEffect.deleteMany({
    where: { runId: input.runId, kind: RUN_TURN_CHECKPOINT_KIND, status: RUN_TURN_CHECKPOINT_KIND },
  });
  await deleteRunSecretsInTransaction(tx, [
    { id: input.runId, userId: run.userId, spaceId: input.spaceId },
  ]);
  await tx.attempt.updateMany({
    where: { runId: input.runId, status: "waiting_input" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: run.taskId, runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
    data: { status: "cancelled" },
  });
  for (const question of questions) {
    await tx.message.update({ where: { id: question.id }, data: { blocks: question.blocks } });
    await appendEventInTransaction(tx, {
      ...input,
      type: "thread.message.updated",
      allowCancelledRun: true,
      payload: { messageId: question.id, role: "bot", blocks: question.blocks },
    });
  }
  await appendEventInTransaction(tx, { ...input, type: "run.cancelled", payload: {} });
  return true;
}

/** Read-only eligibility shared by image admission and composer free-text answers. */
export async function eligibleWaitingTextAnswer(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
    beforeMessageSeq?: number;
    /** Explicit reaction target; composer replies must pass the latest-message check. */
    messageId?: string;
  },
): Promise<string | null> {
  const answer = input.answer.trim();
  if (!answer) return null;
  const found = await findPendingAsk(tx, input);
  if (!found) return null;
  if (isApprovalAskBlock(found.pendingAsk) || isSecretAskBlock(found.pendingAsk)) return null;
  if (input.messageId !== undefined) {
    if (input.messageId !== found.messageId) return null;
  } else {
    // Reactions are projected beneath their target, not new transcript messages.
    let beforeSeq = input.beforeMessageSeq;
    while (true) {
      const latest = await tx.message.findFirst({
        where: {
          threadId: input.threadId,
          ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
        },
        orderBy: { seq: "desc" },
        select: { id: true, seq: true, role: true, blocks: true, replyToMessageId: true },
      });
      if (!latest) return null;
      if (!messageReaction({ ...latest, blocks: latest.blocks as MessageBlock[] })) {
        if (latest.id !== found.messageId) return null;
        break;
      }
      beforeSeq = latest.seq;
    }
  }
  return found.messageId;
}

/** Commit only answers that pass the same read-only composer eligibility check. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof eligibleWaitingTextAnswer>[1],
): Promise<{ threadId: string; seq: number } | null> {
  const messageId = await eligibleWaitingTextAnswer(tx, input);
  return messageId
    ? commitAnswerRunInput(tx, { ...input, messageId, answer: input.answer.trim() })
    : null;
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;
    await expireComputerExecutionLeases(tx, { runId: input.runId });

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: input.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    const response = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: input.blocks },
    });
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { userId: true },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: run?.userId ? { userId: run.userId } : {},
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    const continuationRunId = await createPendingSteeringRun(tx, input);
    return {
      threadId: waitingEvent.threadId,
      seq: waitingEvent.seq,
      continuationRunId,
      firstResponseRunId: response.firstResponse ? input.runId : undefined,
    };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);

  if (!committed) return false;
  await notifyCommittedEvent(
    prisma,
    realtime,
    committed.threadId,
    committed.seq,
    committed.firstResponseRunId,
  );
  return { continuationRunId: committed.continuationRunId };
}

function alwaysAllowedSite(effect: {
  kind: string;
  request: Prisma.JsonValue;
}): string | undefined {
  if (!SITE_SENDING_TOOLS.has(effect.kind)) return undefined;
  const request = effect.request as { url?: unknown } | null;
  return typeof request?.url === "string" ? urlSite(request.url) : undefined;
}
