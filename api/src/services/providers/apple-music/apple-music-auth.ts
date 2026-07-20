import fs from "fs";
import path from "path";
import { CONFIG_DIR, Config } from "../../config/config.js";

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
  // Apple ID credentials are only ever needed transiently for the wrapper's
  // one-time login handshake — never persist them (scrubs older token files
  // that stored them too).
  delete (normalized as unknown as Record<string, unknown>).wrapper_apple_id;
  delete (normalized as unknown as Record<string, unknown>).wrapper_apple_password;
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

/** App video-quality setting → downloader mv-max height (Apple MVs go up to 4K). */
export function resolveAppleVideoMaxHeight(): number {
  let configured = "fhd";
  try {
    configured = String(Config.getQualityConfig()?.video_quality || "uhd").toLowerCase();
  } catch { /* config unavailable during early bootstrap — keep the default */ }
  switch (configured) {
    case "sd": return 480;
    case "hd": return 720;
    case "uhd": return 2160;
    default: return 1080;
  }
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
  const embedCover = Config.getQualityConfig()?.embed_cover !== false;
  const lines = [
    "# Managed by Discogenius. Manual edits are overwritten on credential sync.",
    `media-user-token: ${yamlString(resolved.media_user_token)}`,
    `authorization-token: ${yamlString(resolved.developer_token || "")}`,
    `storefront: ${yamlString(resolved.storefront || resolveAppleStorefront())}`,
    "language: \"\"",
    // MUST stay disabled: upstream apple-music-dl panics (nil pointer in
    // lyrics.TtmlToLrc) whenever a track has no TTML lyrics, aborting the whole
    // album download.
    "embed-lrc: false",
    "save-lrc-file: false",
    `embed-cover: ${embedCover ? "true" : "false"}`,
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
    // Headless jobs must exit after the final per-item error summary so the
    // Discogenius command queue can apply its bounded retry policy. Upstream
    // does the opposite when this is false: it prompts for Enter and retries
    // the entire album forever; stdin-at-EOF makes that loop spin immediately.
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
    `mv-max: ${resolveAppleVideoMaxHeight()}`,
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

/**
 * Wrapper decryption-sidecar login, fully self-contained (no docker socket,
 * no credentials in compose files). The wrapper container mounts
 * `wrapper-rootfs/data` from our config volume, so both containers see the
 * same directory: Discogenius writes `login_trigger.txt` (appleId:password)
 * and `2fa.txt`; the wrapper's supervisor entrypoint (provisioned below and
 * mounted by compose) consumes them, runs the login handshake, reports through
 * `login_status.json`, and restarts the decryption server. Credentials only
 * ever exist transiently in the trigger file, which the supervisor deletes as
 * soon as it reads it.
 */

const WRAPPER_ROOTFS_DATA_DIR = path.join(CONFIG_DIR, "providers", "apple-music", "wrapper-rootfs", "data");
export const WRAPPER_ENTRYPOINT_FILE = path.join(APPLE_MUSIC_PROVIDER_DIR, "wrapper-entrypoint.sh");

let loginStatus: "idle" | "logging_in" | "waiting_for_2fa" | "success" | "failed" = "idle";
let loginMessage = "";

// Bump the marker when the script changes so existing installs pick up fixes.
const WRAPPER_ENTRYPOINT_VERSION = "discogenius-wrapper-entrypoint v7";
const WRAPPER_ENTRYPOINT_SCRIPT = `#!/bin/bash
# ${WRAPPER_ENTRYPOINT_VERSION} — managed by Discogenius, manual edits are overwritten.
# Supervises the Apple Music decryption wrapper: serves decryption on ports
# 10020/20020 and performs a login handshake whenever the Discogenius UI drops
# a login_trigger.txt into the shared rootfs data directory.

DATA_DIR="/app/rootfs/data"
CRED_FILE="$DATA_DIR/login_trigger.txt"
TFA_FILE="$DATA_DIR/2fa.txt"
STATUS_FILE="$DATA_DIR/login_status.json"
LOG_FILE="$DATA_DIR/login.log"
SERVER_LOG="$DATA_DIR/server.log"
SESSION_MARKER="$DATA_DIR/data/com.apple.android.music/files/mpl_db/cookies.sqlitedb"

SERVER_PID=""
SERVER_RESTARTS=0
SERVER_RESTART_WINDOW_START=0

write_status() {
    printf '{"status": "%s", "message": "%s"}\\n' "$1" "$2" > "$STATUS_FILE"
}

start_server() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
    fi
    echo "[wrapper-manager] Starting decryption server on ports 10020/20020..."
    : > "$SERVER_LOG"
    ./wrapper -M 20020 -D 10020 -H 0.0.0.0 >> "$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
}

login_error_message() {
    local msg=""
    if [ -f "$LOG_FILE" ]; then
        msg=$(tail -n 3 "$LOG_FILE" | grep -v "2FA:" | tail -n 1 | tr -d '"' | tr -d '\\n')
    fi
    if [ -z "$msg" ]; then
        msg="Login failed (incorrect password or verification code)."
    fi
    printf '%s' "$msg"
}

echo "[wrapper-manager] Discogenius wrapper supervisor starting..."
if [ -f "$SESSION_MARKER" ]; then
    echo "[wrapper-manager] Active session detected."
    start_server
    write_status "success" "Decryption server is running with an active session."
else
    echo "[wrapper-manager] No session yet. Waiting for login from the Discogenius UI..."
    write_status "idle" "No active session. Authenticate from the Discogenius Auth page."
fi

while true; do
    if [ -f "$CRED_FILE" ]; then
        echo "[wrapper-manager] Login trigger detected."
        CREDS=$(cat "$CRED_FILE")
        rm -f "$CRED_FILE" "$TFA_FILE" "$TFA_FILE.consumed" "$LOG_FILE" "$DATA_DIR/code.txt" /app/code.txt

        if [ -n "$SERVER_PID" ]; then
            echo "[wrapper-manager] Stopping decryption server for login..."
            kill "$SERVER_PID" 2>/dev/null
            wait "$SERVER_PID" 2>/dev/null
            SERVER_PID=""
        fi

        write_status "logging_in" "Starting login handshake..."
        ./wrapper -L "$CREDS" -F > "$LOG_FILE" 2>&1 &
        LOGIN_PID=$!
        CREDS=""

        SENT_2FA_STATUS=false
        SENT_2FA_CODE=false
        TIMEOUT=0
        LOGIN_EXIT_CODE=0
        while kill -0 "$LOGIN_PID" 2>/dev/null; do
            if [ -f "$CRED_FILE" ]; then
                echo "[wrapper-manager] New login trigger detected. Aborting current login process..."
                kill "$LOGIN_PID" 2>/dev/null || true
                LOGIN_EXIT_CODE=2
                break
            fi

            if [ "$SENT_2FA_CODE" != true ] && [ -f "$TFA_FILE" ]; then
                echo "[wrapper-manager] 2FA code provided by UI. Handing it to the wrapper..."
                # The wrapper POLLS its own rootfs/data/2fa.txt for the code (its
                # prompt shows: echo -n <code> > rootfs/data/2fa.txt). Previously we
                # renamed 2fa.txt to .consumed ~1s after the UI wrote it, so the
                # wrapper never saw it and EVERY 2FA login timed out. Leave 2fa.txt
                # in place for the wrapper to consume, and also mirror the code to
                # code.txt for wrapper builds that read that path instead. Both are
                # cleared at the next login start.
                cp "$TFA_FILE" "$DATA_DIR/code.txt" 2>/dev/null || true
                SENT_2FA_CODE=true
            fi

            if [ "$SENT_2FA_STATUS" = false ] && grep -q "2FA: true" "$LOG_FILE" 2>/dev/null; then
                echo "[wrapper-manager] 2FA prompt detected."
                write_status "waiting_for_2fa" "Enter the 6-digit Apple ID verification code."
                SENT_2FA_STATUS=true
            fi

            if grep -qi "login failed" "$LOG_FILE" 2>/dev/null; then
                echo "[wrapper-manager] Detected 'login failed' in log. Killing process..."
                kill "$LOGIN_PID" 2>/dev/null || true
                LOGIN_EXIT_CODE=1
                break
            fi

            sleep 1
            TIMEOUT=$((TIMEOUT+1))
            if [ "$TIMEOUT" -gt 120 ]; then
                echo "[wrapper-manager] Login handshake timed out. Killing process..."
                kill "$LOGIN_PID" 2>/dev/null || true
                LOGIN_EXIT_CODE=1
                break
            fi
        done

        wait "$LOGIN_PID" 2>/dev/null
        WAIT_CODE=$?
        if [ "$LOGIN_EXIT_CODE" -eq 0 ]; then
            LOGIN_EXIT_CODE=$WAIT_CODE
        fi
        # A successful login resets the crash-loop guard for the fresh session.
        SERVER_RESTARTS=0

        if [ "$LOGIN_EXIT_CODE" -eq 2 ]; then
            continue
        fi

        if [ "$LOGIN_EXIT_CODE" -eq 0 ] && [ -f "$SESSION_MARKER" ]; then
            echo "[wrapper-manager] Login successful."
            write_status "success" "Login completed. Decryption server is running."
            start_server
        else
            ERR_MSG=$(login_error_message)
            echo "[wrapper-manager] Login failed: $ERR_MSG"
            write_status "failed" "$ERR_MSG"
            if [ -f "$SESSION_MARKER" ]; then
                start_server
            fi
        fi
    fi

    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "[wrapper-manager] Decryption server died."
        NOW=$(date +%s)
        if [ $((NOW - SERVER_RESTART_WINDOW_START)) -gt 120 ]; then
            SERVER_RESTART_WINDOW_START=$NOW
            SERVER_RESTARTS=0
        fi
        SERVER_RESTARTS=$((SERVER_RESTARTS + 1))
        # Session files are NEVER deleted automatically: a CKC/Sign-In error on
        # one request (commonly an Atmos/MV key the session tier cannot serve)
        # does not invalidate the session for everything else.
        if tail -n 15 "$SERVER_LOG" 2>/dev/null | grep -Eqi "Sign In|Invalid CKC"; then
            write_status "failed" "Apple rejected a decryption request (Sign-In/CKC). If downloads keep failing, re-authenticate from the Auth page."
        fi
        if [ "$SERVER_RESTARTS" -gt 5 ]; then
            echo "[wrapper-manager] Server crash-looping ($SERVER_RESTARTS in 120s). Pausing restarts until the next login."
            write_status "failed" "Decryption server is crash-looping. Re-authenticate from the Auth page to restart it."
            SERVER_PID=""
        else
            echo "[wrapper-manager] Restarting..."
            start_server
        fi
    fi

    sleep 2
done
`;

/**
 * Provision (or refresh) the supervisor entrypoint the compose file mounts
 * into the wrapper sidecar. Runs at credential sync/boot so fresh deployments
 * work without the repo checked out; version-marked so script fixes roll out.
 */
export function ensureWrapperEntrypointScript(): void {
  try {
    ensureDir(APPLE_MUSIC_PROVIDER_DIR);
    const current = fs.existsSync(WRAPPER_ENTRYPOINT_FILE)
      ? fs.readFileSync(WRAPPER_ENTRYPOINT_FILE, "utf-8")
      : "";
    if (!current.includes(WRAPPER_ENTRYPOINT_VERSION)) {
      fs.writeFileSync(WRAPPER_ENTRYPOINT_FILE, WRAPPER_ENTRYPOINT_SCRIPT, { encoding: "utf-8", mode: 0o755 });
    }
  } catch (error) {
    console.error("[APPLE-MUSIC-AUTH] Failed to provision wrapper entrypoint script:", error);
  }
}

export function getWrapperLoginStatus(): { status: string; message: string } {
  try {
    const statusPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "login_status.json");
    if (fs.existsSync(statusPath)) {
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      if (parsed && typeof parsed === "object" && "status" in parsed && "message" in parsed) {
        return { status: String(parsed.status), message: String(parsed.message) };
      }
    }
  } catch {
    // Fall back to the in-memory state below.
  }
  return { status: loginStatus, message: loginMessage };
}

/**
 * Hand the Apple ID credentials to the running wrapper sidecar through the
 * shared rootfs volume. The credentials are never persisted by Discogenius;
 * the supervisor deletes the trigger file the moment it reads it.
 */
export function startWrapperLogin(credentials: { appleId: string; password: string }): void {
  const appleId = String(credentials.appleId || "").trim();
  const password = String(credentials.password || "");
  if (!appleId || !password) {
    loginStatus = "failed";
    loginMessage = "Apple ID and password are required for the wrapper login.";
    return;
  }

  ensureWrapperEntrypointScript();

  const tfaPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "2fa.txt");
  const triggerPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "login_trigger.txt");
  const statusPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "login_status.json");

  try {
    fs.mkdirSync(WRAPPER_ROOTFS_DATA_DIR, { recursive: true });
    fs.rmSync(tfaPath, { force: true });
    fs.rmSync(statusPath, { force: true });

    loginStatus = "logging_in";
    loginMessage = "Login request sent to the decryption wrapper...";
    fs.writeFileSync(statusPath, JSON.stringify({ status: loginStatus, message: loginMessage }), "utf-8");
    fs.writeFileSync(triggerPath, `${appleId}:${password}`, { encoding: "utf-8", mode: 0o600 });
  } catch (err: any) {
    loginStatus = "failed";
    loginMessage = `Failed to hand credentials to the wrapper: ${err.message}`;
  }
}

export function submitWrapper2fa(code: string): void {
  const tfaPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "2fa.txt");
  try {
    fs.mkdirSync(WRAPPER_ROOTFS_DATA_DIR, { recursive: true });
    fs.writeFileSync(tfaPath, code.trim(), "utf-8");
    loginMessage = "2FA code submitted. Authenticating...";
  } catch (err: any) {
    loginStatus = "failed";
    loginMessage = `Failed to submit 2FA code: ${err.message}`;
  }
}
