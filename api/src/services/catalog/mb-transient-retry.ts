/**
 * Bounded retry for a local MusicBrainz mirror that is momentarily busy.
 *
 * A MB-docker mirror answers `503 "The MusicBrainz web server is currently
 * busy. Please try again later."` while it is under load — during our own
 * provider-matching runs, for instance. One such answer used to fail a whole
 * artist intake, leaving the artist monitored with zero albums and nothing on
 * screen saying to try again.
 *
 * The point of this module is to survive that *without* becoming a way to not
 * notice a mirror that is actually down:
 *
 *  - only genuinely transient signals are retried (503/502/504/429 and
 *    network timeouts) — a 404 or a 400 fails on the first answer, because
 *    retrying a definite answer only delays the truth;
 *  - the attempt budget is small and fixed, so a persistent outage surfaces in
 *    seconds rather than being absorbed indefinitely;
 *  - when the budget runs out the original failure is re-thrown with the
 *    attempt count and elapsed time attached. Exhausted retries must read as a
 *    louder version of the underlying error, never as a quieter one.
 */

export class MbHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "MbHttpError";
  }
}

/** Signals that mean "ask again shortly", as opposed to a definite answer. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export function isTransientMbFailure(error: unknown): boolean {
  if (error instanceof MbHttpError) return TRANSIENT_STATUSES.has(error.status);
  if (error instanceof Error) {
    // AbortSignal.timeout rejects with TimeoutError; undici surfaces connection
    // resets as TypeError("fetch failed"). Both mean "no answer", not "no".
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (/fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

export interface BoundedRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Delay before the first retry; doubled each time. */
  baseDelayMs?: number;
  /** Ceiling for one backoff step. */
  maxDelayMs?: number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the message can name what was being fetched. */
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation`, retrying only transient failures, at most `attempts` times.
 *
 * The rejection a caller sees is always the last real failure — annotated, never
 * replaced — so a mirror that is genuinely unreachable still fails the command
 * with its own status and message.
 */
export async function withBoundedMbRetry<T>(
  operation: () => Promise<T>,
  label: string,
  options: BoundedRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientMbFailure(error) || attempt === attempts) break;

      // Honour Retry-After when the mirror sends one, still bounded by maxDelayMs.
      const advertised = error instanceof MbHttpError ? error.retryAfterMs : null;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.min(Math.max(advertised ?? backoff, 0), maxDelayMs);
      options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  if (lastError instanceof Error && isTransientMbFailure(lastError)) {
    // Persistent, not transient after all: say so on the error the caller gets.
    lastError.message =
      `${lastError.message} (still failing after ${attempts} attempt(s) over ${Date.now() - startedAt}ms: ${label})`;
  }
  throw lastError;
}
