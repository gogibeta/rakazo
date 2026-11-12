import type { AdapterContext, DecisionProvider, DecisionRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { decisionFromTool } from "./decision-tools.js";

const context: AdapterContext = {
  operationId: "decide",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};

function fakeProvider() {
  const calls: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    async decide(request) {
      calls.push(request);
      return {
        model: "drex-latest",
        answers: {
          route: { type: "choice", choice: "support", confidence: 0.87 },
        },
      };
    },
  };
  return { provider, calls };
}

const decisions = (provider: DecisionProvider) => ({ provider, model: "drex-latest" });

describe("decisionFromTool", () => {
  it("maps tool arguments onto the decision contract", async () => {
    const { provider, calls } = fakeProvider();
    const result = await decisionFromTool(decisions(provider), context, {
      state: "My invoice was charged twice",
      questions: [
        {
          name: "route",
          question: "Where should this ticket go?",
          options: [
            { label: "support", description: "Billing and account help" },
            { label: "sales", description: "New purchases" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      model: "drex-latest",
      answers: { route: { type: "choice", choice: "support", confidence: 0.87 } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("drex-latest");
    expect(calls[0]?.state).toEqual({ text: "My invoice was charged twice" });
    expect(calls[0]?.questions).toEqual({
      route: {
        type: "choice",
        instructions: "Where should this ticket go?",
        criteria: { support: "Billing and account help", sales: "New purchases" },
      },
    });
  });

  it("passes an object state through and defaults plain labels to themselves", async () => {
    const { provider, calls } = fakeProvider();
    await decisionFromTool(decisions(provider), context, {
      state: { amount: 42, currency: "USD" },
      questions: [{ name: "route", question: "Pick one", options: ["support", "sales"] }],
    });
    expect(calls[0]?.state).toEqual({ amount: 42, currency: "USD" });
    expect(calls[0]?.questions.route?.criteria).toEqual({ support: "support", sales: "sales" });
  });

  it("rejects malformed calls without reaching the provider", async () => {
    const { provider, calls } = fakeProvider();
    const run = (args: Record<string, unknown>) =>
      decisionFromTool(decisions(provider), context, args);
    await expect(
      run({ questions: [{ name: "q", question: "?", options: ["a", "b"] }] }),
    ).resolves.toEqual({
      error: "state is required",
    });
    await expect(run({ state: "x" })).resolves.toEqual({ error: "questions are required" });
    await expect(
      run({ state: "x", questions: [{ name: "q", question: "?", options: ["only"] }] }),
    ).resolves.toEqual({ error: 'question "q" needs at least two options' });
    await expect(
      run({
        state: "x",
        questions: [
          { name: "q", question: "?", options: ["a", "b"] },
          { name: "q", question: "?", options: ["a", "b"] },
        ],
      }),
    ).resolves.toEqual({ error: 'duplicate question name "q"' });
    expect(calls).toHaveLength(0);
  });

  it("surfaces provider failures as tool errors", async () => {
    const provider: DecisionProvider = {
      async decide() {
        throw new Error("Decision provider could not complete the request");
      },
    };
    await expect(
      decisionFromTool(decisions(provider), context, {
        state: "x",
        questions: [{ name: "route", question: "?", options: ["a", "b"] }],
      }),
    ).resolves.toEqual({ error: "Decision provider could not complete the request" });
  });
});
