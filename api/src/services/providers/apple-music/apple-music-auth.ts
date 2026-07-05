import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "../../config/config.js";

/**
 * Apple Music auth (tiddl-style credential handoff).
 *
 * Discogenius owns provider credentials and syncs them into
 * `zhaarey/apple-music-downloader`'s config.yaml. The downloader requires the
 * Apple Music web `media-user-token`; its public bearer token can be auto-fetched
 * from music.apple.com, and Discogenius does the same for catalog calls unless a
 * bearer/developer token override is configured.
 */
export const APPLE_MUSIC_PROVIDER_DIR = path.join(CONFIG_DIR, "providers", "apple-music");
export const APPLE_MUSIC_TOKEN_FILE = path.join(APPLE_MUSIC_PROVIDER_DIR, "token.json");
/** Where the bundled `apple-music-downloader` reads its config (config.yaml). */
export const APPLE_MUSIC_DOWNLOADER_DIR = path.join(APPLE_MUSIC_PROVIDER_DIR, ".amdl");
export const APPLE_MUSIC_DOWNLOADER_CONFIG = path.join(APPLE_MUSIC_DOWNLOADER_DIR, "config.yaml");

export const APPLE_MUSIC_API_BASE = "https://api.music.apple.com";

export interface AppleMusicAuthToken {
  /** Optional Apple Music API/Web bearer token override. */
  developer_token?: string;
  /** Per-user cookie granting account-scoped access. */
  media_user_token: string;
  /** Apple storefront (e.g. "us", "gb"); defaults to "us". */
  storefront?: string;
  /** Unix seconds the optional bearer/developer token expires (best effort; JWT exp). */
  expires_at?: number;
  user?: { username?: string } | null;
}

let cachedWebBearerToken: { token: string; expiresAt?: number; fetchedAt: number } | null = null;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveAppleStorefront(env: NodeJS.ProcessEnv = process.env): string {
  const value = String(env.APPLE_MUSIC_STOREFRONT ?? "").trim().toLowerCase();
  return value || "us";
}

function getJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as { exp?: number };
    return decoded.exp;
  } catch {
    return undefined;
  }
}

export async function fetchAppleMusicWebBearerToken(): Promise<string> {
  const homeResponse = await fetch("https://music.apple.com");
  if (!homeResponse.ok) {
    throw new Error(`Failed to load Apple Music web app (${homeResponse.status})`);
  }
  const home = await homeResponse.text();
  const scriptPath = home.match(/\/assets\/index~[^/]+\.js/)?.[0];
  if (!scriptPath) {
    throw new Error("Could not find Apple Music web token script.");
  }

  const scriptResponse = await fetch(`https://music.apple.com${scriptPath}`);
  if (!scriptResponse.ok) {
    throw new Error(`Failed to load Apple Music token script (${scriptResponse.status})`);
  }
  const script = await scriptResponse.text();
  const token = script.match(/eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+/)?.[0];
  if (!token) {
    throw new Error("Could not resolve Apple Music web bearer token.");
  }
  return token;
}

export async function resolveAppleMusicBearerToken(token: AppleMusicAuthToken): Promise<string> {
  if (token.developer_token) {
    return token.developer_token;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedWebBearerToken) {
    const hasValidJwtExpiry = cachedWebBearerToken.expiresAt
      ? cachedWebBearerToken.expiresAt - now > 300
      : false;
    const isRecentlyFetched = now - cachedWebBearerToken.fetchedAt < 3600;
    if (hasValidJwtExpiry || isRecentlyFetched) {
      return cachedWebBearerToken.token;
    }
  }

  const webToken = await fetchAppleMusicWebBearerToken();
  cachedWebBearerToken = {
    token: webToken,
    expiresAt: getJwtExpiry(webToken),
    fetchedAt: now,
  };
  return webToken;
}

export function loadStoredAppleMusicToken(): AppleMusicAuthToken | null {
  // Env-injected tokens win — useful for headless/CI. The bearer/developer token
  // is optional because the downloader can auto-resolve Apple's web token.
  const envDev = String(process.env.APPLE_MUSIC_DEVELOPER_TOKEN ?? "").trim();
  const envUser = String(process.env.APPLE_MUSIC_USER_TOKEN ?? "").trim();
  if (envUser) {
    return {
      developer_token: envDev || undefined,
      media_user_token: envUser,
      storefront: resolveAppleStorefront(),
      expires_at: envDev ? getJwtExpiry(envDev) : undefined,
    };
  }

  try {
    if (fs.existsSync(APPLE_MUSIC_TOKEN_FILE)) {
      const content = fs.readFileSync(APPLE_MUSIC_TOKEN_FILE, "utf-8");
      const parsed = JSON.parse(content) as AppleMusicAuthToken;
      if (parsed.media_user_token) {
        parsed.storefront = parsed.storefront || resolveAppleStorefront();
        if (!parsed.expires_at) {
          parsed.expires_at = parsed.developer_token ? getJwtExpiry(parsed.developer_token) : undefined;
        }
        return parsed;
      }
    }
  } catch (error) {
    console.error("[APPLE-MUSIC-AUTH] Failed to read token:", error);
  }
  return null;
}

export function saveStoredAppleMusicToken(token: AppleMusicAuthToken): void {
  ensureDir(APPLE_MUSIC_PROVIDER_DIR);
  const normalized: AppleMusicAuthToken = {
    ...token,
    storefront: token.storefront || resolveAppleStorefront(),
    expires_at: token.expires_at || (token.developer_token ? getJwtExpiry(token.developer_token) : undefined),
  };
  fs.writeFileSync(APPLE_MUSIC_TOKEN_FILE, JSON.stringify(normalized, null, 2), "utf-8");
  syncTokenToDownloader(normalized);
}

export function clearStoredAppleMusicToken(): void {
  try {
    if (fs.existsSync(APPLE_MUSIC_TOKEN_FILE)) {
      fs.unlinkSync(APPLE_MUSIC_TOKEN_FILE);
    }
  } catch (error) {
    console.error("[APPLE-MUSIC-AUTH] Failed to clear token:", error);
  }
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write the OSS downloader's config.yaml from the stored tokens — the same token
 * we use for the API. This is the single source of truth: authenticate once,
 * reuse everywhere.
 */
export function syncTokenToDownloader(token: AppleMusicAuthToken | null, downloadPath?: string | null): void {
  const resolved = token ?? loadStoredAppleMusicToken();
  if (!resolved) {
    return;
  }
  ensureDir(APPLE_MUSIC_DOWNLOADER_DIR);
  const outputRoot = downloadPath || "AM-DL downloads";
  const lines = [
    "# Managed by Discogenius. Manual edits are overwritten on credential sync.",
    `media-user-token: ${yamlString(resolved.media_user_token)}`,
    `authorization-token: ${yamlString(resolved.developer_token || "")}`,
    `storefront: ${yamlString(resolved.storefront || resolveAppleStorefront())}`,
    "language: \"\"",
    "lrc-type: \"lyrics\"",
    "lrc-format: \"lrc\"",
    "embed-lrc: true",
    "save-lrc-file: false",
    "embed-cover: true",
    "cover-size: 5000x5000",
    "cover-format: jpg",
    "tag-sort-order: true",
    "tag-itunes-id: true",
    `alac-save-folder: ${yamlString(outputRoot)}`,
    `atmos-save-folder: ${yamlString(outputRoot)}`,
    `aac-save-folder: ${yamlString(outputRoot)}`,
    `mv-save-folder: ${yamlString(outputRoot)}`,
    "max-memory-limit: 256",
    "decrypt-m3u8-port: \"127.0.0.1:10020\"",
    "get-m3u8-port: \"127.0.0.1:20020\"",
    "get-m3u8-from-device: true",
    "exit-on-error: true",
    "get-m3u8-mode: hires",
    "aac-type: aac-lc",
    "alac-max: 192000",
    "atmos-max: 2768",
    "limit-max: 200",
    "album-folder-format: \"{AlbumId}\"",
    "playlist-folder-format: \"{PlaylistId}\"",
    "song-file-format: \"{SongId}\"",
    "artist-folder-format: \"\"",
    "explicit-choice: \"[E]\"",
    "clean-choice: \"[C]\"",
    "apple-master-choice: \"[M]\"",
    "use-songinfo-for-playlist: false",
    "dl-albumcover-for-playlist: false",
    "mv-audio-type: atmos",
    "mv-max: 2160",
    "alac-fix: false",
    "convert-after-download: false",
    "ffmpeg-path: \"ffmpeg\"",
    "",
  ];
  fs.writeFileSync(APPLE_MUSIC_DOWNLOADER_CONFIG, lines.join("\n"), "utf-8");
}

export async function buildAppleMusicApiHeaders(token: AppleMusicAuthToken): Promise<Record<string, string>> {
  const bearer = await resolveAppleMusicBearerToken(token);
  return {
    Authorization: `Bearer ${bearer}`,
    "Media-User-Token": token.media_user_token,
    Origin: "https://music.apple.com",
    "Content-Type": "application/json",
  };
}
