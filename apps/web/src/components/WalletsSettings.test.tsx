// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  wallets: {
    list: vi.fn(),
    vaultStatus: vi.fn(),
    vaultUnlock: vi.fn(),
    vaultLock: vi.fn(),
    setVaultPassword: vi.fn(),
    changeVaultPassword: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    requestRemove: vi.fn(),
    migrate: vi.fn(),
    uses: vi.fn(),
    proposals: vi.fn().mockResolvedValue({ proposals: [] }),
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + part + (index < values.length ? values[index] : ""),
      "",
    );
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Spinner: () => null,
}));
vi.mock("./ai/primitives", () => ({ SuccessPop: () => null }));

import { WalletsSettings } from "./WalletsSettings";

const locked = {
  configured: true,
  changedAt: "2026-11-14T21:01:32.000Z",
  unlocked: false,
  expiresAt: null,
  passwordEpoch: 1,
  vaultAvailable: true,
};
const unlocked = {
  ...locked,
  unlocked: true,
  expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
};
const unavailable = { ...locked, vaultAvailable: false };
const unconfigured = {
  configured: false,
  changedAt: null,
  unlocked: false,
  expiresAt: null,
  passwordEpoch: null,
  vaultAvailable: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  rpcMock.wallets.list.mockResolvedValue({ wallets: [] });
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<WalletsSettings />);
  });
  return { container, root };
}

/** The confirmation block's own buttons — both it and the row say "Remove". */
const confirmButton = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("fieldset button")].find(
    (candidate) => candidate.textContent === name,
  );

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  );

/** The unlock form's password field, found through its label — the password form has its own. */
function unlockInput(container: HTMLElement): HTMLInputElement | undefined {
  const label = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === "Unlock password",
  );
  if (!label) return undefined;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows the unlock form while locked, and unlocks for six hours", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.wallets.vaultStatus.mockResolvedValue(locked);
  rpcMock.wallets.vaultUnlock.mockResolvedValue(unlocked);
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Unlock wallets"));
    expect(container.textContent).toContain("Unlocking lasts six hours.");
    expect(button(container, "Unlock for six hours")).toBeDefined();

    await type(unlockInput(container)!, "unlock-password-one");
    await act(async () => button(container, "Unlock for six hours")?.click());
    expect(rpcMock.wallets.vaultUnlock).toHaveBeenLastCalledWith({
      password: "unlock-password-one",
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Unlocked until"));
    expect(button(container, "Lock wallets")).toBeDefined();
    expect(button(container, "Unlock for six hours")).toBeUndefined();
    // The password field is cleared after a successful unlock.
    expect(unlockInput(container)).toBeUndefined();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("locks on demand and offers unlock again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.wallets.vaultStatus.mockResolvedValue(unlocked);
  rpcMock.wallets.vaultLock.mockResolvedValue(locked);
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(button(container, "Lock wallets")).toBeDefined());
    expect(container.textContent).toContain("Unlocked until");
    await act(async () => button(container, "Lock wallets")?.click());
    expect(rpcMock.wallets.vaultLock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(button(container, "Unlock for six hours")).toBeDefined());
    expect(container.textContent).toContain("Unlocking lasts six hours.");
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("says the vault is unavailable instead of offering unlock", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.wallets.vaultStatus.mockResolvedValue(unavailable);
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Unlock wallets"));
    expect(container.textContent).toContain("The wallet vault is unavailable.");
    expect(button(container, "Unlock for six hours")).toBeUndefined();
    expect(button(container, "Lock wallets")).toBeUndefined();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows no unlock section before a wallet password exists", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.wallets.vaultStatus.mockResolvedValue(unconfigured);
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Wallet password"));
    expect(container.textContent).not.toContain("Unlock wallets");
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

const oneWallet = {
  wallets: [
    {
      id: "w1",
      name: "burner",
      address: "0xabc",
      chain: "evm",
      migrationStatus: "legacy_server_only",
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
};

it("asks before removing, then removes with the token it was given", async () => {
  rpcMock.wallets.list.mockResolvedValue(oneWallet);
  rpcMock.wallets.vaultStatus.mockResolvedValue(locked);
  rpcMock.wallets.requestRemove.mockResolvedValue({
    token: "tok-1",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    wallet: { name: "burner", address: "0xabc" },
  });
  rpcMock.wallets.remove.mockResolvedValue({ ok: true });
  const { container, root } = await render();

  // One click does not remove anything: it only asks for a confirmation.
  await act(async () => {
    button(container, "Remove")!.click();
  });
  expect(rpcMock.wallets.requestRemove).toHaveBeenCalledWith({ walletId: "w1" });
  expect(rpcMock.wallets.remove).not.toHaveBeenCalled();

  // The confirmation names the wallet, so the owner can see what they are about
  // to remove rather than trusting a stale list.
  const fieldset = container.querySelector("fieldset");
  expect(fieldset).not.toBeNull();
  expect(fieldset!.textContent).toContain("burner");
  expect(fieldset!.textContent).toContain("kept");

  // The second click spends the token.
  await act(async () => {
    confirmButton(container, "Remove")!.click();
  });
  expect(rpcMock.wallets.remove).toHaveBeenCalledWith({
    walletId: "w1",
    confirmationToken: "tok-1",
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

it("does not remove when the confirmation is dismissed", async () => {
  rpcMock.wallets.list.mockResolvedValue(oneWallet);
  rpcMock.wallets.vaultStatus.mockResolvedValue(locked);
  rpcMock.wallets.requestRemove.mockResolvedValue({
    token: "tok-1",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    wallet: { name: "burner", address: "0xabc" },
  });
  const { container, root } = await render();

  await act(async () => {
    button(container, "Remove")!.click();
  });
  await act(async () => {
    confirmButton(container, "Keep it")!.click();
  });
  expect(rpcMock.wallets.remove).not.toHaveBeenCalled();
  expect(container.querySelector("fieldset")).toBeNull();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

it("says why a removal was refused instead of pretending it worked", async () => {
  rpcMock.wallets.list.mockResolvedValue(oneWallet);
  rpcMock.wallets.vaultStatus.mockResolvedValue(locked);
  rpcMock.wallets.requestRemove.mockRejectedValue(new Error("Confirmation expired. Try again."));
  const { container, root } = await render();

  await act(async () => {
    button(container, "Remove")!.click();
  });
  // No confirmation is offered when no token could be issued.
  expect(container.querySelector("fieldset")).toBeNull();
  expect(container.textContent).toContain("Confirmation expired");
  expect(rpcMock.wallets.remove).not.toHaveBeenCalled();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
