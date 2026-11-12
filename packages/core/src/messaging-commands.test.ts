import { describe, expect, it } from "vitest";
import { parseMessagingCommand, parseMessagingSlashCommand } from "./messaging-commands.js";

describe("parseMessagingCommand", () => {
  it("parses the minimal command set case-insensitively", () => {
    expect(parseMessagingCommand("YES")).toBe("approve");
    expect(parseMessagingCommand("yes")).toBe("approve");
    expect(parseMessagingCommand(" yes ")).toBe("approve");
    expect(parseMessagingCommand("NO")).toBe("decline");
    expect(parseMessagingCommand("no")).toBe("decline");
    expect(parseMessagingCommand("LEAVE")).toBe("leave");
    expect(parseMessagingCommand("leave")).toBe("leave");
  });

  it("reads a bare stop or stop now, ignoring case, spacing and closing punctuation", () => {
    for (const text of ["stop", "Stop now.", "STOP!", "  stop   now ", "stop…"])
      expect(parseMessagingCommand(text)).toBe("stop");
    for (const text of [
      "Stopp!",
      "detente",
      "¡Detente!",
      "Стоп",
      "停止。",
      "停下！",
      "przestań",
      "Arrête !",
      "pare",
      "멈춰",
      "Dur.",
      "रुको",
      "עצור",
    ])
      expect(parseMessagingCommand(text)).toBe("stop");
    for (const text of ["para", "¿Para?", "stop it", "stopper", "don't stop", "/stop", "stop, now"])
      expect(parseMessagingCommand(text)).toBeNull();
  });

  it("treats everything else as a normal message", () => {
    expect(parseMessagingCommand("yes please")).toBeNull();
    expect(parseMessagingCommand("YES!")).toBeNull();
    expect(parseMessagingCommand("")).toBeNull();
    expect(parseMessagingCommand("hello")).toBeNull();
    expect(parseMessagingCommand("leave the group")).toBeNull();
  });
});

describe("parseMessagingSlashCommand", () => {
  it("parses each command at the start of a message, case-insensitively", () => {
    expect(parseMessagingSlashCommand("/bot")).toEqual({ name: "bot", argument: null });
    expect(parseMessagingSlashCommand("/BOT")).toEqual({ name: "bot", argument: null });
    expect(parseMessagingSlashCommand("/bot Research")).toEqual({
      name: "bot",
      argument: "Research",
    });
    expect(parseMessagingSlashCommand("/new")).toEqual({ name: "new" });
    expect(parseMessagingSlashCommand("/queue write the summary")).toEqual({
      name: "queue",
      text: "write the summary",
    });
    expect(parseMessagingSlashCommand("/steer focus on the tests")).toEqual({
      name: "steer",
      text: "focus on the tests",
    });
    expect(parseMessagingSlashCommand("/steer")).toEqual({ name: "steer", text: "" });
    expect(parseMessagingSlashCommand("/model")).toEqual({ name: "model", argument: null });
    expect(parseMessagingSlashCommand("/model claude-sonnet-5")).toEqual({
      name: "model",
      argument: "claude-sonnet-5",
    });
    expect(parseMessagingSlashCommand("/help")).toEqual({ name: "help" });
  });

  it("accepts a platform's @bot suffix on the command word", () => {
    expect(parseMessagingSlashCommand("/bot@RakazoBot")).toEqual({ name: "bot", argument: null });
    expect(parseMessagingSlashCommand("/queue@RakazoBot later please")).toEqual({
      name: "queue",
      text: "later please",
    });
  });

  it("leaves non-commands and mid-message slashes untouched", () => {
    for (const text of [
      "hello /bot",
      "/botany",
      "/unknown",
      "/",
      "yes",
      "STOP",
      "/bot,",
      "check /model out",
      "",
    ])
      expect(parseMessagingSlashCommand(text)).toBeNull();
  });
});
