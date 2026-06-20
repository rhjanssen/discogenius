import {
  APPLE_MUSIC_API_BASE,
  AppleMusicAuthToken,
  buildAppleMusicApiHeaders,
  loadStoredAppleMusicToken,
  resolveAppleStorefront,
} from "./apple-music-auth.js";

/**
 * Thin Apple Music API client. The fetch implementation is injectable so the
 * adapter can be exercised against recorded fixtures without live network
 * (see apple-music-provider.test.ts).
 */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface AppleMusicApiOptions {
  fetchImpl?: FetchLike;
  token?: AppleMusicAuthToken | null;
}

export class AppleMusicApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AppleMusicApiError";
  }
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") {
    return fetch as unknown as FetchLike;
  }
  throw new Error("No fetch implementation available for Apple Music API");
}

export async function appleMusicApiRequest<T = unknown>(
  endpoint: string,
  options: AppleMusicApiOptions = {},
): Promise<T> {
  const token = options.token ?? loadStoredAppleMusicToken();
  if (!token) {
    throw new AppleMusicApiError(401, "Apple Music is not authenticated");
  }
  const doFetch = resolveFetch(options.fetchImpl);
  const url = endpoint.startsWith("http") ? endpoint : `${APPLE_MUSIC_API_BASE}${endpoint}`;
  const response = await doFetch(url, { headers: buildAppleMusicApiHeaders(token) });
  if (!response.ok) {
    throw new AppleMusicApiError(response.status, `Apple Music API request failed (${response.status}) for ${endpoint}`);
  }
  return (await response.json()) as T;
}

/** Resolve the storefront for catalog endpoints (token-scoped, else env default). */
export function storefrontFor(token?: AppleMusicAuthToken | null): string {
  return token?.storefront || resolveAppleStorefront();
}
