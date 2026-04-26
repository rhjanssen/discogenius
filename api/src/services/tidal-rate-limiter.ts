/**
 * TIDAL Rate Limiter — Adaptive concurrency and throttle control.
 *
 * Manages bounded-concurrency request slots and an adaptive per-slot
 * interval that backs off on 429s and recovers after sustained success.
 */

const RATE_LIMIT_MAX_DELAY_MS = 30_000;
const RATE_LIMIT_MIN_WAIT_MS = 20_000;
const RETRY_BACKOFF_FACTOR = 1.5;
export const RETRY_MAX_ATTEMPTS = 3;

const MIN_REQUEST_INTERVAL_MS = 100;
const BASE_REQUEST_INTERVAL_MS = 150;
const MAX_REQUEST_INTERVAL_MS = 3000;
const BACKOFF_MULTIPLIER = 1.5;
const RECOVERY_RATE = 0.95;
const REQUESTS_BEFORE_RECOVERY = 10;
const RATE_LIMIT_HISTORY_SIZE = 50;

let currentRequestInterval = BASE_REQUEST_INTERVAL_MS;
let lastRequestTime = 0;
let consecutiveSuccesses = 0;
let rateLimitUntil = 0;
const recentRequests: { timestamp: number; was429: boolean }[] = [];

const REQUEST_MAX_CONCURRENT = 3;
let activeRequests = 0;
const requestQueue: Array<() => void> = [];

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Adaptive tracking ────────────────────────────────────────────────

export function recordRequest(was429: boolean) {
    const now = Date.now();
    recentRequests.push({ timestamp: now, was429 });

    while (recentRequests.length > RATE_LIMIT_HISTORY_SIZE) {
        recentRequests.shift();
    }

    if (was429) {
        consecutiveSuccesses = 0;
        const oldInterval = currentRequestInterval;
        currentRequestInterval = Math.min(
            currentRequestInterval * BACKOFF_MULTIPLIER,
            MAX_REQUEST_INTERVAL_MS,
        );
        if (currentRequestInterval > oldInterval) {
            console.log(`[TidalAPI] Rate limit hit — increasing request interval: ${oldInterval}ms → ${Math.round(currentRequestInterval)}ms`);
        }
    } else {
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= REQUESTS_BEFORE_RECOVERY && currentRequestInterval > MIN_REQUEST_INTERVAL_MS) {
            const oldInterval = currentRequestInterval;
            currentRequestInterval = Math.max(
                currentRequestInterval * RECOVERY_RATE,
                MIN_REQUEST_INTERVAL_MS,
            );
            if (oldInterval - currentRequestInterval > 10) {
                console.log(`[TidalAPI] Stable requests — decreasing interval: ${Math.round(oldInterval)}ms → ${Math.round(currentRequestInterval)}ms`);
            }
        }
    }
}

export function getRateLimitMetrics() {
    const recent429s = recentRequests.filter(r => r.was429).length;
    const total = recentRequests.length;
    return {
        currentIntervalMs: Math.round(currentRequestInterval),
        consecutiveSuccesses,
        recent429Rate: total > 0 ? (recent429s / total * 100).toFixed(1) + '%' : '0%',
        rateLimitUntil: rateLimitUntil > Date.now() ? new Date(rateLimitUntil).toISOString() : null,
    };
}

// ── Slot management ──────────────────────────────────────────────────

async function waitForRequestSlot(context: string) {
    const now = Date.now();

    if (now < rateLimitUntil) {
        const waitMs = rateLimitUntil - now;
        console.warn(`[TidalAPI] Rate limit active, waiting ${Math.ceil(waitMs)}ms before ${context}`);
        await sleep(waitMs);
    }

    const timeSinceLastRequest = Date.now() - lastRequestTime;
    if (timeSinceLastRequest < currentRequestInterval) {
        const waitMs = currentRequestInterval - timeSinceLastRequest;
        if (waitMs > 1000) {
            console.log(`[TidalAPI] Pacing requests, waiting ${Math.ceil(waitMs)}ms before ${context}`);
        }
        await sleep(waitMs);
    }

    lastRequestTime = Date.now();
}

export async function acquireRequestSlot(context: string) {
    await waitForRequestSlot(context);
    await new Promise<void>((resolve) => {
        const tryAcquire = () => {
            if (activeRequests < REQUEST_MAX_CONCURRENT) {
                activeRequests += 1;
                resolve();
            } else {
                requestQueue.push(tryAcquire);
            }
        };
        tryAcquire();
    });
}

export function releaseRequestSlot() {
    activeRequests = Math.max(0, activeRequests - 1);
    const next = requestQueue.shift();
    if (next) next();
}

// ── Retry-after parsing ──────────────────────────────────────────────

export function parseRetryAfterMs(response: Response): number | null {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds)) {
            return Math.max(seconds * 1000, 0);
        }
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs)) {
            return Math.max(dateMs - Date.now(), 0);
        }
    }

    const reset = response.headers.get('x-ratelimit-reset');
    if (reset) {
        const resetValue = Number(reset);
        if (!Number.isNaN(resetValue)) {
            const resetMs = resetValue > 1e12
                ? resetValue
                : resetValue > 1e10
                    ? resetValue * 1000
                    : Date.now() + (resetValue * 1000);
            return Math.max(resetMs - Date.now(), 0);
        }
    }

    return null;
}

// ── Rate-limited fetch ───────────────────────────────────────────────

export async function tidalFetchWithRetry(
    url: string,
    options: RequestInit,
    context: string,
    maxRetries: number = RETRY_MAX_ATTEMPTS,
): Promise<Response> {
    let lastResponse: Response | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await acquireRequestSlot(context);
        let response: Response;
        try {
            response = await fetch(url, options);
        } finally {
            releaseRequestSlot();
        }
        lastResponse = response;

        const isRateLimit = response.status === 429;
        const isServerError = response.status >= 500 && response.status < 600;

        recordRequest(isRateLimit);

        if (isRateLimit) {
            const retryAfterMs = parseRetryAfterMs(response);
            const baseDelay = retryAfterMs ?? RATE_LIMIT_MIN_WAIT_MS;
            const waitMs = Math.max(baseDelay, RATE_LIMIT_MIN_WAIT_MS);
            const willRetry = attempt < maxRetries;

            rateLimitUntil = Math.max(rateLimitUntil, Date.now() + waitMs);
            console.warn(`[TidalAPI] 429 Too Many Requests for ${context} — ${willRetry ? `retry ${attempt}/${maxRetries} in ${Math.ceil(waitMs)}ms` : `giving up after ${maxRetries} attempts`}`);

            if (willRetry) {
                await sleep(waitMs);
                continue;
            }
        } else if (isServerError) {
            const waitSeconds = Math.pow(RETRY_BACKOFF_FACTOR, attempt);
            const waitMs = Math.min(waitSeconds * 1000, RATE_LIMIT_MAX_DELAY_MS);
            const willRetry = attempt < maxRetries;
            console.warn(`[TidalAPI] ${response.status} ${response.statusText} for ${context} — ${willRetry ? `retry ${attempt}/${maxRetries} in ${Math.ceil(waitMs)}ms` : `giving up after ${maxRetries} attempts`}`);

            if (willRetry) {
                await sleep(waitMs);
                continue;
            }
        }

        return response;
    }

    return lastResponse as Response;
}
