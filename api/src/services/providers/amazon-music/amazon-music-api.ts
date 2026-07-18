import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  isPrivateAmazonMusicApiBaseAllowed,
  isPublicAmazonMusicNetworkAddress,
  loadAmazonMusicCredentials,
  normalizeAmazonMusicApiBase,
  type AmazonMusicCredentials,
} from "./amazon-music-auth.js";

export const AMAZON_MUSIC_API_TIMEOUT_MS = 10_000;

export type AmazonMusicFetchLike = (
  input: string,
  init?: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type AmazonMusicHostnameResolver = (hostname: string) => Promise<readonly string[]>;

export interface AmazonMusicApiOptions {
  fetchImpl?: AmazonMusicFetchLike;
  credentials?: AmazonMusicCredentials | null;
  resolveHostname?: AmazonMusicHostnameResolver;
  timeoutMs?: number;
}

export class AmazonMusicApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AmazonMusicApiError";
  }
}

function resolveFetch(fetchImpl?: AmazonMusicFetchLike): AmazonMusicFetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as AmazonMusicFetchLike;
  throw new Error("No fetch implementation is available for Amazon Music.");
}

function requestTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return AMAZON_MUSIC_API_TIMEOUT_MS;
  return Math.max(1, Math.min(60_000, Math.trunc(Number(value))));
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function assertResolvedHostIsAllowed(
  apiBase: string,
  options: AmazonMusicApiOptions,
): Promise<void> {
  const hostname = new URL(apiBase).hostname.replace(/^\[|\]$/gu, "").replace(/%.+$/u, "");
  if (isIP(hostname)) return;

  // An injected fetch implementation is an in-process test seam and cannot
  // issue the native request. Production requests always resolve and inspect
  // every address immediately before sending the bearer token.
  if (options.fetchImpl && !options.resolveHostname) return;

  let addresses: readonly string[];
  try {
    addresses = await (options.resolveHostname || defaultResolveHostname)(hostname);
  } catch {
    throw new AmazonMusicApiError(400, "Amazon Music API base host could not be resolved safely.");
  }
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw new AmazonMusicApiError(400, "Amazon Music API base host did not resolve to a valid network address.");
  }
  if (addresses.some((address) => !isPublicAmazonMusicNetworkAddress(address))
    && !isPrivateAmazonMusicApiBaseAllowed()) {
    throw new AmazonMusicApiError(400, "Amazon Music API base resolved to a private or non-public network address.");
  }
}

function safeRouteUrl(route: string, apiBase: string): URL {
  const baseUrl = new URL(`${apiBase}/`);
  const url = new URL(String(route || "").replace(/^\/+/u, ""), baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new AmazonMusicApiError(400, "Amazon Music API route must stay on the configured API host.");
  }
  return url;
}

export async function amazonMusicApiRequest<T>(
  route: string,
  params: Record<string, string | number | undefined> = {},
  options: AmazonMusicApiOptions = {},
): Promise<T> {
  const credentials = options.credentials ?? loadAmazonMusicCredentials();
  if (!credentials) throw new AmazonMusicApiError(401, "Amazon Music API token is required.");
  const apiBase = normalizeAmazonMusicApiBase(credentials.apiBase);
  const url = safeRouteUrl(route, apiBase);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeoutMs = requestTimeoutMs(options.timeoutMs);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new AmazonMusicApiError(504, `Amazon Music API request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([assertResolvedHostIsAllowed(apiBase, options), timeout]);
    const response = await Promise.race([
      resolveFetch(options.fetchImpl)(url.toString(), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.accessToken}`,
        },
        redirect: "error",
        signal: controller.signal,
      }),
      timeout,
    ]);
    const payload = await Promise.race([response.json(), timeout]) as any;
    if (!response.ok || payload?.success === false) {
      const message = String(payload?.message || payload?.detail || payload?.error || `Amazon Music API request failed (${response.status}).`);
      throw new AmazonMusicApiError(response.status, message);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof AmazonMusicApiError) throw error;
    if (controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new AmazonMusicApiError(504, `Amazon Music API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function unwrapAmazonData<T = any>(payload: any): T {
  if (payload && typeof payload === "object" && "data" in payload) return payload.data as T;
  return payload as T;
}

export async function validateAmazonMusicCredentials(
  credentials: AmazonMusicCredentials,
  options: AmazonMusicApiOptions = {},
): Promise<void> {
  await amazonMusicApiRequest("account", {}, { ...options, credentials });
}
