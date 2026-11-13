import * as z from "zod";
import { Id } from "./ids.js";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
  normalizeHost,
} from "./network-host.js";

/**
 * A person's own API services, registered in Settings: a name, a base URL and
 * an API key. The key is sealed server-side on save and never read back —
 * lists and responses carry only the name, the base URL and how the key is
 * presented. Bots call a service through the server, which adds the key at
 * call time; they never see the value. Display and contracts stay
 * vendor-neutral: a connection is a base URL plus one auth style.
 */
export const CustomConnectionAuthStyleSchema = z.enum(["bearer", "header", "query"]);
export type CustomConnectionAuthStyle = z.infer<typeof CustomConnectionAuthStyleSchema>;

export const CUSTOM_CONNECTION_NAME_MAX_LENGTH = 80;
export const CUSTOM_CONNECTION_BASE_URL_MAX_LENGTH = 2_000;
export const CUSTOM_CONNECTION_API_KEY_MAX_LENGTH = 4_096;
export const CUSTOM_CONNECTION_PATH_MAX_LENGTH = 2_048;

export const CustomConnectionName = z.string().trim().min(1).max(CUSTOM_CONNECTION_NAME_MAX_LENGTH);

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUERY_PARAM_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Why a base URL cannot be registered, or null when it can. HTTPS only, no
 * embedded credentials, and the host must be public: name and literal-IP
 * checks here; the call layer re-resolves and re-checks the address on every
 * request, the way the proxy dispatcher does.
 */
export function customConnectionBaseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Base URL is invalid";
  }
  if (url.protocol !== "https:") return "Base URL must use HTTPS";
  if (url.username || url.password) return "Base URL must not contain credentials";
  if (url.hash) return "Base URL must not contain a fragment";
  const host = normalizeHost(url.hostname.replace(/^\[|\]$/g, ""));
  if (!host || host.length > 253) return "Base URL is invalid";
  if (isInternalHostname(host) || isCloudMetadataHost(host)) {
    return "Base URL must be a public host";
  }
  if (ipVersion(host) !== 0 && isNonPublicAddress(host)) {
    return "Base URL must be a public host";
  }
  return null;
}

function baseUrlSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(CUSTOM_CONNECTION_BASE_URL_MAX_LENGTH)
    .superRefine((value, ctx) => {
      const problem = customConnectionBaseUrlProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}

/**
 * Why a request path cannot be used, or null when it can. A path is always
 * relative to the connection's base URL; the call layer also checks the
 * composed URL stays under that base before sending.
 */
export function customConnectionPathProblem(path: string): string | null {
  if (path.length > CUSTOM_CONNECTION_PATH_MAX_LENGTH) return "Path is too long";
  if (/[\s\\]/.test(path)) return "Path is invalid";
  if (path.startsWith("//") || path.includes("://")) {
    return "Path must be relative to the connection's base URL";
  }
  return null;
}

function pathSchema() {
  return z.string().superRefine((value, ctx) => {
    const problem = customConnectionPathProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
}

const authNameSchema = z.string().trim().min(1).max(64);

/** What the add form collects: the service, how its key is presented, and the key itself. */
export const CustomConnectionAddInput = z
  .object({
    name: CustomConnectionName,
    baseUrl: baseUrlSchema(),
    authStyle: CustomConnectionAuthStyleSchema,
    /** The header or query parameter the key rides in; only for those two styles. */
    authName: authNameSchema.nullable().optional(),
    /** Write-only: sealed on save and never returned. Omit for a service that needs no key. */
    apiKey: z.string().min(1).max(CUSTOM_CONNECTION_API_KEY_MAX_LENGTH).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.authStyle === "bearer") return;
    if (!value.authName) {
      ctx.addIssue({
        code: "custom",
        message:
          value.authStyle === "header"
            ? "A header name is required for header auth"
            : "A parameter name is required for query auth",
        path: ["authName"],
      });
      return;
    }
    const pattern = value.authStyle === "header" ? HEADER_NAME : QUERY_PARAM_NAME;
    if (!pattern.test(value.authName)) {
      ctx.addIssue({
        code: "custom",
        message:
          value.authStyle === "header" ? "Header name is invalid" : "Parameter name is invalid",
        path: ["authName"],
      });
    }
  });
export type CustomConnectionAddInput = z.infer<typeof CustomConnectionAddInput>;

/** What lists and responses may show: never the key, in any form. */
export const CustomConnectionSummarySchema = z.object({
  id: Id,
  name: z.string(),
  baseUrl: z.string(),
  authStyle: CustomConnectionAuthStyleSchema,
  authName: z.string().nullable(),
  hasApiKey: z.boolean(),
  createdAt: z.string(),
});
export type CustomConnectionSummary = z.infer<typeof CustomConnectionSummarySchema>;

export const CustomConnectionRemoveInput = z.object({ connectionId: Id });
export type CustomConnectionRemoveInput = z.infer<typeof CustomConnectionRemoveInput>;

/** A reachability check: one GET against the base URL, or against `path` under it. */
export const CustomConnectionTestInput = z.object({
  connectionId: Id,
  path: pathSchema().optional(),
});
export type CustomConnectionTestInput = z.infer<typeof CustomConnectionTestInput>;

/** Only the outcome is reported — never the response body, which may echo the key. */
export const CustomConnectionTestResultSchema = z.object({
  status: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type CustomConnectionTestResult = z.infer<typeof CustomConnectionTestResultSchema>;

/** One call a bot makes through a registered connection, key added by the server. */
export const CustomConnectionCallInput = z
  .object({
    connection: CustomConnectionName,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    /** Relative to the connection's base URL; empty means the base URL itself. */
    path: pathSchema().optional(),
    /** JSON body for methods that take one. */
    body: z.unknown().optional(),
    /** Extra headers. The saved key's header cannot be overridden. */
    headers: z
      .record(z.string().max(128), z.string().max(1_024))
      .refine((headers) => Object.keys(headers).length <= 20, "Too many headers")
      .optional(),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
export type CustomConnectionCallInput = z.infer<typeof CustomConnectionCallInput>;
