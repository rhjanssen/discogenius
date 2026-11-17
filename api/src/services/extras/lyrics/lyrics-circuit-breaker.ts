/**
 * Circuit breaker for provider lyrics endpoints.
 *
 * When a provider's lyrics endpoint fails repeatedly with timeouts or 5xx
 * server errors (e.g. TIDAL 504s), continuing to query it for dozens or hundreds
 * of tracks stalls album processing.
 *
 * After N consecutive qualifying failures (default: 5), the circuit breaker opens
 * for a cooldown period (default: 15 minutes) across all jobs. During this window,
 * lookups for that provider return null immediately without making network calls.
 */

export const DEFAULT_LYRICS_CIRCUIT_MAX_FAILURES = 5;
export const DEFAULT_LYRICS_CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

export class LyricsCircuitBreaker {
  private consecutiveFailures = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();
  private loggedTrip = new Map<string, boolean>();

  constructor(
    private maxConsecutiveFailures = Number(process.env.DISCOGENIUS_LYRICS_CIRCUIT_MAX_FAILURES) || DEFAULT_LYRICS_CIRCUIT_MAX_FAILURES,
    private cooldownMs = Number(process.env.DISCOGENIUS_LYRICS_CIRCUIT_COOLDOWN_MS) || DEFAULT_LYRICS_CIRCUIT_COOLDOWN_MS,
  ) {}

  private normalizeProvider(provider?: string | null): string {
    return String(provider || "").trim().toLowerCase();
  }

  /**
   * Returns true if the circuit breaker is open (cooling down) for the given provider.
   */
  isOpen(provider?: string | null, now = Date.now()): boolean {
    const key = this.normalizeProvider(provider);
    if (!key) return false;
    const until = this.cooldownUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;

    // Cooldown expired: transition to half-open (allow next request)
    this.cooldownUntil.delete(key);
    this.loggedTrip.delete(key);
    return false;
  }

  /**
   * Record a successful response (or definitive absence like 404).
   * Resets the consecutive failure counter and clears any cooldown.
   */
  recordSuccess(provider?: string | null): void {
    const key = this.normalizeProvider(provider);
    if (!key) return;
    this.consecutiveFailures.set(key, 0);
    this.cooldownUntil.delete(key);
    this.loggedTrip.delete(key);
  }

  /**
   * Record a failure from the provider lyrics endpoint.
   * If the failure qualifies (timeout or 5xx), increments consecutive failures
   * and opens the circuit if threshold is reached.
   */
  recordFailure(provider?: string | null, error?: unknown, now = Date.now()): boolean {
    const key = this.normalizeProvider(provider);
    if (!key) return false;

    if (!this.isQualifyingFailure(error)) {
      return false;
    }

    const current = (this.consecutiveFailures.get(key) || 0) + 1;
    this.consecutiveFailures.set(key, current);

    if (current >= this.maxConsecutiveFailures) {
      const until = now + this.cooldownMs;
      this.cooldownUntil.set(key, until);
      if (!this.loggedTrip.get(key)) {
        this.loggedTrip.set(key, true);
        const cooldownMinutes = Math.round(this.cooldownMs / 60_000);
        const reason = this.describeError(error);
        console.warn(
          `[Lyrics] Circuit breaker tripped for provider ${provider} after ${current} consecutive failures (${reason}); lyrics lookups paused for ${cooldownMinutes}m across all jobs`,
        );
      }
      return true;
    }
    return false;
  }

  /**
   * Only timeouts and 5xx HTTP errors qualify towards opening the circuit breaker.
   * Definitive absence (404) or client errors (400, 422) do not trip the circuit.
   */
  isQualifyingFailure(error: unknown): boolean {
    if (!error) return false;

    const status = Number(
      (error as any).status ??
      (error as any).statusCode ??
      (error as any).response?.status,
    );
    if (Number.isInteger(status) && status >= 500 && status < 600) {
      return true;
    }

    const name = String((error as any).name || "");
    if (name === "TimeoutError" || name === "AbortError") {
      return true;
    }

    const message = String((error as any).message || error).toLowerCase();
    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("etimedout") ||
      message.includes("esockettimedout") ||
      message.includes("gateway timeout") ||
      message.includes("504") ||
      message.includes("503") ||
      message.includes("502") ||
      message.includes("500")
    ) {
      return true;
    }

    return false;
  }

  describeError(error: unknown): string {
    const status = Number(
      (error as any).status ??
      (error as any).statusCode ??
      (error as any).response?.status,
    );
    if (Number.isInteger(status) && status > 0) {
      return `HTTP ${status}`;
    }
    const name = String((error as any).name || "");
    if (name === "TimeoutError") return "timeout";
    const message = String((error as any).message || error);
    return message.length > 60 ? `${message.slice(0, 60)}…` : message;
  }

  getConsecutiveFailures(provider?: string | null): number {
    const key = this.normalizeProvider(provider);
    return this.consecutiveFailures.get(key) || 0;
  }

  resetForTests(): void {
    this.consecutiveFailures.clear();
    this.cooldownUntil.clear();
    this.loggedTrip.clear();
  }

  setThresholdsForTests(maxFailures: number, cooldownMs: number): void {
    this.maxConsecutiveFailures = maxFailures;
    this.cooldownMs = cooldownMs;
  }
}

export const lyricsCircuitBreaker = new LyricsCircuitBreaker();

export function isLyricsCircuitOpen(provider?: string | null, now?: number): boolean {
  return lyricsCircuitBreaker.isOpen(provider, now);
}

export function recordLyricsSuccess(provider?: string | null): void {
  lyricsCircuitBreaker.recordSuccess(provider);
}

export function recordLyricsFailure(provider?: string | null, error?: unknown, now?: number): boolean {
  return lyricsCircuitBreaker.recordFailure(provider, error, now);
}

export function resetLyricsCircuitBreakerForTests(): void {
  lyricsCircuitBreaker.resetForTests();
}
