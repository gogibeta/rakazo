// @vitest-environment jsdom

import type { ThreadSession } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listState = vi.hoisted(() => ({ data: [] as ThreadSession[] }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { SidebarSessions } from "./sidebar-sessions";

const primary: ThreadSession = {
  id: "thread-primary",
  botId: "bot-1",
  title: null,
  kind: "direct",
  isPrimary: true,
  archivedAt: null,
  lastMessageAt: "2026-11-14T10:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
};
const second: ThreadSession = {
  id: "thread-2",
  botId: "bot-1",
  title: "Trip planning",
  kind: "direct",
  isPrimary: false,
  archivedAt: null,
  lastMessageAt: "2026-11-13T10:00:00.000Z",
  createdAt: "2026-11-12T10:00:00.000Z",
};
const archived: ThreadSession = {
  id: "thread-3",
  botId: "bot-1",
  title: "Old topic",
  kind: "direct",
  isPrimary: false,
  archivedAt: "2026-11-10T10:00:00.000Z",
  lastMessageAt: "2026-11-09T10:00:00.000Z",
  createdAt: "2026-11-08T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  listState.data = [];
  vi.unstubAllGlobals();
});

async function renderSessions(sessionId?: string) {
  const rpc = {
    threads: {
      listSessions: vi.fn(async () => listState.data),
      createSession: vi.fn(async () => ({ threadId: "thread-new", botId: "bot-1" })),
      renameSession: vi.fn(async () => second),
      archiveSession: vi.fn(async () => ({ ok: true as const })),
      unarchiveSession: vi.fn(async () => ({ ok: true as const })),
    },
  };
  const onSelect = vi.fn();
  act(() =>
    root.render(
      <SidebarSessions
        rpc={rpc as never}
        botId="bot-1"
        botName="Chief"
        sessionId={sessionId}
        onSelect={onSelect}
      />,
    ),
  );
  // Flush the session list load.
  await act(async () => {});
  return { rpc, onSelect };
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button labelled ${label}`);
  return button as HTMLButtonElement;
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

it("lists the sessions with the bot's name for the untitled primary and folds archived ones away", async () => {
  listState.data = [primary, second, archived];
  await renderSessions();

  expect(container.textContent).toContain("Conversations");
  expect(container.textContent).toContain("Chief");
  expect(container.textContent).toContain("Trip planning");
  expect(container.textContent).toContain("Archived (1)");
  expect(container.textContent).not.toContain("Old topic");
  // Session rows are labelled as conversations, never with the bare bot
  // name the roster button uses.
  expect(buttonByLabel("Conversation: Chief")).not.toBeNull();
  expect(buttonByLabel("Conversation: Trip planning")).not.toBeNull();
  // The primary session cannot be archived; the other live one can.
  expect(container.querySelector('button[aria-label="Archive Chief"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Archive Trip planning"]')).not.toBeNull();

  click(
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Archived"))!,
  );
  expect(container.textContent).toContain("Old topic");
});

it("opens the clicked session and returns to the primary from its row", async () => {
  listState.data = [primary, second];
  const { onSelect } = await renderSessions();

  click(buttonByLabel("Conversation: Trip planning"));
  expect(onSelect).toHaveBeenCalledWith("thread-2");

  click(buttonByLabel("Conversation: Chief"));
  expect(onSelect).toHaveBeenCalledWith(null);
});

it("starts a new conversation and opens it", async () => {
  listState.data = [primary];
  const { rpc, onSelect } = await renderSessions();

  click(buttonByLabel("New conversation"));
  await act(async () => {});

  expect(rpc.threads.createSession).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(onSelect).toHaveBeenCalledWith("thread-new");
});

it("archiving the open session returns to the primary", async () => {
  listState.data = [primary, second];
  const { rpc, onSelect } = await renderSessions("thread-2");

  click(buttonByLabel("Archive Trip planning"));
  await act(async () => {});

  expect(rpc.threads.archiveSession).toHaveBeenCalledWith({
    botId: "bot-1",
    threadId: "thread-2",
  });
  expect(onSelect).toHaveBeenCalledWith(null);
});
