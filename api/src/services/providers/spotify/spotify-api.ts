import type { SpotifyAuthStore, SpotifyCredentials } from "./spotify-auth.js";
import { spotifyAuthStore } from "./spotify-auth.js";

export const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_TOKEN_TIMEOUT_MS = 10_000;

export interface SpotifyFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type SpotifyFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<SpotifyFetchResponse>;

export interface SpotifyApiClient {
  request<T>(endpoint: string): Promise<T>;
}

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

export class SpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SpotifyApiError";
  }
}

function resolveFetch(fetchImpl?: SpotifyFetchLike): SpotifyFetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as SpotifyFetchLike;
  throw new Error("No fetch implementation available for Spotify Web API");
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === "string" && nested) return nested;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
    if (typeof record.error_description === "string" && record.error_description) {
      return record.error_description;
    }
  }
  return fallback;
}

export class SpotifyApi implements SpotifyApiClient {
  private readonly fetchImpl: SpotifyFetchLike;
  private readonly authStore: SpotifyAuthStore;
  private readonly now: () => number;
  private readonly tokenTimeoutMs: number;
  private token: CachedAccessToken | null = null;

  constructor(options: {
    fetchImpl?: SpotifyFetchLike;
    authStore?: SpotifyAuthStore;
    now?: () => number;
    tokenTimeoutMs?: number;
  } = {}) {
    this.fetchImpl = resolveFetch(options.fetchImpl);
    this.authStore = options.authStore ?? spotifyAuthStore;
    this.now = options.now ?? Date.now;
    this.tokenTimeoutMs = Number.isFinite(options.tokenTimeoutMs)
      ? Math.max(1, Math.min(60_000, Math.trunc(Number(options.tokenTimeoutMs))))
      : SPOTIFY_TOKEN_TIMEOUT_MS;
  }

  tokenSnapshot(): { present: boolean; expiresAt: number | null } {
    return { present: Boolean(this.token), expiresAt: this.token?.expiresAt ?? null };
  }

  clearAccessToken(): void {
    this.token = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const credentials = this.authStore.load();
    if (!credentials) throw new SpotifyApiError(401, "Spotify client credentials are not configured");
    return this.requestAccessToken(credentials);
  }

  private async requestAccessToken(credentials: SpotifyCredentials): Promise<string> {
    const encoded = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, "utf8").toString("base64");
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new SpotifyApiError(504, `Spotify token request timed out after ${this.tokenTimeoutMs}ms`));
      }, this.tokenTimeoutMs);
    });

    let response: SpotifyFetchResponse;
    let payload: Record<string, unknown>;
    try {
      ({ response, payload } = await Promise.race([this.fetchToken(encoded, controller.signal), timeout]));
    } catch (error) {
      if (error instanceof SpotifyApiError) throw error;
      if (controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        throw new SpotifyApiError(504, `Spotify token request timed out after ${this.tokenTimeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (!response.ok) {
      throw new SpotifyApiError(
        response.status,
        apiErrorMessage(payload, `Spotify token request failed (${response.status})`),
      );
    }
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    const expiresIn = Number(payload.expires_in);
    if (!accessToken) throw new SpotifyApiError(502, "Spotify token response did not include access_token");
    // Refresh slightly early so a token cannot expire midway through a page walk.
    const usableLifetimeMs = Math.max(1, Number.isFinite(expiresIn) ? expiresIn - 30 : 3300) * 1000;
    this.token = { value: accessToken, expiresAt: this.now() + usableLifetimeMs };
    return accessToken;
  }

  private async fetchToken(
    encodedCredentials: string,
    signal: AbortSignal,
  ): Promise<{ response: SpotifyFetchResponse; payload: Record<string, unknown> }> {
    const response = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${encodedCredentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, payload };
  }

  async request<T>(endpoint: string): Promise<T> {
    let token = await this.getAccessToken();
    let response = await this.fetchCatalog(endpoint, token);
    if (response.status === 401) {
      this.clearAccessToken();
      token = await this.getAccessToken();
      response = await this.fetchCatalog(endpoint, token);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const retryAfterRaw = response.headers?.get("retry-after");
      const retryAfter = retryAfterRaw == null ? undefined : Number(retryAfterRaw);
      throw new SpotifyApiError(
        response.status,
        apiErrorMessage(payload, `Spotify API request failed (${response.status}) for ${endpoint}`),
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    return payload as T;
  }

  private fetchCatalog(endpoint: string, token: string) {
    const candidate = /^https?:\/\//iu.test(endpoint)
      ? endpoint
      : `${SPOTIFY_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const url = new URL(candidate);
    const apiBase = new URL(SPOTIFY_API_BASE);
    if (url.protocol !== "https:" || url.origin !== apiBase.origin || !/^\/v1(?:\/|$)/u.test(url.pathname)) {
      throw new SpotifyApiError(400, "Spotify pagination URL must stay on the official Web API.");
    }
    return this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  }
}
