// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { Transcript } from "./transcript";

const stableT = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw(strings, ...values);

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
  useLingui: () => ({ t: stableT }),
}));

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

// Counts how many text blocks render. A streaming tick that re-rendered the whole list would
// show up here as dozens; a memoized one shows up as the single live block.
const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@rakazo/chat-ui/web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/chat-ui/web")>();
  const React = await import("react");
  return {
    ...actual,
    ChatMarkdown: (props: { children?: unknown }) => {
      markdownRenders.count += 1;
      return React.createElement(actual.ChatMarkdown, props as never);
    },
  };
});

let container: HTMLDivElement;
let root: Root;
let scrollRef: RefObject<HTMLDivElement | null>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scrollRef = { current: container };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

let seq = 0;
const at = (minutes: number) => new Date(2026, 0, 1, 10, minutes).toISOString();

/** A tool dump shaped like a browser snapshot or a search result page. */
function dump(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `- item ${index}: a result line with **bold** and \`code\` and a [link](https://example.test/${index})`,
  ).join("\n");
}

function message(id: string, role: "user" | "bot", text: string): ThreadMessage {
  seq += 1;
  return {
    id,
    threadId: "thread",
    seq,
    role,
    createdAt: at(seq),
    blocks: [{ kind: "text", text }],
  };
}

function live(text: string): ThreadMessage {
  return {
    id: "progress:run",
    threadId: "thread",
    seq: 9999,
    role: "bot",
    createdAt: at(120),
    blocks: [{ kind: "progress", text }],
  };
}

/** The handlers and sets a real Shell passes are stable; the harness must be too, or it measures itself. */
const noop = vi.fn();
const stableSet = new Set<string>();
const stablePeerBot = () => ({ name: "Atlas", color: "orange" });
let stable: Omit<ComponentProps<typeof Transcript>, "transcript">;

beforeEach(() => {
  stable = {
    scrollRef,
    scrollRequest: null,
    onScrollRequestHandled: noop,
    followRequest: 0,
    callHoldsSpeaker: false,
    artifactTarget: { botId: "bot" },
    showToolActivity: true,
    olderCursor: null,
    unreadAfterSeq: null,
    loadingOlder: false,
    answerableAskIds: stableSet,
    dismissableAskIds: stableSet,
    running: false,
    workingBots: [{ botId: "bot", color: "orange", status: "running" }],
    onLoadOlder: noop,
    onOpenBot: noop,
    onAnswer: noop,
    onReply: noop,
    onMarkUnread: noop,
    onQuote: noop,
    onReact: noop,
    onJumpToMessage: noop,
    onOpenPeerMessages: noop,
    peerBot: stablePeerBot,
    onRefresh: noop,
    onBotChanged: noop,
    onAddRoutine: noop,
    voiceReady: false,
    speakingMessageId: null,
    onSpeak: noop,
    onOpenComputer: noop,
    onReleaseComputer: noop,
    rpc,
  };
});

function props(messages: readonly ThreadMessage[]): ComponentProps<typeof Transcript> {
  return { ...stable, transcript: foldPeerReplies(messages, { includePeerReceipts: true }) };
}

function render(messages: readonly ThreadMessage[]) {
  act(() => root.render(<Transcript {...props(messages)} />));
}

/** A 150-message thread in the shape the deployment's frozen thread has. */
function longThread(): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (let index = 0; index < 150; index++) {
    if (index % 3 === 0)
      messages.push(message(`m${index}`, "bot", `Here is what I found:\n\n${dump(40)}`));
    else
      messages.push(
        message(`m${index}`, index % 2 ? "user" : "bot", "Short message about the plan."),
      );
  }
  return messages;
}

const nodeCount = () => container.querySelectorAll("*").length;

it("keeps a 150-message thread with large tool dumps under a small DOM budget", () => {
  render(longThread());
  // Before folding, this thread took ~20,500 nodes, hundreds per dump. The budget is loose
  // enough not to be brittle and tight enough that an unfolded dump breaks it.
  expect(nodeCount()).toBeLessThan(9_000);
  // The dumps are still there, folded, each with a control to open it.
  expect(container.querySelectorAll('[data-testid="long-text-toggle"]').length).toBe(50);
});

it("folds a long tool dump but not a short reply", () => {
  render([
    message("short", "bot", "Sounds good — see you at eight."),
    message("long", "bot", dump(40)),
  ]);
  // Only the long one carries the control.
  expect(container.querySelectorAll('[data-testid="long-text-toggle"]').length).toBe(1);
  expect(container.textContent).toContain("Show full output");
  // The folded part is not in the DOM at all, which is where the saving comes from.
  expect(container.textContent).not.toContain("item 39:");
});

it("opens the whole block on request", () => {
  render([message("long", "bot", dump(40))]);
  expect(container.textContent).not.toContain("item 39:");
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="long-text-toggle"]')!;
  act(() => toggle.click());
  expect(container.textContent).toContain("item 39:");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  act(() => toggle.click());
  expect(container.textContent).not.toContain("item 39:");
});

it("re-renders only the streaming message when its text grows", () => {
  const base: ThreadMessage[] = [];
  for (let index = 0; index < 60; index++)
    base.push(
      message(`m${index}`, index % 2 ? "user" : "bot", `Reply ${index} with a little text.`),
    );
  render([...base, live("Thinking")]);
  markdownRenders.count = 0;
  // One streaming token: the live message's progress text grows.
  render([...base, live("Thinking about it")]);
  // The 30 settled bot replies are memoized, so only the live block renders again.
  expect(markdownRenders.count).toBe(1);
});
