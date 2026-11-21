import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole, commitBotUpdate, updateModelRole } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnBotModelRow } from "./app-model.js";
import {
  applyDefaultModelChange,
  applyOwnBotModelChange,
  listOwnBotModels,
  prepareDefaultModelChange,
  prepareOwnBotModelChange,
} from "./app-model.js";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import type * as ModelSelection from "./model-selection.js";
import { validateBotModelChange } from "./model-selection.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelection>()),
  validateBotModelChange: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appliedModelRole: vi.fn(),
  commitBotUpdate: vi.fn(),
  updateModelRole: vi.fn(),
}));

const validate = vi.mocked(validateBotModelChange);
const commit = vi.mocked(commitBotUpdate);
const appliedRole = vi.mocked(appliedModelRole);
const updateRole = vi.mocked(updateModelRole);

const scope = { userId: "user-1", spaceId: "space-1" };
const onDefault: OwnBotModelRow = {
  id: "bot-self",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
};

function deps(input?: {
  defaultModel?: { provider: string | null; model: string | null };
  botRow?: OwnBotModelRow | null;
}) {
  const credential = {
    id: "cred-google",
    provider: "google",
    secretId: "secret-google",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => [credential]) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findMany: vi.fn(async () => [{ id: "secret-google", ciphertext: "fake" }]),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        input?.botRow && where.id === input.botRow.id ? input.botRow : null,
      ),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    modelChange: {
      secretStore: { load: async () => "fake-api-key" },
      refreshExpiredCredential: vi.fn(),
      defaultModel: async () =>
        input?.defaultModel ?? { provider: "google", model: "gemini-3.8-flash" },
    },
  } satisfies FleetPrepareDeps;
}

beforeEach(() => {
  validate.mockReset();
  validate.mockImplementation(async (_deps, input) => ({
    ok: true,
    provider: input.provider,
    model: input.model,
    thinkingLevel: input.thinkingLevel ?? null,
  }));
  commit.mockReset();
  commit.mockResolvedValue({ id: "bot-self", name: "Chief", description: "" });
});

describe("listOwnBotModels", () => {
  it("lists the connections with the default model marked active for a bot on the default", async () => {
    const listing = await listOwnBotModels(deps(), scope, onDefault);
    expect(listing.current).toEqual({
      provider: "google",
      model: "gemini-3.8-flash",
      label: "Google: Gemini 3.8 Flash",
      isDefault: true,
    });
    expect(listing.connections).toHaveLength(1);
    const [connection] = listing.connections;
    expect(connection).toMatchObject({ provider: "google", providerName: "Google" });
    expect(connection!.models).toContainEqual({
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      active: true,
    });
    expect(connection!.models.some((model) => !model.active)).toBe(true);
  });

  it("marks the bot's own model, not the default, when it has one", async () => {
    const first = await listOwnBotModels(deps(), scope, onDefault);
    const other = first.connections[0]!.models.find((model) => !model.active)!;
    const listing = await listOwnBotModels(deps(), scope, {
      ...onDefault,
      modelProvider: "google",
      modelId: other.id,
    });
    expect(listing.current).toMatchObject({ model: other.id, isDefault: false });
    const [connection] = listing.connections;
    expect(connection!.models.find((model) => model.id === other.id)?.active).toBe(true);
    expect(connection!.models.find((model) => model.id === "gemini-3.8-flash")?.active).toBe(false);
  });
});

describe("prepareOwnBotModelChange", () => {
  it("resolves a spoken name and records what the approval card shows", async () => {
    const prepared = await prepareOwnBotModelChange(deps(), scope, onDefault, {
      model: "gemini flash",
    });
    expect(prepared).toEqual({
      ok: true,
      canonical: {
        provider: "google",
        model: "gemini-3.8-flash",
        thinkingLevel: null,
        previous: { provider: null, model: null, thinkingLevel: null },
      },
      summary: {
        title: "Change your model?",
        lines: ["From: Default model", "To: Google: Gemini 3.8 Flash"],
      },
    });
  });

  it("resolves names case-insensitively", async () => {
    const prepared = await prepareOwnBotModelChange(deps(), scope, onDefault, {
      model: "GEMINI FLASH",
    });
    expect(prepared).toMatchObject({
      ok: true,
      canonical: { provider: "google", model: "gemini-3.8-flash" },
    });
  });

  it("limits the search to the named provider", async () => {
    const prepared = await prepareOwnBotModelChange(deps(), scope, onDefault, {
      model: "gemini-3.8-flash",
      provider: "google",
    });
    expect(prepared).toMatchObject({
      ok: true,
      canonical: { provider: "google", model: "gemini-3.8-flash" },
    });
  });

  it("names the provider to connect when no connected model matches", async () => {
    const prepared = await prepareOwnBotModelChange(deps(), scope, onDefault, {
      model: "Claude Sonnet",
    });
    expect(prepared).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect .*Anthropic.* in Settings first/),
    });
  });

  it("refuses the model the bot already uses", async () => {
    const prepared = await prepareOwnBotModelChange(
      deps(),
      scope,
      { ...onDefault, modelProvider: "google", modelId: "gemini-3.8-flash" },
      { model: "gemini flash" },
    );
    expect(prepared).toEqual({ ok: false, error: "You already use this model." });
  });

  it("refuses clear together with a model, and a request with neither", async () => {
    expect(
      await prepareOwnBotModelChange(deps(), scope, onDefault, {
        model: "gemini flash",
        clear: true,
      }),
    ).toEqual({ ok: false, error: "Pass either clear: true or model, not both." });
    expect(await prepareOwnBotModelChange(deps(), scope, onDefault, {})).toEqual({
      ok: false,
      error: "Pass model, or clear: true.",
    });
  });

  it("resets to the default, saying when the thinking level goes with it", async () => {
    validate
      .mockImplementationOnce(async () => ({ ok: false, error: "Unsupported thinking level" }))
      .mockImplementation(async (_deps, input) => ({
        ok: true,
        provider: input.provider,
        model: input.model,
        thinkingLevel: input.thinkingLevel ?? null,
      }));
    const prepared = await prepareOwnBotModelChange(
      deps(),
      scope,
      { ...onDefault, modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
      { clear: true },
    );
    expect(prepared).toEqual({
      ok: true,
      canonical: {
        provider: null,
        model: null,
        thinkingLevel: null,
        previous: { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "high" },
      },
      summary: {
        title: "Change your model?",
        lines: ["From: Google: Gemini 3.8 Flash", "To: Default model", "Thinking: Default"],
      },
    });
  });

  it("surfaces a validation refusal", async () => {
    validate.mockResolvedValue({ ok: false, error: "Unknown model for that provider" });
    const prepared = await prepareOwnBotModelChange(deps(), scope, onDefault, {
      model: "gemini flash",
    });
    expect(prepared).toEqual({ ok: false, error: "Unknown model for that provider" });
  });
});

describe("applyOwnBotModelChange", () => {
  const canonical = {
    provider: "google",
    model: "gemini-3.8-flash",
    thinkingLevel: null,
    previous: { provider: null, model: null, thinkingLevel: null },
  };
  const notify = { notify: vi.fn(async () => undefined) };

  it("commits the prepared change to the acting bot only, guarded on its previous model", async () => {
    const prepared = deps({ botRow: onDefault });
    const result = await applyOwnBotModelChange(
      { ...prepared, events: notify },
      { ...scope, threadId: "thread-1" },
      "bot-self",
      canonical,
    );
    expect(result).toEqual({
      ok: true,
      provider: "google",
      model: "gemini-3.8-flash",
      thinkingLevel: null,
    });
    expect(prepared.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot-self", spaceId: "space-1", archivedAt: null },
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-self",
        spaceId: "space-1",
        threadId: "thread-1",
        expectedSettings: { modelProvider: null, modelId: null, thinkingLevel: null },
        data: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: null },
      }),
    );
  });

  it("cannot be aimed at another bot: an unknown id writes nothing", async () => {
    const prepared = deps({ botRow: onDefault });
    const result = await applyOwnBotModelChange(
      { ...prepared, events: notify },
      { ...scope, threadId: "thread-1" },
      "bot-other",
      canonical,
    );
    expect(result).toEqual({ error: "This bot is no longer available." });
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses when the model changed while the approval waited", async () => {
    const prepared = deps({
      botRow: { ...onDefault, modelProvider: "google", modelId: "gemini-2.5-pro" },
    });
    const result = await applyOwnBotModelChange(
      { ...prepared, events: notify },
      { ...scope, threadId: "thread-1" },
      "bot-self",
      canonical,
    );
    expect(result).toEqual({ error: "Your model changed since you approved; ask again." });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("prepareDefaultModelChange", () => {
  const currentRole = {
    primary: { provider: "google", modelId: "gemini-3.8-flash" },
    backups: [{ provider: "google", modelId: "gemini-2.5-pro" }],
  };

  beforeEach(() => {
    appliedRole.mockReset();
    appliedRole.mockResolvedValue(currentRole);
  });

  it("promotes the named model and steps the current default down to the fallback head", async () => {
    const listing = await listOwnBotModels(deps(), scope, onDefault);
    const target = listing.connections[0]!.models.find((model) => !model.active)!;
    const prepared = await prepareDefaultModelChange(deps(), scope, { model: target.id });
    expect(prepared).toEqual({
      ok: true,
      canonical: {
        provider: "google",
        model: target.id,
        previous: { provider: "google", model: "gemini-3.8-flash" },
      },
      summary: {
        title: "Make this the default model?",
        lines: [
          "From: Google: Gemini 3.8 Flash",
          `To: Google: ${target.label}`,
          "The current default stays first in the fallback chain.",
        ],
      },
    });
  });

  it("refuses the model that is already the default", async () => {
    const prepared = await prepareDefaultModelChange(deps(), scope, { model: "gemini flash" });
    expect(prepared).toEqual({ ok: false, error: "That model is already the default." });
  });

  it("needs a model to promote", async () => {
    expect(await prepareDefaultModelChange(deps(), scope, {})).toEqual({
      ok: false,
      error: "Pass the model to make the default.",
    });
  });

  it("refuses a model no connection serves", async () => {
    const prepared = await prepareDefaultModelChange(deps(), scope, { model: "Claude Sonnet" });
    expect(prepared).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect .*Anthropic.* in Settings first/),
    });
  });

  it("surfaces a validation refusal", async () => {
    const listing = await listOwnBotModels(deps(), scope, onDefault);
    const target = listing.connections[0]!.models.find((model) => !model.active)!;
    validate.mockResolvedValue({ ok: false, error: "Unknown model for that provider" });
    const prepared = await prepareDefaultModelChange(deps(), scope, { model: target.id });
    expect(prepared).toEqual({ ok: false, error: "Unknown model for that provider" });
  });
});

describe("applyDefaultModelChange", () => {
  beforeEach(() => {
    appliedRole.mockReset();
    updateRole.mockReset();
  });

  it("promotes the chosen model and steps the old default to the fallback head", async () => {
    const prepared = deps();
    appliedRole.mockResolvedValue({
      primary: { provider: "google", modelId: "gemini-3.8-flash" },
      backups: [{ provider: "google", modelId: "gemini-2.5-pro" }],
    });
    updateRole.mockResolvedValue({ primary: null, backups: [] });
    const result = await applyDefaultModelChange(prepared, scope, {
      provider: "google",
      model: "gemini-2.5-pro",
      previous: { provider: "google", model: "gemini-3.8-flash" },
    });
    expect(result).toEqual({
      ok: true,
      provider: "google",
      model: "gemini-2.5-pro",
      previous: { provider: "google", model: "gemini-3.8-flash" },
    });
    expect(updateRole).toHaveBeenCalledWith(
      prepared.prisma,
      { userId: "user-1", spaceId: "space-1" },
      "main",
      {
        primary: { provider: "google", modelId: "gemini-2.5-pro" },
        backups: [{ provider: "google", modelId: "gemini-3.8-flash" }],
      },
    );
  });

  it("refuses when the default changed while the approval waited", async () => {
    appliedRole.mockResolvedValue({
      primary: { provider: "google", modelId: "gemini-2.5-pro" },
      backups: [],
    });
    const result = await applyDefaultModelChange(deps(), scope, {
      provider: "google",
      model: "gemini-2.5-pro",
      previous: { provider: "google", model: "gemini-3.8-flash" },
    });
    expect(result).toEqual({ error: "The default model changed since you approved; ask again." });
    expect(updateRole).not.toHaveBeenCalled();
  });

  it("refuses a change that would not move the default", async () => {
    appliedRole.mockResolvedValue({
      primary: { provider: "google", modelId: "gemini-2.5-pro" },
      backups: [],
    });
    const result = await applyDefaultModelChange(deps(), scope, {
      provider: "google",
      model: "gemini-2.5-pro",
      previous: { provider: "google", model: "gemini-2.5-pro" },
    });
    expect(result).toEqual({ error: "That model is already the default." });
    expect(updateRole).not.toHaveBeenCalled();
  });

  it("refuses a prepared request that names no model", async () => {
    const result = await applyDefaultModelChange(deps(), scope, {
      previous: { provider: null, model: null },
    });
    expect(result).toEqual({ error: "This default-model change names no model." });
    expect(updateRole).not.toHaveBeenCalled();
  });
});
