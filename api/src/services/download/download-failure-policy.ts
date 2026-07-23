import { readIntEnv } from "../../utils/env.js";
import { streamingProviderManager } from "../providers/index.js";

/**
 * Same-offer retries before provider fallback (A1).
 * Default: 3 total attempts (1 initial + 2 retries) with exponential backoff
 * starting at 2s (2s, then 4s).
 */
export const SAME_OFFER_MAX_ATTEMPTS = readIntEnv(
  "DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS",
  3,
  1,
);
export const SAME_OFFER_BACKOFF_BASE_MS = readIntEnv(
  "DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS",
  2_000,
  0,
);

export type DownloadFailureKind = "transient" | "permanent";

const PERMANENT_PATTERNS: RegExp[] = [
  /\b404\b/i,
  /\bnot[\s_-]?found\b/i,
  /\bunavailable\b/i,
  /\bdoes not exist\b/i,
  /\bno (?:longer )?available\b/i,
  /\btrack not found\b/i,
  /\balbum not found\b/i,
  /\bvideo not found\b/i,
  /\bno matching (?:track|album|video)\b/i,
  /\binvalid (?:track|album|video|id)\b/i,
  /\bforbidden\b/i,
  /\b403\b/,
  /\b401\b/,
  /\bunauthorized\b/i,
  /\bquality not available\b/i,
  /\bno stream(?:ing)? (?:url|available)\b/i,
  // YouTube / yt-dlp entitlement — retries and cookie re-attempts will not help
  // once the account still sees private / members-only.
  /\bprivate video\b/i,
  /\bmembers[- ]only\b/i,
  /\bsign in if you've been granted access\b/i,
  /\blogin required\b/i,
  // SoundCloud DRM / SNIP (native + yt-dlp wording variants)
  /\bDRM[\s/_-]?protected\b/i,
  /\bDRM\/SNIP\b/i,
  /\bpolicy=SNIP\b/i,
  /\bencrypted HLS\b/i,
  // Deezer / Streamrip permanent entitlement
  /\bnot available in (?:your|this) country\b/i,
  /\binvalid (?:arl|token)\b/i,
  /\barl (?:expired|invalid)\b/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\btiddl exited with code 1\b/i,
  /\btraceback\b/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\betimedout\b/i,
  /\benetunreach\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork\b/i,
  /\btimeout\b/i,
  /\brate[\s_-]?limit/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\btemporar(?:y|ily)\b/i,
  /\bretry/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error ?? "");
}

export function isDownloadCancellationError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("download cancelled")
    || text.includes("aborted")
    || (error instanceof Error && error.name === "AbortError");
}

/**
 * Classify download failures for retry policy.
 * Permanent failures skip same-offer retries and go straight to fallback (or fail).
 * Unknown / Traceback / exit-1 style errors default to transient.
 */
export function classifyDownloadFailure(error: unknown): DownloadFailureKind {
  const text = errorText(error);
  if (!text.trim()) {
    return "transient";
  }
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "permanent";
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "transient";
  }
  // Default: treat unknown provider/ripper failures as transient so exit-1 /
  // opaque Tracebacks get a few same-offer retries before fallback.
  return "transient";
}

/** Backoff before attempt `nextAttempt` (1-based; call after a failed attempt). */
export function sameOfferBackoffMs(failedAttempt: number): number {
  if (SAME_OFFER_BACKOFF_BASE_MS <= 0) {
    return 0;
  }
  const exponent = Math.max(0, failedAttempt - 1);
  return SAME_OFFER_BACKOFF_BASE_MS * (2 ** exponent);
}

export function formatProviderLabel(providerId: string | null | undefined): string {
  return streamingProviderManager.getProviderDisplayName(providerId);
}

export function formatFallbackSuccessMessage(
  fallbackProvider: string,
  primaryProvider: string,
): string {
  const fallback = formatProviderLabel(fallbackProvider);
  const primary = formatProviderLabel(primaryProvider);
  return `Downloaded from ${fallback} after ${primary} failed. File is ready.`;
}

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw new Error("Download cancelled");
    }
    return;
  }
  if (signal?.aborted) {
    throw new Error("Download cancelled");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Download cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type SameOfferRetryHooks = {
  signal?: AbortSignal;
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: unknown;
  }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Run `fn` up to SAME_OFFER_MAX_ATTEMPTS times. Permanent failures throw
 * immediately (caller may fall back to another provider). Transient failures
 * back off and retry the same offer.
 */
export async function executeWithSameOfferRetries<T>(
  hooks: SameOfferRetryHooks,
  fn: () => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, SAME_OFFER_MAX_ATTEMPTS);
  const sleep = hooks.sleep ?? sleepMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isDownloadCancellationError(error)) {
        throw error;
      }
      const kind = classifyDownloadFailure(error);
      const canRetry = kind === "transient" && attempt < maxAttempts;
      if (!canRetry) {
        throw error;
      }
      const delayMs = sameOfferBackoffMs(attempt);
      hooks.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error,
      });
      await sleep(delayMs, hooks.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Download failed"));
}
