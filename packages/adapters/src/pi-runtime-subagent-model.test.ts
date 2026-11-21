import { describe, expect, it, vi } from "vitest";
import { subagentRequestModel } from "./pi-runtime-subagent.js";

const runModel = { provider: "run-provider", id: "run-model" };
const activeConfig = { provider: "run-provider", id: "run-model" };

function host(
  overrides: {
    fallbackModels?: Array<{ provider: string; id: string }>;
    resolveModel?: (provider: string, modelId: string) => Promise<{ provider: string; id: string }>;
    resolveSubagentModel?: () => Promise<{ provider: string; id: string } | null>;
  } = {},
) {
  return {
    request: {
      model: runModel,
      fallbackModels: overrides.fallbackModels,
      resolveModel: overrides.resolveModel,
      resolveSubagentModel: overrides.resolveSubagentModel,
    },
    activeModel: { config: activeConfig },
  };
}

describe("the model a helper runs", () => {
  it("follows the run's model when the member set no subagent model", async () => {
    const h = host();
    await expect(subagentRequestModel(h, { name: "scout", task: "t" })).resolves.toBe(runModel);
  });

  it("runs the member's configured subagent model when they set one", async () => {
    const configured = { provider: "helper-provider", id: "helper-model" };
    const resolveSubagentModel = vi.fn(async () => configured);
    const h = host({ resolveSubagentModel });
    await expect(subagentRequestModel(h, {})).resolves.toBe(configured);
    // Read when a helper actually starts, so a run that starts none does no extra work.
    expect(resolveSubagentModel).toHaveBeenCalledOnce();
  });

  it("prefers the model the call named over the configured subagent model", async () => {
    const configured = { provider: "helper-provider", id: "helper-model" };
    const resolved = { provider: "named-provider", id: "named-model" };
    const h = host({
      resolveModel: vi.fn(async () => resolved),
      resolveSubagentModel: vi.fn(async () => configured),
    });
    await expect(
      subagentRequestModel(h, { model_provider: "named-provider", model_id: "named-model" }),
    ).resolves.toBe(resolved);
  });

  it("follows the run's model when the configured subagent model cannot run", async () => {
    const h = host({ resolveSubagentModel: vi.fn(async () => null) });
    await expect(subagentRequestModel(h, {})).resolves.toBe(runModel);
  });

  it("rejects a call that names only half a model", async () => {
    const h = host();
    await expect(subagentRequestModel(h, { model_provider: "p" })).rejects.toThrow(
      "model_provider and model_id must both be set",
    );
    await expect(subagentRequestModel(h, { model_id: "m" })).rejects.toThrow(
      "model_provider and model_id must both be set",
    );
  });

  it("keeps the active model's config when the run has fallbacks and names no model", async () => {
    const h = host({ fallbackModels: [{ provider: "backup-provider", id: "backup-model" }] });
    await expect(subagentRequestModel(h, {})).resolves.toBe(activeConfig);
  });
});
