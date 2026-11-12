import type { AdapterContext, AutoReviewRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { DrexAutoReviewProvider } from "./drex-auto-review.js";

const context: AdapterContext = {
  operationId: "auto-review",
  traceId: "auto-review",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const request: AutoReviewRequest = {
  toolName: "gmail_send_email",
  connectorKind: "gmail",
  args: { to: "a@b.test" },
  userTask: "Draft a reply",
  botDescription: "Mail bot",
  matchingRules: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DrexAutoReviewProvider", () => {
  it("maps a pass choice to pass through the Nace endpoint", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse({
        model: "drex-latest",
        answers: { decision: { type: "choice", choice: "pass", confidence: 0.9 } },
      });
    };
    const provider = new DrexAutoReviewProvider({ apiKey: "nace-key", fetch: fetchMock });
    await expect(provider.review(request, context)).resolves.toEqual({
      decision: "pass",
      model: "drex/drex-latest",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://console.nace.ai/v1/systemone");
    const headers = seen[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer nace-key");
    const body = JSON.parse(String(seen[0]?.init?.body)) as { model: string };
    expect(body.model).toBe("drex-latest");
    expect(JSON.stringify(body)).not.toContain("nace-key");
  });

  it("refuses a blank API key", () => {
    expect(() => new DrexAutoReviewProvider({ apiKey: " " })).toThrow(/NACE_API_KEY/);
  });

  it("maps HTTP failures to error without leaking the key", async () => {
    const provider = new DrexAutoReviewProvider({
      apiKey: "nace-key",
      fetch: async () => new Response("nace-key leaked", { status: 401 }),
    });
    const result = await provider.review(request, context);
    expect(result).toMatchObject({ decision: "error", reason: "Checker could not authenticate." });
    expect(JSON.stringify(result)).not.toContain("nace-key");
  });
});
