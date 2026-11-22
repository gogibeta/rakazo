// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CustomConnectionsSettings } from "./CustomConnectionsSettings";

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
const connectionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    get customConnections() {
      return { ...connectionsApi };
    },
  },
}));

const savedConnection = {
  id: "conn-1",
  name: "GitHub",
  baseUrl: "https://api.github.com",
  authStyle: "bearer" as const,
  authName: null,
  hasApiKey: true,
  createdAt: "2026-12-16T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  connectionsApi.list.mockResolvedValue({ connections: [] });
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

function button(text: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent === text);
}

it("lists saved connections with their base URL and key status, and never a key", async () => {
  connectionsApi.list.mockResolvedValue({ connections: [savedConnection] });
  await act(async () => root.render(<CustomConnectionsSettings />));
  expect(host.textContent).toContain("GitHub");
  expect(host.textContent).toContain("https://api.github.com");
  expect(host.textContent).toContain("Key saved");
  expect(host.textContent).toContain("Connected. Your bots can call the GitHub API.");
  expect(host.textContent).not.toContain("ghp_");
});

it("fills the form from the GitHub preset, so only the token is typed", async () => {
  connectionsApi.add.mockResolvedValue(savedConnection);
  await act(async () => root.render(<CustomConnectionsSettings />));
  await act(async () => button("Connect GitHub")?.click());
  const [name, baseUrl, apiKey] = inputs();
  expect(name?.value).toBe("GitHub");
  expect(baseUrl?.value).toBe("https://api.github.com");
  await act(async () => setValue(apiKey!, "ghp_example"));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(connectionsApi.add).toHaveBeenCalledWith({
    name: "GitHub",
    baseUrl: "https://api.github.com",
    authStyle: "bearer",
    authName: null,
    apiKey: "ghp_example",
  });
});

it("adds a custom service with header auth", async () => {
  connectionsApi.add.mockResolvedValue({
    ...savedConnection,
    id: "conn-2",
    name: "Weather",
    baseUrl: "https://api.weather.example",
    authStyle: "header" as const,
    authName: "X-Api-Key",
  });
  await act(async () => root.render(<CustomConnectionsSettings />));
  const [name, baseUrl] = inputs();
  const style = host.querySelector("select")!;
  await act(async () => {
    setValue(name!, "Weather");
    setValue(baseUrl!, "https://api.weather.example");
    setValue(style, "header");
  });
  const [, , authName, apiKey] = inputs();
  await act(async () => {
    setValue(authName!, "X-Api-Key");
    setValue(apiKey!, "wx-key");
  });
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(connectionsApi.add).toHaveBeenCalledWith({
    name: "Weather",
    baseUrl: "https://api.weather.example",
    authStyle: "header",
    authName: "X-Api-Key",
    apiKey: "wx-key",
  });
  expect(host.textContent).toContain("Header · X-Api-Key");
});

it("tests a connection and shows only the status", async () => {
  connectionsApi.list.mockResolvedValue({ connections: [savedConnection] });
  connectionsApi.test.mockResolvedValue({ status: 200, error: null });
  await act(async () => root.render(<CustomConnectionsSettings />));
  await act(async () => button("Test")?.click());
  expect(connectionsApi.test).toHaveBeenCalledWith({ connectionId: "conn-1" });
  expect(host.textContent).toContain("Reachable — HTTP 200");
});

it("removes a connection from the list", async () => {
  connectionsApi.list.mockResolvedValue({ connections: [savedConnection] });
  connectionsApi.remove.mockResolvedValue({ ok: true });
  await act(async () => root.render(<CustomConnectionsSettings />));
  await act(async () => button("Remove")?.click());
  expect(connectionsApi.remove).toHaveBeenCalledWith({ connectionId: "conn-1" });
  expect(host.textContent).not.toContain("https://api.github.com");
});
