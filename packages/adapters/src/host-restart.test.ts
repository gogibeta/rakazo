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
const serverError = { ok: false, status: 500 };

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
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/stop");
    expect(calls[1]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/start");
    for (const call of calls) {
      expect(call.init?.method).toBe("POST");
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer key-123");
      expect(headers["idempotency-key"]).toEqual(expect.any(String));
      expect(headers["idempotency-key"]!.length).toBeGreaterThan(0);
    }
    // Idempotency keys are per-request: the start carries a different key
    // from the stop.
    expect(idempotencyKeyOf(calls[1]!)).not.toBe(idempotencyKeyOf(calls[0]!));
  });

  it("does not resolve restart() until the start request has been accepted", async () => {
    let acceptStart!: (response: Response) => void;
    const startGate = new Promise<Response>((resolve) => {
      acceptStart = resolve;
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/start")) return startGate;
      return { ok: true, status: 202, text: async () => "" } as unknown as Response;
    });
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    let resolved = false;
    const pending = restarter.restart().then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // Give restart() every chance to settle early; it must not: the caller
    // dies with the guest, so returning before the start is accepted could
    // lose the start and leave the machine off.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    acceptStart({ ok: true, status: 202, text: async () => "" } as unknown as Response);
    await pending;
    expect(resolved).toBe(true);
  });

  it("retries the start after a network failure, reusing the start's own idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let startAttempts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/start")) {
        startAttempts++;
        if (startAttempts === 1) throw new TypeError("fetch failed");
      }
      return { ok: true, status: 202, text: async () => "" } as unknown as Response;
    });
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await restarter.restart();
    expect(startAttempts).toBe(2);
    // Every start attempt reuses the start's own key, never the stop's.
    const startKeys = new Set(
      calls.filter((call) => call.url.endsWith("/start")).map(idempotencyKeyOf),
    );
    expect(startKeys.size).toBe(1);
    expect(startKeys.has(idempotencyKeyOf(calls[0]!))).toBe(false);
  });

  it("fails the restart at once when the start is refused with a 409", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, conflict]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(restarter.restart()).rejects.toThrow("409");
    // A conflict fails identically on every retry: exactly one start attempt.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.instabox.sh/v1/machines/m_abc/start");
  });

  it("retries the start through the operation_conflict window until the stop settles", async () => {
    // Live-verified: a start fired while the stop operation is still active
    // is refused with 409 operation_conflict, and the same start is accepted
    // once the stop settles.
    const operationConflict = {
      ok: false,
      status: 409,
      body: JSON.stringify({
        error: {
          code: "operation_conflict",
          message: "machine has an active stop operation",
        },
      }),
    };
    const { calls, fetchImpl } = recordingFetch([ok, operationConflict, operationConflict, ok]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await restarter.restart();
    const startCalls = calls.filter((call) => call.url.endsWith("/start"));
    expect(startCalls).toHaveLength(3);
    // Every retried start reuses the start's own key, never the stop's.
    const startKeys = new Set(startCalls.map(idempotencyKeyOf));
    expect(startKeys.size).toBe(1);
    expect(startKeys.has(idempotencyKeyOf(calls[0]!))).toBe(false);
  });

  it("fails the restart at once when the start is refused with a 409 that is not operation_conflict", async () => {
    const otherConflict = {
      ok: false,
      status: 409,
      body: JSON.stringify({
        error: { code: "some_other_conflict", message: "a different conflict" },
      }),
    };
    const { calls, fetchImpl } = recordingFetch([ok, otherConflict]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(restarter.restart()).rejects.toThrow("409");
    // Only operation_conflict is transient: exactly one start attempt.
    const startCalls = calls.filter((call) => call.url.endsWith("/start"));
    expect(startCalls).toHaveLength(1);
  });

  it("gives up after a bounded number of start attempts when the start keeps failing transiently", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, serverError]);
    const restarter = createInstaboxHostRestarter({
      apiKey: "key-123",
      machineId: "m_abc",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(restarter.restart()).rejects.toThrow("500");
    const startCalls = calls.filter((call) => call.url.endsWith("/start"));
    // One attempt per 2s interval across the 120s retry window, even when
    // the injected sleep returns immediately.
    expect(startCalls).toHaveLength(60);
    // Every attempt reuses the start's own key, never the stop's.
    const startKeys = new Set(startCalls.map(idempotencyKeyOf));
    expect(startKeys.size).toBe(1);
    expect(startKeys.has(idempotencyKeyOf(calls[0]!))).toBe(false);
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
    await restarter.restart();
    expect(calls).toHaveLength(4);
    // A fresh key per action per restart: all four calls carry distinct keys.
    expect(new Set(calls.map(idempotencyKeyOf)).size).toBe(4);
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
