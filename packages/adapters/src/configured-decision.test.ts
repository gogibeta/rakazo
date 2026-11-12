import type { AdapterContext, DecisionRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredDecision } from "./configured-decision.js";

const context: AdapterContext = {
  operationId: "review",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};

function requestFor(model: string): DecisionRequest {
  return {
    model,
    state: { task: "fake task" },
    questions: {
      decision: {
        type: "choice",
        instructions: "Choose",
        criteria: { pass: "Safe", ask: "Needs a person" },
      },
    },
  };
}

const okResponse = (model: string) =>
  new Response(
    JSON.stringify({
      id: "fake-request",
      model,
      answers: { decision: { type: "choice", choice: "pass", confidence: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 },
    }),
  );

/** Runs the configured provider against a stubbed fetch and reports where it called and with what key. */
async function callConfigured(
  configured: NonNullable<ReturnType<typeof createConfiguredDecision>>,
) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => okResponse(configured.model));
  vi.stubGlobal("fetch", fetchMock);
  const result = await configured.provider.decide(requestFor(configured.model), context);
  expect(result.answers.decision).toEqual({ type: "choice", choice: "pass", confidence: 0.9 });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url, authorization: headers.Authorization };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createConfiguredDecision", () => {
  it("is unconfigured when neither the environment nor Settings has a key", () => {
    expect(createConfiguredDecision({})).toBeUndefined();
    expect(createConfiguredDecision({}, {})).toBeUndefined();
    expect(createConfiguredDecision({}, { naceApiKey: "   " })).toBeUndefined();
  });

  it("uses the saved Nace key when the environment has none", async () => {
    const configured = createConfiguredDecision({}, { naceApiKey: "saved-nace-key" });
    expect(configured?.model).toBe("drex-latest");
    if (!configured) throw new Error("expected a configured decision provider");
    await expect(callConfigured(configured)).resolves.toEqual({
      url: "https://console.nace.ai/v1/systemone",
      authorization: "Bearer saved-nace-key",
    });
  });

  it("prefers the environment's Nace key over the saved one", async () => {
    const configured = createConfiguredDecision(
      { NACE_API_KEY: "env-nace-key" },
      { naceApiKey: "saved-nace-key" },
    );
    if (!configured) throw new Error("expected a configured decision provider");
    await expect(callConfigured(configured)).resolves.toEqual({
      url: "https://console.nace.ai/v1/systemone",
      authorization: "Bearer env-nace-key",
    });
  });

  it("falls back to the saved TypeSafe key when no Nace key exists anywhere", async () => {
    const configured = createConfiguredDecision({}, { typesafeApiKey: "saved-typesafe-key" });
    expect(configured?.model).toBe("jev-latest");
    if (!configured) throw new Error("expected a configured decision provider");
    await expect(callConfigured(configured)).resolves.toEqual({
      url: "https://api.typesafe.ai/v1/systemone",
      authorization: "Bearer saved-typesafe-key",
    });
  });
});
