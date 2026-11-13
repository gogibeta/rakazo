import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Power-cycling the machine this deployment itself runs on. The generic shape
 * is all the API and the bot tools see; which provider sits behind it is an
 * adapter concern resolved from the environment at startup.
 */
export interface HostRestarter {
  /**
   * Begin the power-cycle. Resolves once the stop and the queued start have
   * both been accepted by the provider; throws if initiation fails.
   */
  restart(): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The API's own error detail from a failed response, for logs: the JSON
 * error's code and message when the body carries them, else the raw text.
 * Capped so a verbose body cannot flood the log. Only the response body is
 * read — never the request — so the API key and headers cannot leak into it.
 */
async function errorDetail(response: Response): Promise<string | undefined> {
  let body: string;
  try {
    body = (await response.text()).trim();
  } catch {
    return undefined;
  }
  if (!body) return undefined;
  let detail = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const parts = [parsed.error?.code ?? parsed.code, parsed.error?.message ?? parsed.message]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ");
    if (parts) detail = parts;
  } catch {
    // Not JSON: the raw body is the detail.
  }
  return detail.slice(0, 200);
}

/**
 * A lifecycle call the provider answered with an HTTP error. The status
 * rides along so the start retry can classify the failure structurally —
 * retrying only what can pass on a later attempt — instead of matching on
 * message text.
 */
class LifecycleHttpError extends Error {
  readonly status: number;

  constructor(action: "stop" | "start", status: number, detail: string | undefined) {
    super(`instabox ${action} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "LifecycleHttpError";
    this.status = status;
  }
}

/**
 * Whether a failed start attempt can succeed on a retry. A rejection from
 * fetch itself (network failure, abort, the per-attempt timeout) may never
 * have reached the provider, and the start's idempotency key makes retrying
 * it safe; 408, 425, 429 and 5xx are transient on the provider side. Any
 * other 4xx — a 409 idempotency conflict above all — fails identically on
 * every retry, so it surfaces at once.
 */
function isRetryableStartError(error: unknown): boolean {
  if (error instanceof LifecycleHttpError) {
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
 * finish — but it does not need to: a start requested while the machine is
 * still stopping is accepted and queued behind the stop, and the machine
 * starts again on its own once the stop completes. That queued start, not
 * any retry loop, is what makes the restart self-recovering.
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
      const detail = await errorDetail(response);
      throw new LifecycleHttpError(action, response.status, detail);
    }
  };
  return {
    async restart() {
      await lifecycle("stop", randomUUID());
      // Fire the start immediately, with its OWN idempotency key: the
      // platform queues it behind the still-running stop, which is what
      // brings the machine back. The bounded retry only covers the start
      // call itself failing to land transiently, and reuses the start's
      // key so a retry can never become a second start.
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

/**
 * The deployment's host restarter, when the operator pointed the deployment at
 * its own machine: INSTABOX_API_KEY (the sandbox provider's key) plus
 * INSTABOX_MACHINE_ID naming the one machine a restart may touch. Either one
 * missing disables the feature.
 */
export function createHostRestarter(
  env: NodeJS.ProcessEnv = process.env,
): HostRestarter | undefined {
  const apiKey = env.INSTABOX_API_KEY?.trim();
  const machineId = env.INSTABOX_MACHINE_ID?.trim();
  if (!apiKey || !machineId) return undefined;
  return createInstaboxHostRestarter({ apiKey, machineId });
}
