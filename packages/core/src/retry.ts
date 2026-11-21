import { abortableDelay } from "./async.js";
import { isRetryableError, retryDelayMs } from "./retry-policy.js";

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;

export interface RetryOptions {
  /** Tries in total, the first included. */
  attempts: number;
  /**
   * The exact wait after a failed try: one value, a list by try (its last entry repeats), or a
   * function of the failed try's index (0 for the first) and its error. Left out, the shared
   * policy applies: the wait the error asked for (`retryAfterMs`), otherwise a jittered backoff
   * doubling from 250 ms up to 30 s.
   */
  delayMs?: number | readonly number[] | ((attempt: number, error: unknown) => number);
  /** Which failures deserve another try. Defaults to {@link isRetryableError}. */
  retryable?: (error: unknown) => boolean | Promise<boolean>;
  /** Called before each wait with the failure being retried, for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Ends a wait early; `retry` then rejects with the signal's reason. */
  signal?: AbortSignal;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Runs `operation` until it succeeds, a failure is not retryable, or the tries run out, and
 * rejects with the last failure. The operation honors the signal while it runs; `retry` honors it
 * between tries.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, signal, retryable = isRetryableError, delay = abortableDelay } = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !(await retryable(error))) throw error;
      const ms = retryWaitMs(options, attempt, error);
      options.onRetry?.(error, attempt, ms);
      if (ms > 0) await delay(ms, signal);
      signal?.throwIfAborted();
    }
  }
}

function retryWaitMs(options: RetryOptions, attempt: number, error: unknown): number {
  const { delayMs } = options;
  if (delayMs === undefined) {
    return retryDelayMs(error, Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS));
  }
  if (typeof delayMs === "number") return delayMs;
  if (typeof delayMs === "function") return delayMs(attempt, error);
  return delayMs[Math.min(attempt, delayMs.length - 1)] ?? 0;
}
