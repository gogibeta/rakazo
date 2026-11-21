import type { Actor, ModelRoleChoice } from "@rakazo/contracts";
import { makeDefaultModelPatch } from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { appliedModelRole, commitBotUpdate, isRecordNotFound, updateModelRole } from "@rakazo/db";
import type { FleetCardSummary } from "./approval-ask.js";
import { asRecord } from "./connector-http.js";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import { modelLabel } from "./fleet-tools.js";
import { connectedModelChoices, resolveModelChoice } from "./model-choice.js";
import { validateBotModelChange } from "./model-selection.js";

/**
 * Conversational control of the acting bot's own model: the service layer
 * behind the app_list_models / app_set_model tools. Everything reuses the
 * same catalog, name resolution and validation the app model picker, the
 * /model chat command and the fleet model tools share, and every write is
 * scoped to the bot the run belongs to — no argument can name another bot.
 */

export type OwnBotModelRow = {
  id: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

type Scope = Pick<Actor, "userId" | "spaceId">;

/** Ids listed per connection; the rest stay reachable by name through app_set_model. */
const MODELS_PER_CONNECTION = 15;

export type OwnModelListing = {
  /** The model this bot effectively runs, and whether it is its own pick or the default. */
  current: {
    provider: string | null;
    model: string | null;
    label: string;
    isDefault: boolean;
  };
  /** The owner's model connections and the models each can run, in picker order. */
  connections: Array<{
    provider: string;
    providerName: string;
    models: Array<{ id: string; label: string; active: boolean }>;
    /** Connected models past the listed ones; still switchable by name. */
    more?: number;
  }>;
};

/** The acting bot's connected models, grouped by connection, with its current one marked. */
export async function listOwnBotModels(
  deps: FleetPrepareDeps,
  scope: Scope,
  bot: OwnBotModelRow,
): Promise<OwnModelListing> {
  const modelDeps = { prisma: deps.prisma, ...deps.modelChange };
  const [choices, fallback] = await Promise.all([
    connectedModelChoices(modelDeps, scope),
    deps.modelChange.defaultModel(),
  ]);
  const own = Boolean(bot.modelProvider && bot.modelId);
  const effective = own
    ? { provider: bot.modelProvider, model: bot.modelId }
    : { provider: fallback.provider, model: fallback.model };
  const connections = new Map<
    string,
    {
      provider: string;
      providerName: string;
      models: OwnModelListing["connections"][number]["models"];
    }
  >();
  for (const choice of choices) {
    const group = connections.get(choice.provider) ?? {
      provider: choice.provider,
      providerName: choice.providerName,
      models: [],
    };
    group.models.push({
      id: choice.id,
      label: choice.label,
      active: choice.provider === effective.provider && choice.id === effective.model,
    });
    connections.set(choice.provider, group);
  }
  return {
    current: {
      provider: effective.provider,
      model: effective.model,
      label: modelLabel(effective.provider, effective.model),
      isDefault: !own,
    },
    connections: [...connections.values()].map((group) => ({
      provider: group.provider,
      providerName: group.providerName,
      models: group.models.slice(0, MODELS_PER_CONNECTION),
      ...(group.models.length > MODELS_PER_CONNECTION
        ? { more: group.models.length - MODELS_PER_CONNECTION }
        : {}),
    })),
  };
}

export type OwnModelChangePrepared =
  | {
      ok: true;
      canonical: {
        provider: string | null;
        model: string | null;
        thinkingLevel: string | null;
        previous: {
          provider: string | null;
          model: string | null;
          thinkingLevel: string | null;
        };
      };
      summary: FleetCardSummary;
    }
  | { ok: false; error: string };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Resolve a requested model change for the acting bot before the approval
 * card is written: the canonical request the card shows is the request an
 * approval replays, so a rename or a settings change while the card waits
 * cannot change what was approved.
 */
export async function prepareOwnBotModelChange(
  deps: FleetPrepareDeps,
  scope: Scope,
  bot: OwnBotModelRow,
  args: Record<string, unknown>,
): Promise<OwnModelChangePrepared> {
  const provider = text(args.provider);
  const model = text(args.model);
  const clear = args.clear === true;
  if (clear && (provider || model)) {
    return refuse("Pass either clear: true or model, not both.");
  }
  if (!clear && !model) return refuse("Pass model, or clear: true.");
  const previous = {
    provider: bot.modelProvider,
    model: bot.modelId,
    thinkingLevel: bot.thinkingLevel ?? null,
  };
  const modelDeps = { prisma: deps.prisma, ...deps.modelChange };
  const chosen = model
    ? await resolveModelChoice(modelDeps, scope, {
        model,
        provider,
        preferredProvider: bot.modelProvider,
      })
    : undefined;
  if (chosen && !chosen.ok) return refuse(chosen.error);
  const validate = (thinkingLevel: string | null) =>
    validateBotModelChange(modelDeps, {
      userId: scope.userId,
      spaceId: scope.spaceId,
      provider: chosen?.provider ?? null,
      model: chosen?.model ?? null,
      thinkingLevel,
      current: { provider: bot.modelProvider, model: bot.modelId },
    });
  // A new model keeps the bot's thinking level when it supports it, else
  // falls back to the model's default — the settings screen's behaviour.
  let validated = await validate(previous.thinkingLevel);
  if (!validated.ok && previous.thinkingLevel) validated = await validate(null);
  if (!validated.ok) return refuse(validated.error);
  if (validated.provider === previous.provider && validated.model === previous.model) {
    return refuse(
      previous.provider ? "You already use this model." : "You already use the default model.",
    );
  }
  const lines = [
    `From: ${modelLabel(previous.provider, previous.model)}`,
    `To: ${modelLabel(validated.provider, validated.model)}`,
  ];
  // Keeping the level is silent; resetting one the owner set is said out loud.
  if (validated.thinkingLevel !== previous.thinkingLevel && previous.thinkingLevel) {
    lines.push("Thinking: Default");
  }
  return {
    ok: true,
    canonical: {
      provider: validated.provider,
      model: validated.model,
      thinkingLevel: validated.thinkingLevel,
      previous,
    },
    summary: { title: "Change your model?", lines },
  };
}

/**
 * Commit a prepared (and, unless the space never asks, approved) model
 * change for the acting bot. The bot's row is re-read and must still hold
 * the values the card showed; the write itself is guarded the same way.
 */
export async function applyOwnBotModelChange(
  deps: FleetPrepareDeps & { events: Pick<ThreadEvents, "notify"> },
  scope: Scope & { threadId: string },
  botId: string,
  canonical: Record<string, unknown>,
): Promise<
  | { ok: true; provider: string | null; model: string | null; thinkingLevel: string | null }
  | { error: string }
> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: scope.spaceId, archivedAt: null },
    select: { id: true, modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!bot) return { error: "This bot is no longer available." };
  const previous = asRecord(canonical.previous);
  if (
    (previous?.provider ?? null) !== bot.modelProvider ||
    (previous?.model ?? null) !== bot.modelId ||
    (previous?.thinkingLevel ?? null) !== (bot.thinkingLevel ?? null)
  ) {
    return { error: "Your model changed since you approved; ask again." };
  }
  const validated = await validateBotModelChange(
    { prisma: deps.prisma, ...deps.modelChange },
    {
      userId: scope.userId,
      spaceId: scope.spaceId,
      provider: text(canonical.provider) ?? null,
      model: text(canonical.model) ?? null,
      thinkingLevel: text(canonical.thinkingLevel) ?? null,
      current: { provider: bot.modelProvider, model: bot.modelId },
    },
  );
  if (!validated.ok) return { error: validated.error };
  try {
    await commitBotUpdate({
      prisma: deps.prisma,
      notify: (threadId, seq) => deps.events.notify(threadId, seq),
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      botId: bot.id,
      emitBotUpdated: true,
      expectedSettings: {
        modelProvider: bot.modelProvider,
        modelId: bot.modelId,
        thinkingLevel: bot.thinkingLevel ?? null,
      },
      data: {
        modelProvider: validated.provider,
        modelId: validated.model,
        thinkingLevel: validated.thinkingLevel,
      },
    });
  } catch (error) {
    if (isRecordNotFound(error))
      return { error: "Your model changed since you approved; ask again." };
    throw error;
  }
  return {
    ok: true,
    provider: validated.provider,
    model: validated.model,
    thinkingLevel: validated.thinkingLevel,
  };
}

export type DefaultModelChangePrepared =
  | {
      ok: true;
      canonical: {
        provider: string;
        model: string;
        previous: { provider: string | null; model: string | null };
      };
      summary: FleetCardSummary;
    }
  | { ok: false; error: string };

/**
 * Resolve a requested change to the default model — the one that runs when a bot
 * has no model of its own — before the approval card is written. The canonical
 * request the card shows is the request an approval replays, so a catalog or
 * settings change while the card waits cannot change what was approved.
 */
export async function prepareDefaultModelChange(
  deps: FleetPrepareDeps,
  scope: Scope,
  args: Record<string, unknown>,
): Promise<DefaultModelChangePrepared> {
  const provider = text(args.provider);
  const model = text(args.model);
  if (!model) return refuse("Pass the model to make the default.");
  const modelDeps = { prisma: deps.prisma, ...deps.modelChange };
  const chosen = await resolveModelChoice(modelDeps, scope, { model, provider });
  if (!chosen.ok) return refuse(chosen.error);
  const validated = await validateBotModelChange(modelDeps, {
    userId: scope.userId,
    spaceId: scope.spaceId,
    provider: chosen.provider,
    model: chosen.model,
  });
  if (!validated.ok) return refuse(validated.error);
  if (!validated.provider || !validated.model)
    return refuse("That model is not available on a connected provider.");
  const choice: ModelRoleChoice = { provider: validated.provider, modelId: validated.model };
  const current = await appliedModelRole(deps.prisma, scope, "main");
  const patch = makeDefaultModelPatch(current, choice);
  if (!patch) return refuse("That model is already the default.");
  const previous = current.primary;
  const lines = [
    `From: ${modelLabel(previous?.provider ?? null, previous?.modelId ?? null)}`,
    `To: ${modelLabel(choice.provider, choice.modelId)}`,
  ];
  // The old default is demoted, not dropped: it takes over when the new one fails.
  if (previous) lines.push("The current default stays first in the fallback chain.");
  return {
    ok: true,
    canonical: {
      provider: choice.provider,
      model: choice.modelId,
      previous: { provider: previous?.provider ?? null, model: previous?.modelId ?? null },
    },
    summary: { title: "Make this the default model?", lines },
  };
}

/**
 * Commit a prepared (and, unless the space never asks, approved) default-model
 * change. The current default is re-read and must still be the one the card
 * showed, and the patch is recomputed from it, so fallbacks edited while the
 * card waited are kept rather than clobbered.
 */
export async function applyDefaultModelChange(
  deps: FleetPrepareDeps,
  scope: Scope,
  canonical: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      provider: string;
      model: string;
      previous: { provider: string | null; model: string | null };
    }
  | { error: string }
> {
  const provider = text(canonical.provider);
  const model = text(canonical.model);
  if (!provider || !model) return { error: "This default-model change names no model." };
  const shownRecord = asRecord(canonical.previous);
  const shown = {
    provider: text(shownRecord?.provider) ?? null,
    model: text(shownRecord?.model) ?? null,
  };
  const current = await appliedModelRole(deps.prisma, scope, "main");
  const live = current.primary;
  if ((live?.provider ?? null) !== shown.provider || (live?.modelId ?? null) !== shown.model)
    return { error: "The default model changed since you approved; ask again." };
  const patch = makeDefaultModelPatch(current, { provider, modelId: model });
  if (!patch) return { error: "That model is already the default." };
  await updateModelRole(
    deps.prisma,
    { userId: scope.userId, spaceId: scope.spaceId },
    "main",
    patch,
  );
  return { ok: true, provider, model, previous: shown };
}
