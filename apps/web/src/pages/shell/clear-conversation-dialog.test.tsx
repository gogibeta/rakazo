// @vitest-environment jsdom

import type { Bot, Group, ThreadSession } from "@rakazo/contracts";
import { DEFAULT_NEW_BOT_AVATAR_SET } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

import { ClearConversationDialog } from "./dialogs";
import type { ShellDialogsState } from "./shell-dialogs";
import { ShellDialogs } from "./shell-dialogs";

const bot = { id: "bot-1", name: "Ada", description: "Research bot", preview: "Research" } as Bot;
const otherBot = { id: "bot-2", name: "Bo", description: "Helper bot", preview: "Help" } as Bot;
const group = { id: "group-1", name: "Study" } as Group;

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

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function dialogText() {
  return document.querySelector("[role='alertdialog']")?.textContent ?? "";
}

function clearButton() {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === "Clear",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("No Clear button");
  return found;
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ClearConversationDialog copy", () => {
  it("names the main conversation when no session is targeted", () => {
    act(() =>
      root.render(
        <ClearConversationDialog
          bot={bot}
          kind="bot"
          onCancel={() => undefined}
          onConfirm={async () => undefined}
        />,
      ),
    );
    expect(dialogText()).toContain("Clear Ada’s main conversation?");
    expect(dialogText()).toContain("Other conversations are kept.");
  });

  it("names the session being cleared and says the main conversation is kept", () => {
    act(() =>
      root.render(
        <ClearConversationDialog
          bot={bot}
          kind="bot"
          sessionTitle="Trip planning"
          onCancel={() => undefined}
          onConfirm={async () => undefined}
        />,
      ),
    );
    expect(dialogText()).toContain("Clear “Trip planning”?");
    expect(dialogText()).toContain("Ada’s main conversation is kept.");
    expect(dialogText()).not.toContain("main conversation?");
  });

  it("falls back to 'this conversation' while the session title loads", () => {
    act(() =>
      root.render(
        <ClearConversationDialog
          bot={bot}
          kind="bot"
          sessionTitle={null}
          onCancel={() => undefined}
          onConfirm={async () => undefined}
        />,
      ),
    );
    expect(dialogText()).toContain("Clear this conversation?");
    expect(dialogText()).toContain("Ada’s main conversation is kept.");
  });

  it("keeps the group copy, where there is only one conversation", () => {
    act(() =>
      root.render(
        <ClearConversationDialog
          bot={group}
          kind="group"
          onCancel={() => undefined}
          onConfirm={async () => undefined}
        />,
      ),
    );
    expect(dialogText()).toContain("Clear Study’s conversation?");
    expect(dialogText()).toContain("The chat remains available.");
  });
});

describe("ShellDialogs clear targeting", () => {
  function dialogsState(clearTarget: ShellDialogsState["clearTarget"]): ShellDialogsState {
    return {
      deleteTarget: null,
      setDeleteTarget: vi.fn(),
      deleteGroupTarget: null,
      setDeleteGroupTarget: vi.fn(),
      deleteSpaceTarget: null,
      setDeleteSpaceTarget: vi.fn(),
      spaceMenu: null,
      setSpaceMenu: vi.fn(),
      spaceMenuAnchor: { current: null },
      closeSpaceMenu: vi.fn(),
      clearTarget,
      setClearTarget: vi.fn(),
      newSectionTarget: null,
      setNewSectionTarget: vi.fn(),
      renameSectionTarget: null,
      setRenameSectionTarget: vi.fn(),
      deleteSectionTarget: null,
      setDeleteSectionTarget: vi.fn(),
      newSpaceOpen: false,
      setNewSpaceOpen: vi.fn(),
      createBotOpen: false,
      setCreateBotOpen: vi.fn(),
      commandPaletteOpen: false,
      setCommandPaletteOpen: vi.fn(),
    };
  }

  async function renderDialogs(input: {
    clearTarget: ShellDialogsState["clearTarget"];
    activeId?: string;
    activeGroupId?: string;
    activeSessionId?: string;
    sessions?: ThreadSession[];
  }) {
    const rpc = {
      threads: {
        clear: vi.fn(async () => ({ ok: true as const })),
        listSessions: vi.fn(async () => input.sessions ?? [primary, second]),
      },
    };
    const clearOpenThread = vi.fn();
    const refreshBots = vi.fn(async () => undefined);
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShellDialogs
            dialogs={dialogsState(input.clearTarget)}
            rpc={rpc as never}
            spaces={[]}
            bots={[bot, otherBot]}
            activeId={input.activeId}
            activeGroupId={input.activeGroupId}
            activeSessionId={input.activeSessionId}
            alive={{ current: true }}
            navigate={vi.fn()}
            setPanel={vi.fn()}
            refreshBots={refreshBots}
            removeSpace={vi.fn()}
            openSpaceSettings={vi.fn()}
            closeMobileSidebar={vi.fn()}
            createBot={vi.fn(async () => undefined)}
            botAvatarSet={DEFAULT_NEW_BOT_AVATAR_SET}
            clearOpenThread={clearOpenThread}
            discardChatAttachments={vi.fn()}
            deleteRoutineDialogProps={null}
            paletteActions={[]}
          />
        </QueryClientProvider>,
      ),
    );
    // Flush the session-title load for the clear dialog.
    await act(async () => {});
    return { rpc, clearOpenThread, refreshBots };
  }

  it("clears the open session, not the main conversation", async () => {
    const { rpc, clearOpenThread } = await renderDialogs({
      clearTarget: { kind: "bot", chat: bot },
      activeId: "bot-1",
      activeSessionId: "thread-2",
    });

    expect(dialogText()).toContain("Clear “Trip planning”?");
    click(clearButton());
    await act(async () => {});

    expect(rpc.threads.clear).toHaveBeenCalledWith({
      botId: "bot-1",
      threadId: "thread-2",
    });
    expect(rpc.threads.clear).toHaveBeenCalledTimes(1);
    expect(clearOpenThread).toHaveBeenCalled();
  });

  it("clears the main conversation when no session is open", async () => {
    const { rpc } = await renderDialogs({
      clearTarget: { kind: "bot", chat: bot },
      activeId: "bot-1",
    });

    expect(dialogText()).toContain("Clear Ada’s main conversation?");
    click(clearButton());
    await act(async () => {});

    expect(rpc.threads.clear).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(rpc.threads.listSessions).not.toHaveBeenCalled();
  });

  it("never clears another bot's open session", async () => {
    const { rpc } = await renderDialogs({
      clearTarget: { kind: "bot", chat: bot },
      activeId: "bot-2",
      activeSessionId: "thread-2",
    });

    expect(dialogText()).toContain("Clear Ada’s main conversation?");
    click(clearButton());
    await act(async () => {});

    expect(rpc.threads.clear).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(rpc.threads.listSessions).not.toHaveBeenCalled();
  });

  it("clears a group by group id, with no session involved", async () => {
    const { rpc } = await renderDialogs({
      clearTarget: { kind: "group", chat: group },
      activeGroupId: "group-1",
    });

    expect(dialogText()).toContain("Clear Study’s conversation?");
    click(clearButton());
    await act(async () => {});

    expect(rpc.threads.clear).toHaveBeenCalledWith({ groupId: "group-1" });
  });
});
