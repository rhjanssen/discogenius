import fs from "fs";
import path from "path";
import { Config, CONFIG_DIR } from "../../config/config.js";
import { resolveTidalAuthClientConfig } from "../../config/provider-client-config.js";
import {
    checkCommandAvailability,
    checkWritablePath,
    rollupHealthStatus,
    type BackendCapabilitySnapshot,
} from "../../../utils/health.js";

// tiddl resolves its app directory from TIDDL_PATH (default ~/.tiddl). We keep it
// inside the Discogenius config volume so auth and cache survive container rebuilds.
export const TIDDL_CONFIG_DIR = path.join(CONFIG_DIR, ".tiddl");
export const TIDDL_AUTH_FILE = path.join(TIDDL_CONFIG_DIR, "auth.json");
export const TIDDL_CONFIG_FILE = path.join(TIDDL_CONFIG_DIR, "config.toml");

export type TiddlTrackQuality = "low" | "normal" | "high" | "max";
export type TiddlVideoQuality = "sd" | "hd" | "fhd";

export function getTiddlBinary(): string {
    return process.env.TIDDL_BIN || "tiddl";
}

export function buildTiddlEnv(): NodeJS.ProcessEnv {
    const client = resolveTidalAuthClientConfig(process.env);
    return {
        ...process.env,
        TIDDL_PATH: TIDDL_CONFIG_DIR,
        // tiddl ships its own embedded OAuth client. The token we sync into
        // auth.json was issued to the Discogenius client, so tiddl must use the
        // same client credentials or its own token refresh would be rejected.
        TIDDL_AUTH: `${client.clientId};${client.clientSecret}`,
        FORCE_COLOR: "1",
        TERM: "xterm-256color",
    };
}

export function ensureTiddlConfigDir(): void {
    if (!fs.existsSync(TIDDL_CONFIG_DIR)) {
        fs.mkdirSync(TIDDL_CONFIG_DIR, { recursive: true });
    }
}

export interface TiddlAuthData {
    token: string | null;
    refresh_token: string | null;
    expires_at: number;
    user_id: string | null;
    country_code: string | null;
}

export interface TiddlAuthTokenInput {
    access_token: string;
    refresh_token?: string | null;
    expires_at?: number | null;
    user?: {
        userId?: number | string | null;
        countryCode?: string | null;
    } | null;
}

export function syncTokenToTiddl(token: TiddlAuthTokenInput): void {
    ensureTiddlConfigDir();

    const authData: TiddlAuthData = {
        token: token.access_token,
        refresh_token: token.refresh_token || null,
        expires_at: token.expires_at || Math.floor(Date.now() / 1000) + 3600,
        user_id: token.user?.userId != null ? String(token.user.userId) : null,
        country_code: token.user?.countryCode || null,
    };

    fs.writeFileSync(TIDDL_AUTH_FILE, JSON.stringify(authData), "utf-8");
}

export function readTiddlAuth(): TiddlAuthData | null {
    try {
        if (fs.existsSync(TIDDL_AUTH_FILE)) {
            return JSON.parse(fs.readFileSync(TIDDL_AUTH_FILE, "utf-8")) as TiddlAuthData;
        }
    } catch (error) {
        console.error("[TIDDL] Failed to read auth file:", error);
    }
    return null;
}

export function clearTiddlAuth(): void {
    try {
        if (fs.existsSync(TIDDL_AUTH_FILE)) {
            fs.unlinkSync(TIDDL_AUTH_FILE);
        }
    } catch (error) {
        console.error("[TIDDL] Failed to clear auth file:", error);
    }
}

/**
 * Map a quality label to a tiddl track quality.
 *
 * Accepts both tiddl's own values (from the quality config section) and the
 * provider quality tags carried by slots/offers (LOSSLESS, HIRES_LOSSLESS,
 * DOLBY_ATMOS, ...). Falls back to the configured audio quality.
 */
export function mapAudioQualityToTiddl(quality?: string | null): TiddlTrackQuality {
    const normalized = String(quality || "").trim().toUpperCase().replace(/[\s-]+/g, "_");

    switch (normalized) {
        case "LOW":
            return "low";
        case "NORMAL":
        case "HIGH": // TIDAL "HIGH" tier = 320 kbps AAC = tiddl "normal"
            return "normal";
        case "LOSSLESS":
            return "high";
        case "MAX":
        case "MASTER":
        case "MQA":
        case "HI_RES":
        case "HIRES":
        case "HIRES_LOSSLESS":
        case "HI_RES_LOSSLESS":
            return "max";
    }

    if (normalized.includes("ATMOS") || normalized.includes("SPATIAL") || normalized.includes("360")) {
        // Spatial delivery is selected via --dolby-atmos; request the top tier
        // so tiddl never downgrades the container stream.
        return "max";
    }

    const configured = String(Config.getQualityConfig()?.audio_quality || "high").toLowerCase();
    if (configured === "low" || configured === "normal" || configured === "high" || configured === "max") {
        return configured;
    }
    return "high";
}

export function mapVideoQualityToTiddl(quality?: string | null): TiddlVideoQuality {
    const normalized = String(quality || "").trim().toLowerCase();
    if (normalized === "sd" || normalized === "hd" || normalized === "fhd") {
        return normalized;
    }

    const configured = String(Config.getQualityConfig()?.video_quality || "fhd").toLowerCase();
    if (configured === "sd" || configured === "hd" || configured === "fhd") {
        return configured as TiddlVideoQuality;
    }
    return "fhd";
}

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write tiddl's config.toml from Discogenius settings.
 *
 * Downloads land in per-job workspaces (passed per invocation via --path), so the
 * template only needs to be collision-free inside one workspace; the organizer
 * applies the user's naming config when importing into the library.
 */
export function syncTiddlSettings(downloadPath: string = Config.getDownloadPath()): void {
    ensureTiddlConfigDir();

    const quality = Config.getQualityConfig();
    const trackQuality = mapAudioQualityToTiddl(quality?.audio_quality);
    const videoQuality = mapVideoQualityToTiddl(quality?.video_quality);
    const embedCover = quality?.embed_cover !== false;
    const embedLyrics = quality?.embed_lyrics !== false;

    const lines = [
        "# Managed by Discogenius. Manual edits are overwritten on settings sync.",
        "enable_cache = true",
        "debug = false",
        "",
        "[download]",
        `track_quality = ${tomlString(trackQuality)}`,
        `video_quality = ${tomlString(videoQuality)}`,
        // Workspaces are wiped before each job; skip_existing only matters for retries.
        "skip_existing = true",
        "threads_count = 4",
        `download_path = ${tomlString(downloadPath.replace(/\\/g, "/"))}`,
        `scan_path = ${tomlString(downloadPath.replace(/\\/g, "/"))}`,
        "singles_filter = \"include\"",
        "videos_filter = \"none\"",
        "atmos_filter = \"none\"",
        "",
        "[metadata]",
        "enable = true",
        `lyrics = ${embedLyrics}`,
        `cover = ${embedCover}`,
        "album_review = false",
        "",
        "[templates]",
        "default = \"{album.artist}/{album.title}/{item.number:02d}. {item.title_version}\"",
        "video = \"{item.artist} - {item.title}\"",
        "",
        "[m3u]",
        "save = false",
        "",
    ];

    fs.writeFileSync(TIDDL_CONFIG_FILE, lines.join("\n"), "utf-8");
}

export function getTiddlCapabilitySnapshot(): BackendCapabilitySnapshot {
    const configDirCheck = checkWritablePath("tiddl.config", TIDDL_CONFIG_DIR, {
        kind: "dir",
        displayName: "tiddl config directory",
    });

    const commandCheck = checkCommandAvailability("tiddl.command", getTiddlBinary(), "tiddl");

    const auth = readTiddlAuth();
    const authCheck = auth?.token
        ? {
            scope: "tiddl.auth",
            status: "ok" as const,
            message: "tiddl authentication is present",
            details: { path: TIDDL_AUTH_FILE },
        }
        : {
            scope: "tiddl.auth",
            status: "warning" as const,
            message: "tiddl authentication is not present",
            details: { path: TIDDL_AUTH_FILE },
        };

    const checks = [configDirCheck, commandCheck, authCheck];
    const status = rollupHealthStatus(checks);
    const available = !checks.some((check) => check.status === "error");
    const ready = available && Boolean(auth?.token);

    return {
        name: "tiddl",
        status,
        available,
        ready,
        capabilities: {
            audio: true,
            video: true,
            spatialAudio: true,
            highResAudio: true,
        },
        checks,
        notes: !auth?.token ? ["Connect your TIDAL account to enable downloads."] : [],
    };
}
