import { describe, expect, it } from "vitest";
import { foldedPreview } from "../pages/shell/long-text-block";
import {
  COLLAPSE_AFTER_CHARS,
  COLLAPSED_PREVIEW_CHARS,
  collapsesByDefault,
} from "./transcript-fold";

/** A tool dump of the shape that freezes the page: many short markdown lines. */
function dump(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `- item ${index}: a result with **bold** and \`code\` and a [link](https://example.test/${index})`,
  ).join("\n");
}

describe("long output folding", () => {
  it("leaves ordinary replies, short code and short tool lines alone", () => {
    for (const text of [
      "Sounds good — see you at eight.",
      "```ts\nconst answer = 42;\n```",
      "- read_file notes.md\n- search_memory weekend plans",
      "x".repeat(COLLAPSE_AFTER_CHARS),
    ]) {
      expect({ text: text.slice(0, 20), folded: collapsesByDefault(text) }).toEqual({
        text: text.slice(0, 20),
        folded: false,
      });
    }
  });

  it("folds a browser snapshot or search dump", () => {
    expect(collapsesByDefault(dump(40))).toBe(true);
  });

  it("keeps the head of a folded block and marks it as cut", () => {
    const text = dump(40);
    const preview = foldedPreview(text);
    expect(preview.length).toBeLessThanOrEqual(COLLAPSED_PREVIEW_CHARS + 1);
    expect(preview.endsWith("…")).toBe(true);
    // Cut at a line boundary, so it does not end mid-word.
    expect(preview.slice(0, -1).endsWith("\n")).toBe(false);
    expect(text.startsWith(preview.slice(0, -1))).toBe(true);
  });

  it("cuts a single long line where the budget ends", () => {
    // A JSON dump has no newline to cut at; it must still be bounded.
    const preview = foldedPreview("x".repeat(5_000));
    expect(preview.length).toBe(COLLAPSED_PREVIEW_CHARS + 1);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns short text unchanged", () => {
    expect(foldedPreview("short")).toBe("short");
  });
});
