import { describe, expect, it, vi } from "vitest";
import { createHostRestarter, createInstaboxHostRestarter } from "./host-restart.js";

function recordingFetch(responses: Array<{ ok: boolean; status: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return response as Response;
  });
  return { calls, fetchImpl };
}

const ok = { ok: true, status: 202 };
const conflict = { ok: false, status: 409 };

describe("createInstaboxHostRestarter", () => {
  it("stops then starts the one configured machine, with the key as a bearer token", async () => {
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
      expect(call.init?.headers).toEqual({ authorization: "Bearer key-123" });
    }
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
