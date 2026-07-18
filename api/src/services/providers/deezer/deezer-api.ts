export const DEEZER_API_BASE = "https://api.deezer.com";

export interface DeezerApiErrorShape {
  error?: { type?: string; message?: string; code?: number };
}

export interface DeezerPage<T> extends DeezerApiErrorShape {
  data?: T[];
  next?: string;
  total?: number;
}

export type DeezerFetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class DeezerApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeezerApiError";
  }
}

function resolveFetch(fetchImpl?: DeezerFetchLike): DeezerFetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as DeezerFetchLike;
  throw new Error("No fetch implementation is available for Deezer.");
}

function endpointUrl(endpoint: string): string {
  const resolved = new URL(endpoint, `${DEEZER_API_BASE}/`);
  const allowedOrigin = new URL(DEEZER_API_BASE).origin;
  if (resolved.protocol !== "https:" || resolved.origin !== allowedOrigin) {
    throw new DeezerApiError(400, "Deezer pagination URL must stay on api.deezer.com.");
  }
  return resolved.toString();
}

// Deezer's public API caps unauthenticated callers at ~50 requests / 5s and
// answers overflow with `{ error: { code: 4, message: "Quota limit exceeded" } }`.
// A bulk artist refresh (one tracklist fetch per album) blows straight through
// that, so real-API calls are serialized and spaced (~8 req/s) with a bounded
// backoff-retry on quota. Injected fetch implementations (tests, or a caller
// that manages its own pacing) bypass this entirely.
const MIN_REQUEST_INTERVAL_MS = 120;
const MAX_QUOTA_RETRIES = 4;
let requestChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttleGlobalRequest(): Promise<void> {
  const scheduled = requestChain.then(async () => {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();
  });
  requestChain = scheduled.catch(() => undefined);
  return scheduled;
}

export function isDeezerQuotaError(payload: DeezerApiErrorShape | undefined, status: number): boolean {
  return status === 429
    || payload?.error?.code === 4
    || /quota/i.test(payload?.error?.message || "");
}

export async function deezerApiRequest<T>(
  endpoint: string,
  fetchImpl?: DeezerFetchLike,
  attempt = 0,
): Promise<T> {
  const usingGlobalFetch = !fetchImpl;
  if (usingGlobalFetch) {
    await throttleGlobalRequest();
  }
  const response = await resolveFetch(fetchImpl)(endpointUrl(endpoint), {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json() as T & DeezerApiErrorShape;
  if (!response.ok || payload?.error) {
    if (usingGlobalFetch && isDeezerQuotaError(payload, response.status) && attempt < MAX_QUOTA_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      return deezerApiRequest<T>(endpoint, fetchImpl, attempt + 1);
    }
    const message = payload?.error?.message || `Deezer API request failed (${response.status}).`;
    throw new DeezerApiError(response.status || payload?.error?.code || 500, message);
  }
  return payload;
}

/** Follow Deezer's absolute `next` links with an explicit safety cap. */
export async function deezerApiAllPages<T>(
  endpoint: string,
  fetchImpl?: DeezerFetchLike,
  maximumPages = 20,
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = endpoint;
  for (let page = 0; next && page < maximumPages; page += 1) {
    const response: DeezerPage<T> = await deezerApiRequest<DeezerPage<T>>(next, fetchImpl);
    items.push(...(response.data || []));
    next = response.next;
  }
  return items;
}
