import fs from "fs";
import path from "path";
import { updateConfig, Config } from "./config.js";
import {
  loadStoredTidalToken,
  saveStoredTidalToken,
  clearStoredTidalToken,
  refreshStoredTidalToken,
} from "./tidal-auth.js";
import { tidalFetchWithRetry } from "./tidal-rate-limiter.js";
export { getRateLimitMetrics } from "./tidal-rate-limiter.js";

const TIDAL_API_BASE = "https://api.tidal.com/v1";
const TIDAL_HIFI_BASE = "https://api.tidalhifi.com/v1";
const TIDAL_AUTH_BASE = "https://auth.tidal.com/v1/oauth2";
const TIDAL_CLIENT_TOKEN = "wdgaB1CilGA-S_sj"; // Public client token used by TIDAL web clients

// tidal-dl-ng credentials (base64 decoded: client_id;client_secret)
const TIDAL_DL_NG_CREDENTIALS = Buffer.from(
  "ZlgySnhkbW50WldLMGl4VDsxTm45QWZEQWp4cmdKRkpiS05XTGVBeUtHVkdtSU51WFBQTEhWWEF2eEFnPQ==",
  "base64"
).toString();
const [CLIENT_ID, CLIENT_SECRET] = TIDAL_DL_NG_CREDENTIALS.split(";");

export interface TidalToken {
  access_token: string;
  refresh_token: string;
  client_name?: string;
  token_type?: string;
  expires_in?: number;
  expiry_time?: number;
  expires_at?: number; // Unix timestamp when token expires (calculated)
  scope?: string;
  user?: {
    userId: number;
    email?: string;
    countryCode: string;
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    nickname: string | null;
    username: string;
    picture?: string | null;
  };
}

export interface TidalTextMeta {
  text: string | null;
  source: string | null;
  lastUpdated: string | number | null;
}

// Helper readAuthFile removed

// Helper to extract expiry from JWT token
function getJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return decoded.exp;
  } catch (e) {
    return undefined;
  }
}

export function loadToken(): TidalToken | null {
  const token = loadStoredTidalToken();
  if (!token) return null;

  const user = token.user ? {
    userId: token.user.userId,
    email: token.user.email,
    countryCode: token.user.countryCode,
    fullName: token.user.fullName ?? null,
    firstName: token.user.firstName ?? null,
    lastName: token.user.lastName ?? null,
    nickname: token.user.nickname ?? null,
    username: token.user.username,
    picture: token.user.picture ?? null,
  } : undefined;

  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expires_at: token.expires_at || getJwtExpiry(token.access_token),
    user,
  };
}

export function saveToken(token: TidalToken) {
  saveStoredTidalToken(token);
}

let lastRefreshAttempt = 0;
const REFRESH_COOLDOWN_MS = 60_000;

let lastUserInfoCache: any = null;
let lastUserInfoFetchedAt = 0;
const USERINFO_CACHE_MS = 5 * 60_000;

function normalizeTidalDate(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isNaN(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
  }

  return raw;
}

function extractTidalTextMeta(data: any): TidalTextMeta {
  if (typeof data === "string") {
    return { text: data, source: null, lastUpdated: null };
  }

  const text = data?.text ?? data?.bio ?? data?.review ?? null;
  const source =
    data?.source ??
    data?.sourceName ??
    data?.provider ??
    null;
  const lastUpdatedRaw =
    data?.lastUpdated ??
    data?.last_updated ??
    data?.updated ??
    data?.lastUpdate ??
    data?.lastUpdatedAt ??
    data?.date ??
    null;

  return {
    text: text ?? null,
    source: source ?? null,
    lastUpdated: normalizeTidalDate(lastUpdatedRaw),
  };
}

/**
 * Extract quality from mediaMetadata.tags
 * 
 * Tidal API returns exactly three possible tags: LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS
 * When multiple tags are present (e.g., ["LOSSLESS", "HIRES_LOSSLESS"]), return the highest quality.
 * 
 * Priority: DOLBY_ATMOS > HIRES_LOSSLESS > LOSSLESS
 */
function deriveQuality(item: any): string {
  const tags: string[] = item?.mediaMetadata?.tags || [];

  // Priority order - return first match (highest quality)
  if (tags.includes('DOLBY_ATMOS')) return 'DOLBY_ATMOS';
  if (tags.includes('HIRES_LOSSLESS')) return 'HIRES_LOSSLESS';
  if (tags.includes('LOSSLESS')) return 'LOSSLESS';

  // Fallback if no tags (shouldn't happen with valid Tidal data)
  return 'LOSSLESS';
}

export async function getUserInfo(options?: { refreshOn401?: boolean }) {
  const refreshOn401 = options?.refreshOn401 !== false;
  const token = loadToken();
  if (!token) {
    return null;
  }

  // Return cached user info if recent
  if (lastUserInfoCache && Date.now() - lastUserInfoFetchedAt < USERINFO_CACHE_MS) {
    return lastUserInfoCache;
  }

  try {
    // First get session info for userId and countryCode
    let sessionResponse = await tidalFetchWithRetry(`${TIDAL_API_BASE}/sessions`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
    }, "sessions");

    // If token expired, refresh it through the provider-owned TIDAL auth flow.
    if (sessionResponse.status === 401 && refreshOn401) {
      // Avoid spamming refresh if we just tried
      if (Date.now() - lastRefreshAttempt < REFRESH_COOLDOWN_MS) {
        return token.user
          ? {
            userId: token.user.userId,
            username: token.user.username || "user",
            email: token.user.email,
            firstName: token.user.firstName,
            lastName: token.user.lastName,
            fullName: token.user.fullName,
            countryCode: token.user.countryCode,
            picture: null,
          }
          : null;
      }

      lastRefreshAttempt = Date.now();
      await refreshTidalToken(true);

      // Retry with new token
      const newToken = loadToken();
      if (newToken) {
        sessionResponse = await tidalFetchWithRetry(`${TIDAL_API_BASE}/sessions`, {
          headers: {
            Authorization: `Bearer ${newToken.access_token}`,
            "Content-Type": "application/json",
          },
        }, "sessions");
      } else {
        console.error('[getUserInfo] No token after refresh attempt');
        return null;
      }
    }

    if (!sessionResponse.ok) {
      // Network or other error: fall back to token data if available
      if (token.user) {
        const fallback = {
          userId: token.user.userId,
          username: token.user.username || "user",
          email: token.user.email,
          firstName: token.user.firstName,
          lastName: token.user.lastName,
          fullName: token.user.fullName,
          countryCode: token.user.countryCode,
          picture: token.user.picture || null,
          nickname: null
        };
        lastUserInfoCache = fallback;
        lastUserInfoFetchedAt = Date.now();
        return fallback;
      }
      return null;
    }

    const sessionData = await sessionResponse.json() as any;
    const userId = sessionData.userId;
    // Then fetch full user profile including picture
    const userResponse = await tidalFetchWithRetry(`${TIDAL_API_BASE}/users/${userId}`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
    }, `users/${userId}`);

    if (userResponse.ok) {
      const userData = await userResponse.json() as any;
      console.log('[getUserInfo] Raw userData:', JSON.stringify(userData, null, 2));

      // Get profile picture
      let pictureUrl = null;

      // 1. Check direct picture on user object (regular users)
      if (userData.picture) {
        const pictureId = userData.picture.replace(/-/g, "/");
        pictureUrl = `https://resources.tidal.com/images/${pictureId}/1280x1280.jpg`;
      }
      // 2. Fallback to artist profile if they have one
      else if (userData.artistId) {
        try {
          const artistData = await tidalApiRequest(`/artists/${userData.artistId}?countryCode=${sessionData.countryCode || 'US'}`) as any;
          if (artistData.picture) {
            const pictureId = artistData.picture.replace(/-/g, "/");
            pictureUrl = `https://resources.tidal.com/images/${pictureId}/1280x1280.jpg`;
          }
        } catch (error) {
          console.error('Error fetching artist profile picture:', error);
        }
      }

      const userInfo = {
        userId: userId,
        username: userData.username || token.user?.username || "user",
        email: userData.email || token.user?.email,
        firstName: userData.firstName || token.user?.firstName,
        lastName: userData.lastName || token.user?.lastName,
        fullName: userData.firstName && userData.lastName
          ? `${userData.firstName} ${userData.lastName}`
          : (token.user?.fullName || null),
        countryCode: sessionData.countryCode || token.user?.countryCode,
        picture: pictureUrl,
        nickname: null
      };
      console.log('[getUserInfo] Returning user info:', userInfo);

      // Update token file with fresh user info to persist it (only if changed)
      try {
        const hasChanged = JSON.stringify(token.user) !== JSON.stringify(userInfo);

        if (hasChanged) {
          const updatedToken = {
            ...token,
            user: userInfo
          };
          saveToken(updatedToken);
        } else {
          // console.log('[getUserInfo] User info unchanged, skipping save');
        }
      } catch (err) {
        console.error('[getUserInfo] Failed to save updated user info to token file:', err);
      }

      lastUserInfoCache = userInfo;
      lastUserInfoFetchedAt = Date.now();
      return userInfo;
    }

    // Fallback to session + token data if user endpoint fails
    console.log('[getUserInfo] User endpoint failed, using fallback data');
    const fallbackInfo = {
      userId: userId,
      username: sessionData.user?.username || token.user?.username || "user",
      email: token.user?.email,
      firstName: token.user?.firstName,
      lastName: token.user?.lastName,
      fullName: token.user?.fullName,
      countryCode: sessionData.countryCode || token.user?.countryCode,
      picture: token.user?.picture || null,
      nickname: null
    };
    console.log('[getUserInfo] Returning fallback info:', fallbackInfo);
    lastUserInfoCache = fallbackInfo;
    lastUserInfoFetchedAt = Date.now();
    return fallbackInfo;
  } catch (error) {
    console.error('[getUserInfo] Error occurred:', error);
    // Not logged in
  }

  return null;
}

export function logout() {
  try {
    clearStoredTidalToken();
    console.log("✅ [TIDAL] Logged out (cleared auth and user data)");
  } catch (e) {
    console.error("❌ [TIDAL] Error logging out:", e);
  }
}

// Token refresh threshold: 25 minutes (proactive refresh window)
const TOKEN_REFRESH_THRESHOLD = 25 * 60; // 25 minutes in seconds

/**
 * Check if Tidal token needs refresh based on expires_at timestamp
 * Returns true if:
 * - Token expires in less than TOKEN_REFRESH_THRESHOLD seconds (proactive refresh)
 * - Token is already expired (reactive refresh)
 * Uses Discogenius token-refresh policy (proactive before expiry)
 */
export function shouldRefreshToken(token: TidalToken | null): boolean {
  // If token is missing or has no expires_at, skip proactive refresh
  if (!token?.expires_at) {
    console.log('⏭️ [TOKEN] No expires_at found, skipping refresh');
    return false;
  }

  const expiresAt = token.expires_at;
  const nowInSeconds = Math.floor(Date.now() / 1000);

  // Refresh if token expires in less than TOKEN_REFRESH_THRESHOLD seconds
  // This covers both cases: already expired (negative value) and expiring soon
  const timeUntilExpiry = expiresAt - nowInSeconds;
  const hoursUntilExpiry = timeUntilExpiry / 3600;

  const needsRefresh = timeUntilExpiry < TOKEN_REFRESH_THRESHOLD;

  console.log(
    `🔍 [TOKEN] Token check: expires in ${hoursUntilExpiry.toFixed(1)}h (threshold: ${TOKEN_REFRESH_THRESHOLD / 3600}h) → ${needsRefresh ? "NEEDS REFRESH" : "still valid"}`
  );

  return needsRefresh;
}

/**
 * Base Tidal API request with auth handling
 */
export async function tidalApiRequest(endpoint: string): Promise<unknown> {
  const token = loadToken();
  if (!token) throw new Error("Not authenticated");

  const doFetch = async (accessToken: string) => {
    const url = `${TIDAL_API_BASE}${endpoint}`;
    console.log(`[TidalAPI] Requesting: ${url}`);
    const response = await tidalFetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-Tidal-Token": TIDAL_CLIENT_TOKEN,
      },
    }, url);
    console.log(`[TidalAPI] Response: ${response.status} ${response.statusText} for ${url}`);
    return response;
  };

  let response = await doFetch(token.access_token);

  if (!response.ok && response.status === 401) {
    console.log('[TidalAPI] 401 Unauthorized, attempting to refresh token...');
    await refreshTidalToken(true);
    const newToken = loadToken();
    if (newToken) {
      response = await doFetch(newToken.access_token);
    }

    if (!response.ok && response.status === 401) {
      throw new Error("Tidal API error: Unauthorized - Token expired and refresh failed");
    }
  }

  if (!response.ok) {
    let detail = `Tidal API error: ${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as any;
      if (body?.userMessage) detail = body.userMessage;
      else if (body?.status || body?.subStatus) {
        detail = `Tidal API error: ${body.status || response.status} (subStatus ${body.subStatus})`;
      }
    } catch {
      /* ignore */
    }
    const error = new Error(detail) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Refresh Tidal token using tidal-dl-ng
 * tidal-dl-ng handles token refresh automatically, but we can trigger it
 */
export async function refreshTidalToken(force: boolean = false): Promise<void> {
  const token = loadToken();

  // Skip refresh if token is still valid (unless forced)
  if (!force && !shouldRefreshToken(token)) {
    return;
  }

  console.log('🕖 [TIDAL] Refreshing TIDAL token...');
  await refreshStoredTidalToken();
}

// Paginated API request - fetches all items by following pagination
// Note: Tidal API limit varies by endpoint (albums: 100, favorites: 50)
async function tidalApiRequestPaginated(endpoint: string, limit: number = 100) {
  const token = loadToken();
  if (!token) throw new Error("Not authenticated");

  let offset = 0;
  let allItems: any[] = [];
  let totalNumberOfItems = 0;
  let pageCount = 0;

  console.log(`[TidalPaginated] Starting pagination for: ${endpoint} (limit=${limit})`);

  while (true) {
    pageCount++;
    const url = new URL(`${TIDAL_API_BASE}${endpoint}`);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());

    console.log(`[TidalPaginated] Fetching page ${pageCount}: offset=${offset}, limit=${limit}`);

    const doFetch = async (accessToken: string) =>
      tidalFetchWithRetry(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "X-Tidal-Token": TIDAL_CLIENT_TOKEN,
        },
      }, url.toString());

    let response = await doFetch(token.access_token);

    if (!response.ok && response.status === 401) {
      console.log('[TidalAPI] 401 Unauthorized (Paginated), attempting to refresh token...');
      await refreshTidalToken(true);
      const newToken = loadToken();
      if (newToken) {
        response = await doFetch(newToken.access_token);
      }
    }

    if (!response.ok) {
      const error = new Error(`Tidal API error: ${response.status} ${response.statusText}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const data = await response.json() as any;

    if (!data || !data.items) {
      console.log(`[TidalPaginated] No items in response, stopping`);
      break;
    }

    const itemsReceived = data.items.length;
    allItems = allItems.concat(data.items);

    // Check if we have the total count from API
    if (data.totalNumberOfItems !== undefined && totalNumberOfItems === 0) {
      totalNumberOfItems = data.totalNumberOfItems;
      console.log(`[TidalPaginated] API reports totalNumberOfItems: ${totalNumberOfItems}`);
    }

    console.log(`[TidalPaginated] Page ${pageCount}: received ${itemsReceived} items, total so far: ${allItems.length}`);

    // Stop if we got no items
    if (itemsReceived === 0) {
      console.log(`[TidalPaginated] Received 0 items, stopping`);
      break;
    }

    // Stop if we have all items based on totalNumberOfItems
    if (totalNumberOfItems > 0 && allItems.length >= totalNumberOfItems) {
      console.log(`[TidalPaginated] Reached totalNumberOfItems (${totalNumberOfItems}), stopping`);
      break;
    }

    // Stop if we got fewer items than the limit (last page) - only if we don't have a totalNumberOfItems
    if (totalNumberOfItems === 0 && itemsReceived < limit) {
      console.log(`[TidalPaginated] Received fewer items than limit (${itemsReceived} < ${limit}), stopping`);
      break;
    }

    offset += itemsReceived;

    // Safety limit to prevent infinite loops
    if (pageCount >= 100) {
      console.warn(`[TidalPaginated] Safety limit reached (100 pages), stopping`);
      break;
    }
  }

  console.log(`[TidalPaginated] Finished: ${allItems.length} total items in ${pageCount} pages`);
  return { items: allItems, totalNumberOfItems: allItems.length };
}

export async function tidalApiRequestPaginatedSafe(endpoint: string, label: string): Promise<any[]> {
  try {
    const res = await tidalApiRequestPaginated(endpoint);
    return res.items || [];
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (error?.status === 404 || msg.includes('404')) {
      // Expected for some filters like APPEARS_ON
      return [];
    }
    console.warn(`[tidalApiRequestPaginatedSafe] ${label} failed:`, msg);
    return [];
  }
}

type TidalSearchType = "artists" | "albums" | "tracks" | "videos" | "playlists";

function normalizeSearchTypes(type: string | string[]): TidalSearchType[] {
  const allSearchTypes: TidalSearchType[] = ["artists", "albums", "tracks", "videos", "playlists"];
  const normalized: TidalSearchType[] = (Array.isArray(type) ? type : String(type || "all").split(","))
    .map((value) => value.trim().toLowerCase())
    .flatMap<TidalSearchType>((value) => {
      if (!value || value === "all") {
        return allSearchTypes;
      }
      if (value === "artist") return ["artists"];
      if (value === "album") return ["albums"];
      if (value === "track") return ["tracks"];
      if (value === "video") return ["videos"];
      if (value === "playlist") return ["playlists"];
      return allSearchTypes.includes(value as TidalSearchType)
        ? [value as TidalSearchType]
        : [];
    });

  return normalized.length > 0 ? [...new Set(normalized)] : allSearchTypes;
}

export async function searchTidal(query: string, type: string | string[], limit: number) {
  const typeMap: Record<TidalSearchType, string> = {
    artists: "ARTISTS",
    albums: "ALBUMS",
    tracks: "TRACKS",
    videos: "VIDEOS",
    playlists: "PLAYLISTS",
  };
  const searchTypes = normalizeSearchTypes(type);
  const typesParam = searchTypes.map((value) => typeMap[value]).join(",");
  const token = loadToken();
  if (!token?.access_token) throw new Error("Not authenticated");
  const tokenCountry = token?.user?.countryCode || "US";
  const searchParams = new URLSearchParams({
    query,
    types: typesParam,
    limit: String(limit),
    countryCode: tokenCountry,
    deviceType: "BROWSER",
    locale: "en_US",
  });

  const doSearch = async (accessToken: string) => {
    const res = await tidalFetchWithRetry(`${TIDAL_API_BASE}/search?${searchParams.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-Tidal-Token": TIDAL_CLIENT_TOKEN,
      },
    }, `search:${searchParams.get("query") || "query"}`);

    if (res.ok) return res.json();

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }

    // Refresh once when subStatus 11003 indicates an expired token
    if (res.status === 401 && body?.subStatus === 11003) {
      await refreshTidalToken();
      const refreshedToken = loadToken();
      if (refreshedToken?.access_token) {
        return doSearch(refreshedToken.access_token);
      }
    }

    const detail =
      body?.userMessage ||
      (body?.status || res.status === 401 ? `Tidal API error: ${body?.status || res.status} (subStatus ${body?.subStatus ?? "n/a"})` : `Tidal API error: ${res.status} ${res.statusText}`);
    throw new Error(detail);
  };

  const data = await doSearch(token.access_token) as any;

  const mapArtist = (item: any) => {
    return {
      type: "artist",
      id: item.id?.toString(),
      tidal_id: item.id?.toString(),
      name: item.name || 'Unknown Artist',
      picture: item.picture || null,  // UUID for artist picture
      popularity: item.popularity || 0,
    };
  };

  const mapAlbum = (item: any) => {
    const artistName = item.artist?.name || item.artists?.[0]?.name;
    // Construct rich object for ImportService
    return {
      id: item.id?.toString(),
      tidal_id: item.id?.toString(), // Retained for existing internal consumers
      title: item.title || 'Unknown Album',
      url: item.url || `https://tidal.com/album/${item.id}`,
      cover: item.cover || null,
      releaseDate: item.releaseDate || item.streamStartDate || null,
      release_date: item.releaseDate || item.streamStartDate || null,
      type: "album",
      quality: deriveQuality(item),
      audioQuality: item.audioQuality,
      mediaMetadata: { tags: item.mediaMetadata?.tags || [] },
      explicit: item.explicit || false,
      popularity: item.popularity || 0,
      duration: item.duration || 0,
      numberOfTracks: item.numberOfTracks || 0,
      numberOfVideos: item.numberOfVideos || 0,
      numberOfVolumes: item.numberOfVolumes || 1,
      upc: item.upc || null,
      artist: {
        id: item.artist?.id?.toString() || item.artists?.[0]?.id?.toString(),
        name: artistName,
        picture: item.artist?.picture || null
      },
      artists: item.artists?.map((a: any) => ({
        id: a.id?.toString(),
        name: a.name,
        picture: a.picture
      })) || []
    };
  };

  const mapTrack = (item: any) => {
    const artistName = item.artist?.name || item.artists?.[0]?.name;
    return {
      type: "track",
      id: item.id?.toString(),
      tidal_id: item.id?.toString(),
      title: item.title || 'Unknown Track',
      name: item.title || 'Unknown Track',
      artist_id: item.artist?.id?.toString() || item.artists?.[0]?.id?.toString(),
      artist_name: artistName,
      subtitle: artistName,
      album_id: item.album?.id?.toString(),
      album_title: item.album?.title,
      duration: item.duration,
      track_number: item.trackNumber || 0,
      audio_quality: deriveQuality(item),
      cover: item.album?.cover || null,  // Album cover UUID
    };
  };

  const mapVideo = (item: any) => {
    const artistName = item.artist?.name || item.artists?.[0]?.name;
    return {
      type: "video",
      id: item.id?.toString(),
      tidal_id: item.id?.toString(),
      title: item.title || 'Unknown Video',
      name: item.title || 'Unknown Video',
      artist_id: item.artist?.id?.toString() || item.artists?.[0]?.id?.toString(),
      artist_name: artistName,
      subtitle: artistName,
      image_id: item.imageId || item.image || null,  // UUID for video thumbnail
      vibrant_color: item.vibrantColor || null,
      duration: item.duration,
      quality: item.quality || 'MP4_1080P',
    };
  };

  if (searchTypes.length === 1 && searchTypes[0] === "artists") return (data?.artists?.items || data.items || []).filter((i: any) => i?.id).map(mapArtist);
  if (searchTypes.length === 1 && searchTypes[0] === "albums") return (data?.albums?.items || data.items || []).filter((i: any) => i?.id).map(mapAlbum);
  if (searchTypes.length === 1 && searchTypes[0] === "tracks") return (data?.tracks?.items || data.items || []).filter((i: any) => i?.id).map(mapTrack);
  if (searchTypes.length === 1 && searchTypes[0] === "videos") return (data?.videos?.items || data.items || []).filter((i: any) => i?.id).map(mapVideo);

  const artists = data.artists?.items?.map(mapArtist) || [];
  const albums = data.albums?.items?.map(mapAlbum) || [];
  const tracks = data.tracks?.items?.map(mapTrack) || [];
  const videos = data.videos?.items?.map(mapVideo) || [];
  return [...artists, ...albums, ...tracks, ...videos];
}

export async function getArtistSimilar(artistId: string) {
  const token = loadToken();
  if (!token?.access_token) throw new Error("Not authenticated");
  const cc = getCountryCode();

  // Similar artists are returned in the page API under the "ARTIST_SIMILAR_ARTISTS" module
  // Using the page endpoint is more reliable than the direct /similar endpoint
  const res = await tidalFetchWithRetry(`${TIDAL_API_BASE}/artists/${artistId}/similar?countryCode=${cc}&limit=10`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
      "X-Tidal-Token": TIDAL_CLIENT_TOKEN,
    },
  }, `artists/${artistId}/similar`);

  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Failed to fetch similar artists: ${res.statusText}`);
  }

  const data = await res.json() as any;
  return (data.items || []).map((item: any) => ({
    tidal_id: item.id?.toString(),
    name: item.name,
    picture: item.picture || null,  // UUID for artist picture
    popularity: item.popularity || 0,
  }));
}

export function getCountryCode(): string {
  const token = loadToken();
  return token?.user?.countryCode || "US";
}

export async function getArtist(artistId: string) {
  if (!artistId || artistId === "undefined") {
    console.error(`[TidalAPI] getArtist called with invalid ID: ${artistId}`);
    console.trace();
    throw new Error(`Invalid artist ID: ${artistId}`);
  }
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/artists/${artistId}?countryCode=${cc}`) as any;

  if (!data || !data.id) {
    throw new Error(`Invalid artist data returned for ID ${artistId}`);
  }

  return {
    id: data.id.toString(),
    tidal_id: data.id.toString(),
    name: data.name || 'Unknown Artist',
    url: data.url || `https://listen.tidal.com/artist/${data.id}`,
    picture: data.picture || null,  // UUID for artist picture
    popularity: data.popularity || 0,
    artist_types: data.artistTypes || ['ARTIST'],  // JSON array: ["ARTIST", "CONTRIBUTOR", ...]
    artist_roles: data.artistRoles || [],  // JSON array of role objects
  };
}

export async function getArtistAlbums(artistId: string) {
  const cc = getCountryCode();
  // Fetch all album types: ALBUMS, EPSANDSINGLES, COMPILATIONS
  // NOTE: COMPILATIONS endpoint = "albums artist appeared on as featured artist" (various artists albums)
  //       NOT the artist's own compilation albums!
  // NOTE: Tidal API only supports EPSANDSINGLES as combined filter - we use album's type field to distinguish
  const albums = await tidalApiRequestPaginatedSafe(`/artists/${artistId}/albums?countryCode=${cc}`, "albums");
  const epsSingles = await tidalApiRequestPaginatedSafe(`/artists/${artistId}/albums?countryCode=${cc}&filter=EPSANDSINGLES`, "eps_singles");
  const compilations = await tidalApiRequestPaginatedSafe(`/artists/${artistId}/albums?countryCode=${cc}&filter=COMPILATIONS`, "compilations");

  // Tag each album with group_type (which API endpoint) and derive initial module category
  // group_type: ALBUMS, EPSANDSINGLES, COMPILATIONS (matches Tidal API filters)
  // module: Derived UI category - ALBUM, EP, SINGLE, APPEARS_ON, REMIX, SOUNDTRACK, DEMO (LIVE determined by page API)
  const tag = (arr: any[], groupType: 'ALBUMS' | 'EPSANDSINGLES' | 'COMPILATIONS') =>
    (arr || []).map(item => {
      // Derive module from group_type, release type, and title
      // REMIX/SOUNDTRACK/DEMO are detected by title, LIVE is left to page API module mapping
      let module: string;
      const titleLower = (item.title || '').toLowerCase();

      if (groupType === 'COMPILATIONS') {
        module = 'APPEARS_ON';  // Various artists albums
      } else if (titleLower.includes('soundtrack') || titleLower.includes('o.s.t.') || titleLower.includes('original score') || titleLower.includes('motion picture')) {
        module = 'SOUNDTRACK';
      } else if (titleLower.includes('demo') || titleLower.includes('demos')) {
        module = 'DEMO';
      } else if (titleLower.includes('remix') || titleLower.includes('remixes') || titleLower.includes('remixed')) {
        module = 'REMIX';  // Remix albums/EPs/singles
      } else if (item.type === 'EP') {
        module = 'EP';
      } else if (item.type === 'SINGLE') {
        module = 'SINGLE';
      } else {
        module = 'ALBUM';
      }
      return { ...item, _group_type: groupType, _module: module };
    });

  const allItems = [
    ...tag(albums, 'ALBUMS'),
    ...tag(epsSingles, 'EPSANDSINGLES'),
    ...tag(compilations, 'COMPILATIONS'),
  ];

  // Deduplicate by ID (in case of overlaps) and map to our format
  const uniqueAlbums = new Map();
  allItems.filter((item: any) => item && item.id).forEach((item: any) => {
    const albumId = item.id.toString();
    const coverId = item.cover || item.image || item.imageId || item.squareImage || null;
    const coverUrl = coverId ? `https://resources.tidal.com/images/${coverId.replace(/-/g, "/")}/1280x1280.jpg` : null;

    const quality = deriveQuality(item);

    // Keep highest quality version if duplicate
    // Preserve first group_type and module seen (more specific categorization wins)
    if (!uniqueAlbums.has(albumId) ||
      (quality && getQualityRank(quality) > getQualityRank(uniqueAlbums.get(albumId).quality))) {
      uniqueAlbums.set(albumId, {
        tidal_id: albumId,
        // Use the album's actual artist, not necessarily the one we queried
        artist_id: item.artist?.id?.toString() || artistId,
        artist_name: item.artist?.name || 'Unknown Artist',
        artists: item.artists || (item.artist ? [item.artist] : []),
        title: item.title || 'Unknown Album',
        release_date: item.releaseDate || null,
        cover: coverId,  // UUID for album cover
        vibrant_color: item.vibrantColor || null,  // Hex color code
        video_cover: item.videoCover || null,  // UUID for animated cover
        num_tracks: item.numberOfTracks || 0,
        num_videos: item.numberOfVideos || 0,
        num_volumes: item.numberOfVolumes || 1,
        duration: item.duration || 0,
        type: item.type || 'ALBUM',  // Release type: ALBUM, EP, SINGLE
        version: item.version || null,
        explicit: item.explicit || false,
        quality: quality || 'LOSSLESS',  // Derived from mediaMetadata.tags
        url: item.url || `https://listen.tidal.com/album/${item.id}`,
        popularity: item.popularity || 0,
        copyright: item.copyright || null,
        upc: item.upc || null,
        _group_type: item._group_type || 'ALBUMS',  // API endpoint: ALBUMS, EPSANDSINGLES, COMPILATIONS
        _module: item._module || 'ALBUM'  // UI category: ALBUM, EP, SINGLE, APPEARS_ON, REMIX, SOUNDTRACK, DEMO (can be refined by page data)
      });
    }
  });

  return Array.from(uniqueAlbums.values());
}

export async function getTrack(trackId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/tracks/${trackId}?countryCode=${cc}`) as any;
  if (!data || !data.id) {
    throw new Error(`Invalid track data for ID ${trackId}`);
  }
  return {
    id: data.id.toString(),
    tidal_id: data.id.toString(),
    title: data.title,
    duration: data.duration,
    track_number: data.trackNumber || data.trackNumberOnVolume || 0,
    volume_number: data.volumeNumber || 1,
    album_id: data.album?.id?.toString() || null,
    album_title: data.album?.title || null,
    artist_id: data.artist?.id?.toString() || null,
    artist_name: data.artist?.name || null,
    isrc: data.isrc || null,
    quality: deriveQuality(data) || "LOSSLESS",
    explicit: data.explicit || false,
    url: data.url || `https://listen.tidal.com/track/${data.id}`,
  };
}

export async function getAlbumReview(albumId: string): Promise<TidalTextMeta | null> {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/albums/${albumId}/review?countryCode=${cc}`) as any;
    return extractTidalTextMeta(data);
  } catch (error: any) {
    const msg = error?.message || "";
    if (error?.status === 404 || msg.includes("Review or album") || msg.includes("not found")) {
      return null;
    }
    console.warn(`[getAlbumReview] Failed for ${albumId}:`, error?.message || error);
    throw error;
  }
}

export async function getAlbumSimilar(albumId: string) {
  const cc = getCountryCode();
  const token = loadToken();
  if (!token?.access_token) throw new Error("Not authenticated");

  try {
    const res = await tidalFetchWithRetry(`${TIDAL_API_BASE}/albums/${albumId}/similar?countryCode=${cc}&limit=10`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
        "X-Tidal-Token": TIDAL_CLIENT_TOKEN,
      },
    }, `albums/${albumId}/similar`);

    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`Failed to fetch similar albums: ${res.statusText}`);
    }

    const data = await res.json() as any;
    return (data.items || []).map((item: any) => ({
      tidal_id: item.id?.toString(),
      title: item.title,
      artist_id: item.artist?.id?.toString(),
      artist_name: item.artist?.name,
      cover: item.cover || null,
      release_date: item.releaseDate,
      type: item.type || 'ALBUM',
      quality: deriveQuality(item) || 'LOSSLESS',
      explicit: item.explicit || false,
      popularity: item.popularity || 0,
    }));
  } catch (e) {
    console.warn(`[getAlbumSimilar] Failed for ${albumId}:`, e);
    return [];
  }
}


// Helper function to rank audio quality for deduplication
// Used when the same album appears multiple times in API results
// This is a simple absolute ranking - library-specific filtering happens later in redundancy service
function getQualityRank(quality: string): number {
  const ranks: Record<string, number> = {
    'LOSSLESS': 1,
    'HIRES_LOSSLESS': 2,
    'DOLBY_ATMOS': 3,  // Highest for initial dedup - library filtering happens later
  };
  return ranks[quality] || 0;
}


export async function getFollowedArtists() {
  const token = loadToken();
  if (!token) throw new Error("Not authenticated");

  const userId = token.user?.userId;
  const cc = token.user?.countryCode || "US";
  if (!userId) throw new Error("User ID not found");

  console.log(`[getFollowedArtists] Fetching followed artists for user ${userId}...`);

  // Use limit=50 for favorites endpoint (Tidal API max for favorites is lower than albums)
  const data = await tidalApiRequestPaginated(`/users/${userId}/favorites/artists?countryCode=${cc}`, 50);

  console.log(`[getFollowedArtists] Tidal API returned ${data?.items?.length || 0} artists`);

  if (!data || !data.items) {
    console.warn('[getFollowedArtists] No followed artists data returned from Tidal API');
    return [];
  }

  console.log(`[getFollowedArtists] Found ${data.items.length} followed artists`);

  // Tidal favorites API wraps each artist in an "item" object
  return data.items
    .filter((favorite: any) => favorite && favorite.item && favorite.item.id)
    .map((favorite: any) => {
      const artist = favorite.item;
      return {
        tidal_id: artist.id.toString(),
        name: artist.name || 'Unknown Artist',
        picture: artist.picture || null,  // UUID for artist picture
        url: artist.url || `https://listen.tidal.com/artist/${artist.id}`,
        popularity: artist.popularity || 0,
      };
    });
}

export async function getAlbum(albumId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/albums/${albumId}?countryCode=${cc}`) as any;

  if (!data || !data.id) {
    throw new Error(`Invalid album data returned for ID ${albumId}`);
  }

  return {
    id: data.id.toString(),
    tidal_id: data.id.toString(),
    title: data.title || 'Unknown Album',
    url: data.url || `https://tidal.com/album/${data.id}`,
    cover: data.cover || null,
    releaseDate: data.releaseDate || data.streamStartDate || null,
    release_date: data.releaseDate || data.streamStartDate || null,
    type: data.type || "ALBUM",
    quality: deriveQuality(data),
    explicit: data.explicit || false,
    popularity: data.popularity || 0,
    duration: data.duration || 0,
    numberOfTracks: data.numberOfTracks || 0,
    numberOfVideos: data.numberOfVideos || 0,
    numberOfVolumes: data.numberOfVolumes || 1,
    vibrant_color: data.vibrantColor || null,
    version: data.version || null,
    items: [], // Sometimes useful for downstream handlers expecting items array
    artist: {
      id: data.artist?.id?.toString() || data.artists?.[0]?.id?.toString(),
      name: data.artist?.name || data.artists?.[0]?.name,
      picture: data.artist?.picture || null
    },
    // Flattened props retained for existing internal callers
    artist_id: data.artist?.id?.toString() || data.artists?.[0]?.id?.toString(),
    artist_name: data.artist?.name || data.artists?.[0]?.name,
    upc: data.upc || null,
    copyright: data.copyright || null,
    video_cover: data.videoCover || null,
    num_videos: data.numberOfVideos || 0,
    num_volumes: data.numberOfVolumes || 1,
    num_tracks: data.numberOfTracks || 0,
    artists: data.artists?.map((a: any) => ({
      id: a.id?.toString(),
      name: a.name,
      picture: a.picture
    })) || []
  };
}

export async function getAlbumVersions(albumId: string) {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/albums/${albumId}?countryCode=${cc}`) as any;
    // Tidal sometimes returns otherVersions in the response
    return data.otherVersions || [];
  } catch (error) {
    console.warn(`[getAlbumVersions] Failed for ${albumId}:`, error);
    return [];
  }
}

export async function getAlbumTracks(albumId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequestPaginated(`/albums/${albumId}/tracks?countryCode=${cc}`);

  return data.items?.filter((item: any) => item && item.id).map((item: any) => ({
    tidal_id: item.id.toString(),
    title: item.title || 'Unknown Track',
    duration: item.duration || 0,
    track_number: item.trackNumber || 0,
    volume_number: item.volumeNumber || 1,
    version: item.version || null,
    isrc: item.isrc || null,
    explicit: item.explicit || false,
    quality: deriveQuality(item) || 'LOSSLESS',  // Derived from mediaMetadata.tags, ready for DB
    copyright: item.copyright || null,
    artist_id: item.artist?.id?.toString() || null,
    artist_name: item.artist?.name || 'Unknown Artist',
    artists: item.artists
      ? item.artists
        .filter((a: any) => a && a.id)
        .map((a: any) => ({ id: a.id, name: a.name || 'Unknown', type: a.type || null }))
      : [],
    url: item.url || `https://listen.tidal.com/track/${item.id}`,
    bpm: item.bpm || null,
    key: item.key || null,
    key_scale: item.keyScale || null,
    peak: item.peak || null,
    replay_gain: item.replayGain || null,
    popularity: item.popularity || 0,
    release_date: item.streamStartDate || null,
  })) || [];
}

// Get album items (tracks + videos) - use this for video albums
export async function getAlbumItems(albumId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequestPaginated(`/albums/${albumId}/items?countryCode=${cc}`);

  return (data.items || []).filter((wrapper: any) => wrapper?.item?.id).map((wrapper: any) => {
    const item = wrapper.item;
    const itemType = wrapper.type; // 'track' or 'video'

    if (itemType === 'video') {
      return {
        tidal_id: item.id.toString(),
        title: item.title || 'Unknown Video',
        duration: item.duration || 0,
        track_number: item.trackNumber || 0,
        volume_number: item.volumeNumber || 1,
        version: item.version || null,
        explicit: item.explicit || false,
        quality: item.quality || 'MP4_1080P',
        image_id: item.imageId || item.image || null,
        artist_id: item.artist?.id?.toString() || null,
        artist_name: item.artist?.name || 'Unknown Artist',
        artists: item.artists || [],
        url: item.url || `https://listen.tidal.com/video/${item.id}`,
        popularity: item.popularity || 0,
        release_date: item.releaseDate || item.streamStartDate || null,
        type: 'Music Video',
        item_type: 'video',
      };
    }

    // Track
    return {
      tidal_id: item.id.toString(),
      title: item.title || 'Unknown Track',
      duration: item.duration || 0,
      track_number: item.trackNumber || 0,
      volume_number: item.volumeNumber || 1,
      version: item.version || null,
      isrc: item.isrc || null,
      explicit: item.explicit || false,
      quality: deriveQuality(item) || 'LOSSLESS',
      copyright: item.copyright || null,
      artist_id: item.artist?.id?.toString() || null,
      artist_name: item.artist?.name || 'Unknown Artist',
      artists: item.artists
        ? item.artists
          .filter((a: any) => a && a.id)
          .map((a: any) => ({ id: a.id, name: a.name || 'Unknown', type: a.type || null }))
        : [],
      url: item.url || `https://listen.tidal.com/track/${item.id}`,
      bpm: item.bpm || null,
      key: item.key || null,
      key_scale: item.keyScale || null,
      peak: item.peak || null,
      replay_gain: item.replayGain || null,
      popularity: item.popularity || 0,
      release_date: item.streamStartDate || null,
      type: 'Track',
      item_type: 'track',
    };
  });
}

// Get artist videos
export async function getArtistVideos(artistId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequestPaginated(`/artists/${artistId}/videos?countryCode=${cc}`);

  return data.items?.filter((item: any) => item && item.id).map((item: any) => ({
    id: item.id.toString(),
    tidal_id: item.id.toString(),
    title: item.title || 'Unknown Video',
    duration: item.duration || 0,
    release_date: item.releaseDate || item.streamStartDate || null,
    version: item.version || null,
    explicit: item.explicit || false,
    quality: item.quality || 'MP4_1080P',  // Video quality like MP4_1080P
    image_id: item.imageId || item.image || null,  // UUID for video thumbnail
    vibrant_color: item.vibrantColor || null,  // Hex color code
    artist_id: item.artist?.id?.toString() || artistId,
    artist_name: item.artist?.name || 'Unknown Artist',
    artists: item.artists || [],
    album_id: item.album?.id?.toString() || null,  // Some videos have album association
    url: item.url || `https://listen.tidal.com/video/${item.id}`,
    popularity: item.popularity || 0,
    type: 'Music Video'  // Standardize type
  })) || [];
}

export async function getVideo(videoId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/videos/${videoId}?countryCode=${cc}`) as any;
  if (!data || !data.id) {
    throw new Error(`Invalid video data for ID ${videoId}`);
  }
  return {
    id: data.id.toString(),
    tidal_id: data.id.toString(),
    title: data.title,
    artist_id: data.artist?.id?.toString() || null,
    artist_name: data.artist?.name || null,
    artists: data.artists || [],
    album_id: data.album?.id?.toString() || null,
    duration: data.duration,
    release_date: data.releaseDate || data.streamStartDate || null,
    image_id: data.imageId || data.image || null,  // UUID for video thumbnail
    vibrant_color: data.vibrantColor || null,  // Hex color code
    quality: data.quality || 'MP4_1080P',  // Video quality
    explicit: data.explicit || false,
    popularity: data.popularity || 0,
    url: `https://listen.tidal.com/video/${data.id}`,
    type: 'Music Video'
  };
}

export async function getArtistBio(artistId: string): Promise<TidalTextMeta | null> {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/artists/${artistId}/bio?countryCode=${cc}`) as any;
    return extractTidalTextMeta(data);
  } catch (error: any) {
    if (error?.status === 404 || error?.message?.includes("404")) return null;
    console.warn(`[getArtistBio] Failed for ${artistId}:`, error?.message || error);
    throw error;
  }
}

export async function getAlbumCredits(albumId: string) {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/albums/${albumId}/credits?countryCode=${cc}`) as any;
    return data.credits || [];
  } catch (e) {
    return [];
  }
}

/**
 * Fetches per-track credits for all tracks in an album in a single request.
 * Returns a map of trackId → credits array, ready to be stored in media.credits.
 * Uses the same /albums/{id}/items/credits endpoint that the Orpheus TIDAL module uses.
 */
export async function getAlbumItemsCredits(albumId: string): Promise<Map<string, any[]>> {
  const cc = getCountryCode();
  const result = new Map<string, any[]>();
  try {
    let offset = 0;
    const limit = 100;
    while (true) {
      const data = await tidalApiRequest(
        `/albums/${albumId}/items/credits?countryCode=${cc}&replace=true&offset=${offset}&limit=${limit}&includeContributors=true`
      ) as any;
      const items: any[] = data?.items ?? [];
      for (const item of items) {
        const trackId = String(item?.item?.id ?? "");
        if (!trackId) continue;
        const credits: any[] = item?.credits ?? [];
        if (credits.length > 0) {
          result.set(trackId, credits);
        }
      }
      const total: number = data?.totalNumberOfItems ?? items.length;
      offset += limit;
      if (offset >= total || items.length === 0) break;
    }
  } catch (e) {
    // Non-fatal — caller handles empty map gracefully
  }
  return result;
}

export async function getTrackCredits(trackId: string) {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/tracks/${trackId}/credits?countryCode=${cc}`) as any;
    return data.credits || [];
  } catch (e) {
    return [];
  }
}

// Get artist page layout (as seen on Tidal website)
export async function getArtistPage(artistId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/pages/artist?artistId=${artistId}&countryCode=${cc}&deviceType=BROWSER`) as any;
  return data;
}

// Extract album ID → module mapping from page data
// The page API returns: { rows: [{ modules: [{ title, type, pagedList: { items } }] }] }
// Titles we care about: "Albums", "EP & Singles", "Compilations", "Live albums", "Appears On"
export function getPageModuleMap(pageData: any): Map<string, string> {
  const moduleMap = new Map<string, string>();

  // Map page section titles to module DB values
  const titleToModule: Record<string, string> = {
    'Albums': 'ALBUMS',
    'EP & Singles': 'EPSANDSINGLES',
    'Compilations': 'COMPILATIONS',      // Compilation-type albums
    'Live albums': 'LIVE',               // Live albums
    'Appears On': 'APPEARS_ON',          // Featured on other artists' releases
  };

  // Parse rows structure
  const rows = pageData?.rows;
  if (!Array.isArray(rows)) return moduleMap;

  for (const row of rows) {
    const modules = row?.modules;
    if (!Array.isArray(modules)) continue;

    for (const mod of modules) {
      const title = mod?.title;
      const moduleName = titleToModule[title];
      if (!moduleName) continue;

      // Extract album IDs from pagedList.items
      const items = mod?.pagedList?.items || mod?.items || [];
      for (const item of items) {
        const albumId = item?.id?.toString();
        if (albumId) {
          moduleMap.set(albumId, moduleName);
        }
      }
    }
  }

  return moduleMap;
}

// Async version that fetches page data and returns module map
export async function getArtistPageModuleMap(artistId: string): Promise<Map<string, string>> {
  try {
    const pageData = await getArtistPage(artistId);
    return getPageModuleMap(pageData);
  } catch (err) {
    console.warn(`[tidal] Failed to get page module map for artist ${artistId}:`, err);
    return new Map();
  }
}

// Get album page layout (as seen on Tidal website)
// Useful for getting "Other versions" to deduce module types
export async function getAlbumPage(albumId: string) {
  const cc = getCountryCode();
  const data = await tidalApiRequest(`/pages/album?albumId=${albumId}&countryCode=${cc}&deviceType=BROWSER`) as any;
  return data;
}

// Get album page "Other versions" - returns array of album IDs
export async function getAlbumOtherVersions(albumId: string): Promise<string[]> {
  try {
    const pageData = await getAlbumPage(albumId);
    if (!pageData?.rows) return [];

    for (const row of pageData.rows) {
      if (!Array.isArray(row.modules)) continue;
      for (const mod of row.modules) {
        if (mod.title === 'Other versions') {
          const items = mod.pagedList?.items || mod.items || [];
          return items.map((item: any) => item.id?.toString()).filter(Boolean);
        }
      }
    }
    return [];
  } catch (e) {
    console.warn(`[TIDAL] Failed to get other versions for album ${albumId}:`, e);
    return [];
  }
}

// ====================================================================
// PLAYLIST FUNCTIONS
// ====================================================================

export async function getPlaylist(playlistId: string) {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequest(`/playlists/${playlistId}?countryCode=${cc}`) as any;
    if (!data || !data.uuid) return null;
    return data;
  } catch (e) {
    console.error(`[TIDAL] Error fetching playlist ${playlistId}:`, e);
    return null;
  }
}

export async function getPlaylistTracks(playlistId: string) {
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequestPaginated(`/playlists/${playlistId}/tracks?countryCode=${cc}`);
    return data || [];
  } catch (e) {
    console.error(`[TIDAL] Error fetching playlist tracks:`, e);
    return [];
  }
}

export async function getUserPlaylists() {
  const token = loadToken();
  if (!token?.user?.userId) {
    throw new Error("Not authenticated");
  }
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequestPaginated(`/users/${token.user.userId}/playlists?countryCode=${cc}`);
    return data || [];
  } catch (e) {
    console.error(`[TIDAL] Error fetching user playlists:`, e);
    return [];
  }
}

export async function getUserFavoritePlaylists() {
  const token = loadToken();
  if (!token?.user?.userId) {
    throw new Error("Not authenticated");
  }
  const cc = getCountryCode();
  try {
    const data = await tidalApiRequestPaginated(`/users/${token.user.userId}/favorites/playlists?countryCode=${cc}`);
    return data || [];
  } catch (e) {
    console.error(`[TIDAL] Error fetching favorite playlists:`, e);
    return [];
  }
}
