import { describe, expect, it, vi } from "vitest";
import { createHostRestarter, createInstaboxHostRestarter } from "./host-restart.js";

function recordingFetch(responses: Array<{ ok: boolean; status: number; body?: string }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return { ...response, text: async () => response.body ?? "" } as unknown as Response;
  });
  return { calls, fetchImpl };
}

const ok = { ok: true, status: 202 };
const conflict = { ok: false, status: 409 };

function idempotencyKeyOf(call: { init?: RequestInit }): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.["idempotency-key"];
}

describe("createInstaboxHostRestarter", () => {
  it("stops then starts the one configured machine, with the key as an Authorization Bearer token", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, ok]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await restarter.restart();
    // The start runs in the background; let it land before asserting.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/stop");
    expect(calls[1]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/start");
    for (const call of calls) {
      expect(call.init?.method).toBe("POST");
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer key-123");
      expect(headers["idempotency-key"]).toEqual(expect.any(String));
      expect(headers["idempotency-key"]!.length).toBeGreaterThan(0);
    }
    // One idempotency key per restart, shared by its stop and start calls.
    expect(idempotencyKeyOf(calls[1]!)).toBe(idempotencyKeyOf(calls[0]!));
  });

  it("retries the start while the platform refuses it during the stop", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, conflict, conflict, ok]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await restarter.restart();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.slice(1).every((call) => call.url.endsWith("/start"))).toBe(true);
    // Retried starts reuse the restart's one idempotency key.
    expect(new Set(calls.map(idempotencyKeyOf)).size).toBe(1);
  });

  it("mints a fresh idempotency key for each restart", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, ok]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await restarter.restart();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await restarter.restart();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(idempotencyKeyOf(calls[1]!)).toBe(idempotencyKeyOf(calls[0]!));
    expect(idempotencyKeyOf(calls[3]!)).toBe(idempotencyKeyOf(calls[2]!));
    expect(idempotencyKeyOf(calls[2]!)).not.toBe(idempotencyKeyOf(calls[0]!));
  });

  it("fails the restart when the stop itself is refused", async () => {
    const { calls, fetchImpl } = recordingFetch([conflict]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(restarter.restart()).rejects.toThrow("409");
    expect(calls).toHaveLength(1);
  });

  it("surfaces the API's error detail from a JSON body, never the key", async () => {
    const body = JSON.stringify({
      error: { code: "malformed_key", message: "Send the key as an Authorization Bearer token" },
    });
    const { fetchImpl } = recordingFetch([{ ok: false, status: 400, body }]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    const error = await restarter.restart().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).toContain("malformed_key");
    expect((error as Error).message).toContain("Authorization Bearer token");
    expect((error as Error).message).not.toContain("key-123");
  });
});

describe("createHostRestarter", () => {
  it("is disabled unless both the key and the machine id are set", () => {
    expect(createHostRestarter({})).toBeUndefined();
    expect(createHostRestarter({ INSTABOX_API_KEY: "key-123" })).toBeUndefined();
    expect(createHostRestarter({ INSTABOX_MACHINE_ID: "m_abc" })).toBeUndefined();
    expect(
      createHostRestarter({ INSTABOX_API_KEY: "key-123", INSTABOX_MACHINE_ID: "m_abc" }),
    ).toBeDefined();
  });
});
