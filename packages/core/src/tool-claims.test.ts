import { describe, expect, it } from "vitest";
import {
  TOOL_STEP_LABELS,
  unsupportedToolClaims,
  unsupportedToolClaimText,
} from "./tool-claims.js";

/**
 * RED-first from the PR #97 retest transcript: a bot replied
 * "Web fetch (succeeded) … Remember (succeeded)" having made no tool call at all.
 * Each case below is a shape seen in real traffic or its honest counterpart.
 */
describe("unsupportedToolClaims", () => {
  it("catches the recorded fabricated reply with no tool events", () => {
    const text =
      "Web fetch (succeeded): I pulled the pricing page.\nRemember (succeeded): saved it to memory.";
    const claims = unsupportedToolClaims(text, []);
    expect(claims.map((claim) => claim.label)).toEqual(["Web fetch", "Remember"]);
  });

  it("catches a step line without an outcome, which is how history prints a bare step", () => {
    expect(unsupportedToolClaims("- Web search\nI found three sources.", [])).toEqual([
      { label: "Web search", toolName: "web_search" },
    ]);
  });

  it("passes a reply backed by real tool events", () => {
    const text = "Web fetch (succeeded): I pulled the pricing page.";
    expect(unsupportedToolClaims(text, ["Web fetch"])).toEqual([]);
  });

  it("passes an honest failure reply", () => {
    for (const text of [
      "Web fetch failed: the site refused the connection.",
      "I could not save that to memory.",
      "The shell command was blocked by policy.",
      "Web search (failed): the provider timed out.",
    ]) {
      expect(unsupportedToolClaims(text, [])).toEqual([]);
    }
  });

  it("does not read a quoted example or a code fence as a claim", () => {
    const text = [
      "Your history shows lines like:",
      "```",
      "- Web fetch (succeeded)",
      "```",
      "and `Web fetch (succeeded)` is what one looks like.",
    ].join("\n");
    expect(unsupportedToolClaims(text, [])).toEqual([]);
  });

  it("does not treat a blockquote of earlier history as its own work", () => {
    expect(unsupportedToolClaims("> Web fetch (succeeded): earlier turn", [])).toEqual([]);
  });

  it("ignores a negation in a neighbouring sentence", () => {
    // "Nothing worked." must not launder a fabricated step that follows it.
    expect(unsupportedToolClaims("Nothing worked. Web fetch (succeeded): done.", [])).toHaveLength(
      1,
    );
    // ...and a real negation in the same sentence still protects it.
    expect(unsupportedToolClaims("Web fetch (succeeded) did not happen.", [])).toEqual([]);
  });

  it("catches the counted and mixed shapes the app itself prints", () => {
    // `toolStepsHistoryText` prints `Web fetch ×3 (succeeded)` for a repeated step and
    // `(2 succeeded, 1 failed)` for mixed results. These are exactly the lines the model
    // copies, so missing either would leave the most likely forgery unguarded.
    expect(unsupportedToolClaims("Web fetch ×3 (succeeded): done.", [])).toHaveLength(1);
    expect(unsupportedToolClaims("Web fetch x2 (succeeded)", [])).toHaveLength(1);
    expect(unsupportedToolClaims("Web search (2 succeeded, 1 failed)", [])).toHaveLength(1);
  });

  it("does not read a mixed outcome's own 'failed' as a denial", () => {
    // The word "failed" inside `(2 succeeded, 1 failed)` is a result count. Treating it
    // as a negation would protect a fabricated step — the opposite of the intent.
    expect(unsupportedToolClaims("Web search (2 succeeded, 1 failed): partial.", [])).toHaveLength(
      1,
    );
    // A real denial beside the step still protects it.
    expect(unsupportedToolClaims("Web search (succeeded) was not attempted.", [])).toEqual([]);
  });

  it("does not match ordinary prose that names no tool", () => {
    for (const text of [
      "I searched the web and found three sources.",
      "I fetched the page and saved the notes.",
      "Remember to water the plants.",
    ]) {
      expect(unsupportedToolClaims(text, [])).toEqual([]);
    }
  });

  it("covers every built-in tool, not a hand-picked list", () => {
    // A tool added tomorrow must be covered without editing the guard.
    expect(TOOL_STEP_LABELS.length).toBeGreaterThan(30);
    expect(TOOL_STEP_LABELS).toContain("Web fetch");
    expect(TOOL_STEP_LABELS).toContain("Remember");
  });

  it("matches labels case-insensitively", () => {
    expect(unsupportedToolClaims("web fetch (SUCCEEDED): pulled it.", [])).toHaveLength(1);
  });

  it("names every claimed tool in the retry text", () => {
    const text = unsupportedToolClaimText([
      { label: "Web fetch", toolName: "web_fetch" },
      { label: "Remember", toolName: "remember" },
    ]);
    expect(text).toContain("`Web fetch`");
    expect(text).toContain("`Remember`");
    expect(text).toContain("no such tool call is in this run");
  });
});
