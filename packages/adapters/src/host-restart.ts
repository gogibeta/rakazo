import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Power-cycling the machine this deployment itself runs on. The generic shape
 * is all the API and the bot tools see; which provider sits behind it is an
 * adapter concern resolved from the environment at startup.
 */
export interface HostRestarter {
  /**
   * Begin the power-cycle. Resolves once the stop and the start have both
   * been accepted by the provider; throws if initiation fails.
   */
  restart(): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The API's own error detail from a failed response, for logs, plus the
 * provider's error code on its own for structural classification: the JSON
 * error's code and message when the body carries them, else the raw text.
 * The detail is capped so a verbose body cannot flood the log. Only the
 * response body is read — never the request — so the API key and headers
 * cannot leak into either value.
 */
async function errorInfo(response: Response): Promise<{ detail?: string; code?: string }> {
  let body: string;
  try {
    body = (await response.text()).trim();
  } catch {
    return {};
  }
  if (!body) return {};
  let detail = body;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const rawCode = parsed.error?.code ?? parsed.code;
    if (typeof rawCode === "string" && rawCode.length > 0) code = rawCode;
    const parts = [parsed.error?.code ?? parsed.code, parsed.error?.message ?? parsed.message]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ");
    if (parts) detail = parts;
  } catch {
    // Not JSON: the raw body is the detail.
  }
  return { detail: detail.slice(0, 200), code };
}

/**
 * A lifecycle call the provider answered with an HTTP error. The status and
 * the provider's error code ride along so the start retry can classify the
 * failure structurally — retrying only what can pass on a later attempt —
 * instead of matching on message text.
 */
class LifecycleHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(
    action: "stop" | "start",
    status: number,
    detail: string | undefined,
    code: string | undefined,
  ) {
    super(`instabox ${action} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "LifecycleHttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether a failed start attempt can succeed on a retry. A rejection from
 * fetch itself (network failure, abort, the per-attempt timeout) may never
 * have reached the provider, and the start's idempotency key makes retrying
 * it safe; 408, 425, 429 and 5xx are transient on the provider side. A 409
 * is retryable only when the provider names it operation_conflict: the
 * start landed while the stop operation was still settling, and the same
 * start is accepted once it has (live-verified). Any other 409 — an
 * idempotency_conflict above all — and any other 4xx fails identically on
 * every retry, so it surfaces at once.
 */
function isRetryableStartError(error: unknown): boolean {
  if (error instanceof LifecycleHttpError) {
    if (error.status === 409) return error.code === "operation_conflict";
    return (
      error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    );
  }
  return true;
}

/** The instabox API the sandbox provider already talks to (SDK default base). */
const INSTABOX_API_URL = "https://api.instabox.sh";
/** How long a failed start call is retried before restart() gives up and throws. */
const START_RETRY_WINDOW_MS = 120_000;
const START_RETRY_INTERVAL_MS = 2_000;
/**
 * Attempts are also capped at one per interval across the window, so a
 * caller whose sleeps return immediately cannot spin past the bound.
 */
const START_MAX_ATTEMPTS = START_RETRY_WINDOW_MS / START_RETRY_INTERVAL_MS;
/** No single lifecycle call may hang longer than this. */
const LIFECYCLE_TIMEOUT_MS = 10_000;
/** No single call to the external restarter may hang longer than this. */
const REMOTE_RESTART_TIMEOUT_MS = 15_000;
/**
 * The external restarter sits behind an edge that rejects bot-ish default
 * user agents, so the delegation presents as a current browser.
 */
const REMOTE_RESTART_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface InstaboxHostRestarterOptions {
  apiKey: string;
  machineId: string;
  apiUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Restart one instabox machine: POST /v1/machines/{id}/stop, then start.
 * The instabox API has no single restart action — the CLI's `restart` is the
 * same stop-then-start pair (SDK lifecycle actions: start/stop/suspend/resume).
 *
 * Lifecycle calls are asynchronous (live-verified): each returns a queued
 * operation rather than waiting for the machine to change state. The caller
 * runs on the machine being restarted, so it cannot wait for the stop to
 * finish before asking for the start — and a start requested while the stop
 * operation is still active is refused with a 409 operation_conflict, not
 * queued. The start is accepted once the stop operation settles (the
 * machine reaching stopping/stopped, ~14s observed), and this process lives
 * until the guest finishes powering down, so the bounded retry below —
 * paced at 2s across a 120s window — lands the start inside that window.
 * That retry through the conflict window is what makes the restart
 * self-recovering.
 */
export function createInstaboxHostRestarter(options: InstaboxHostRestarterOptions): HostRestarter {
  const base = (options.apiUrl ?? INSTABOX_API_URL).replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const lifecycle = async (action: "stop" | "start", idempotencyKey: string): Promise<void> => {
    const response = await send(
      `${base}/v1/machines/${encodeURIComponent(options.machineId)}/${action}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
        // Live-verified against api.instabox.sh: an ibk_ key sent via
        // X-API-Key is rejected (401 "malformed_key"); the API takes the key
        // as an Authorization Bearer token. The vendor SDK sends X-API-Key,
        // but the live API disagrees for these keys — do not switch back.
        // Lifecycle POSTs also require an Idempotency-Key header (1-200
        // printable characters); without one the API returns 400
        // bad_request. Keys are per-request (live-verified): each action
        // call carries its own key, because reusing one key for a different
        // request is rejected (409 idempotency_conflict). Retries of the
        // same action reuse that action's key, so a retried call cannot
        // apply twice.
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "idempotency-key": idempotencyKey,
        },
      },
    );
    if (!response.ok) {
      const { detail, code } = await errorInfo(response);
      throw new LifecycleHttpError(action, response.status, detail, code);
    }
  };
  return {
    async restart() {
      await lifecycle("stop", randomUUID());
      // Fire the start immediately, with its OWN idempotency key. While the
      // stop operation is still settling the provider refuses the start
      // with a 409 operation_conflict; the bounded retry below re-sends the
      // same start — same key, so a retry can never become a second start —
      // until the stop settles and the start is accepted, which is what
      // brings the machine back. The retry also covers the start call
      // itself failing to land transiently.
      //
      // The start is awaited, never fire-and-forget: this process runs on
      // the machine being stopped, so once the guest powers off nothing
      // here runs any more. The start must be ACCEPTED by the provider
      // before restart() returns — an un-awaited start races the power-off
      // and can be lost with the process, leaving the machine off. If no
      // attempt lands within the retry window, restart() throws the last
      // error instead of reporting a restart that will not happen.
      const startIdempotencyKey = randomUUID();
      const deadline = Date.now() + START_RETRY_WINDOW_MS;
      let lastError: unknown;
      for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt++) {
        try {
          await lifecycle("start", startIdempotencyKey);
          return;
        } catch (error) {
          lastError = error;
          if (!isRetryableStartError(error)) throw error;
          if (Date.now() + START_RETRY_INTERVAL_MS > deadline) break;
          await sleep(START_RETRY_INTERVAL_MS).catch(() => undefined);
        }
      }
      throw lastError;
    },
  };
}

export interface RemoteHostRestarterOptions {
  url: string;
  secret: string;
  fetch?: FetchLike;
}

/**
 * Delegate the power-cycle to an external restarter that runs outside the
 * machine being restarted: one POST to the configured URL, authenticated
 * with the shared secret as a Bearer token. The delegate performs the
 * stop-then-start sequence itself, so this call only needs the request to
 * be accepted — resolving on any 2xx. Failures surface the HTTP status and
 * the response body's error detail; the secret and the request headers are
 * never read back into the error.
 */
export function createRemoteHostRestarter(options: RemoteHostRestarterOptions): HostRestarter {
  const send = options.fetch ?? fetch;
  return {
    async restart() {
      const response = await send(options.url, {
        method: "POST",
        signal: AbortSignal.timeout(REMOTE_RESTART_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${options.secret}`,
          "user-agent": REMOTE_RESTART_USER_AGENT,
        },
      });
      if (!response.ok) {
        const { detail } = await errorInfo(response);
        throw new Error(
          `remote host restart failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
    },
  };
}

/**
 * The deployment's host restarter, when the operator configured one. An
 * external restarter (HOST_RESTART_URL plus HOST_RESTART_SECRET) wins when
 * both of its values are set: it performs the power-cycle from outside the
 * machine, which the in-guest path cannot do reliably. Otherwise the direct
 * path remains as a fallback: INSTABOX_API_KEY (the sandbox provider's key)
 * plus INSTABOX_MACHINE_ID naming the one machine a restart may touch.
 * Either configuration missing its pair disables the feature.
 */
export function createHostRestarter(
  env: NodeJS.ProcessEnv = process.env,
): HostRestarter | undefined {
  const url = env.HOST_RESTART_URL?.trim();
  const secret = env.HOST_RESTART_SECRET?.trim();
  if (url && secret) return createRemoteHostRestarter({ url, secret });
  const apiKey = env.INSTABOX_API_KEY?.trim();
  const machineId = env.INSTABOX_MACHINE_ID?.trim();
  if (!apiKey || !machineId) return undefined;
  return createInstaboxHostRestarter({ apiKey, machineId });
}
