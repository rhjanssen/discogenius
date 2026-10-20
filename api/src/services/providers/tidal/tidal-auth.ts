import { withSqliteWriteGate } from "../../../database.js";
import { ProviderAuthError } from "../provider-auth-error.js";
import { providerNeedsReauth, recordProviderAuthFailure, recordProviderAuthOk } from "../provider-auth-state.js";
import fs from "fs";
import path from "path";
import { CONFIG_DIR, updateConfig } from "../../config/config.js";
import { clearTiddlAuth, syncTokenToTiddl } from "./tiddl.js";
import { resolveTidalAuthClientConfig } from "../../config/provider-client-config.js";

const TIDAL_AUTH_DIR = path.join(CONFIG_DIR, "providers", "tidal");
const TIDAL_AUTH_TOKEN_FILE = path.join(TIDAL_AUTH_DIR, "token.json");
const TIDAL_REFRESH_PAUSE_FILE = path.join(TIDAL_AUTH_DIR, "refresh-pause.json");
const TIDAL_AUTH_BASE = "https://auth.tidal.com/v1";
const TIDAL_API_BASE = "https://api.tidal.com/v1";
// TIDAL answers too-frequent refreshes with 403 abuse_detected. Retrying on
// the five-minute token interval keeps that block in place, so a refusal
// pauses further attempts. The pause escalates (30 min, 1 h, 2 h, 4 h) and is
// capped below the access-token lifetime: a pause longer than the token's
// remaining life guarantees an outage (18 Oct 2026: a 12 h pause let the token
// expire and every TIDAL download failed for 8 h). The stored token stays
// untouched while paused.
const TIDAL_ABUSE_BACKOFF_BASE_MS = 30 * 60 * 1000;
const TIDAL_ABUSE_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;
// A token that is not close to expiry is only refreshed again when the last
// successful refresh is at least this old. Callers force a refresh on any
// failed request (a 403/404 video probe, a missing manifest); without this
// floor a metadata pass refreshed a still-valid token every ~12 minutes and
// TIDAL flagged the account with abuse_detected.
export const TIDAL_MIN_FORCED_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Refresh proactively when the access token expires within this window.
export const TIDAL_REFRESH_EXPIRY_WINDOW_SECONDS = 25 * 60;
let tidalRefreshBlockedUntilMs = 0;
let tidalRefreshInFlight: Promise<TidalAuthToken | null> | null = null;

export function resetTidalRefreshBackoffForTests(): void {
    tidalRefreshBlockedUntilMs = 0;
    tidalRefreshInFlight = null;
    fs.rmSync(TIDAL_REFRESH_PAUSE_FILE, { force: true });
}

interface TidalRefreshPauseState {
    until: number;
    strikes: number;
    writtenAt: number;
}

function readTidalRefreshPause(): TidalRefreshPauseState {
    try {
        const parsed = JSON.parse(fs.readFileSync(TIDAL_REFRESH_PAUSE_FILE, "utf8")) as { until?: unknown; strikes?: unknown };
        const until = typeof parsed.until === "string" ? Date.parse(parsed.until) : Number.NaN;
        const strikes = typeof parsed.strikes === "number" && Number.isFinite(parsed.strikes) ? parsed.strikes : 1;
        const writtenAt = fs.statSync(TIDAL_REFRESH_PAUSE_FILE).mtimeMs;
        return { until: Number.isFinite(until) ? until : 0, strikes: Math.max(1, Math.floor(strikes)), writtenAt };
    } catch {
        return { until: 0, strikes: 0, writtenAt: 0 };
    }
}

export function isTidalRefreshPaused(now = Date.now()): boolean {
    const persisted = readTidalRefreshPause();
    // Clamp legacy/long pauses (the old 12 h value) to the cap, counted from
    // when the pause was written.
    const persistedUntil = Math.min(persisted.until, persisted.writtenAt + TIDAL_ABUSE_BACKOFF_MAX_MS);
    return now < Math.max(tidalRefreshBlockedUntilMs, persistedUntil);
}

export function tidalAbuseBackoffMs(strikes: number): number {
    const exponent = Math.max(0, Math.floor(strikes) - 1);
    return Math.min(TIDAL_ABUSE_BACKOFF_MAX_MS, TIDAL_ABUSE_BACKOFF_BASE_MS * 2 ** exponent);
}

function pauseTidalRefresh(now: number): number {
    const strikes = readTidalRefreshPause().strikes + 1;
    const untilMs = now + tidalAbuseBackoffMs(strikes);
    tidalRefreshBlockedUntilMs = untilMs;
    fs.mkdirSync(TIDAL_AUTH_DIR, { recursive: true });
    const temporary = `${TIDAL_REFRESH_PAUSE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ until: new Date(untilMs).toISOString(), strikes }));
    fs.renameSync(temporary, TIDAL_REFRESH_PAUSE_FILE);
    return untilMs - now;
}

function clearTidalRefreshPause(): void {
    tidalRefreshBlockedUntilMs = 0;
    fs.rmSync(TIDAL_REFRESH_PAUSE_FILE, { force: true });
}

function getTidalAuthClientConfig() {
    return resolveTidalAuthClientConfig(process.env);
}

export interface TidalAuthUser {
    userId: number;
    username: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    countryCode: string;
    picture?: string | null;
    nickname?: string | null;
}

export interface TidalAuthToken {
    access_token: string;
    refresh_token: string;
    token_type?: string;
    expires_at?: number;
    /** Epoch ms of the last successful refresh or login (not secret). */
    refreshed_at?: number;
    user?: TidalAuthUser;
}

interface TidalDeviceLoginState {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    interval: number;
}

let activeDeviceLogin: TidalDeviceLoginState | null = null;

function ensureAuthDir(): void {
    if (!fs.existsSync(TIDAL_AUTH_DIR)) {
        fs.mkdirSync(TIDAL_AUTH_DIR, { recursive: true });
    }
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

function buildTidalApiHeaders(accessToken: string): Record<string, string> {
    const tidalClient = getTidalAuthClientConfig();
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Tidal-Token": tidalClient.clientId,
        "User-Agent": tidalClient.authUserAgent,
    };
}

async function cacheAccountInfo(user: TidalAuthUser | undefined): Promise<void> {
    if (!user) {
        return;
    }

    try {
        await withSqliteWriteGate(() => updateConfig("account", {
            userId: user.userId,
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            fullName: user.fullName,
            countryCode: user.countryCode,
            picture: user.picture,
        }), "tidal:cache-account");
    } catch (error) {
        console.warn("[TIDAL-AUTH] Non-fatal: Failed to cache account info in config:", error);
    }
}

async function enrichTokenUser(token: TidalAuthToken): Promise<TidalAuthToken> {
    const sessionResponse = await fetch(`${TIDAL_API_BASE}/sessions`, {
        headers: buildTidalApiHeaders(token.access_token),
    });

    if (!sessionResponse.ok) {
        const payload = await sessionResponse.text().catch(() => "");
        throw new Error(
            `Failed to fetch TIDAL session for user enrichment (${sessionResponse.status}): ${payload || sessionResponse.statusText}`,
        );
    }

    const sessionData = await sessionResponse.json() as {
        userId: number;
        countryCode: string;
        user?: { username?: string };
    };

    const userResponse = await fetch(
        `${TIDAL_API_BASE}/users/${sessionData.userId}?countryCode=${sessionData.countryCode}`,
        { headers: buildTidalApiHeaders(token.access_token) },
    );

    let userData: Record<string, unknown> = {};
    if (userResponse.ok) {
        userData = await userResponse.json() as Record<string, unknown>;
    }

    const pictureId = typeof userData.picture === "string" ? userData.picture.replace(/-/g, "/") : null;
    const user: TidalAuthUser = {
        userId: sessionData.userId,
        username: (typeof userData.username === "string" && userData.username) || sessionData.user?.username || token.user?.username || "user",
        email: typeof userData.email === "string" ? userData.email : token.user?.email,
        firstName: typeof userData.firstName === "string" ? userData.firstName : token.user?.firstName,
        lastName: typeof userData.lastName === "string" ? userData.lastName : token.user?.lastName,
        fullName: typeof userData.firstName === "string" && typeof userData.lastName === "string"
            ? `${userData.firstName} ${userData.lastName}`
            : token.user?.fullName,
        countryCode: sessionData.countryCode,
        picture: pictureId ? `https://resources.tidal.com/images/${pictureId}/1280x1280.jpg` : token.user?.picture || null,
        nickname: null,
    };

    return { ...token, user };
}

export function loadStoredTidalToken(): TidalAuthToken | null {
    try {
        if (fs.existsSync(TIDAL_AUTH_TOKEN_FILE)) {
            const content = fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf-8");
            return JSON.parse(content) as TidalAuthToken;
        }
    } catch (error) {
        console.error("[TIDAL-AUTH] Failed to read token:", error);
    }

    return null;
}

export async function saveStoredTidalToken(token: TidalAuthToken): Promise<void> {
    ensureAuthDir();
    fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token, null, 2), "utf-8");

    try {
        syncTokenToTiddl(token);
    } catch (error) {
        console.error("[TIDAL-AUTH] Failed to sync tiddl auth:", error);
    }

    await cacheAccountInfo(token.user);
    try {
        await recordProviderAuthOk("tidal");
    } catch (error) {
        console.error("[TIDAL-AUTH] Failed to record auth state:", error instanceof Error ? error.message : "unknown");
    }
}

export async function syncStoredTidalTokenToDownloaders(): Promise<boolean> {
    const token = loadStoredTidalToken();
    if (!token?.access_token) {
        return false;
    }

    syncTokenToTiddl(token);
    return true;
}

export function clearStoredTidalToken(): void {
    try {
        if (fs.existsSync(TIDAL_AUTH_TOKEN_FILE)) {
            fs.unlinkSync(TIDAL_AUTH_TOKEN_FILE);
        }
    } catch (error) {
        console.error("[TIDAL-AUTH] Failed to clear token:", error);
    }

    clearTiddlAuth();
    activeDeviceLogin = null;
    void recordProviderAuthFailure("tidal", "Tidal login was cleared.").catch((error) => {
        console.error("[TIDAL-AUTH] Failed to record auth state:", error instanceof Error ? error.message : "unknown");
    });

    updateConfig("account", {
        userId: undefined,
        username: undefined,
        email: undefined,
        firstName: undefined,
        lastName: undefined,
        fullName: undefined,
        countryCode: undefined,
        picture: undefined,
    });
}

function tokenExpiresWithinRefreshWindow(token: TidalAuthToken, nowMs: number): boolean {
    const expiresAt = token.expires_at ?? getJwtExpiry(token.access_token);
    if (!expiresAt) return true;
    return expiresAt - Math.floor(nowMs / 1000) < TIDAL_REFRESH_EXPIRY_WINDOW_SECONDS;
}

/**
 * Refresh the stored TIDAL token. Single-flight: concurrent callers share one
 * request. A token that is not close to expiry and was refreshed less than
 * TIDAL_MIN_FORCED_REFRESH_INTERVAL_MS ago is returned as-is without calling
 * TIDAL, whatever the caller asked for.
 */
export async function refreshStoredTidalToken(): Promise<TidalAuthToken | null> {
    if (!tidalRefreshInFlight) {
        tidalRefreshInFlight = performTidalTokenRefresh().finally(() => {
            tidalRefreshInFlight = null;
        });
    }
    return tidalRefreshInFlight;
}

function tidalRefreshIsAuthFailure(status: number, errorCode: string, errorDescription: string): boolean {
    if (status === 403 && errorCode === "abuse_detected") return false;
    if (status === 401) return true;
    return /token has expired/i.test(`${errorCode}\n${errorDescription}`);
}

async function performTidalTokenRefresh(): Promise<TidalAuthToken | null> {
    if (isTidalRefreshPaused()) {
        return null;
    }
    // A dead login cannot be refreshed. Stop calling TIDAL until a re-login
    // saves a new token; repeating the 401 is what failed the whole queue.
    if (providerNeedsReauth("tidal")) {
        return null;
    }
    const token = loadStoredTidalToken();
    if (!token?.refresh_token) {
        return null;
    }
    const now = Date.now();
    if (
        !tokenExpiresWithinRefreshWindow(token, now)
        && typeof token.refreshed_at === "number"
        && now - token.refreshed_at < TIDAL_MIN_FORCED_REFRESH_INTERVAL_MS
    ) {
        return token;
    }
    const tidalClient = getTidalAuthClientConfig();

    const response = await fetch(`${TIDAL_AUTH_BASE}/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": tidalClient.authUserAgent,
        },
        body: new URLSearchParams({
            refresh_token: token.refresh_token,
            client_id: tidalClient.clientId,
            client_secret: tidalClient.clientSecret,
            grant_type: "refresh_token",
        }).toString(),
    });

    if (!response.ok) {
        let errorCode = "";
        let errorDescription = "";
        try {
            const payload = await response.json() as { error?: unknown; error_description?: unknown };
            if (typeof payload.error === "string") errorCode = payload.error;
            if (typeof payload.error_description === "string") errorDescription = payload.error_description;
        } catch {
            // The status alone is enough when the provider returns no JSON.
        }
        if (response.status === 403 && errorCode === "abuse_detected") {
            const pauseMs = pauseTidalRefresh(Date.now());
            console.warn(`[TIDAL] Token refresh paused for ${Math.round(pauseMs / 60_000)} minutes after HTTP 403 abuse_detected`);
        }
        if (tidalRefreshIsAuthFailure(response.status, errorCode, errorDescription)) {
            const authMessage = "Tidal login expired (token has expired).";
            try {
                await recordProviderAuthFailure("tidal", authMessage);
            } catch (error) {
                console.error("[TIDAL-AUTH] Failed to record auth state:", error instanceof Error ? error.message : "unknown");
            }
            throw new ProviderAuthError("tidal", authMessage);
        }
        throw new Error(`TIDAL token refresh failed (HTTP ${response.status}${errorCode ? `: ${errorCode}` : ""})`);
    }
    clearTidalRefreshPause();

    const data = await response.json() as {
        access_token: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
    };

    const refreshed = await enrichTokenUser({
        ...token,
        access_token: data.access_token,
        refresh_token: data.refresh_token || token.refresh_token,
        token_type: data.token_type || token.token_type || "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        refreshed_at: Date.now(),
    });

    await saveStoredTidalToken(refreshed);
    return refreshed;
}

export async function startTidalDeviceLogin(): Promise<{
    alreadyLoggedIn?: boolean;
    userCode?: string;
    verificationUrl?: string;
    expiresIn?: number;
    interval?: number;
}> {
    // Only skip the device login for a token that still works. An expired
    // token, or one whose refresh was rejected, must lead to a fresh login;
    // otherwise the connect button silently returns to the library.
    const existing = loadStoredTidalToken();
    if (existing?.access_token && !providerNeedsReauth("tidal")) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (typeof existing.expires_at === "number" && existing.expires_at > nowSeconds + 60) {
            return { alreadyLoggedIn: true };
        }
        try {
            const refreshed = await refreshStoredTidalToken();
            if (refreshed && typeof refreshed.expires_at === "number" && refreshed.expires_at > nowSeconds + 60) {
                return { alreadyLoggedIn: true };
            }
        } catch {
            // Fall through to a new device login.
        }
    }
    const tidalClient = getTidalAuthClientConfig();

    const response = await fetch(`${TIDAL_AUTH_BASE}/oauth2/device_authorization`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": tidalClient.authUserAgent,
        },
        body: new URLSearchParams({
            client_id: tidalClient.clientId,
            scope: "r_usr w_usr",
        }).toString(),
    });

    if (!response.ok) {
        throw new Error("Failed to start TIDAL TV device login");
    }

    const data = await response.json() as {
        deviceCode: string;
        userCode: string;
        expiresIn: number;
        interval?: number;
    };

    activeDeviceLogin = {
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUrl: `https://link.tidal.com/${data.userCode}`,
        expiresAt: Date.now() + (data.expiresIn * 1000),
        interval: data.interval || 3,
    };

    return {
        userCode: activeDeviceLogin.userCode,
        verificationUrl: activeDeviceLogin.verificationUrl,
        expiresIn: data.expiresIn,
        interval: activeDeviceLogin.interval,
    };
}

export async function pollTidalDeviceLogin(): Promise<{
    logged_in: boolean;
    expired?: boolean;
    remainingSeconds?: number;
    user?: TidalAuthUser | null;
}> {
    if (!activeDeviceLogin) {
        const token = loadStoredTidalToken();
        return {
            logged_in: Boolean(token?.access_token),
            user: token?.user || null,
        };
    }

    const remainingMs = activeDeviceLogin.expiresAt - Date.now();
    if (remainingMs <= 0) {
        activeDeviceLogin = null;
        return {
            logged_in: false,
            expired: true,
            remainingSeconds: 0,
        };
    }
    const tidalClient = getTidalAuthClientConfig();

    const response = await fetch(`${TIDAL_AUTH_BASE}/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": tidalClient.authUserAgent,
        },
        body: new URLSearchParams({
            client_id: tidalClient.clientId,
            client_secret: tidalClient.clientSecret,
            device_code: activeDeviceLogin.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            scope: "r_usr w_usr",
        }).toString(),
    });

    if (response.status === 400) {
        return {
            logged_in: false,
            expired: false,
            remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
        };
    }

    if (!response.ok) {
        throw new Error(`TIDAL device login failed (${response.status})`);
    }

    const data = await response.json() as {
        access_token: string;
        refresh_token: string;
        token_type?: string;
        expires_in?: number;
    };

    const token = await enrichTokenUser({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type || "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        refreshed_at: Date.now(),
    });

    await saveStoredTidalToken(token);
    activeDeviceLogin = null;

    return {
        logged_in: true,
        user: token.user || null,
    };
}

export function getTidalAuthStatus() {
    return {
        activeDeviceLogin,
    };
}

export const TIDAL_TV_CLIENT_ID = getTidalAuthClientConfig().clientId;
export { TIDAL_AUTH_TOKEN_FILE };
