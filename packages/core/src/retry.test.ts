import { describe, expect, it, vi } from "vitest";
import { abortableDelay, deadlineSignal, retry } from "./index.js";

describe("retry", () => {
  it("returns the first success without waiting", async () => {
    const operation = vi.fn().mockResolvedValue("done");
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 3, delay })).resolves.toBe("done");

    expect(operation).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("tries again after a failure and rejects with the last one", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 2, delayMs: 1, delay })).rejects.toThrow("second");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1, undefined);
  });

  it("stops at the tries asked for", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("nope"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 4, delayMs: 0, delay })).rejects.toThrow("nope");
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("does not try again when the failure is not retryable", async () => {
    const operation = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 4, delay })).rejects.toThrow("gone");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("asks its own retryable function instead of the shared policy", async () => {
    const operation = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      retry(operation, { attempts: 2, retryable: () => true, delayMs: 0, delay }),
    ).rejects.toThrow("gone");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("takes a list of waits, its last entry repeating", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("nope"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 4, delayMs: [10, 20], delay })).rejects.toThrow(
      "nope",
    );
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 20]);
  });

  it("takes a wait from a function of the failed try", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("nope"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      retry(operation, { attempts: 3, delayMs: (attempt) => attempt * 100 + 1, delay }),
    ).rejects.toThrow("nope");
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([1, 101]);
  });

  it("does not pause when the wait asked for is zero", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("nope"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 3, delayMs: 0, delay })).rejects.toThrow("nope");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delay).not.toHaveBeenCalled();
  });

  it("backs off on its own, honoring the wait the error asked for", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { retryAfterMs: 3_000 }))
      .mockResolvedValue("done");
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(retry(operation, { attempts: 2, delay })).resolves.toBe("done");
    expect(delay).toHaveBeenCalledWith(3_000, undefined);
  });

  it("reports each failure it retries", async () => {
    const error = new Error("nope");
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("done");
    const onRetry = vi.fn();

    await retry(operation, { attempts: 2, delayMs: 7, delay: vi.fn(), onRetry });

    expect(onRetry).toHaveBeenCalledWith(error, 0, 7);
  });

  it("rejects with the signal's reason instead of waiting out the pause", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new Error("nope"));
    const delay = vi.fn(async () => {
      controller.abort(new Error("stopped"));
    });

    await expect(
      retry(operation, { attempts: 4, delayMs: 1_000, delay, signal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("deadlineSignal", () => {
  it("aborts on its own after the time asked for", async () => {
    // AbortSignal.timeout runs on the real clock, so this waits a real few milliseconds.
    const signal = deadlineSignal(20);
    expect(signal.aborted).toBe(false);
    await abortableDelay(60, signal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("aborts with the parent's reason, before its own time", async () => {
    const parent = new AbortController();
    const reason = new Error("the caller gave up");
    const signal = deadlineSignal(60_000, parent.signal);

    parent.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("is already aborted when the parent already is", () => {
    const parent = new AbortController();
    const reason = new Error("gone");
    parent.abort(reason);

    const signal = deadlineSignal(60_000, parent.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("does not need disposing, and keeps a paused request within the deadline", async () => {
    const signal = deadlineSignal(5);
    await abortableDelay(50, signal);
    expect(signal.aborted).toBe(true);
  });
});
