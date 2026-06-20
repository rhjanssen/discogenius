import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "../../config/config.js";

/**
 * Apple Music auth (Tidarr/tiddl pattern).
 *
 * We integrate the OSS `zhaarey/apple-music-downloader` (Go) as the download
 * backend. That tool authenticates via a `config.yaml` carrying:
 *   - `media-user-token` — the per-user cookie copied from the Apple Music web
 *     app (grants access to the user's account-scoped catalog/streams).
 *   - a developer (storefront) token — a short-lived JWT the web app mints; the
 *     Apple Music API (`https://api.music.apple.com`) accepts it as the
 *     `Authorization: Bearer` token alongside the `media-user-token` cookie.
 *
 * Per the contract we REUSE the exact same tokens the downloader establishes for
 * our own Apple Music API calls — we never run a second auth flow. The
 * downloader's binary path performs the live decryption; our adapter only needs
 * the two tokens to read catalog metadata.
 *
 * All Apple provider artifacts live together under config/providers/apple-music/
 * mirroring the TIDAL layout (config/providers/tidal/).
 */
export const APPLE_MUSIC_PROVIDER_DIR = path.join(CONFIG_DIR, "providers", "apple-music");
export const APPLE_MUSIC_TOKEN_FILE = path.join(APPLE_MUSIC_PROVIDER_DIR, "token.json");
/** Where the bundled `apple-music-downloader` reads its config (config.yaml). */
export const APPLE_MUSIC_DOWNLOADER_DIR = path.join(APPLE_MUSIC_PROVIDER_DIR, ".amdl");
export const APPLE_MUSIC_DOWNLOADER_CONFIG = path.join(APPLE_MUSIC_DOWNLOADER_DIR, "config.yaml");

export const APPLE_MUSIC_API_BASE = "https://api.music.apple.com";

export interface AppleMusicAuthToken {
  /** Developer/storefront JWT used as the API Bearer token. */
  developer_token: string;
  /** Per-user cookie granting account-scoped access. */
  media_user_token: string;
  /** Apple storefront (e.g. "us", "gb"); defaults to "us". */
  storefront?: string;
  /** Unix seconds the developer token expires (best effort; JWT exp). */
  expires_at?: number;
  user?: { username?: string } | null;
}

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

export function loadStoredAppleMusicToken(): AppleMusicAuthToken | null {
  // Env-injected tokens win — useful for headless/CI and the standard way the
  // Apple developer token is provisioned (it is short-lived and minted outside).
  const envDev = String(process.env.APPLE_MUSIC_DEVELOPER_TOKEN ?? "").trim();
  const envUser = String(process.env.APPLE_MUSIC_USER_TOKEN ?? "").trim();
  if (envDev && envUser) {
    return {
      developer_token: envDev,
      media_user_token: envUser,
      storefront: resolveAppleStorefront(),
      expires_at: getJwtExpiry(envDev),
    };
  }

  try {
    if (fs.existsSync(APPLE_MUSIC_TOKEN_FILE)) {
      const content = fs.readFileSync(APPLE_MUSIC_TOKEN_FILE, "utf-8");
      const parsed = JSON.parse(content) as AppleMusicAuthToken;
      if (parsed.developer_token && parsed.media_user_token) {
        parsed.storefront = parsed.storefront || resolveAppleStorefront();
        if (!parsed.expires_at) {
          parsed.expires_at = getJwtExpiry(parsed.developer_token);
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
    expires_at: token.expires_at || getJwtExpiry(token.developer_token),
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
export function syncTokenToDownloader(token: AppleMusicAuthToken | null): void {
  const resolved = token ?? loadStoredAppleMusicToken();
  if (!resolved) {
    return;
  }
  ensureDir(APPLE_MUSIC_DOWNLOADER_DIR);
  const lines = [
    "# Managed by Discogenius. Manual edits are overwritten on credential sync.",
    `media-user-token: ${yamlString(resolved.media_user_token)}`,
    `authorization-token: ${yamlString(resolved.developer_token)}`,
    `storefront: ${yamlString(resolved.storefront || resolveAppleStorefront())}`,
    "",
  ];
  fs.writeFileSync(APPLE_MUSIC_DOWNLOADER_CONFIG, lines.join("\n"), "utf-8");
}

export function buildAppleMusicApiHeaders(token: AppleMusicAuthToken): Record<string, string> {
  return {
    Authorization: `Bearer ${token.developer_token}`,
    "Media-User-Token": token.media_user_token,
    Origin: "https://music.apple.com",
    "Content-Type": "application/json",
  };
}
