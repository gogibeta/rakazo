import { describe, expect, it } from "vitest";
import { promptVersion } from "./prompt-version.js";

describe("promptVersion", () => {
  it("is deterministic for the same prompt text", () => {
    const prompt = "You are a Rakazo bot with a persistent sandbox filesystem and shell.";
    expect(promptVersion(prompt)).toBe(promptVersion(prompt));
  });

  it("changes when the prompt changes, so an edit bumps the version on its own", () => {
    expect(promptVersion("You are a Rakazo bot.")).not.toBe(promptVersion("You are a Rakazo bot!"));
  });

  it("distinguishes prompts that differ only by one appended character", () => {
    expect(promptVersion("abc")).not.toBe(promptVersion("abcd"));
  });

  it("returns a 16-character lowercase hex version", () => {
    expect(promptVersion("any prompt")).toMatch(/^[0-9a-f]{16}$/);
  });
});
