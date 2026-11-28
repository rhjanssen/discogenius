import dns from "node:dns";
import fs from "fs";
import net from "node:net";
import path from "path";
import { CONFIG_DIR, Config } from "../../config/config.js";
import { configuredVideoMaxHeight } from "../provider-quality.js";
import {
  providerNeedsReauth,
  recordProviderAuthFailure,
  recordProviderAuthOk,
  readProviderAuthPublic,
  type ProviderAuthPublic,
  APPLE_WRAPPER_STUCK_MESSAGE,
} from "../provider-auth-state.js";

export { APPLE_WRAPPER_STUCK_MESSAGE };

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

/**
 * Host the OSS downloader uses to reach the FairPlay wrapper.
 *
 * Compose used to share Discogenius' network namespace so `127.0.0.1:10020`
 * worked. That killed the wrapper session whenever the API container was
 * recreated. The wrapper now binds `0.0.0.0` on its own network, so Docker
 * jobs talk to `apple-music-wrapper`. Override with APPLE_MUSIC_WRAPPER_HOST
 * for host networking or a renamed service.
 */
export function resolveAppleWrapperHost(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.APPLE_MUSIC_WRAPPER_HOST ?? "").trim();
  if (override) return override;
  return String(env.DOCKER ?? "").toLowerCase() === "true" ? "apple-music-wrapper" : "127.0.0.1";
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
  let configured = "uhd";
  try {
    configured = String(Config.getQualityConfig()?.video_quality || "uhd").toLowerCase();
  } catch { /* config unavailable during early bootstrap — keep the default */ }
  return configuredVideoMaxHeight(configured);
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
    `decrypt-m3u8-port: "${resolveAppleWrapperHost()}:10020"`,
    `get-m3u8-port: "${resolveAppleWrapperHost()}:20020"`,
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
 * and `2fa.txt`; the wrapper's supervisor entrypoint (provisioned below into
 * that same data dir) consumes them, runs the login handshake, reports through
 * `login_status.json`, and restarts the decryption server. Credentials only
 * ever exist transiently in the trigger file, which the supervisor deletes as
 * soon as it reads it.
 *
 * The supervisor script lives INSIDE the shared data dir on purpose. Compose
 * bind-mounts that directory, and a directory mount is immune to Docker's
 * "bind-mount a not-yet-existent file" trap: if you mount a host *file* that
 * does not exist when the sidecar starts, Docker silently creates an empty
 * *directory* in its place, so `bash <script>` fails and the sidecar breaks
 * permanently until it is recreated. `depends_on` only waits for Discogenius to
 * start (not to finish booting and write the script), so that trap fired on
 * every fresh deploy. The paired compose entrypoint is a tiny static bootstrap
 * that waits for this script to appear in the data dir and then execs it, so a
 * fresh deploy self-heals without a manual recreate.
 */

const WRAPPER_ROOTFS_DATA_DIR = path.join(CONFIG_DIR, "providers", "apple-music", "wrapper-rootfs", "data");
export const WRAPPER_ENTRYPOINT_FILE = path.join(WRAPPER_ROOTFS_DATA_DIR, "wrapper-entrypoint.sh");
/** Pre-2.6.8 location: a bind-mounted file, which caused the phantom-dir trap. */
const LEGACY_WRAPPER_ENTRYPOINT_FILE = path.join(APPLE_MUSIC_PROVIDER_DIR, "wrapper-entrypoint.sh");

let loginStatus: "idle" | "logging_in" | "waiting_for_2fa" | "success" | "failed" = "idle";
let loginMessage = "";

// Bump the marker when the script changes so existing installs pick up fixes.
export const WRAPPER_ENTRYPOINT_VERSION = "discogenius-wrapper-entrypoint v14";
export const WRAPPER_ENTRYPOINT_SCRIPT = `#!/bin/bash
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
# Discogenius drops this file right before an Apple download when the
# decryption ports do not answer: the wrapper can hang with its process alive,
# which the liveness check below never notices.
RESTART_FILE="$DATA_DIR/restart_server.txt"

SERVER_PID=""
SERVER_RESTARTS=0
SERVER_RESTART_WINDOW_START=0

# The wrapper's Android libc stores a mutex owner's thread id in 16 bits, so a
# wrapper whose thread ids pass 65535 in this container's PID namespace
# deadlocks in its loader and never opens the decryption ports. Keep the
# supervisor fork-free while idle (pause instead of sleep) and, when the
# namespace has used too many ids, exit so Docker restarts the container with a
# fresh PID namespace. The session survives on the data volume.
exec {PAUSE_FD}<> <(:)
pause() {
    read -r -t "$1" -u "$PAUSE_FD" _ || true
}

exit_if_pid_namespace_exhausted() {
    local last_pid=0
    read -r last_pid < /proc/sys/kernel/ns_last_pid 2>/dev/null || return 0
    if [ "$last_pid" -gt 60000 ]; then
        echo "[wrapper-manager] PID namespace at $last_pid (wrapper deadlocks past 65535). Exiting so Docker restarts the container."
        exit 75
    fi
}

write_status() {
    printf '{"status": "%s", "message": "%s"}\\n' "$1" "$2" > "$STATUS_FILE.tmp"
    mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

ports_bound() {
    # 0A is LISTEN. TIME_WAIT (06) must not count, or a finished server can never bind again.
    if awk 'toupper($4) == "0A" && $2 ~ /:(2724|4E34)$/ { found=1; exit 0 } END { if (!found) exit 1 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
        return 0
    fi
    if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' 2>/dev/null; then
        return 0
    fi
    if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' 2>/dev/null; then
        return 0
    fi
    return 1
}

stop_server() {
    if [ -n "$SERVER_PID" ]; then
        kill -TERM "-$SERVER_PID" 2>/dev/null || true
        kill -9 "-$SERVER_PID" 2>/dev/null || true
        kill -9 "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
    fi
    pkill -9 -f "wrapper.*-M 20020" 2>/dev/null || true
    local waited=0
    while ports_bound && [ "$waited" -lt 10 ]; do
        pause 1
        waited=$((waited + 1))
    done
}

start_server() {
    stop_server
    if ports_bound; then
        if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' 2>/dev/null && \\
           timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' 2>/dev/null; then
            echo "[wrapper-manager] Ports 10020/20020 still bound and answering. Not starting a second server."
            if [ -f "$SESSION_MARKER" ]; then
                write_status "success" "Decryption server is running with an active session."
            fi
            return 0
        fi
        echo "[wrapper-manager] Warning: ports 10020/20020 still bound after 10s wait. Not starting a second server."
        return 1
    fi
    exit_if_pid_namespace_exhausted
    echo "[wrapper-manager] Starting decryption server on ports 10020/20020..."
    : > "$SERVER_LOG"
    setsid ./wrapper -M 20020 -D 10020 -H 0.0.0.0 >> "$SERVER_LOG" 2>&1 &
    SERVER_PID=$!

    # Verify that ports 10020 and 20020 accept and answer within ~15s.
    # A TCP connect with a 1s timeout is the "answers" check, which catches
    # a full accept backlog or hanging socket, since the decrypt protocol has no ping.
    local verified=0
    for i in $(seq 1 15); do
        pause 1
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "[wrapper-manager] Decryption server process exited during startup."
            break
        fi
        if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' 2>/dev/null && \
           timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' 2>/dev/null; then
            verified=1
            break
        fi
    done

    if [ "$verified" -eq 1 ]; then
        echo "[wrapper-manager] Decryption server ready (ports 10020 and 20020 accepting connections)."
        if [ -f "$SESSION_MARKER" ]; then
            write_status "success" "Decryption server is running with an active session."
        fi
        return 0
    fi

    echo "[wrapper-manager] Decryption server failed readiness check (ports 10020/20020 not answering within 15s)."
    stop_server
    NOW=$(date +%s)
    if [ $((NOW - SERVER_RESTART_WINDOW_START)) -gt 120 ]; then
        SERVER_RESTART_WINDOW_START=$NOW
        SERVER_RESTARTS=0
    fi
    SERVER_RESTARTS=$((SERVER_RESTARTS + 1))
    if [ "$SERVER_RESTARTS" -gt 5 ]; then
        echo "[wrapper-manager] Server crash-looping ($SERVER_RESTARTS in 120s). Pausing restarts until the next login."
        if [ -f "$SESSION_MARKER" ]; then
            write_status "failed" "Decryption server is crash-looping. Restart the wrapper container (docker compose restart apple-music-wrapper)."
        else
            write_status "failed" "Decryption server is crash-looping. Re-authenticate from the Auth page to restart it."
        fi
        SERVER_PID=""
        return 1
    else
        echo "[wrapper-manager] Retrying server start..."
        start_server
    fi
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
# A restart file from the previous process is stale. Consuming it here would
# kill the server this process is about to start.
rm -f "$RESTART_FILE"
stop_server
if [ -f "$SESSION_MARKER" ]; then
    echo "[wrapper-manager] Active session detected."
    start_server
else
    echo "[wrapper-manager] No session yet. Waiting for login from the Discogenius UI..."
    write_status "idle" "No active session. Authenticate from the Discogenius Auth page."
fi

while true; do
    if [ -f "$RESTART_FILE" ] && [ ! -f "$CRED_FILE" ]; then
        rm -f "$RESTART_FILE"
        if [ -f "$SESSION_MARKER" ]; then
            echo "[wrapper-manager] Restart requested by Discogenius (decryption ports unreachable). Restarting server..."
            SERVER_RESTARTS=0
            start_server
        else
            echo "[wrapper-manager] Restart requested but there is no session; waiting for login."
        fi
    fi

    if [ -f "$CRED_FILE" ]; then
        exit_if_pid_namespace_exhausted
        echo "[wrapper-manager] Login trigger detected."
        CREDS=$(cat "$CRED_FILE")
        rm -f "$CRED_FILE" "$TFA_FILE" "$TFA_FILE.consumed" "$LOG_FILE" "$DATA_DIR/code.txt" /app/code.txt

        echo "[wrapper-manager] Stopping decryption server for login..."
        stop_server

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

            pause 1
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
            if [ -f "$SESSION_MARKER" ]; then
                write_status "failed" "Decryption server is crash-looping. Restart the wrapper container (docker compose restart apple-music-wrapper)."
            else
                write_status "failed" "Decryption server is crash-looping. Re-authenticate from the Auth page to restart it."
            fi
            SERVER_PID=""
        else
            echo "[wrapper-manager] Restarting..."
            start_server
        fi
    fi

    pause 2
done
`;

/**
 * Provision (or refresh) the supervisor entrypoint the compose file mounts
 * into the wrapper sidecar. Runs at credential sync/boot so fresh deployments
 * work without the repo checked out; version-marked so script fixes roll out.
 */
export function ensureWrapperEntrypointScript(): void {
  try {
    // Written into the shared data dir (see the WRAPPER_ENTRYPOINT_FILE note):
    // a directory mount the sidecar's bootstrap waits on, so it can never be
    // clobbered by Docker's phantom-directory trap.
    ensureDir(WRAPPER_ROOTFS_DATA_DIR);
    const current = fs.existsSync(WRAPPER_ENTRYPOINT_FILE) && fs.statSync(WRAPPER_ENTRYPOINT_FILE).isFile()
      ? fs.readFileSync(WRAPPER_ENTRYPOINT_FILE, "utf-8")
      : "";
    if (!current.includes(WRAPPER_ENTRYPOINT_VERSION)) {
      // Atomic write: the bootstrap greps for a non-empty file, so never let it
      // observe a half-written script (matters on version-bump rewrites).
      const tmpPath = `${WRAPPER_ENTRYPOINT_FILE}.tmp`;
      fs.writeFileSync(tmpPath, WRAPPER_ENTRYPOINT_SCRIPT, { encoding: "utf-8", mode: 0o755 });
      fs.renameSync(tmpPath, WRAPPER_ENTRYPOINT_FILE);
    }
    cleanupLegacyWrapperEntrypoint();
  } catch (error) {
    console.error("[APPLE-MUSIC-AUTH] Failed to provision wrapper entrypoint script:", error);
  }
}

/**
 * Best-effort removal of the pre-2.6.8 entrypoint artifact. The old compose
 * bind-mounted `providers/apple-music/wrapper-entrypoint.sh` as a file; on a
 * fresh deploy Docker created an empty directory there instead, which is the
 * exact thing that stranded logins at "Login request sent to the decryption
 * wrapper...". We only ever drop an empty phantom dir or a stale managed file —
 * never anything the operator might still be using.
 */
function cleanupLegacyWrapperEntrypoint(): void {
  try {
    if (!fs.existsSync(LEGACY_WRAPPER_ENTRYPOINT_FILE)) {
      return;
    }
    const stat = fs.statSync(LEGACY_WRAPPER_ENTRYPOINT_FILE);
    if (stat.isDirectory()) {
      if (fs.readdirSync(LEGACY_WRAPPER_ENTRYPOINT_FILE).length === 0) {
        fs.rmdirSync(LEGACY_WRAPPER_ENTRYPOINT_FILE);
      }
    } else {
      fs.rmSync(LEGACY_WRAPPER_ENTRYPOINT_FILE, { force: true });
    }
  } catch {
    // A leftover legacy artifact is harmless; the new data-dir script wins.
  }
}

export const APPLE_WRAPPER_SESSION_MARKER = path.join(WRAPPER_ROOTFS_DATA_DIR, "data", "com.apple.android.music", "files", "mpl_db", "cookies.sqlitedb");

export function hasAppleWrapperSession(): boolean {
  try {
    return fs.existsSync(APPLE_WRAPPER_SESSION_MARKER);
  } catch {
    return false;
  }
}

let probeRestartCount = 0;
let lastProbeRestartAt = 0;

export function hasAttemptedWrapperRestart(authRow?: ProviderAuthPublic | null): boolean {
  const row = authRow !== undefined ? authRow : readProviderAuthPublic("apple-music");
  return row?.lastError === APPLE_WRAPPER_STUCK_MESSAGE;
}

export function recordWrapperRestartRequested(now = Date.now()): void {
  lastProbeRestartAt = now;
  probeRestartCount++;
}

export function resetAppleWrapperProbeBackoff(): void {
  probeRestartCount = 0;
  lastProbeRestartAt = 0;
}

export function getAppleWrapperProbeBackoff(): { count: number; lastAt: number } {
  return { count: probeRestartCount, lastAt: lastProbeRestartAt };
}

export function resetAppleWrapperRestartState(): void {
  resetAppleWrapperProbeBackoff();
}

export function getAppleWrapperRestartState(): { count: number; lastAt: number } {
  return getAppleWrapperProbeBackoff();
}

export const APPLE_WRAPPER_RESTART_BACKOFF_MIN_MS = 5 * 60 * 1000;
export const APPLE_WRAPPER_RESTART_BACKOFF_MAX_MS = 15 * 60 * 1000;

export function calculateWrapperRestartBackoffMs(attempt: number): number {
  if (attempt <= 1) return APPLE_WRAPPER_RESTART_BACKOFF_MIN_MS;
  return Math.min(APPLE_WRAPPER_RESTART_BACKOFF_MIN_MS * attempt, APPLE_WRAPPER_RESTART_BACKOFF_MAX_MS);
}

export type AppleWrapperLoginStatus = { status: string; message: string };

export function reconcileWrapperLoginStatus(
  saved: AppleWrapperLoginStatus,
  readiness: {
    decryptPortOpen: boolean;
    m3u8PortOpen: boolean;
    successAgeMs?: number;
    hasSession?: boolean;
    restartAttempted?: boolean;
    authRow?: ProviderAuthPublic | null;
  },
): AppleWrapperLoginStatus {
  // A successful login is durable state, but it does not prove the sidecar is
  // running now. This file survives Compose stops and app/container restarts.
  // Reporting the saved success as live sent users into downloads that could
  // only fail with a low-level connection error.
  if (saved.status === "success" && (!readiness.decryptPortOpen || !readiness.m3u8PortOpen)) {
    // The supervisor writes success immediately after forking the server. Give
    // the two listeners one UI polling interval to bind instead of turning a
    // healthy container restart into a false login failure.
    if ((readiness.successAgeMs ?? Number.POSITIVE_INFINITY) < 10_000) {
      return {
        status: "logging_in",
        message: "The saved Apple Music session is active and the decryption wrapper is starting...",
      };
    }
    const hasSession = readiness.hasSession ?? hasAppleWrapperSession();
    const restartAttempted = readiness.restartAttempted ?? hasAttemptedWrapperRestart(readiness.authRow);
    if (hasSession && restartAttempted) {
      return {
        status: "failed",
        message: APPLE_WRAPPER_STUCK_MESSAGE,
      };
    }
    return {
      status: "failed",
      message: "The saved Apple Music wrapper session is present, but the decryption wrapper is not reachable. Start it with `docker compose up -d apple-music-wrapper`. Re-authenticate only if the wrapper then reports a session error.",
    };
  }
  return saved;
}

export type TcpPortLookup = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

const appleWrapperProcessStartedAt = Date.now();
/** A deploy's sidecar is still binding while Discogenius is already serving. */
export const APPLE_WRAPPER_STARTUP_GRACE_MS = 20_000;

export function isAppleWrapperStartupGrace(now = Date.now()): boolean {
  return now >= appleWrapperProcessStartedAt
    && now - appleWrapperProcessStartedAt < APPLE_WRAPPER_STARTUP_GRACE_MS;
}

/**
 * Succeeds when any resolved address accepts. Docker DNS for the wrapper
 * returns IPv6 first, and the sidecar listens on IPv4 only. A refused or
 * hanging address must not cancel, or outwait, an address that already accepted.
 */
export function checkTcpPort(
  host: string,
  port: number,
  timeoutMs = 3_000,
  lookup: TcpPortLookup = dns.lookup,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sockets: net.Socket[] = [];
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (settled) return;
      const targets = !err && addresses.length > 0 ? [...addresses] : [{ address: host, family: 4 }];
      // Docker DNS can answer with only the IPv6 address. The wrapper listens
      // on IPv4, so also ask the OS for an A record of the original hostname.
      if (net.isIP(host) === 0 && !targets.some((entry) => entry.family === 4)) {
        targets.push({ address: host, family: 4 });
      }
      if (targets.length === 0) {
        finish(false);
        return;
      }
      let pending = targets.length;
      for (const entry of targets) {
        const socket = net.createConnection({
          host: entry.address,
          port,
          family: entry.family === 6 ? 6 : 4,
        });
        sockets.push(socket);
        let doneOnce = false;
        const done = (open: boolean) => {
          if (doneOnce || settled) return;
          doneOnce = true;
          if (open) {
            finish(true);
            return;
          }
          pending -= 1;
          if (pending === 0) finish(false);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
      }
    });
  });
}

function checkWrapperPort(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return checkTcpPort(host, port, timeoutMs);
}

export async function getWrapperLoginStatus(deps: {
  checkPort?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  now?: number;
} = {}): Promise<AppleWrapperLoginStatus> {
  let saved: AppleWrapperLoginStatus = { status: loginStatus, message: loginMessage };
  let savedAtMs: number | null = null;
  try {
    const statusPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "login_status.json");
    if (fs.existsSync(statusPath)) {
      savedAtMs = fs.statSync(statusPath).mtimeMs;
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      if (parsed && typeof parsed === "object" && "status" in parsed && "message" in parsed) {
        saved = { status: String(parsed.status), message: String(parsed.message) };
      }
    }
  } catch {
    // Fall back to the in-memory state below.
  }

  // During login the wrapper deliberately stops its server while it waits for
  // Apple and possibly 2FA, so port readiness only qualifies a claimed
  // success. It must not turn an in-progress login into a false failure.
  if (saved.status !== "success") return saved;
  const host = resolveAppleWrapperHost();
  const checkPort = deps.checkPort ?? checkWrapperPort;
  const [decryptPortOpen, m3u8PortOpen] = await Promise.all([
    checkPort(host, 10020),
    checkPort(host, 20020),
  ]);
  // The saved session file is old across deploys. A sidecar that is still
  // binding for a few seconds is not a hold.
  if (
    saved.status === "success"
    && (!decryptPortOpen || !m3u8PortOpen)
    && hasAppleWrapperSession()
    && isAppleWrapperStartupGrace(deps.now)
  ) {
    return {
      status: "logging_in",
      message: "The saved Apple Music session is active and the decryption wrapper is starting...",
    };
  }
  const reconciled = reconcileWrapperLoginStatus(saved, {
    decryptPortOpen,
    m3u8PortOpen,
    successAgeMs: savedAtMs == null ? undefined : Math.max(0, Date.now() - savedAtMs),
    hasSession: hasAppleWrapperSession(),
    restartAttempted: hasAttemptedWrapperRestart(),
  });
  // Apple jobs held because the wrapper stopped answering resume as soon as
  // the decryption server answers again (after a re-login or manual restart).
  if (reconciled.status === "success" && decryptPortOpen && m3u8PortOpen) {
    resetAppleWrapperRestartState();
    if (providerNeedsReauth("apple-music")) {
      await recordProviderAuthOk("apple-music", { probedAt: new Date().toISOString() }).catch(() => undefined);
    }
  } else if ((!decryptPortOpen || !m3u8PortOpen) && loadStoredAppleMusicToken()) {
    await recordProviderAuthFailure("apple-music", reconciled.message).catch(() => undefined);
  }
  return reconciled;
}

export const APPLE_DECRYPT_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const APPLE_DECRYPT_FAILURE_THRESHOLD = 2;

let decryptFailureTimestamps: number[] = [];

export function resetAppleDecryptFailuresForTests(): void {
  decryptFailureTimestamps = [];
}

export function recordAppleDecryptFailureTimestamp(now = Date.now()): number {
  const cutoff = now - APPLE_DECRYPT_FAILURE_WINDOW_MS;
  decryptFailureTimestamps = decryptFailureTimestamps.filter((t) => t > cutoff);
  decryptFailureTimestamps.push(now);
  return decryptFailureTimestamps.length;
}

export function hasRepeatedAppleDecryptFailures(now = Date.now()): boolean {
  const cutoff = now - APPLE_DECRYPT_FAILURE_WINDOW_MS;
  decryptFailureTimestamps = decryptFailureTimestamps.filter((t) => t > cutoff);
  return decryptFailureTimestamps.length >= APPLE_DECRYPT_FAILURE_THRESHOLD;
}

export type AppleDecryptFailureResult = {
  held: boolean;
  reason?: string;
  code?: "wrapper_unreachable" | "session_expired";
};

export function checkWrapperSessionOrLogErrors(): boolean {
  try {
    const statusPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "login_status.json");
    if (fs.existsSync(statusPath)) {
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      if (parsed && typeof parsed === "object" && parsed.status === "failed") {
        if (isWrapperSessionOrLoginError({ status: String(parsed.status), message: String(parsed.message || "") })) {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const serverLogPath = path.join(WRAPPER_ROOTFS_DATA_DIR, "server.log");
    if (fs.existsSync(serverLogPath)) {
      const stat = fs.statSync(serverLogPath);
      const readSize = Math.min(stat.size, 32_768);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(serverLogPath, "r");
      try {
        fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      } finally {
        fs.closeSync(fd);
      }
      const text = buffer.toString("utf-8");
      if (/sign[\s-]?in|invalid ckc|\bckc\b/i.test(text)) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

export const APPLE_WRAPPER_SESSION_FAILURE_PATTERN =
  /reading response from device|device:\s*eof|\bckc\b|decrypt failed|sign[\s-]?in|unauthor|invalid.*(?:token|session|user)|forbidden|\b401\b|\b403\b/i;

export async function handleAppleDecryptFailure(
  errorDetail: string,
  options: {
    checkPorts?: boolean;
    portsOpen?: boolean;
    now?: number;
    hasSessionError?: boolean;
  } = {},
): Promise<AppleDecryptFailureResult> {
  const count = recordAppleDecryptFailureTimestamp(options.now);

  const sessionError = options.hasSessionError !== undefined
    ? options.hasSessionError
    : (APPLE_WRAPPER_SESSION_FAILURE_PATTERN.test(errorDetail || "") || checkWrapperSessionOrLogErrors());

  if (sessionError) {
    const message = `Apple Music decryption failed because the wrapper session expired or Apple rejected it. Re-authenticate Apple Music from the Auth page. [detail: ${errorDetail}]`;
    await recordProviderAuthFailure("apple-music", message);
    return { held: true, reason: message, code: "session_expired" };
  }

  const host = resolveAppleWrapperHost();
  let portsOpen = options.portsOpen;
  if (portsOpen === undefined && options.checkPorts !== false) {
    try {
      const [dOpen, mOpen] = await Promise.all([
        checkWrapperPort(host, 10020, 1500),
        checkWrapperPort(host, 20020, 1500),
      ]);
      portsOpen = dOpen && mOpen;
    } catch {
      portsOpen = false;
    }
  }

  if (portsOpen === false) {
    const message = `Apple Music decryption wrapper is not answering (ports 10020/20020 not answering); Apple downloads are held until it responds. [detail: ${errorDetail}]`;
    await recordProviderAuthFailure("apple-music", message);
    return { held: true, reason: message, code: "wrapper_unreachable" };
  }

  if (count >= APPLE_DECRYPT_FAILURE_THRESHOLD) {
    const message = `Apple Music decryption failed repeatedly (${count} failures in ${Math.round(APPLE_DECRYPT_FAILURE_WINDOW_MS / 60000)}m): ${errorDetail}`;
    await recordProviderAuthFailure("apple-music", message);
    return { held: true, reason: message, code: "session_expired" };
  }

  return { held: false };
}

export async function handleAppleDecryptSuccess(): Promise<void> {
  decryptFailureTimestamps = [];
  resetAppleWrapperProbeBackoff();
  if (loadStoredAppleMusicToken()) {
    await recordProviderAuthOk("apple-music", { probedAt: new Date().toISOString() });
  }
}

/**
 * Health probe checking wrapper reachability and recent decrypt failures.
 * Sets Apple to non-ok when ports are unreachable or failures repeat in a window,
 * and sets status back to ok with lastOkAt updated when reachable.
 */
export async function probeAppleWrapperHealth(
  deps: {
    checkPort?: (host: string, port: number) => Promise<boolean>;
    hasToken?: () => boolean;
    hasSession?: () => boolean;
    restartAttempted?: () => boolean;
    readAuth?: () => ProviderAuthPublic | null;
  } = {},
): Promise<{ ok: boolean; status: "ok" | "needs_reauth" | "idle"; message: string }> {
  const hasToken = deps.hasToken ? deps.hasToken() : Boolean(loadStoredAppleMusicToken());
  if (!hasToken) {
    return { ok: true, status: "idle", message: "Apple Music is not configured." };
  }
  const host = resolveAppleWrapperHost();
  const check = deps.checkPort ?? checkWrapperPort;
  const [decryptPortOpen, m3u8PortOpen] = await Promise.all([
    check(host, 10020),
    check(host, 20020),
  ]);
  if (!decryptPortOpen || !m3u8PortOpen) {
    const missing: string[] = [];
    if (!decryptPortOpen) missing.push("10020");
    if (!m3u8PortOpen) missing.push("20020");
    const hasSession = deps.hasSession ? deps.hasSession() : hasAppleWrapperSession();
    const readAuth = deps.readAuth ? deps.readAuth : () => readProviderAuthPublic("apple-music");
    const restartAttempted = deps.restartAttempted
      ? deps.restartAttempted()
      : hasAttemptedWrapperRestart(readAuth());
    const message = hasSession && restartAttempted
      ? APPLE_WRAPPER_STUCK_MESSAGE
      : `Apple Music decryption wrapper is unreachable (ports ${missing.join(", ")} not answering). Start it with docker compose up -d apple-music-wrapper.`;
    await recordProviderAuthFailure("apple-music", message);
    return { ok: false, status: "needs_reauth", message };
  }
  if (hasRepeatedAppleDecryptFailures()) {
    const message = `Apple Music decryption failed repeatedly in the last ${Math.round(APPLE_DECRYPT_FAILURE_WINDOW_MS / 60000)} minutes.`;
    await recordProviderAuthFailure("apple-music", message);
    return { ok: false, status: "needs_reauth", message };
  }
  resetAppleWrapperProbeBackoff();
  await recordProviderAuthOk("apple-music", { probedAt: new Date().toISOString() });
  return { ok: true, status: "ok", message: "Decryption wrapper is reachable." };
}

export function isWrapperSessionOrLoginError(status: AppleWrapperLoginStatus): boolean {
  if (status.status !== "failed") return false;
  const msg = status.message || "";
  if (/crash-loop|unreachable|not answering|readiness check/i.test(msg)) return false;
  if (msg.includes(APPLE_WRAPPER_STUCK_MESSAGE)) return false;
  return /sign[- ]?in|invalid ckc|session expired|login failed|verification code|incorrect password|cookies\.sqlitedb/i.test(msg);
}

export function isAuthRowSessionExpired(lastError?: string | null): boolean {
  if (!lastError) return false;
  if (lastError.includes(APPLE_WRAPPER_STUCK_MESSAGE)) return false;
  if (/crash-loop|unreachable|not answering|readiness check/i.test(lastError)) return false;
  return /sign[- ]?in|invalid ckc|session expired|re-authenticate/i.test(lastError);
}

/** Held Apple jobs are re-checked this often; no network when nothing is held. */
export const APPLE_WRAPPER_HOLD_PROBE_INTERVAL_MS = 2 * 60 * 1000;

let appleHoldProbeLoop: ReturnType<typeof setInterval> | null = null;

async function wrapperPortsOpen(
  checkPort: (host: string, port: number) => Promise<boolean> = checkWrapperPort,
): Promise<boolean> {
  const host = resolveAppleWrapperHost();
  const [decryptPortOpen, m3u8PortOpen] = await Promise.all([
    checkPort(host, 10020),
    checkPort(host, 20020),
  ]);
  return decryptPortOpen && m3u8PortOpen;
}

/**
 * Clears the Apple hold once the wrapper answers again. While Apple is held for
 * "wrapper not answering" (session exists and no expired-session error), it keeps
 * re-probing with backoff (5m -> 10m -> 15m) and re-requests a wrapper server restart.
 * A restart is not requested while this process is still in its startup grace:
 * the sidecar is often still binding then.
 */
export async function runAppleWrapperHoldProbe(
  deps: {
    needsReauth?: () => boolean;
    loginStatus?: () => Promise<AppleWrapperLoginStatus>;
    hasSession?: () => boolean;
    requestRestart?: () => boolean;
    now?: () => number;
    recordRestart?: (time?: number) => void;
    recordFailure?: (provider: string, message: string) => Promise<unknown>;
    recordOk?: (provider: string) => Promise<unknown>;
    readAuth?: () => ProviderAuthPublic | null;
    portsOpen?: () => Promise<boolean>;
  } = {},
): Promise<"idle" | "cleared" | "still_held"> {
  const needsReauth = deps.needsReauth ?? (() => providerNeedsReauth("apple-music"));
  if (!needsReauth()) return "idle";

  const readAuth = deps.readAuth ?? (() => readProviderAuthPublic("apple-music"));
  const authRow = readAuth();
  const portsOpen = deps.portsOpen ? await deps.portsOpen() : await wrapperPortsOpen();
  // A stuck or "not answering" hold is not a session expiry. Ports that accept
  // mean the saved failure is stale and the albums can download again.
  if (portsOpen && !isAuthRowSessionExpired(authRow?.lastError)) {
    const recordOk = deps.recordOk ?? ((provider: string) => recordProviderAuthOk(provider, { probedAt: new Date().toISOString() }));
    await recordOk("apple-music");
    resetAppleWrapperProbeBackoff();
    return "cleared";
  }

  const status = await (deps.loginStatus ?? getWrapperLoginStatus)();
  if (!needsReauth()) {
    resetAppleWrapperProbeBackoff();
    return "cleared";
  }

  const now = deps.now ? deps.now() : Date.now();
  if (isAppleWrapperStartupGrace(now)) return "still_held";

  // Apple is still held. Check if held for "wrapper not answering" vs a real session problem.
  // Check the wrapper status (status === "failed" with a session/login error, not crash-loop
  // or unreachable text) before restarting or overwriting.
  const hasSession = deps.hasSession ? deps.hasSession() : hasAppleWrapperSession();
  const isWrapperSessionFailure = isWrapperSessionOrLoginError(status);
  const isAuthSessionExpired = isAuthRowSessionExpired(authRow?.lastError);
  const isSessionProblem = isWrapperSessionFailure || isAuthSessionExpired;

  if (hasSession && !isSessionProblem) {
    // If a restart was previously requested and the wrapper is still held on this probe,
    // the previous restart didn't help: record the stuck message now.
    if (probeRestartCount > 0 && authRow?.lastError !== APPLE_WRAPPER_STUCK_MESSAGE) {
      const recordFailureFn = deps.recordFailure ?? recordProviderAuthFailure;
      await recordFailureFn("apple-music", APPLE_WRAPPER_STUCK_MESSAGE);
    }

    const backoffMs = calculateWrapperRestartBackoffMs(probeRestartCount);
    const shouldRestart = lastProbeRestartAt === 0 || (now - lastProbeRestartAt) >= backoffMs;

    if (shouldRestart) {
      const restartFn = deps.requestRestart ?? requestWrapperServerRestart;
      const recordRestartFn = deps.recordRestart ?? recordWrapperRestartRequested;

      restartFn();
      recordRestartFn(now);
      console.warn(
        `[APPLE] Wrapper not answering; requested server restart (attempt ${probeRestartCount}, next backoff in ${Math.round(calculateWrapperRestartBackoffMs(probeRestartCount) / 60000)}m).`,
      );
    }
  }

  return "still_held";
}

/** What the startup/interval tick should do. A healthy install must not be held while the sidecar is still binding. */
export function appleWrapperStartupProbeAction(
  needsReauth: boolean,
  hasToken: boolean,
  now = Date.now(),
): "hold" | "health" | "skip" {
  if (needsReauth) return "hold";
  if (!hasToken || isAppleWrapperStartupGrace(now)) return "skip";
  return "health";
}

export function startAppleWrapperHoldProbeLoop(): void {
  if (appleHoldProbeLoop) return;
  const tick = () => {
    const action = appleWrapperStartupProbeAction(
      providerNeedsReauth("apple-music"),
      Boolean(loadStoredAppleMusicToken()),
    );
    if (action === "hold") {
      void runAppleWrapperHoldProbe()
        .then((result) => {
          if (result === "cleared") console.log("[APPLE] Wrapper answers again; released held Apple downloads.");
        })
        .catch((error) => {
          console.error("[APPLE] Wrapper hold probe failed:", error instanceof Error ? error.message : "unknown");
        });
    } else if (action === "health") {
      void probeAppleWrapperHealth().catch((error) => {
        console.error("[APPLE] Wrapper health probe failed:", error instanceof Error ? error.message : "unknown");
      });
    }
  };
  tick();
  const graceLeft = appleWrapperProcessStartedAt + APPLE_WRAPPER_STARTUP_GRACE_MS - Date.now();
  if (graceLeft > 0) {
    const graceTimer = setTimeout(tick, graceLeft);
    graceTimer.unref?.();
  }
  appleHoldProbeLoop = setInterval(tick, APPLE_WRAPPER_HOLD_PROBE_INTERVAL_MS);
  appleHoldProbeLoop.unref?.();
}

export function stopAppleWrapperHoldProbeLoop(): void {
  if (!appleHoldProbeLoop) return;
  clearInterval(appleHoldProbeLoop);
  appleHoldProbeLoop = null;
}

/**
 * Ask the wrapper supervisor to kill and relaunch its decryption server.
 * Used right before an Apple download when ports 10020/20020 do not answer:
 * the wrapper can hang with its process still alive. Returns false when the
 * shared data directory is not writable (no supervisor to ask).
 */
export function requestWrapperServerRestart(): boolean {
  try {
    ensureWrapperEntrypointScript();
    fs.mkdirSync(WRAPPER_ROOTFS_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(WRAPPER_ROOTFS_DATA_DIR, "restart_server.txt"), new Date().toISOString(), "utf-8");
    return true;
  } catch {
    return false;
  }
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
