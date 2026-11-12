// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProxiesSettings } from "./ProxiesSettings";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Spinner: () => null,
}));
vi.mock("./ai/primitives", () => ({ SuccessPop: () => null }));
const proxiesApi = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    get proxies() {
      return { ...proxiesApi };
    },
  },
}));

const savedProxy = {
  id: "proxy-1",
  name: "Mumbai",
  protocol: "http" as const,
  host: "pr.example.com",
  port: 7777,
  country: "IN",
  username: "customer-42",
  hasPassword: true,
  createdAt: "2026-12-12T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  proxiesApi.list.mockResolvedValue({ proxies: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

function inputs() {
  return [...host.querySelectorAll<HTMLInputElement>("input")];
}

it("lists saved proxies with host, port and country, and never a password", async () => {
  proxiesApi.list.mockResolvedValue({ proxies: [savedProxy] });
  await act(async () => root.render(<ProxiesSettings />));
  expect(host.textContent).toContain("Mumbai");
  expect(host.textContent).toContain("pr.example.com:7777");
  expect(host.textContent).toContain("IN");
  expect(host.textContent).not.toContain("customer-42-cc-IN");
});

it("adds a proxy from the structured fields", async () => {
  proxiesApi.add.mockResolvedValue(savedProxy);
  await act(async () => root.render(<ProxiesSettings />));
  const [name, country, hostInput, port, username, secret] = inputs();
  await act(async () => {
    setValue(name!, "Mumbai");
    setValue(country!, "in");
    setValue(hostInput!, "pr.example.com");
    setValue(port!, "7777");
    setValue(username!, "customer-42");
    setValue(secret!, "pw");
  });
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(proxiesApi.add).toHaveBeenCalledWith({
    name: "Mumbai",
    protocol: "http",
    host: "pr.example.com",
    port: 7777,
    country: "IN",
    username: "customer-42",
    password: "pw",
  });
  expect(host.textContent).toContain("Mumbai");
});

it("adds a proxy from a pasted URL", async () => {
  proxiesApi.add.mockResolvedValue({ ...savedProxy, protocol: "socks5" as const, port: 1080 });
  await act(async () => root.render(<ProxiesSettings />));
  const toggle = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Paste a URL instead"),
  );
  await act(async () => toggle?.click());
  const [name, url] = inputs();
  await act(async () => {
    setValue(name!, "Frankfurt");
    setValue(url!, "socks5://user:pw@proxy.example.com:1080");
  });
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(proxiesApi.add).toHaveBeenCalledWith({
    name: "Frankfurt",
    url: "socks5://user:pw@proxy.example.com:1080",
  });
});

it("removes a proxy from the list", async () => {
  proxiesApi.list.mockResolvedValue({ proxies: [savedProxy] });
  proxiesApi.remove.mockResolvedValue({ ok: true });
  await act(async () => root.render(<ProxiesSettings />));
  const remove = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove",
  );
  await act(async () => remove?.click());
  expect(proxiesApi.remove).toHaveBeenCalledWith({ proxyId: "proxy-1" });
  expect(host.textContent).not.toContain("Mumbai");
});
