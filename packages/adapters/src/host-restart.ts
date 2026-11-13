import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Power-cycling the machine this deployment itself runs on. The generic shape
 * is all the API and the bot tools see; which provider sits behind it is an
 * adapter concern resolved from the environment at startup.
 */
export interface HostRestarter {
  /** Begin the power-cycle. Resolves once the restart has been initiated. */
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

/** The instabox API the sandbox provider already talks to (SDK default base). */
const INSTABOX_API_URL = "https://api.instabox.sh";
/** How long the background start retries run after the stop is accepted. */
const START_RETRY_WINDOW_MS = 120_000;
const START_RETRY_INTERVAL_MS = 2_000;

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
 * The caller runs on the machine being restarted, so it cannot wait for the
 * stop to finish: the start is requested as soon as the stop is accepted and
 * retried in the background, so the platform queues it behind the stop. A
 * guest that dies before a start lands leaves the machine stopped; starting
 * it from the instabox dashboard always works.
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
        // Live-verified against api.instabox.sh: an ibk_ key sent via
        // X-API-Key is rejected (401 "malformed_key"); the API takes the key
        // as an Authorization Bearer token. The vendor SDK sends X-API-Key,
        // but the live API disagrees for these keys — do not switch back.
        // Lifecycle POSTs also require an Idempotency-Key header (1-200
        // printable characters); without one the API returns 400
        // bad_request. One key is minted per restart and shared by its stop
        // and start calls, so a retried start cannot apply twice.
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "idempotency-key": idempotencyKey,
        },
      },
    );
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new Error(
        `instabox ${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
  };
  return {
    async restart() {
      const idempotencyKey = randomUUID();
      await lifecycle("stop", idempotencyKey);
      const startWithRetries = async (): Promise<void> => {
        const deadline = Date.now() + START_RETRY_WINDOW_MS;
        for (;;) {
          try {
            await lifecycle("start", idempotencyKey);
            return;
          } catch {
            if (Date.now() + START_RETRY_INTERVAL_MS > deadline) return;
            await sleep(START_RETRY_INTERVAL_MS).catch(() => undefined);
          }
        }
      };
      void startWithRetries().catch(() => undefined);
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
