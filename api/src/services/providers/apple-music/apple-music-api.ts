import {
  APPLE_MUSIC_API_BASE,
  AppleMusicAuthToken,
  buildAppleMusicApiHeaders,
  loadStoredAppleMusicToken,
  resolveAppleStorefront,
} from "./apple-music-auth.js";
import { ProviderRateLimitError, ProviderRequestState, providerRequestState } from "../provider-request-state.js";

/**
 * Thin Apple Music API client. The fetch implementation is injectable so the
 * adapter can be exercised against recorded fixtures without live network
 * (see apple-music-provider.test.ts).
 */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Present on real Response; fixtures may omit and return JSON only. */
  text?(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export interface AppleMusicApiOptions {
  fetchImpl?: FetchLike;
  token?: AppleMusicAuthToken | null;
  requestState?: ProviderRequestState;
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
  const state = options.requestState ?? providerRequestState();
  const retryAt = state.retryAt("apple-music");
  if (retryAt > Date.now()) throw new ProviderRateLimitError("apple-music", retryAt);
  const url = endpoint.startsWith("http") ? endpoint : `${APPLE_MUSIC_API_BASE}${endpoint}`;
  const response = await doFetch(url, { headers: await buildAppleMusicApiHeaders(token), signal: AbortSignal.timeout(30_000) });
  if (response.status === 429) {
    const now = Date.now();
    const header = response.headers?.get("retry-after")?.trim();
    const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
    const date = header ? Date.parse(header) : NaN;
    const deadline = Number.isFinite(seconds) ? now + Math.max(1, seconds) * 1000 : date > now ? date : now + 60_000;
    throw new ProviderRateLimitError("apple-music", state.defer("apple-music", deadline));
  }
  if (!response.ok) {
    throw new AppleMusicApiError(response.status, `Apple Music API request failed (${response.status}) for ${endpoint}`);
  }
  return (await response.json()) as T;
}

export async function validateAppleMusicCredentials(
  token: AppleMusicAuthToken,
  options: Omit<AppleMusicApiOptions, "token"> = {},
): Promise<{ storefront?: string }> {
  const response = await appleMusicApiRequest<{ data?: Array<{ id?: string }> }>(
    "/v1/me/storefront",
    { ...options, token },
  );
  const storefront = response.data?.[0]?.id;
  return { storefront };
}

/** Resolve the storefront for catalog endpoints (token-scoped, else env default). */
export function storefrontFor(token?: AppleMusicAuthToken | null): string {
  return token?.storefront || loadStoredAppleMusicToken()?.storefront || resolveAppleStorefront();
}
