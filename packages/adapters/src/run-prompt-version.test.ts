import { promptVersion } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { trackRunPromptVersion } from "./run-prompt-version.js";

function fakeStore() {
  const update = vi.fn().mockResolvedValue({});
  return { store: { run: { update } }, update };
}

describe("trackRunPromptVersion", () => {
  it("returns the run request unchanged so it reaches the runtime untouched", () => {
    const { store } = fakeStore();
    const request = { instructions: "You are a Rakazo bot.", runId: "run-1" };
    expect(trackRunPromptVersion(store, "run-1", request)).toBe(request);
  });

  it("records the content-derived version of the prompt the run executes with", () => {
    const { store, update } = fakeStore();
    const request = { instructions: "You are a Rakazo bot with a persistent sandbox." };
    trackRunPromptVersion(store, "run-1", request);
    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { promptVersion: promptVersion(request.instructions) },
    });
  });

  it("gives two runs the same version when their prompt is unchanged", () => {
    const first = fakeStore();
    const second = fakeStore();
    const instructions = "You are a Rakazo bot.";
    trackRunPromptVersion(first.store, "run-1", { instructions });
    trackRunPromptVersion(second.store, "run-2", { instructions });
    expect(first.update.mock.calls[0]?.[0].data.promptVersion).toBe(
      second.update.mock.calls[0]?.[0].data.promptVersion,
    );
  });

  it("never lets a failed version write block or fail the run", async () => {
    const update = vi.fn().mockRejectedValue(new Error("write failed"));
    const store = { run: { update } };
    const request = { instructions: "You are a Rakazo bot." };
    expect(trackRunPromptVersion(store, "run-1", request)).toBe(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(update).toHaveBeenCalled();
  });

  it("survives a data layer without run.update, such as a narrow test fake", () => {
    const request = { instructions: "You are a Rakazo bot." };
    expect(() => trackRunPromptVersion({ run: {} as never }, "run-1", request)).not.toThrow();
  });
});
