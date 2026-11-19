// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyText, writeClipboard } from "./copy-text";

/** Clipboard writes the test settles by hand, so results can arrive out of click order. */
function manualClipboard() {
  const writes: Array<{ resolve: () => void; reject: () => void }> = [];
  return {
    writes,
    writeText: (_text: string) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject });
      }),
  };
}

function CopyProbe() {
  const [copied, copy, failed, , failedText] = useCopyText();
  return (
    <>
      <button type="button" onClick={() => copy("text")}>
        copy
      </button>
      <span data-copied={String(copied)} data-failed={String(failed)} data-text={failedText} />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CopyProbe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(navigator, "clipboard");
});

it("keeps the newer copy's success when an older copy fails after it", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  // The selection fallback also fails, so the older attempt really resolves as a failure.
  document.execCommand = vi.fn(() => false);
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(clipboard.writes).toHaveLength(2);
  expect(status()?.dataset.copied).toBe("true");
  expect(status()?.dataset.failed).toBe("false");
  expect(status()?.dataset.text).toBe("");
});

it("drops the earlier confirmation while a newer copy is still pending", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => clipboard.writes[0]?.resolve());
  expect(status()?.dataset.copied).toBe("true");

  await act(async () => button?.click());
  expect(status()?.dataset.copied).toBe("false");
});

it("does not let a superseded copy fall back to selection over the newer text", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const execCommand = vi.fn(() => true);
  document.execCommand = execCommand;
  const button = container.querySelector<HTMLButtonElement>("button");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(execCommand).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLElement>("span")?.dataset.copied).toBe("true");
});

describe("clipboard on an insecure page", () => {
  /** Point the page at `url` for one test, then put the jsdom default back. */
  function atUrl(url: string) {
    const original = window.location.href;
    Reflect.defineProperty(window, "location", {
      value: new URL(url),
      configurable: true,
      writable: true,
    });
    return () => {
      Reflect.defineProperty(window, "location", {
        value: new URL(original),
        configurable: true,
        writable: true,
      });
    };
  }

  it("refuses a write on plain http over a LAN name, and never falls back to selection", async () => {
    // The Clipboard API is absent there, so the old code fell through to execCommand, which still
    // works on an insecure page. A document in a bot's page must not reach the clipboard that way.
    const restore = atUrl("http://rakazo.lan:3000/");
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    try {
      await expect(writeClipboard("secret")).resolves.toBe(false);
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each(["https://app.rakazo.com/", "http://localhost:3000/", "http://127.0.0.1:3000/"])(
    "allows a write on %s",
    async (url) => {
      const restore = atUrl(url);
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      try {
        await expect(writeClipboard("ok")).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith("ok");
      } finally {
        restore();
      }
    },
  );
});
