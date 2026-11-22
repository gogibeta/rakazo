import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  callUserConnection,
  connectionRequestUrl,
  listUserConnections,
  testUserConnection,
} from "./user-connections.js";

const KEY = "test-only-api-key-12345";

type Row = {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  authStyle: string;
  authName: string | null;
  secretCipher: string | null;
};

const bearerRow: Row = {
  id: "c1",
  userId: "user-1",
  name: "GitHub",
  baseUrl: "https://api.example.com",
  authStyle: "bearer",
  authName: null,
  secretCipher: "v2:sealed",
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];
const privateResolver = async () => [{ address: "10.0.0.5", family: 4 as const }];

function fixture(row: Row = bearerRow, responseBody: unknown = { ok: true }) {
  const secretStore = { load: vi.fn(async () => KEY) };
  // Both lookups honour the owner: a row is visible only to the user who saved
  // it, so a lookup or listing for anyone else finds nothing.
  const findFirst = vi.fn(async ({ where }: { where: { userId: string; name: string } }) =>
    where.userId === row.userId && where.name === row.name ? row : null,
  );
  const findMany = vi.fn(async ({ where }: { where: { userId: string } }) =>
    where.userId === row.userId ? [row] : [],
  );
  const prisma = {
    userCustomConnection: { findFirst, findMany },
  } as unknown as PrismaClient;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(responseBody));
  const registerRedactions = vi.fn();
  const input = {
    prisma,
    secretStore,
    userId: "user-1",
    name: row.name,
    signal: new AbortController().signal,
    remote: { fetch, resolveHostname: publicResolver },
    registerRedactions,
  };
  return { input, prisma, fetch, secretStore, registerRedactions, findFirst, findMany };
}

function calledRequest(fetch: ReturnType<typeof fixture>["fetch"]) {
  const [url, init] = fetch.mock.calls[0]!;
  return { url: new URL(String(url)), headers: new Headers(init?.headers) };
}

describe("custom connection calls", () => {
  it("adds the key as a bearer token and returns the JSON response", async () => {
    const { input, fetch, registerRedactions, findFirst } = fixture();
    const result = await callUserConnection({
      ...input,
      request: { method: "GET", path: "/user" },
    });
    expect(result).toEqual({ status: 200, body: { ok: true }, truncated: false });
    const { url, headers } = calledRequest(fetch);
    expect(url.href).toBe("https://api.example.com/user");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // The key's forms join the run's redaction set before anything returns.
    expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([KEY]));
    // The lookup is scoped to the acting user, not the name alone.
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "user-1", name: "GitHub" } });
  });

  it("redacts the key when the service echoes it back", async () => {
    const { input } = fixture(bearerRow, { echo: KEY, nested: [`Bearer ${KEY}`] });
    const result = await callUserConnection({ ...input, request: { method: "GET", path: "/" } });
    expect(JSON.stringify(result)).not.toContain(KEY);
    if ("body" in result) {
      expect(result.body).toEqual({ echo: "[redacted]", nested: ["[redacted]"] });
    }
  });

  it("sends the key in a named header, and a caller cannot replace it", async () => {
    const row: Row = { ...bearerRow, authStyle: "header", authName: "X-Api-Key" };
    const { input, fetch } = fixture(row);
    await callUserConnection({
      ...input,
      request: { method: "GET", path: "/items", headers: { "X-Api-Key": "forged" } },
    });
    const { headers } = calledRequest(fetch);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("authorization")).toBeNull();
  });

  it("sends the key as a query parameter", async () => {
    const row: Row = { ...bearerRow, authStyle: "query", authName: "api_key" };
    const { input, fetch } = fixture(row);
    await callUserConnection({ ...input, request: { method: "GET", path: "/items?fixed=1" } });
    const { url } = calledRequest(fetch);
    expect(url.searchParams.get("api_key")).toBe(KEY);
    expect(url.searchParams.get("fixed")).toBe("1");
  });

  it("posts a JSON body with the key in place", async () => {
    const { input, fetch } = fixture();
    await callUserConnection({
      ...input,
      request: { method: "POST", path: "/items", body: { title: "Hello" } },
    });
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ title: "Hello" }));
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("refuses a base URL that resolves to a private address, without fetching", async () => {
    const { input, fetch } = fixture();
    const result = await callUserConnection({
      ...input,
      remote: { fetch, resolveHostname: privateResolver },
      request: { method: "GET", path: "/user" },
    });
    expect(result).toEqual({
      error: "The request could not be completed. Check the connection and try again.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    const { input, fetch } = fixture();
    fetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const result = await callUserConnection({ ...input, request: { method: "GET", path: "/" } });
    expect(result).toEqual({
      error: "The service redirected the request; redirects are not followed.",
    });
    // The redirect is refused at the transport, not followed: the request goes
    // out with redirects off, and it carries the caller's abort signal.
    const [, init] = fetch.mock.calls[0]!;
    expect(init).toMatchObject({ redirect: "manual", method: "GET" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports an unknown connection name without fetching", async () => {
    const { input, fetch } = fixture();
    const result = await callUserConnection({
      ...input,
      name: "Missing",
      request: { method: "GET", path: "/" },
    });
    expect("error" in result && result.error).toContain("No connection is saved under this name");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists only names and metadata, never the key", async () => {
    const { prisma, findMany } = fixture();
    const listed = await listUserConnections(prisma, "user-1");
    expect(listed).toEqual([
      {
        name: "GitHub",
        baseUrl: "https://api.example.com",
        authStyle: "bearer",
        authName: null,
        hasApiKey: true,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(KEY);
    expect(JSON.stringify(listed)).not.toContain("secretCipher");
    // The listing is scoped to the acting user.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
  });

  it("never serves one user's connection to another user", async () => {
    const { input, prisma, fetch, findFirst, findMany } = fixture();
    // The same connection name under a different owner is not found, and
    // nothing is fetched on its behalf.
    const other = await callUserConnection({
      ...input,
      userId: "user-2",
      request: { method: "GET", path: "/" },
    });
    expect("error" in other && other.error).toContain("No connection is saved under this name");
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "user-2", name: "GitHub" } });
    expect(fetch).not.toHaveBeenCalled();

    const listed = await listUserConnections(prisma, "user-2");
    expect(listed).toEqual([]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-2" } }));
  });

  it("tests a connection by status only, discarding the body", async () => {
    const { input } = fixture(bearerRow, { echo: KEY });
    const result = await testUserConnection({
      secretStore: input.secretStore,
      row: bearerRow,
      remote: input.remote,
    });
    expect(result).toEqual({ status: 200, error: null });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("connectionRequestUrl", () => {
  it("joins paths under the base URL, including a path prefix", () => {
    const root = connectionRequestUrl("https://api.example.com", "/user/repos");
    expect("url" in root && root.url.href).toBe("https://api.example.com/user/repos");
    const prefixed = connectionRequestUrl("https://api.example.com/v1", "items");
    expect("url" in prefixed && prefixed.url.href).toBe("https://api.example.com/v1/items");
    const base = connectionRequestUrl("https://api.example.com/v1", undefined);
    expect("url" in base && base.url.href).toBe("https://api.example.com/v1");
  });

  it("refuses paths that escape the base URL", () => {
    expect(connectionRequestUrl("https://api.example.com/v1", "/../secret")).toEqual({
      error: "Path must stay under the connection's base URL.",
    });
    expect(connectionRequestUrl("https://api.example.com", "//evil.example.com/x")).toEqual({
      error: "Path must stay on the connection's base URL.",
    });
  });

  it("refuses a stored base URL that is no longer public HTTPS", () => {
    expect(connectionRequestUrl("http://api.example.com", "/x")).toEqual({
      error: "This connection's base URL is no longer usable.",
    });
    expect(connectionRequestUrl("https://127.0.0.1", "/x")).toEqual({
      error: "This connection's base URL is no longer usable.",
    });
  });
});
