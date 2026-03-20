import fs from "fs";
import path from "path";
import { CONFIG_DIR, updateConfig } from "./config.js";
import {
    clearTidalDlNgToken,
    syncTokenToTidalDlNg,
} from "./tidal-dl-ng.js";
import { clearOrpheusSession, syncTokenToOrpheusSession } from "./orpheus.js";
import { resolveTidalAuthClientConfig } from "./provider-client-config.js";

const TIDAL_AUTH_DIR = path.join(CONFIG_DIR, "providers", "tidal");
const TIDAL_AUTH_TOKEN_FILE = path.join(TIDAL_AUTH_DIR, "token.json");
const TIDAL_AUTH_BASE = "https://auth.tidal.com/v1";
const TIDAL_API_BASE = "https://api.tidal.com/v1";

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

function cacheAccountInfo(user: TidalAuthUser | undefined): void {
    if (!user) {
        return;
    }

    updateConfig("account", {
        userId: user.userId,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        countryCode: user.countryCode,
        picture: user.picture,
    });
}

async function enrichTokenUser(token: TidalAuthToken): Promise<TidalAuthToken> {
    const sessionResponse = await fetch(`${TIDAL_API_BASE}/sessions`, {
        headers: buildTidalApiHeaders(token.access_token),
    });

    if (!sessionResponse.ok) {
        throw new Error(`Failed to read TIDAL session (${sessionResponse.status})`);
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

export function saveStoredTidalToken(token: TidalAuthToken): void {
    ensureAuthDir();
    fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token, null, 2), "utf-8");
    cacheAccountInfo(token.user);

    const expiresAt = token.expires_at || Math.floor(Date.now() / 1000) + 3600;
    syncTokenToTidalDlNg(token.access_token, token.refresh_token || "", expiresAt);
    void syncTokenToOrpheusSession(token).catch((error) => {
        console.error("[TIDAL-AUTH] Failed to sync Orpheus session:", error);
    });
}

export function clearStoredTidalToken(): void {
    try {
        if (fs.existsSync(TIDAL_AUTH_TOKEN_FILE)) {
            fs.unlinkSync(TIDAL_AUTH_TOKEN_FILE);
        }
    } catch (error) {
        console.error("[TIDAL-AUTH] Failed to clear token:", error);
    }

    clearTidalDlNgToken();
    clearOrpheusSession();
    activeDeviceLogin = null;

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

export async function refreshStoredTidalToken(): Promise<TidalAuthToken | null> {
    const token = loadStoredTidalToken();
    if (!token?.refresh_token) {
        return null;
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
        return null;
    }

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
    });

    saveStoredTidalToken(refreshed);
    return refreshed;
}

export async function startTidalDeviceLogin(): Promise<{
    alreadyLoggedIn?: boolean;
    userCode?: string;
    verificationUrl?: string;
    expiresIn?: number;
    interval?: number;
}> {
    const existing = loadStoredTidalToken();
    if (existing?.access_token) {
        return { alreadyLoggedIn: true };
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
    });

    saveStoredTidalToken(token);
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
