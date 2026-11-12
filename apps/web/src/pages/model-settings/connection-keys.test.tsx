// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionKeysSection } from "./connection-keys";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});

const rpcState = vi.hoisted(() => ({
  addCredentialKey: vi.fn(async () => ({})),
  removeCredentialKey: vi.fn(async () => ({})),
}));
vi.mock("../../lib/space-rpc", () => ({
  useSpaceRpc: () => ({
    models: {
      addCredentialKey: rpcState.addCredentialKey,
      removeCredentialKey: rpcState.removeCredentialKey,
    },
  }),
}));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcState.addCredentialKey.mockClear();
  rpcState.removeCredentialKey.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

type Props = ComponentProps<typeof ConnectionKeysSection>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    acceptsKey: true,
    beginAddAccountSignIn: vi.fn(),
    busy: false,
    refresh: vi.fn(async () => undefined),
    subscriptionSignIn: true,
    credential: {
      id: "cred-1",
      provider: "anthropic",
      label: "Anthropic",
      hasKey: true,
      isDefault: false,
      keys: [
        { id: "key-1", label: "Main key", authKind: "api_key", active: true },
        {
          id: "key-2",
          label: "second@example.test",
          authKind: "oauth",
          active: false,
          lastFailedAt: "2026-11-12T10:00:00.000Z",
        },
      ],
    },
    ...overrides,
  } as Props;
}

async function renderSection(sectionProps: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionKeysSection {...sectionProps} />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("lists the pooled keys with the active one and a failed account marked", async () => {
  const view = await renderSection(props());
  try {
    expect(view.container.textContent).toContain("Keys and accounts");
    expect(view.container.textContent).toContain("Main key");
    expect(view.container.textContent).toContain("Active");
    expect(view.container.textContent).toContain("second@example.test");
    expect(view.container.textContent).toContain("Last failed");
    expect(buttonByText(view.container, "Add key")).toBeDefined();
    expect(buttonByText(view.container, "Add account")).toBeDefined();
  } finally {
    await view.unmount();
  }
});

it("adds a key through the pool RPC and refreshes in place", async () => {
  const sectionProps = props();
  const view = await renderSection(sectionProps);
  try {
    const input = view.container.querySelector('input[type="password"]') as HTMLInputElement;
    await typeInto(input, "sk-added-key");
    await act(async () => buttonByText(view.container, "Add key")?.click());
    expect(rpcState.addCredentialKey).toHaveBeenCalledWith({
      credentialId: "cred-1",
      apiKey: "sk-added-key",
    });
    expect(sectionProps.refresh).toHaveBeenCalledWith({ keepForm: true });
  } finally {
    await view.unmount();
  }
});

it("removes a key through the pool RPC", async () => {
  const view = await renderSection(props());
  try {
    const removes = [...view.container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Remove",
    );
    expect(removes).toHaveLength(2);
    await act(async () => (removes[1] as HTMLButtonElement).click());
    expect(rpcState.removeCredentialKey).toHaveBeenCalledWith({
      credentialId: "cred-1",
      keyId: "key-2",
    });
  } finally {
    await view.unmount();
  }
});

it("starts an add-account sign-in from the section", async () => {
  const sectionProps = props();
  const view = await renderSection(sectionProps);
  try {
    await act(async () => buttonByText(view.container, "Add account")?.click());
    expect(sectionProps.beginAddAccountSignIn).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});
