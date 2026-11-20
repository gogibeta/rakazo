import type * as NodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunExecutionHost } from "./run-execution.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: vi.fn(),
}));

const GiB = 1024 ** 3;

function cgroupFiles(inactiveFile: number) {
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (path === "/proc/self/cgroup") return "0::/\n";
    if (path === "/sys/fs/cgroup/memory.stat")
      return `anon 734003200\nfile ${inactiveFile + 4096}\ninactive_file ${inactiveFile}\nactive_file 4096\n`;
    throw new Error(`unexpected read ${path}`);
  }) as unknown as typeof readFileSync);
}

describe("RunExecutionHost memory admission", () => {
  let release: () => void;
  let released: Promise<void>;
  const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
    onRunStarted();
    await released;
  };

  beforeEach(() => {
    released = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(process, "constrainedMemory").mockReturnValue(2 * GiB);
    vi.spyOn(process, "availableMemory").mockReturnValue(1024 ** 2);
  });
  afterEach(() => {
    release();
    vi.restoreAllMocks();
  });

  it("counts a container's inactive page cache as room for another run", async () => {
    cgroupFiles(GiB);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(true);
    release();
    await host.stop();
  });

  it("still holds runs back when the container's memory is really in use", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(false);
    release();
    await host.stop();
  });
});

describe("RunExecutionHost shutdown", () => {
  // execute() waits for the callback to report it started, so every run here calls onRunStarted
  // before blocking; otherwise the test would hang inside admission rather than in stop().
  it("lets a run in progress finish its turn before stop resolves", async () => {
    // A stopping worker must not drop a run mid-turn: the turn's writes are half done, and nothing
    // else is left to finish them. stop() therefore waits for active runs rather than aborting them.
    const host = new RunExecutionHost();
    let finishRun: () => void = () => undefined;
    let runReachedTheEnd = false;
    let started: () => void = () => undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = new Promise<void>((resolve) => {
      finishRun = () => {
        runReachedTheEnd = true;
        resolve();
      };
    });
    const execution = host.execute(async ({ onRunStarted }) => {
      onRunStarted();
      started();
      await run;
    });
    await began;
    await new Promise((r) => setTimeout(r, 10));
    expect(host.activeCount).toBe(1);

    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });

    // stop() is waiting, not done: the run has not finished yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    expect(host.activeCount).toBe(1);

    finishRun();
    await stopping;
    await execution;
    expect(stopped).toBe(true);
    expect(runReachedTheEnd).toBe(true);
    expect(host.activeCount).toBe(0);
  });

  it("refuses new work once stopping", async () => {
    // The complement: draining existing runs must not mean quietly accepting more.
    const host = new RunExecutionHost();
    let finishRun: () => void = () => undefined;
    let began: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const execution = host.execute(async ({ onRunStarted }) => {
      onRunStarted();
      began();
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    await started;
    const stopping = host.stop();
    await expect(
      host.execute(
        async ({ onRunStarted }) => {
          onRunStarted();
        },
        { waitForCapacity: false },
      ),
    ).rejects.toThrow("Worker is stopping");
    finishRun();
    await stopping;
    await execution;
  });
});
