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
 * A person's named proxies. Bots route their web traffic through one the owner
 * picks; the password is sealed server-side and never read back after save.
 * Display and contracts stay vendor-neutral: a proxy is a protocol, a host and
 * a port, with an optional country the connection composes into the username
 * the way residential providers expect (`-cc-XX`).
 */
export const ProxyProtocolSchema = z.enum(["http", "https", "socks5"]);
export type ProxyProtocol = z.infer<typeof ProxyProtocolSchema>;

export const PROXY_NAME_MAX_LENGTH = 80;
export const PROXY_HOST_MAX_LENGTH = 253;
export const PROXY_USERNAME_MAX_LENGTH = 200;
export const PROXY_PASSWORD_MAX_LENGTH = 500;
export const PROXY_URL_MAX_LENGTH = 2_000;

const ProxyCountrySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Country must be a two-letter code")
  .transform((value) => value.toUpperCase());

const ProxyPasswordSchema = z.string().min(1).max(PROXY_PASSWORD_MAX_LENGTH);

/** The structured parts of one proxy, as the add form collects them. */
export type ProxyParts = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  country?: string | null;
  username?: string | null;
  password?: string | null;
};

const DEFAULT_PROXY_PORTS: Record<ProxyProtocol, number> = { http: 80, https: 443, socks5: 1080 };

/** Why a proxy host cannot be used, or null when it can. Name and literal-IP checks only;
 * the egress layer re-resolves and re-checks the address on every connection. */
export function proxyHostProblem(host: string): string | null {
  const normalized = normalizeHost(host.replace(/^\[|\]$/g, ""));
  if (!normalized || normalized.length > PROXY_HOST_MAX_LENGTH) return "Proxy host is required";
  if (/[\s/@?#\\]/.test(normalized)) return "Proxy host is invalid";
  if (isInternalHostname(normalized) || isCloudMetadataHost(normalized)) {
    return "Proxy host must be a public host";
  }
  if (ipVersion(normalized) !== 0 && isNonPublicAddress(normalized)) {
    return "Proxy host must be a public host";
  }
  return null;
}

function proxyHostSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(PROXY_HOST_MAX_LENGTH)
    .superRefine((host, ctx) => {
      const problem = proxyHostProblem(host);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}

/**
 * Add a proxy from the structured fields, or by pasting one proxy URL instead.
 * With `url` set the server parses it into the same parts; the structured
 * fields are then ignored.
 */
export const ProxyAddInput = z
  .object({
    name: z.string().trim().min(1).max(PROXY_NAME_MAX_LENGTH),
    url: z.string().trim().min(1).max(PROXY_URL_MAX_LENGTH).optional(),
    protocol: ProxyProtocolSchema.optional(),
    host: proxyHostSchema().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    country: ProxyCountrySchema.nullable().optional(),
    username: z.string().trim().min(1).max(PROXY_USERNAME_MAX_LENGTH).nullable().optional(),
    password: ProxyPasswordSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.url) {
      try {
        parseProxyUrl(value.url);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Proxy URL is invalid",
          path: ["url"],
        });
      }
      return;
    }
    if (!value.host) {
      ctx.addIssue({ code: "custom", message: "Proxy host is required", path: ["host"] });
    }
    if (value.port === undefined) {
      ctx.addIssue({ code: "custom", message: "Proxy port is required", path: ["port"] });
    }
    if (value.password && !value.username) {
      ctx.addIssue({
        code: "custom",
        message: "A proxy password needs a username",
        path: ["password"],
      });
    }
  });
export type ProxyAddInput = z.infer<typeof ProxyAddInput>;

/** What lists and responses may show: never the password, never the composed URL. */
export const ProxySummarySchema = z.object({
  id: Id,
  name: z.string(),
  protocol: ProxyProtocolSchema,
  host: z.string(),
  port: z.number().int(),
  country: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
});
export type ProxySummary = z.infer<typeof ProxySummarySchema>;

export const ProxyRemoveInput = z.object({ proxyId: Id });
export type ProxyRemoveInput = z.infer<typeof ProxyRemoveInput>;

/** The username a connection actually presents: the country rides in it as `-cc-XX`. */
export function proxyUsername(parts: Pick<ProxyParts, "username" | "country">): string | null {
  const username = parts.username?.trim();
  if (!username) return null;
  const country = parts.country?.trim().toUpperCase();
  return country ? `${username}-cc-${country}` : username;
}

/** Compose the standard proxy URL for a connection. Credentials are URL-encoded. */
export function composeProxyUrl(parts: ProxyParts): string {
  const host = ipVersion(parts.host) === 6 ? `[${parts.host}]` : parts.host;
  const username = proxyUsername(parts);
  const auth = username
    ? `${encodeURIComponent(username)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ""}@`
    : "";
  return `${parts.protocol}://${auth}${host}:${parts.port}`;
}

const COUNTRY_SUFFIX = /-cc-([A-Za-z]{2})$/;

/** Parse a pasted proxy URL into the structured parts; a `-cc-XX` username suffix becomes the country. */
export function parseProxyUrl(raw: string): ProxyParts {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Proxy URL is invalid");
  }
  const protocol = url.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
    throw new Error("Proxy URL must start with http://, https:// or socks5://");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const problem = proxyHostProblem(host);
  if (problem) throw new Error(problem);
  const port = url.port ? Number(url.port) : DEFAULT_PROXY_PORTS[protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Proxy port is invalid");
  let username: string | null = null;
  let country: string | null = null;
  if (url.username) {
    let decoded = decodeURIComponent(url.username);
    const suffix = COUNTRY_SUFFIX.exec(decoded);
    if (suffix) {
      country = suffix[1]!.toUpperCase();
      decoded = decoded.slice(0, suffix.index);
    }
    username = decoded || null;
  }
  const password = url.password ? decodeURIComponent(url.password) : null;
  if (password && !username) throw new Error("A proxy password needs a username");
  return { protocol, host, port, country, username, password };
}

/** The parts an add request stores, from its structured fields or its pasted URL. */
export function proxyPartsFromInput(input: ProxyAddInput): ProxyParts {
  if (input.url) return parseProxyUrl(input.url);
  return {
    protocol: input.protocol ?? "http",
    host: input.host!,
    port: input.port!,
    country: input.country ?? null,
    username: input.username ?? null,
    password: input.password ?? null,
  };
}
