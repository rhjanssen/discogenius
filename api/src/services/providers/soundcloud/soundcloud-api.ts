import {
  loadSoundCloudCredentials,
  SOUNDCLOUD_DEFAULT_CLIENT_ID,
  updateSoundCloudUserId,
  type SoundCloudCredentials,
} from "./soundcloud-auth.js";

export const SOUNDCLOUD_API_BASE = "https://api-v2.soundcloud.com";

export interface SoundCloudCollectionPage<T> {
  collection?: T[];
  next_href?: string | null;
}

export interface SoundCloudUserResource {
  id?: number | string;
  urn?: string;
  username?: string;
  full_name?: string;
  permalink_url?: string;
  avatar_url?: string;
  followers_count?: number;
  track_count?: number;
  description?: string;
  kind?: string;
  consumer_subscription?: { product?: { id?: string } };
}

export interface SoundCloudTranscoding {
  url?: string;
  preset?: string;
  duration?: number;
  snipped?: boolean;
  quality?: string;
  format?: { protocol?: string; mime_type?: string };
}

export interface SoundCloudTrackResource {
  id?: number | string;
  urn?: string;
  title?: string;
  permalink_url?: string;
  artwork_url?: string;
  duration?: number;
  release_date?: string;
  display_date?: string;
  created_at?: string;
  genre?: string;
  tag_list?: string;
  downloadable?: boolean;
  has_downloads_left?: boolean;
  download_url?: string | null;
  policy?: string;
  kind?: string;
  user?: SoundCloudUserResource;
  publisher_metadata?: {
    isrc?: string | null;
    upc_or_ean?: string | null;
    artist?: string | null;
    album_title?: string | null;
    release_title?: string | null;
  } | null;
  media?: { transcodings?: SoundCloudTranscoding[] };
  streamable?: boolean;
}

export interface SoundCloudPlaylistResource {
  id?: number | string;
  urn?: string;
  title?: string;
  permalink_url?: string;
  artwork_url?: string;
  duration?: number;
  track_count?: number;
  release_date?: string;
  display_date?: string;
  created_at?: string;
  genre?: string;
  is_album?: boolean;
  set_type?: string;
  kind?: string;
  user?: SoundCloudUserResource;
  tracks?: SoundCloudTrackResource[];
  publisher_metadata?: {
    upc_or_ean?: string | null;
    artist?: string | null;
  } | null;
}

export type SoundCloudFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export class SoundCloudApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SoundCloudApiError";
  }
}

function resolveFetch(fetchImpl?: SoundCloudFetchLike): SoundCloudFetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as SoundCloudFetchLike;
  throw new Error("No fetch implementation is available for SoundCloud.");
}

function resourceId(value: unknown): string {
  if (value == null) return "";
  const raw = String(value).trim();
  const urnMatch = /^soundcloud:(?:tracks|users|playlists):(\d+)$/iu.exec(raw);
  return urnMatch?.[1] || raw;
}

export function soundcloudResourceId(value: unknown): string {
  return resourceId(value);
}

function endpointUrl(endpoint: string, credentials: SoundCloudCredentials): string {
  const resolved = new URL(endpoint, `${SOUNDCLOUD_API_BASE}/`);
  const allowedHosts = new Set(["api-v2.soundcloud.com", "api.soundcloud.com", "api-auth.soundcloud.com"]);
  if (resolved.protocol !== "https:" || !allowedHosts.has(resolved.hostname)) {
    throw new SoundCloudApiError(400, "SoundCloud request URL must stay on SoundCloud API hosts.");
  }
  if (!resolved.searchParams.has("client_id")) {
    resolved.searchParams.set("client_id", credentials.clientId || SOUNDCLOUD_DEFAULT_CLIENT_ID);
  }
  return resolved.toString();
}

export async function soundcloudApiRequest<T>(
  endpoint: string,
  options: {
    credentials?: SoundCloudCredentials | null;
    fetchImpl?: SoundCloudFetchLike;
    method?: string;
    body?: unknown;
    requireAuth?: boolean;
  } = {},
): Promise<T> {
  const credentials = options.credentials === undefined
    ? loadSoundCloudCredentials()
    : options.credentials;
  const requireAuth = options.requireAuth !== false;
  if (requireAuth && !credentials?.oauthToken) {
    throw new SoundCloudApiError(401, "SoundCloud oauthToken is not configured.");
  }
  const effectiveCredentials: SoundCloudCredentials = credentials || {
    clientId: SOUNDCLOUD_DEFAULT_CLIENT_ID,
    oauthToken: "",
  };
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; Discogenius/1.0)",
  };
  if (effectiveCredentials.oauthToken) {
    headers.Authorization = `OAuth ${effectiveCredentials.oauthToken}`;
  }
  if (options.body != null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await resolveFetch(options.fetchImpl)(endpointUrl(endpoint, effectiveCredentials), {
    method: options.method || "GET",
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 240);
    } catch {
      detail = "";
    }
    throw new SoundCloudApiError(
      response.status,
      `SoundCloud API request failed (${response.status})${detail ? `: ${detail}` : ""}.`,
    );
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function soundcloudApiAllPages<T>(
  endpoint: string,
  options: {
    credentials?: SoundCloudCredentials | null;
    fetchImpl?: SoundCloudFetchLike;
    maxPages?: number;
  } = {},
): Promise<T[]> {
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const items: T[] = [];
  let next: string | null = endpoint;
  for (let page = 0; page < maxPages && next; page += 1) {
    const payload: SoundCloudCollectionPage<T> = await soundcloudApiRequest<SoundCloudCollectionPage<T>>(next, {
      credentials: options.credentials,
      fetchImpl: options.fetchImpl,
    });
    items.push(...(payload.collection || []));
    next = payload.next_href || null;
  }
  return items;
}

export async function soundcloudGetMe(
  options: { credentials?: SoundCloudCredentials | null; fetchImpl?: SoundCloudFetchLike } = {},
): Promise<SoundCloudUserResource> {
  const me = await soundcloudApiRequest<SoundCloudUserResource>("/me", options);
  const userId = resourceId(me.id);
  if (userId) updateSoundCloudUserId(userId);
  return me;
}

export function pickPlayableTranscoding(
  track: SoundCloudTrackResource,
  options: { allowSnipped?: boolean } = {},
): SoundCloudTranscoding | null {
  const allowSnipped = options.allowSnipped === true;
  const transcodings = track.media?.transcodings || [];
  const usable = transcodings.filter((item) => {
    if (!item?.url) return false;
    if (item.snipped && !allowSnipped) return false;
    const protocol = String(item.format?.protocol || "").toLowerCase();
    // Encrypted HLS needs a DRM license path we do not implement yet.
    if (protocol.includes("encrypted")) return false;
    return protocol === "progressive" || protocol === "hls";
  });
  const rank = (item: SoundCloudTranscoding): number => {
    const protocol = String(item.format?.protocol || "").toLowerCase();
    const snippedPenalty = item.snipped ? 10 : 0;
    if (protocol === "progressive") return 0 + snippedPenalty;
    if (protocol === "hls" && /mpeg/i.test(item.format?.mime_type || "")) return 1 + snippedPenalty;
    if (protocol === "hls") return 2 + snippedPenalty;
    return 50 + snippedPenalty;
  };
  return [...usable].sort((left, right) =>
    rank(left) - rank(right)
    || String(left.preset || "").localeCompare(String(right.preset || "")))[0] || null;
}

export function listPlayableTranscodings(
  track: SoundCloudTrackResource,
  options: { allowSnipped?: boolean } = {},
): SoundCloudTranscoding[] {
  const allowSnipped = options.allowSnipped === true;
  const transcodings = track.media?.transcodings || [];
  const usable = transcodings.filter((item) => {
    if (!item?.url) return false;
    if (item.snipped && !allowSnipped) return false;
    const protocol = String(item.format?.protocol || "").toLowerCase();
    if (protocol.includes("encrypted")) return false;
    return protocol === "progressive" || protocol === "hls";
  });
  const rank = (item: SoundCloudTranscoding): number => {
    const protocol = String(item.format?.protocol || "").toLowerCase();
    const snippedPenalty = item.snipped ? 10 : 0;
    if (protocol === "progressive") return 0 + snippedPenalty;
    if (protocol === "hls" && /mpeg/i.test(item.format?.mime_type || "")) return 1 + snippedPenalty;
    if (protocol === "hls") return 2 + snippedPenalty;
    return 50 + snippedPenalty;
  };
  return [...usable].sort((left, right) =>
    rank(left) - rank(right)
    || String(left.preset || "").localeCompare(String(right.preset || "")));
}

export async function resolveSoundCloudMediaUrl(
  track: SoundCloudTrackResource,
  options: {
    credentials?: SoundCloudCredentials | null;
    fetchImpl?: SoundCloudFetchLike;
    allowSnipped?: boolean;
  } = {},
): Promise<{ url: string; protocol: string; mimeType: string; snipped: boolean } | null> {
  // Prefer progressive, then plain HLS. Skip dead legacy media endpoints by
  // trying the next candidate on 404 (post-2025 MP3 HLS often 404s while SNIP
  // progressive previews still resolve).
  const candidates = listPlayableTranscodings(track, { allowSnipped: options.allowSnipped });
  for (const transcoding of candidates) {
    if (!transcoding.url) continue;
    try {
      const resolved = await soundcloudApiRequest<{ url?: string }>(transcoding.url, {
        credentials: options.credentials,
        fetchImpl: options.fetchImpl,
      });
      const url = String(resolved.url || "").trim();
      if (!url) continue;
      return {
        url,
        protocol: String(transcoding.format?.protocol || "progressive"),
        mimeType: String(transcoding.format?.mime_type || "audio/mpeg"),
        snipped: Boolean(transcoding.snipped),
      };
    } catch (error) {
      if (error instanceof SoundCloudApiError && (error.status === 404 || error.status === 403)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}
