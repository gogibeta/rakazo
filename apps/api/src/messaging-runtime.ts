import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  ArtifactStore,
  JobPublisher,
  MessagingInboundEvent,
  MessagingSurface,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { createAdapterContext, runJobKey } from "@rakazo/adapter-kit";
import type {
  BotModelChangeDeps,
  CodexLiveCatalog,
  MessagingInstallations,
} from "@rakazo/adapters";
import {
  applyMessagingOutboundStatus,
  connectedModelChoices,
  createMessagingTeamChatHistory,
  createMessagingTeamChatSender,
  kickModelCredentialRefresh,
  resolveModelChoice,
  SpaceMemoryProviderResolver,
  validateBotModelChange,
} from "@rakazo/adapters";
import { MESSAGING_SLASH_COMMANDS } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { commitBotUpdate, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { storeInboundAttachment } from "./artifacts.js";
import type { AppEnv } from "./env.js";
import {
  answerMessagingAskAction,
  answerMessagingPickerAction,
  createMessagingInboundHandler,
  messagingMessageForAction,
} from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
  TeamChatStartupRetries,
} from "./team-chat-startup.js";
import { transcribeInboundVoice } from "./voice.js";

/** Messaging and team chat for one API process; `stop` ends polling, retries, and bridges. */
export async function startMessagingRuntime({
  app,
  prisma,
  events,
  jobs,
  sandbox,
  secrets,
  artifacts,
  runtime,
  env,
  messaging,
  messagingInstallations,
  hostedModelProvider,
  codexCatalog,
}: {
  app: Hono;
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: Pick<JobPublisher, "enqueue" | "cancel">;
  sandbox: SandboxProvider;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  runtime: AgentRuntime;
  env: AppEnv;
  messaging: MessagingSurface;
  messagingInstallations: MessagingInstallations | undefined;
  /** The hosted model provider id when model credits are enabled (the /model command's catalog). */
  hostedModelProvider?: string | undefined;
  codexCatalog?: CodexLiveCatalog | undefined;
}): Promise<{ stop: () => Promise<void> }> {
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let stopInstalledBridges: (() => Promise<void>) | undefined;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearTeamChatRetryDelay: (() => void) | undefined;
  let teamChatInitTask: Promise<void> | undefined;
  let teamChatBridge: TeamChatBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let teamChatBridgeInstance: TeamChatBridge | undefined;
  const pendingTeamChatInbound = new PendingTeamChatInbound();
  const receipts = createMessagingReceipts(messaging);
  // The /model command's seam: the same deps the app model picker is
  // validated against, built the same way (see routes' botModelValidation).
  const modelChangeDeps: BotModelChangeDeps = {
    prisma,
    secretStore: secrets,
    hostedProvider: hostedModelProvider,
    codexCatalog,
    refreshExpiredCredential: (scope, secretId, provider) =>
      kickModelCredentialRefresh(prisma, secrets, scope, secretId, provider),
    defaultModel: async () => ({ provider: env.defaultProvider, model: env.defaultModel }),
  };
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const inboundDeps = {
    prisma,
    events,
    jobs,
    sandbox,
    webOrigin: env.webOrigin,
    provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
    openSignup: env.messagingOpenSignup,
    signupPolicy: {
      signupsEnabled: env.signupsEnabled,
      signupAllowlist: env.signupAllowlist,
    },
    acknowledge: receipts.acknowledge,
    storeAttachment: ({ spaceId, userId, ...input }) =>
      storeInboundAttachment(
        { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
        { spaceId, userId },
        input,
      ),
    transcribe: ({ spaceId, userId, audio, mimeType, signal }) =>
      transcribeInboundVoice(
        {
          prisma,
          secrets,
          env: { mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint },
        },
        { spaceId, userId },
        { audio, mimeType, signal },
      ),
    models: {
      choices: (scope) => connectedModelChoices(modelChangeDeps, scope),
      resolve: async (scope, query, preferredProvider) => {
        const resolved = await resolveModelChoice(modelChangeDeps, scope, {
          model: query,
          preferredProvider,
        });
        return resolved.ok ? { provider: resolved.provider, model: resolved.model } : null;
      },
      apply: async (scope, bot, choice) => {
        const thread = await prisma.thread.findFirst({
          where: { botId: bot.id },
          select: { id: true },
        });
        if (!thread) return { ok: false as const, error: "This bot has no conversation yet." };
        const validated = await validateBotModelChange(modelChangeDeps, {
          userId: scope.userId,
          spaceId: scope.spaceId,
          provider: choice.provider,
          model: choice.model,
          thinkingLevel: bot.thinkingLevel ?? undefined,
          current: { provider: bot.modelProvider, model: bot.modelId },
        });
        if (!validated.ok) return validated;
        await commitBotUpdate({
          prisma,
          notify: (threadId, seq) => events.notify(threadId, seq),
          spaceId: scope.spaceId,
          threadId: thread.id,
          botId: bot.id,
          emitBotUpdated: false,
          data: {
            modelProvider: validated.provider,
            modelId: validated.model,
            thinkingLevel: validated.thinkingLevel,
          },
        });
        return { ok: true as const };
      },
    },
    createTopic: messaging.createTopic
      ? async (provider: string, threadId: string, name: string) => {
          const operationId = `messaging.command.new:${randomUUID()}`;
          const created = await messaging.createTopic!(
            { provider, threadId, name },
            {
              operationId,
              traceId: operationId,
              spaceId: "",
              userId: "",
              signal: AbortSignal.timeout(15_000),
            },
          );
          return created?.threadId ?? null;
        }
      : undefined,
    // The app's Clear conversation follow-through, mirrored for /new:
    // cancel the cleared runs' jobs, then purge the previous
    // generations' conversation-derived memory. Both are best-effort —
    // the conversation rows are already gone either way.
    afterThreadClear: async ({
      spaceId,
      userId,
      threadId,
      botId,
      cancelledRunIds,
      historyCompactionGeneration,
    }) => {
      await Promise.all(
        cancelledRunIds.map((runId) => jobs.cancel(runJobKey(runId)).catch(() => undefined)),
      );
      const configured = await memoryProviders.resolve(spaceId).catch((error) => {
        getLogger().error("semantic memory resolution after chat /new failed", error);
        return null;
      });
      if (!configured) return;
      try {
        const purged = await configured.provider.purgeHistory(
          {
            botId,
            generations: [
              Math.max(0, historyCompactionGeneration - 1),
              historyCompactionGeneration,
            ],
          },
          createAdapterContext({ userId, spaceId }, botId, `thread-clear:${threadId}`),
        );
        if (!purged.ok) {
          getLogger().error("semantic memory purge after chat /new failed", purged.error);
        }
      } catch (error) {
        getLogger().error("semantic memory purge after chat /new failed", error);
      }
    },
  } satisfies Parameters<typeof createMessagingInboundHandler>[0];
  const inbound = createMessagingInboundHandler(inboundDeps);
  const handleTeamChatInbound = createTeamChatInboundHandler(inboundDeps, inbound);
  const flushPendingTeamChatInbound = (bridge: TeamChatBridge) => {
    pendingTeamChatInbound.flush((event) => handleTeamChatInbound(bridge, event));
  };
  const makeTeamChatBridge = (
    botId: string,
    installation?: { id: string; workspaceId: string },
  ) => {
    const judge =
      env.teamChatJudgeProvider && env.teamChatJudgeModel
        ? new ModelTeamChatEngagementJudge({
            prisma,
            runtime,
            secrets,
            deploymentProvider: env.defaultProvider,
            deploymentModel: env.defaultModel,
            deploymentModelKey: env.deploymentModelKey,
            allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
            providerOverride: env.teamChatJudgeProvider,
            modelOverride: env.teamChatJudgeModel,
          })
        : new ModelTeamChatEngagementJudge({
            prisma,
            runtime,
            secrets,
            deploymentProvider: env.defaultProvider,
            deploymentModel: env.defaultModel,
            deploymentModelKey: env.deploymentModelKey,
            allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
          });
    const bridge = new TeamChatBridge({
      prisma,
      events,
      jobs,
      send: createMessagingTeamChatSender(messaging),
      fetchThreadHistory: createMessagingTeamChatHistory(messaging),
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
      providerId: "slack",
      botId,
      workspaceId: installation?.workspaceId,
      conversationPrefix: installation ? `slack~${installation.id}:` : undefined,
      onUnavailable: installation
        ? () => {
            installedBridges.delete(installation.id);
          }
        : undefined,
      isAvailable: installation
        ? async () => Boolean(await messagingInstallations?.isActive(installation.id))
        : undefined,
      judge,
      acknowledge: receipts.acknowledge,
    });
    return bridge;
  };
  const installedBridges = new Map<
    string,
    { bridge: TeamChatBridge; pending: Promise<TeamChatBridge> }
  >();
  const installedRetries = new TeamChatStartupRetries((error) =>
    getLogger().error("installed team chat restore failed; retrying", error),
  );
  const retryInstalledBridge = (installation: {
    id: string;
    botId: string;
    workspaceId: string;
  }) => {
    installedRetries.schedule(installation.id, () =>
      runAsSystem("retry installed team chat", async () => {
        if (messagingStopped) return;
        const active = await messagingInstallations?.isActive(installation.id);
        if (!active || messagingStopped) return;
        await installedBridge(installation);
      }),
    );
  };
  const installedBridge = (installation: { id: string; botId: string; workspaceId: string }) => {
    const existing = installedBridges.get(installation.id);
    if (existing) return existing.pending;
    const bridge = makeTeamChatBridge(installation.botId, installation);
    const pending = bridge
      .start()
      .then(() => {
        installedRetries.succeeded(installation.id);
        return bridge;
      })
      .catch(async (error) => {
        installedBridges.delete(installation.id);
        await bridge.stop();
        retryInstalledBridge(installation);
        throw error;
      });
    installedBridges.set(installation.id, { bridge, pending });
    return pending;
  };
  if (messagingInstallations) {
    await Promise.all(
      (await messagingInstallations.targets()).map((installation) =>
        runAsSystem("resume installed team chat", () => installedBridge(installation)).catch(
          (error) => {
            getLogger().error("installed team chat could not resume", error);
          },
        ),
      ),
    );
  }
  stopInstalledBridges = async () => {
    installedRetries.stop();
    // Stop first so an in-flight start() is cancelled, then bound the wait
    // as the static bridge does.
    await Promise.all(
      [...installedBridges.values()].map(({ bridge, pending }) =>
        settleWithTimeout(
          bridge
            .stop()
            .catch(() => undefined)
            .then(() => pending.catch(() => undefined)),
          TEAM_CHAT_STARTUP_SHUTDOWN_MS,
        ),
      ),
    );
  };
  if (env.teamChatBotId) {
    const bridge = makeTeamChatBridge(env.teamChatBotId);
    teamChatBridgeInstance = bridge;
    try {
      await bridge.start();
      teamChatBridge = bridge;
    } catch (error) {
      getLogger().error("team chat bridge failed to start; retrying", error);
      teamChatInitTask = (async () => {
        let delayMs = 2_000;
        while (!messagingStopped) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            clearTeamChatRetryDelay = () => {
              clearTimeout(timer);
              clearTeamChatRetryDelay = undefined;
              resolve();
            };
          });
          clearTeamChatRetryDelay = undefined;
          if (messagingStopped) return;
          try {
            await bridge.start();
            if (messagingStopped) {
              await bridge.stop();
              return;
            }
            teamChatBridge = bridge;
            flushPendingTeamChatInbound(bridge);
            return;
          } catch (retryError) {
            if (
              retryError instanceof Error &&
              retryError.message === "Team chat bridge start cancelled"
            ) {
              return;
            }
            getLogger().error("team chat bridge failed to start; retrying", retryError);
            delayMs = Math.min(delayMs * 5, 30_000);
          }
        }
      })();
    }
  }
  const handleInbound = async (event: MessagingInboundEvent) => {
    if (event.type === "status") {
      await applyMessagingOutboundStatus(prisma, event);
      return;
    }
    // A tap on an ask card is the person's answer to a pending question, not
    // a chat message: its payload names the question and the chosen option,
    // so it resolves here, before any command-word or message routing can
    // misread it. Ask cards only ever go to the personal line's DMs, never
    // to an installed team-chat surface.
    if (event.type === "action" && event.isDirect && !event.installationId) {
      if (await answerMessagingAskAction(inboundDeps, event)) return;
      // A tap on a /bot or /model picker card is a command answer, not a
      // message either: its payload is a bot id or a list position, which
      // message routing would misread as a choice answer or plain text.
      if (await answerMessagingPickerAction(inboundDeps, event)) return;
    }
    // A button tap is the person's answer to a message the bot sent; from
    // here it flows exactly like their next message in that conversation.
    const message = event.type === "action" ? messagingMessageForAction(event) : event;
    if (message.installationBotId && !message.isDirect) {
      if (!message.installationId || !message.workspaceId) return;
      const installation = {
        id: message.installationId,
        botId: message.installationBotId,
        workspaceId: message.workspaceId,
      };
      await handleTeamChatInbound(await installedBridge(installation), message);
      return;
    }
    if (!message.installationBotId && prefersTeamChatSurface(message, env.teamChatBotId)) {
      const bridge = teamChatBridge;
      if (bridge) {
        await handleTeamChatInbound(bridge, message);
        return;
      }
      // Bridge is still starting (or retrying). Do not fall through to the
      // personal-line inbound path — that bypasses externalMessage ownership
      // and can wake routines for unlinked TeamChat senders.
      if (teamChatInitTask) {
        const pending = pendingTeamChatInbound.enqueue(message);
        if (!pending) {
          throw new Error("Team chat inbound buffer is full");
        }
        await pending;
        return;
      }
      throw new Error("Team chat bridge is unavailable");
    }
    await inbound(message);
  };
  messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
  mountMessagingWebhookRoutes(app, { messaging });
  // Start polling adapters now rather than on the first webhook or send; a second poller
  // elsewhere would fight this one for Telegram's single getUpdates slot. Bounded retries
  // cover transient startup failures, otherwise polling-only bots stay dark.
  messagingInitTask = (async () => {
    const delayMs = [0, 2_000, 10_000];
    for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
      if (messagingStopped) return;
      if (delayMs[attempt]! > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs[attempt]);
          clearMessagingRetryDelay = () => {
            clearTimeout(timer);
            clearMessagingRetryDelay = undefined;
            resolve();
          };
        });
        clearMessagingRetryDelay = undefined;
      }
      if (messagingStopped) return;
      try {
        await messaging.initialize?.();
        // The chat command menu is a convenience layered over typed
        // commands; registering it must never fail startup.
        await messaging.registerCommands?.(MESSAGING_SLASH_COMMANDS).catch((error) => {
          getLogger().error("messaging command menu registration failed", error);
        });
        return;
      } catch (error) {
        getLogger().error(
          attempt === delayMs.length - 1
            ? "messaging surface initialize failed"
            : "messaging surface initialize failed; retrying",
          error,
        );
      }
    }
  })();
  return {
    stop: async () => {
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearTeamChatRetryDelay?.();
      receipts.stop();
      pendingTeamChatInbound.reject(new Error("Team chat bridge stopped before startup"));
      // Cancel in-flight start() before awaiting the retry task so stop() cannot
      // sit on DB/reconcile work that bridge.start() is still running.
      await settleWithTimeout(
        teamChatBridgeInstance ? teamChatBridgeInstance.stop().catch(() => undefined) : undefined,
        TEAM_CHAT_STARTUP_SHUTDOWN_MS,
      );
      await messagingInitTask?.catch(() => undefined);
      await settleWithTimeout(teamChatInitTask, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
      await messaging.shutdown?.();
      await teamChatBridge?.stop();
      await stopInstalledBridges?.();
    },
  };
}
