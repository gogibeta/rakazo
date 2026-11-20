import { describe, expect, it } from "vitest";
import type { DrainSteps } from "./shutdown-drain.js";
import { drainServer } from "./shutdown-drain.js";

/** Records the order steps ran in, so the test can assert on sequence rather than just success. */
function recorder(options: { closeDelayMs?: number; drainDelayMs?: number } = {}) {
  const order: string[] = [];
  const steps: DrainSteps = {
    closeServer: async () => {
      order.push("close:start");
      await new Promise((r) => setTimeout(r, options.closeDelayMs ?? 10));
      order.push("close:done");
    },
    stopAcceptingWork: async () => {
      order.push("drain:start");
      await new Promise((r) => setTimeout(r, options.drainDelayMs ?? 10));
      order.push("drain:done");
    },
    destroySockets: () => {
      order.push("destroy");
    },
  };
  return { order, steps };
}

describe("drainServer", () => {
  it("drains in-flight work before destroying the sockets carrying it", async () => {
    // The bug this pins: destroying sockets on a timer that starts with server.close() cut off a
    // handler slower than the grace period. A request in flight must reach "drain:done" while its
    // socket still exists, so the drain has to come before the destroy. The delays are distinct on
    // purpose: equal ones let the two timers race and the assertion flake.
    const { order, steps } = recorder({ closeDelayMs: 50, drainDelayMs: 5 });
    await drainServer(steps);
    expect(order).toEqual(["close:start", "drain:start", "drain:done", "destroy", "close:done"]);
    expect(order.indexOf("drain:done")).toBeLessThan(order.indexOf("destroy"));
  });

  it("does not destroy sockets when the drain throws partway through", async () => {
    // A failed drain must not silently turn into a force-close that resets live requests; the
    // error is the caller's to handle.
    const order: string[] = [];
    const steps: DrainSteps = {
      closeServer: async () => {
        order.push("close");
      },
      stopAcceptingWork: async () => {
        order.push("drain");
        throw new Error("drain failed");
      },
      destroySockets: () => {
        order.push("destroy");
      },
    };
    await expect(drainServer(steps)).rejects.toThrow("drain failed");
    expect(order).toEqual(["close", "drain"]);
    expect(order).not.toContain("destroy");
  });

  it("waits for the server to actually close, not just for the drain", async () => {
    // A server whose close resolves last must still be awaited; otherwise shutdown returns while
    // the listening handle is half-closed.
    const { order, steps } = recorder({ closeDelayMs: 30, drainDelayMs: 5 });
    await drainServer(steps);
    expect(order.at(-1)).toBe("close:done");
  });
});
