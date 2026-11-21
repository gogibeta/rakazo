import { approvalModeFromPreference } from "@rakazo/core";
import type { OwnBotModelRow } from "./app-model.js";
import { applyOwnBotModelChange, listOwnBotModels } from "./app-model.js";
import { asRecord } from "./connector-http.js";
import { botModelLabel } from "./fleet-tools.js";
import type { RunContext } from "./run-context.js";
import { fleetPrepareDeps } from "./run-model.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/**
 * Conversational app control: the tools behind plain-words requests like
 * "what model are you on?" and "change your model to …". They act only on
 * the bot this run belongs to; app_set_model runs the request the approval
 * step prepared (see prepareToolRequest), never the model's raw arguments.
 */
export const appTools: ToolHandlers = {
  async app_list_models(ctx, call) {
    const { deps, run, bot } = ctx;
    const prepared = await fleetPrepareDeps(deps, run);
    const live = await liveModelRow(ctx);
    return call.finish(await listOwnBotModels(prepared, run, live ?? bot));
  },

  async app_get_settings(ctx, call) {
    const { deps, run, bot } = ctx;
    const prepared = await fleetPrepareDeps(deps, run);
    const live = await deps.prisma.bot.findUnique({
      where: { id: bot.id },
      select: {
        name: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
        autoSpeak: true,
        notifyOnFinish: true,
        dailyCheckIns: true,
        computer: { select: { state: true, kind: true } },
      },
    });
    if (!live) return call.finish({ error: "This bot is no longer available." });
    const fallback = await prepared.modelChange.defaultModel();
    const own = Boolean(live.modelProvider && live.modelId);
    return call.finish({
      name: live.name,
      model: {
        provider: own ? live.modelProvider : fallback.provider,
        model: own ? live.modelId : fallback.model,
        label: botModelLabel(live, fallback),
        isDefault: !own,
      },
      thinkingLevel: live.thinkingLevel ?? "default",
      approvalMode: approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()),
      computer: live.computer ? { state: live.computer.state, kind: live.computer.kind } : null,
      notifyOnFinish: live.notifyOnFinish,
      dailyCheckIns: live.dailyCheckIns,
      readAloud: live.autoSpeak,
    });
  },

  async app_set_model(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    // Preparation replaced the model's arguments with the resolved request
    // the approval card showed. Anything else never went through approval.
    if (!asRecord(args.previous) || !("provider" in args) || !("model" in args)) {
      return call.finish({ error: "This model change needs the owner's approval." });
    }
    const prepared = await fleetPrepareDeps(deps, run);
    const result = await applyOwnBotModelChange(
      { ...prepared, events: deps.events },
      { userId: run.userId, spaceId: run.spaceId, threadId: thread.id },
      bot.id,
      args,
    );
    return call.finish(result);
  },
};

/** The acting bot's model fields as they stand now, not at the run's start. */
async function liveModelRow(ctx: Pick<RunContext, "deps" | "bot">): Promise<OwnBotModelRow | null> {
  return ctx.deps.prisma.bot.findUnique({
    where: { id: ctx.bot.id },
    select: { id: true, modelProvider: true, modelId: true, thinkingLevel: true },
  });
}
