import type { SecretStore } from "@rakazo/adapter-kit";
import { customConnectionBaseUrlProblem } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { ConnectorRedirectError, createSafeRemoteFetch } from "./remote-mcp.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

/**
 * The server-side half of custom connections: what bots may see (names, base
 * URLs, auth styles) and the one call they may make. The key is loaded only
 * here, only to be added to that call, and its forms are registered for
 * redaction before the request goes out, so a service echoing its key back
 * cannot leak it into the run.
 */

export type UserConnectionSummary = {
  name: string;
  baseUrl: string;
  authStyle: string;
  authName: string | null;
  hasApiKey: boolean;
};

export type UserConnectionRow = {
  id: string;
  name: string;
  baseUrl: string;
  authStyle: string;
  authName: string | null;
  secretCipher: string | null;
};

/** The connections a bot may plan with: name, base URL and auth style, never the key. */
export async function listUserConnections(
  prisma: PrismaClient,
  userId: string,
): Promise<UserConnectionSummary[]> {
  const rows = await prisma.userCustomConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { name: true, baseUrl: true, authStyle: true, authName: true, secretCipher: true },
  });
  // Mapped field by field, so nothing else on the row can reach a bot.
  return rows.map((row) => ({
    name: row.name,
    baseUrl: row.baseUrl,
    authStyle: row.authStyle,
    authName: row.authName,
    hasApiKey: Boolean(row.secretCipher),
  }));
}

export async function findUserConnection(
  prisma: PrismaClient,
  userId: string,
  name: string,
): Promise<UserConnectionRow | null> {
  return prisma.userCustomConnection.findFirst({ where: { userId, name } });
}

export type ConnectionCallRequest = {
  method: string;
  /** Relative to the connection's base URL; empty means the base URL itself. */
  path?: string | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
};

export type ConnectionCallResult =
  | { status: number; body: unknown; truncated: boolean }
  | { error: string };

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESULT_LENGTH = 20_000;
const CALL_TIMEOUT_MS = 30_000;

/**
 * Compose the request URL under the connection's base URL. The base was
 * checked when the connection was saved and is checked again here, and the
 * composed URL must stay on the base's origin and under its path prefix, so
 * a path cannot walk out of the service it names.
 */
export function connectionRequestUrl(
  baseUrl: string,
  path: string | undefined,
): { url: URL } | { error: string } {
  if (customConnectionBaseUrlProblem(baseUrl)) {
    return { error: "This connection's base URL is no longer usable." };
  }
  const base = new URL(baseUrl);
  const suffix = (path ?? "").trim();
  if (suffix.startsWith("//") || suffix.includes("://")) {
    return { error: "Path must stay on the connection's base URL." };
  }
  const joined = suffix ? `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}` : baseUrl;
  let url: URL;
  try {
    url = new URL(joined);
  } catch {
    return { error: "Path is invalid." };
  }
  if (url.origin !== base.origin) {
    return { error: "Path must stay on the connection's base URL." };
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return { error: "Path must stay under the connection's base URL." };
  }
  return { url };
}

/** The forms of a connection key a run must hide: raw, in its header, encoded. */
export function connectionKeyRedactions(row: UserConnectionRow, secret: string): string[] {
  return [
    ...new Set([
      secret,
      Buffer.from(secret).toString("base64"),
      encodeURIComponent(secret),
      row.authStyle === "bearer" ? `Bearer ${secret}` : secret,
    ]),
  ].filter(Boolean);
}

/**
 * One call through a saved connection. The key is added here and nowhere
 * else: as a bearer token, a named header, or a query parameter, per the
 * connection's auth style. A caller header can never replace it.
 */
export async function executeConnectionCall(input: {
  secretStore: Pick<SecretStore, "load">;
  row: UserConnectionRow;
  request: ConnectionCallRequest;
  signal?: AbortSignal | undefined;
  remote?: RemoteTransportDependencies | undefined;
  registerRedactions?: ((values: string[]) => void) | undefined;
}): Promise<ConnectionCallResult> {
  const { row, request } = input;
  const composed = connectionRequestUrl(row.baseUrl, request.path);
  if ("error" in composed) return composed;
  const url = composed.url;
  const controller = new AbortController();
  const signal = combineSignals(
    input.signal,
    controller.signal,
    AbortSignal.timeout(CALL_TIMEOUT_MS),
  );
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    // A caller never sets the transport's own headers, nor the header the key rides in.
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    if (row.authStyle === "header" && row.authName && lower === row.authName.toLowerCase()) {
      continue;
    }
    if (row.authStyle === "bearer" && lower === "authorization") continue;
    headers.set(name, value);
  }
  let body: string | undefined;
  if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  let secretForms: string[] = [];
  if (row.secretCipher) {
    let secret: string;
    try {
      secret = await input.secretStore.load(row.secretCipher, row.id);
    } catch {
      return { error: "This connection's key could not be read." };
    }
    secretForms = connectionKeyRedactions(row, secret);
    input.registerRedactions?.(secretForms);
    if (row.authStyle === "bearer") {
      headers.set("authorization", `Bearer ${secret}`);
    } else if (row.authStyle === "header" && row.authName) {
      headers.set(row.authName, secret);
    } else if (row.authStyle === "query" && row.authName) {
      url.searchParams.set(row.authName, secret);
    }
  }
  // The safe fetch refuses plain HTTP, private hosts and redirects, and
  // re-checks the resolved addresses on this very connection.
  const fetch = createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
  try {
    const response = await withAbort(
      fetch(url, { method: request.method, headers, body, redirect: "manual", signal }),
      signal,
    );
    const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, signal);
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redaction happens inside the call, before any truncation, so an output
    // boundary cannot expose part of the key; the tool layer registers the
    // same forms with the run for everything after.
    const safe = JSON.stringify(redactConnectorPayload(parsed, secretForms));
    return {
      status: response.status,
      body: safe.length > MAX_RESULT_LENGTH ? safe.slice(0, MAX_RESULT_LENGTH) : JSON.parse(safe),
      truncated: safe.length > MAX_RESULT_LENGTH,
    };
  } catch (error) {
    if (error instanceof ConnectorRedirectError) {
      return { error: "The service redirected the request; redirects are not followed." };
    }
    return { error: "The request could not be completed. Check the connection and try again." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

/** A bot's call through one of the acting user's connections, found by name. */
export async function callUserConnection(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  userId: string;
  name: string;
  request: ConnectionCallRequest;
  signal?: AbortSignal | undefined;
  remote?: RemoteTransportDependencies | undefined;
  registerRedactions?: ((values: string[]) => void) | undefined;
}): Promise<ConnectionCallResult> {
  const row = await findUserConnection(input.prisma, input.userId, input.name);
  if (!row) {
    return {
      error:
        "No connection is saved under this name. The user can add one in Settings, under Custom connections.",
    };
  }
  return executeConnectionCall({
    secretStore: input.secretStore,
    row,
    request: input.request,
    signal: input.signal,
    remote: input.remote,
    registerRedactions: input.registerRedactions,
  });
}

/**
 * The Settings test button: one GET, and only the outcome leaves this
 * function — the response body is dropped here, so a service echoing its key
 * can never leak it into the settings page.
 */
export async function testUserConnection(input: {
  secretStore: Pick<SecretStore, "load">;
  row: UserConnectionRow;
  path?: string | undefined;
  signal?: AbortSignal | undefined;
  remote?: RemoteTransportDependencies | undefined;
}): Promise<{ status: number | null; error: string | null }> {
  const result = await executeConnectionCall({
    secretStore: input.secretStore,
    row: input.row,
    request: { method: "GET", path: input.path },
    signal: input.signal,
    remote: input.remote,
  });
  if ("error" in result) return { status: null, error: result.error };
  return { status: result.status, error: null };
}
