import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { Config, REPO_ROOT } from "./config.js";
import {
    checkCommandAvailability,
    checkWritablePath,
    rollupHealthStatus,
    type BackendCapabilitySnapshot,
} from "../utils/health.js";

// tidal-dl-ng config location
const IS_WINDOWS = process.platform === "win32";
const IS_DOCKER = process.env.DOCKER === 'true';

function hasConfigState(dir: string): boolean {
    return (
        fs.existsSync(path.join(dir, "settings.json")) ||
        fs.existsSync(path.join(dir, "token.json")) ||
        fs.existsSync(dir)
    );
}

// Config paths — tidal-dl-ng-for-dj uses "tidal_dl_ng-dev" as its config folder name.
function resolveConfigDir(): string {
    if (process.env.TIDAL_DL_NG_CONFIG) {
        const explicit = process.env.TIDAL_DL_NG_CONFIG;
        if (fs.existsSync(path.join(explicit, "settings.json"))) {
            return explicit;
        }
        return explicit;
    }

    const repoConfigDir = path.join(REPO_ROOT, "config", "tidal_dl_ng-dev");
    if (IS_DOCKER) {
        return path.join("/config", "tidal_dl_ng-dev");
    }

    const homeConfigDir = path.join(os.homedir(), ".config", "tidal_dl_ng-dev");
    if (hasConfigState(repoConfigDir)) {
        return repoConfigDir;
    }
    if (hasConfigState(homeConfigDir)) {
        return homeConfigDir;
    }

    // Default new local installs to the repo-local config directory so tokens/settings
    // stay colocated with Discogenius instead of being split across ~/.config.
    return repoConfigDir;
}

export const TIDAL_DL_NG_CONFIG_DIR = resolveConfigDir();
export const TIDAL_DL_NG_SETTINGS_FILE = path.join(TIDAL_DL_NG_CONFIG_DIR, "settings.json");
export const TIDAL_DL_NG_TOKEN_FILE = path.join(TIDAL_DL_NG_CONFIG_DIR, "token.json");

/**
 * Quality mapping from Discogenius to tidal-dl-ng
 */

export type TidalDlNgAudioQuality = "LOW" | "HIGH" | "LOSSLESS" | "HI_RES_LOSSLESS";
export type TidalDlNgVideoQuality = "360" | "480" | "720" | "1080";
export type TidalDlNgDownloadType = "album" | "track" | "video" | "playlist";

export function shouldExtractFlac(audioQuality: TidalDlNgAudioQuality): boolean {
    return audioQuality === "LOSSLESS" || audioQuality === "HI_RES_LOSSLESS";
}

export function mapAudioQuality(quality?: string): TidalDlNgAudioQuality {
    switch (quality?.toLowerCase()) {
        case "low":
            return "LOW";
        case "normal":
            return "HIGH";
        case "high":
            return "LOSSLESS";
        case "max":
        default:
            return "HI_RES_LOSSLESS";
    }
}

export function mapVideoQuality(quality?: string): TidalDlNgVideoQuality {
    switch (quality?.toLowerCase()) {
        case "sd":
            return "480";
        case "hd":
            return "720";
        case "fhd":
        default:
            return "1080";
    }
}

/**
 * Cover dimensions available in tidal-dl-ng
 */
export type TidalDlNgCoverDimension = "80" | "160" | "320" | "640" | "1280" | "origin";

/**
 * UPC metadata target options
 */
export type TidalDlNgUpcTarget = "UPC" | "BARCODE" | "EAN";

/**
 * Initial key format options
 */
export type TidalDlNgInitialKeyFormat = "alphanumeric" | "classic";

/**
 * tidal-dl-ng settings interface (full config from model/cfg.py)
 */
export interface TidalDlNgSettings {
    // Core download settings
    download_base_path: string;
    download_delay: boolean;
    download_delay_sec_min: number;
    download_delay_sec_max: number;
    skip_existing: boolean;
    downloads_concurrent_max: number;
    downloads_simultaneous_per_track_max: number;

    // Quality settings
    quality_audio: TidalDlNgAudioQuality;
    quality_video: TidalDlNgVideoQuality;
    download_dolby_atmos: boolean;

    // Video settings
    video_download: boolean;
    video_convert_mp4: boolean;

    // Metadata embedding settings
    metadata_cover_embed: boolean;
    metadata_cover_dimension: TidalDlNgCoverDimension;
    metadata_replay_gain: boolean;
    metadata_write_url: boolean;
    metadata_target_upc: TidalDlNgUpcTarget;
    metadata_delimiter_artist: string;
    metadata_delimiter_album_artist: string;
    mark_explicit: boolean;
    initial_key_format: TidalDlNgInitialKeyFormat;

    // Lyrics settings
    lyrics_embed: boolean;
    lyrics_file: boolean;

    // Sidecar files
    cover_album_file: boolean;
    playlist_create: boolean;
    symlink_to_track: boolean;

    // Path templates (for reference, Discogenius uses own naming)
    format_album: string;
    format_track: string;
    format_video: string;
    format_playlist: string;
    format_mix: string;

    // Filename settings
    filename_delimiter_artist: string;
    filename_delimiter_album_artist: string;
    album_track_num_pad_min: number;

    // Artist handling
    use_primary_album_artist: boolean;

    // FLAC extraction
    extract_flac: boolean;

    // FFmpeg path
    path_binary_ffmpeg: string;

    // Rate limiting (for batch operations)
    api_rate_limit_batch_size: number;
    api_rate_limit_delay_sec: number;
}

/**
 * Default settings for tidal-dl-ng optimized for Discogenius
 * These settings prioritize:
 * - Maximum metadata embedding for library management
 * - No download delays (internal/trusted use)
 * - FLAC extraction for quality
 * - Single-file downloads (Discogenius manages batching)
 */
const DEFAULT_SETTINGS: Partial<TidalDlNgSettings> = {
    // Disable delays for internal use
    download_delay: false,
    download_delay_sec_min: 0,
    download_delay_sec_max: 0,

    // Quality settings - max by default
    download_dolby_atmos: true,

    // Skip existing disabled - Discogenius manages this
    skip_existing: false,

    // Concurrency - let Discogenius control job queue
    downloads_concurrent_max: 1,
    downloads_simultaneous_per_track_max: 20,

    // Video settings
    video_download: true,
    video_convert_mp4: true,

    // Metadata embedding - enable all for rich library
    metadata_cover_embed: true,
    metadata_cover_dimension: "1280",  // High res covers in files
    metadata_replay_gain: true,        // ReplayGain for volume normalization
    metadata_write_url: true,          // Store TIDAL URL in metadata
    metadata_target_upc: "UPC",
    metadata_delimiter_artist: ", ",
    metadata_delimiter_album_artist: ", ",
    mark_explicit: false,              // Don't modify titles with 🅴
    initial_key_format: "alphanumeric",

    // Lyrics - Discogenius manages separately via sidecars
    lyrics_embed: false,
    lyrics_file: false,

    // Sidecar files - Discogenius handles covers
    cover_album_file: false,
    playlist_create: false,
    symlink_to_track: false,

    // Filename settings
    filename_delimiter_artist: ", ",
    filename_delimiter_album_artist: ", ",
    album_track_num_pad_min: 2,

    // Use primary album artist for cleaner folder structure
    use_primary_album_artist: true,

    // Extract FLAC from MP4 containers - always enabled
    extract_flac: true,

    // Use system ffmpeg
    path_binary_ffmpeg: "",

    // Rate limiting disabled for internal use
    api_rate_limit_batch_size: 100,
    api_rate_limit_delay_sec: 0,
};

/**
 * Find ffmpeg in system PATH
 */
function findWingetFfmpegPath(): string {
    if (!IS_WINDOWS) return "";

    const packagesDir = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
    if (!fs.existsSync(packagesDir)) return "";

    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("Gyan.FFmpeg")) {
            continue;
        }

        const packageRoot = path.join(packagesDir, entry.name);
        const directBin = path.join(packageRoot, "bin");
        if (fs.existsSync(path.join(directBin, "ffmpeg.exe"))) {
            return directBin;
        }

        for (const child of fs.readdirSync(packageRoot, { withFileTypes: true })) {
            if (!child.isDirectory()) {
                continue;
            }

            const childBin = path.join(packageRoot, child.name, "bin");
            if (fs.existsSync(path.join(childBin, "ffmpeg.exe"))) {
                return childBin;
            }
        }
    }

    return "";
}

function findFfmpegPath(): string {
    const possiblePaths = IS_WINDOWS
        ? [
            "C:\\ffmpeg\\bin",
            "C:\\ProgramData\\chocolatey\\bin",
            "C:\\Program Files\\ffmpeg\\bin",
            "C:\\Program Files\\FFmpeg\\bin",
            path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links"),
        ]
        : ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

    for (const basePath of possiblePaths) {
        const ffmpegExe = path.join(basePath, IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg");
        if (fs.existsSync(ffmpegExe)) return basePath;
    }

    const wingetPath = findWingetFfmpegPath();
    if (wingetPath) {
        return wingetPath;
    }

    return "";
}

/**
 * Build environment for tidal-dl-ng CLI
 */
export function buildTidalDlNgEnv(): NodeJS.ProcessEnv {
    const pathSeparator = IS_WINDOWS ? ";" : ":";
    const currentPath = process.env.PATH || "";
    const currentPathEntries = currentPath.split(pathSeparator).filter(Boolean);
    const additionalPaths: string[] = [];

    const addPathIfMissing = (candidate: string) => {
        if (!candidate || !fs.existsSync(candidate)) {
            return;
        }

        const normalizedCandidate = path.resolve(candidate);
        const alreadyPresent = currentPathEntries.some((entry) => path.resolve(entry) === normalizedCandidate)
            || additionalPaths.some((entry) => path.resolve(entry) === normalizedCandidate);

        if (!alreadyPresent) {
            additionalPaths.push(candidate);
        }
    };

    const venvBinDir = IS_WINDOWS ? "Scripts" : "bin";
    for (const venvRoot of [
        path.join(REPO_ROOT, ".venv"),
        path.join(process.cwd(), ".venv"),
        path.join(REPO_ROOT, "venv"),
        path.join(process.cwd(), "venv"),
    ]) {
        addPathIfMissing(path.join(venvRoot, venvBinDir));
    }

    // Add Python bin paths for local dev
    const pythonBinPaths = [
        path.join(os.homedir(), ".local", "python-3.13", "bin"),
        path.join(os.homedir(), ".local", "bin"),
    ];

    for (const p of pythonBinPaths) {
        addPathIfMissing(p);
    }

    // Add ffmpeg path if found
    const ffmpegPath = findFfmpegPath();
    addPathIfMissing(ffmpegPath);

    const enhancedPath = additionalPaths.length > 0
        ? additionalPaths.join(pathSeparator) + pathSeparator + currentPath
        : currentPath;

    return {
        ...process.env,
        PATH: enhancedPath,
        // tidal-dl-ng looks for XDG_CONFIG_HOME or uses ~/.config
        // We set it to the parent directory of TIDAL_DL_NG_CONFIG_DIR because
        // tidal-dl-ng-for-dj appends "tidal_dl_ng-dev" to XDG_CONFIG_HOME
        XDG_CONFIG_HOME: path.resolve(path.dirname(TIDAL_DL_NG_CONFIG_DIR)),
        // Force unbuffered Python output for login command
        PYTHONUNBUFFERED: "1",
    };
}

/**
 * Get the path to tidal-dl-ng executable
 */
export function getTidalDlNgCommand(): { command: string, args: string[] } {
    // Explicit override
    if (process.env.TIDAL_DL_NG_BIN) {
        return { command: process.env.TIDAL_DL_NG_BIN, args: [] };
    }

    const thisDir = path.dirname(fileURLToPath(import.meta.url));

    // In Docker, it's in the global Python bin
    if (IS_DOCKER) {
        return { command: "tidal-dl-ng", args: [] };
    }

    const candidates: string[] = [];

    // Workspace / project venvs (preferred for local dev)
    const cwd = process.cwd();
    if (IS_WINDOWS) {
        candidates.push(
            path.join(cwd, ".venv", "Scripts", "tidal-dl-ng.exe")
        );
    } else {
        candidates.push(
            path.join(cwd, ".venv", "bin", "tidal-dl-ng")
        );
    }

    // (api/dist/src/services -> repo root is ../../../..; api/src/services -> repo root is ../../..)
    // We handle both cases by checking directory structure or trying multiple depths

    // Try resolving from dist structure (deep nesting) first
    const repoRootDeep = path.resolve(thisDir, "..", "..", "..", "..");

    // Try resolving from source structure (shallow nesting)
    const repoRootShallow = path.resolve(thisDir, "..", "..", "..");

    const rootsToCheck = [repoRootDeep, repoRootShallow];

    for (const root of rootsToCheck) {
        if (IS_WINDOWS) {
            candidates.push(
                path.join(root, ".venv", "Scripts", "tidal-dl-ng.exe")
            );
        } else {
            candidates.push(
                path.join(root, ".venv", "bin", "tidal-dl-ng"),
                path.join(root, "venv", "bin", "tidal-dl-ng")
            );
        }
    }

    // Other common local location(s)
    candidates.push(path.join(os.homedir(), ".local", "python-3.13", "bin", IS_WINDOWS ? "tidal-dl-ng.exe" : "tidal-dl-ng"));

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return { command: candidate, args: [] };
        }
    }

    // Fall back to PATH
    return { command: "tidal-dl-ng", args: [] };
}

/**
 * Ensure tidal-dl-ng config directory exists
 */
export function ensureConfigDir(): void {
    if (!fs.existsSync(TIDAL_DL_NG_CONFIG_DIR)) {
        fs.mkdirSync(TIDAL_DL_NG_CONFIG_DIR, { recursive: true });
    }
}

/**
 * tidal-dl-ng token format
 */
export interface TidalDlNgToken {
    token_type: string;
    access_token: string;
    refresh_token: string;
    expiry_time: number; // Unix timestamp as float
}

/**
 * Sync token from Discogenius OAuth flow to tidal-dl-ng format
 * This is called after the Discogenius OAuth flow completes to ensure
 * tidal-dl-ng can use the same credentials.
 * 
 * @param accessToken - The access token
 * @param refreshToken - The refresh token
 * @param expiresAt - Unix timestamp (seconds) when token expires
 */
export function syncTokenToTidalDlNg(
    accessToken: string,
    refreshToken: string,
    expiresAt: number
): void {
    ensureConfigDir();

    const token: TidalDlNgToken = {
        token_type: "Bearer",
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_time: expiresAt, // tidal-dl-ng uses seconds as float
    };

    try {
        fs.writeFileSync(TIDAL_DL_NG_TOKEN_FILE, JSON.stringify(token, null, 4), "utf-8");
        console.log(`✅ [TIDAL-DL-NG] Token synced to ${TIDAL_DL_NG_TOKEN_FILE}`);
    } catch (error) {
        console.error(`❌ [TIDAL-DL-NG] Error syncing token to ${TIDAL_DL_NG_TOKEN_FILE}:`, error);
    }
}

/**
 * Read tidal-dl-ng token
 */
export function readTidalDlNgToken(): TidalDlNgToken | null {
    try {
        if (fs.existsSync(TIDAL_DL_NG_TOKEN_FILE)) {
            const content = fs.readFileSync(TIDAL_DL_NG_TOKEN_FILE, "utf-8");
            return JSON.parse(content);
        }
    } catch (error) {
        console.error(`[TIDAL-DL-NG] Error reading token from ${TIDAL_DL_NG_TOKEN_FILE}:`, error);
    }
    return null;
}

/**
 * Clear tidal-dl-ng token (for logout)
 */
export function clearTidalDlNgToken(): void {
    try {
        if (fs.existsSync(TIDAL_DL_NG_TOKEN_FILE)) {
            fs.unlinkSync(TIDAL_DL_NG_TOKEN_FILE);
            console.log(`✅ [TIDAL-DL-NG] Token cleared from ${TIDAL_DL_NG_TOKEN_FILE}`);
        }
    } catch (error) {
        console.error(`[TIDAL-DL-NG] Error clearing token from ${TIDAL_DL_NG_TOKEN_FILE}:`, error);
    }
}

/**
 * Clear tidal-dl-ng history file
 * This prevents tidal-dl-ng from skipping downloads that we explicitly want to re-download (e.g. Upgrader)
 */
export function clearHistory(): void {
    // Check both the resolved config dir and possible alternative dirs
    // tidal-dl-ng dev builds may store history in a different directory
    const candidates = [TIDAL_DL_NG_CONFIG_DIR];
    const baseDir = IS_DOCKER ? "/config" : path.join(os.homedir(), ".config");

    // Add Discogenius config dir
    const appConfigDir = process.env.DOCKER === 'true' ? "/config" : path.join(REPO_ROOT, "config");

    for (const suffix of ["tidal_dl_ng", "tidal_dl_ng-dev"]) {
        const candidate1 = path.join(baseDir, suffix);
        const candidate2 = path.join(appConfigDir, suffix);
        if (!candidates.includes(candidate1)) candidates.push(candidate1);
        if (!candidates.includes(candidate2)) candidates.push(candidate2);
    }

    let cleared = false;
    for (const dir of candidates) {
        const historyFile = path.join(dir, "downloaded_history.json");
        try {
            if (fs.existsSync(historyFile)) {
                fs.unlinkSync(historyFile);
                console.log(`✅ [TIDAL-DL-NG] History cleared from ${historyFile}`);
                cleared = true;
            }
        } catch (error) {
            console.error(`[TIDAL-DL-NG] Error clearing history from ${historyFile}:`, error);
        }
    }
    if (!cleared) {
        console.log(`[TIDAL-DL-NG] No history file found to clear (checked: ${candidates.map(d => path.join(d, "downloaded_history.json")).join(", ")})`);
    }
}

/**
 * Read current tidal-dl-ng settings
 */
export function readSettings(): TidalDlNgSettings | null {
    try {
        if (fs.existsSync(TIDAL_DL_NG_SETTINGS_FILE)) {
            const content = fs.readFileSync(TIDAL_DL_NG_SETTINGS_FILE, "utf-8");
            return JSON.parse(content);
        }
    } catch (error) {
        console.error(`[TIDAL-DL-NG] Error reading settings from ${TIDAL_DL_NG_SETTINGS_FILE}:`, error);
    }
    return null;
}

/**
 * Save all settings directly to file (faster than CLI)
 */
export function saveSettings(settings: Partial<TidalDlNgSettings>): void {
    ensureConfigDir();

    // Read existing to merge
    const current = readSettings() || {};
    const newSettings = { ...current, ...settings };

    try {
        fs.writeFileSync(TIDAL_DL_NG_SETTINGS_FILE, JSON.stringify(newSettings, null, 4), "utf-8");
        console.log(`✅ [TIDAL-DL-NG] Settings saved to ${TIDAL_DL_NG_SETTINGS_FILE}`);
    } catch (error) {
        console.error(`❌ [TIDAL-DL-NG] Error saving settings to ${TIDAL_DL_NG_SETTINGS_FILE}:`, error);
    }
}

export function getDownloadSourcePath(type: TidalDlNgDownloadType, tidalId: string): string {
    const downloadRoot = Config.getDownloadPath();

    switch (type) {
        case "album":
            return path.join(downloadRoot, "albums", tidalId);
        case "track":
            return path.join(downloadRoot, "tracks", tidalId);
        case "video":
            return path.join(downloadRoot, "videos", tidalId);
        case "playlist":
            return path.join(downloadRoot, "playlists", tidalId);
        default:
            return downloadRoot;
    }
}

/**
 * Update a single tidal-dl-ng setting in the config file.
 * Discogenius owns this file, so direct writes are more reliable than shelling
 * out to `tidal-dl-ng cfg`, which is a no-op for some packaged builds.
 */
export async function updateSetting(key: string, value: string | boolean | number): Promise<void> {
    console.log(`[TIDAL-DL-NG] Setting ${key}=${String(value)}`);
    saveSettings({ [key]: value } as Partial<TidalDlNgSettings>);
}

function resolveFfmpegBinary(): string {
    if (IS_DOCKER) {
        const dockerFfmpeg = "/usr/bin/ffmpeg";
        if (fs.existsSync(dockerFfmpeg)) {
            return dockerFfmpeg;
        }
    }

    const discoveredDir = findFfmpegPath();
    if (discoveredDir) {
        return path.join(discoveredDir, IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg");
    }

    const configuredPath = readSettings()?.path_binary_ffmpeg?.trim();
    if (configuredPath && fs.existsSync(configuredPath)) {
        return configuredPath;
    }

    return "";
}

function resolveCoverDimension(value: string | number | undefined): TidalDlNgCoverDimension {
    switch (String(value ?? "1280")) {
        case "80":
        case "160":
        case "320":
        case "640":
        case "1280":
        case "origin":
            return String(value ?? "1280") as TidalDlNgCoverDimension;
        default:
            return "1280";
    }
}

function buildDiscogeniusSettings(
    downloadPath: string,
    audioQuality: TidalDlNgAudioQuality,
    videoQuality: TidalDlNgVideoQuality
): Partial<TidalDlNgSettings> {
    const qualityConfig = Config.getQualityConfig();
    const metadataConfig = Config.getMetadataConfig();
    const ffmpegBinary = resolveFfmpegBinary();

    if (shouldExtractFlac(audioQuality) && !ffmpegBinary) {
        throw new Error("FFmpeg binary is required for lossless downloads but could not be found");
    }

    return {
        ...DEFAULT_SETTINGS,
        download_base_path: downloadPath,
        quality_audio: audioQuality,
        quality_video: videoQuality,
        metadata_cover_embed: qualityConfig.embed_cover ?? true,
        metadata_cover_dimension: resolveCoverDimension(metadataConfig.album_cover_resolution),
        metadata_replay_gain: metadataConfig.embed_replaygain !== false,
        metadata_write_url: metadataConfig.write_tidal_url ?? true,
        metadata_target_upc: metadataConfig.upc_target || "UPC",
        mark_explicit: metadataConfig.mark_explicit ?? false,
        lyrics_embed: qualityConfig.embed_lyrics ?? false,
        format_album: "{track_id}",
        format_track: "{track_id}",
        format_video: "{video_id}",
        format_playlist: "{track_id}",
        format_mix: "{track_id}",
        use_primary_album_artist: true,
        extract_flac: shouldExtractFlac(audioQuality),
        path_binary_ffmpeg: ffmpegBinary,
    };
}

export async function syncDiscogeniusSettings(downloadPath: string = Config.getDownloadPath()): Promise<void> {
    const qualityConfig = Config.getQualityConfig();
    saveSettings(buildDiscogeniusSettings(
        downloadPath,
        mapAudioQuality(qualityConfig?.audio_quality),
        mapVideoQuality(qualityConfig?.video_quality)
    ));
}

/**
 * Initialize tidal-dl-ng with Discogenius-optimized settings
 * Applies the current Discogenius settings into the downloader config once.
 */
export async function initializeSettings(): Promise<void> {
    ensureConfigDir();

    try {
        await syncDiscogeniusSettings();

        console.log("[TIDAL-DL-NG] Settings initialized successfully");
    } catch (error) {
        console.error("[TIDAL-DL-NG] Error initializing settings:", error);
        throw error;
    }
}

/**
 * Check if tidal-dl-ng is authenticated
 */
export async function checkAuth(): Promise<boolean> {
    return new Promise((resolve) => {
        const token = readTidalDlNgToken();
        if (token && token.access_token && token.expiry_time) {
            // expiry_time is in seconds, Date.now() is in milliseconds
            const expiryTimeMs = token.expiry_time * 1000;
            const now = Date.now();
            resolve(expiryTimeMs > now);
        } else {
            resolve(false);
        }
    });
}

export function getTidalDlNgCapabilitySnapshot(): BackendCapabilitySnapshot {
    const configDirCheck = checkWritablePath("tidal-dl-ng.config", TIDAL_DL_NG_CONFIG_DIR, {
        kind: "dir",
        displayName: "tidal-dl-ng config directory",
    });
    const commandCheck = checkCommandAvailability(
        "tidal-dl-ng.command",
        getTidalDlNgCommand().command,
        "tidal-dl-ng",
    );
    const ffmpegBinary = resolveFfmpegBinary();
    const ffmpegCheck = ffmpegBinary
        ? checkCommandAvailability("tidal-dl-ng.ffmpeg", ffmpegBinary, "FFmpeg")
        : {
            scope: "tidal-dl-ng.ffmpeg",
            status: "warning" as const,
            message: "FFmpeg is not configured yet",
            details: { configuredPath: null },
        };
    const token = readTidalDlNgToken();
    const tokenValid = Boolean(
        token?.access_token
        && token?.refresh_token
        && token?.expiry_time
        && token.expiry_time * 1000 > Date.now(),
    );
    const tokenCheck = token
        ? {
            scope: "tidal-dl-ng.token",
            status: tokenValid ? "ok" as const : "warning" as const,
            message: tokenValid
                ? "TIDAL token is present and valid"
                : "TIDAL token is present but expired",
            details: {
                path: TIDAL_DL_NG_TOKEN_FILE,
                expiresAt: token.expiry_time ? new Date(token.expiry_time * 1000).toISOString() : null,
            },
        }
        : {
            scope: "tidal-dl-ng.token",
            status: "warning" as const,
            message: "TIDAL token is not present yet",
            details: { path: TIDAL_DL_NG_TOKEN_FILE },
        };

    const checks = [
        configDirCheck,
        commandCheck,
        ffmpegCheck,
        tokenCheck,
    ];
    const status = rollupHealthStatus(checks);
    const available = !checks.some((check) => check.status === "error");
    const ffmpegRequired = Boolean(Config.getQualityConfig().extract_flac || Config.getQualityConfig().convert_video_mp4);
    const ready = available && tokenValid && (!ffmpegRequired || ffmpegCheck.status === "ok");
    const notes: string[] = [];

    if (!tokenValid) {
        notes.push("Authenticate TIDAL before attempting tidal-dl-ng downloads.");
    }
    if (ffmpegRequired && ffmpegCheck.status !== "ok") {
        notes.push("FFmpeg is required by the current quality settings.");
    }

    return {
        name: "tidal-dl-ng",
        status,
        available,
        ready,
        capabilities: {
            audio: true,
            video: true,
            atmos: true,
            highResAudio: true,
            playlists: true,
        },
        checks,
        notes,
    };
}

/**
 * Progress event parsed from tidal-dl-ng output
 * 
 * tidal-dl-ng uses rich library for progress display:
 * - Individual track: "[blue]Item 'Artist - Track Title' ━━━━━━━━━━ 50%"
 * - List progress: "[green]List 'Album Name' ━━━━━━━━━━ 50% 5/10"
 * - Completion: "Downloaded item 'Artist - Track Title'."
 * - List completion: "Finished list 'Album Name'."
 */
export interface TidalDlNgProgress {
    /** Title of current track being downloaded */
    trackTitle: string;
    /** Progress percentage 0-100 for current item */
    progress: number;
    /** Whether current item download is complete */
    isComplete: boolean;
    /** Whether download is just starting (e.g., session switch) */
    isStarting: boolean;
    /** Current track number in album/playlist (if applicable) */
    currentTrack?: number;
    /** Total tracks in album/playlist (if applicable) */
    totalTracks?: number;
    /** Album/playlist name (if downloading a collection) */
    listName?: string;
    /** Whether this is a list completion message */
    isListComplete?: boolean;
    /** Status message (e.g., "Switching to Atmos...") */
    statusMessage?: string;
    /** Download state for UI display */
    state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused';
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function normalizeProgressOutput(output: string): string {
    return output.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "").trim();
}

/**
 * Parse progress from tidal-dl-ng output
 * 
 * Output examples from tidal-dl-ng:
 * - "Downloaded item 'Artist - Track Title'."
 * - "Item 'Artist - Track Title'   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%"
 * - "Switching session context to Dolby Atmos..."
 * - "Session is now in Atmos mode."
 * - "Session is now in Normal mode."

/**
 * Parse progress from tidal-dl-ng output
 * 
 * Output examples from tidal-dl-ng:
 * - "Downloaded item 'Artist - Track Title'."
 * - "Item 'Artist - Track Title'   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%"
 * - "Switching session context to Dolby Atmos..."
 * - "Session is now in Atmos mode."
 * - "Session is now in Normal mode."
 * - "Finished list 'Album Name'."
 * - "List 'Album Name' ━━━━━━━━━━ 50% 5/10"
 * - "Download skipped, since file exists: 'path'"
 * - "Something went wrong. Skipping 'Artist - Track Title'."
 */
export function parseProgress(output: string): TidalDlNgProgress | null {
    const normalized = normalizeProgressOutput(output);
    if (!normalized) {
        return null;
    }

    if (normalized.includes("Yep, looks good! You are logged in.")) {
        return {
            trackTitle: "",
            progress: 15,
            isComplete: false,
            isStarting: true,
            state: 'downloading',
            statusMessage: "Authenticated with TIDAL",
        };
    }

    if (normalized.includes("Let us check if you are already logged in")) {
        return {
            trackTitle: "",
            progress: 5,
            isComplete: false,
            isStarting: true,
            state: 'downloading',
            statusMessage: "Checking TIDAL session...",
        };
    }

    const convertingVideoMatch = normalized.match(/Converting video:\s*([^\s]+)\s*->/i);
    if (convertingVideoMatch) {
        return {
            trackTitle: "",
            progress: 90,
            isComplete: false,
            isStarting: false,
            state: 'downloading',
            statusMessage: `Converting video ${convertingVideoMatch[1]}...`,
        };
    }

    const conversionCompleteMatch = normalized.match(/Video conversion complete:\s*(.+)$/i);
    if (conversionCompleteMatch) {
        return {
            trackTitle: "",
            progress: 95,
            isComplete: false,
            isStarting: false,
            state: 'downloading',
            statusMessage: `Video conversion complete: ${conversionCompleteMatch[1].trim()}`,
        };
    }

    // Check for "Downloaded item" completion
    const downloadedMatch = normalized.match(/Downloaded (?:item|video|track|file) '([^']+)'/i);
    if (downloadedMatch) {
        return {
            trackTitle: downloadedMatch[1],
            progress: 100,
            isComplete: true,
            isStarting: false,
            state: 'completed',
        };
    }

    // Check for "Finished list" completion
    const finishedListMatch = normalized.match(/Finished list '([^']+)'/i);
    if (finishedListMatch) {
        return {
            trackTitle: "",
            listName: finishedListMatch[1],
            progress: 100,
            isComplete: true,
            isListComplete: true,
            isStarting: false,
            state: 'completed',
        };
    }

    // Check for list progress "List 'name' ━━━ 50% 5/10"
    const listProgressMatch = normalized.match(/(?:\[[^\]]+\]\s*)*List '([^']+)'.*?(\d+)%\s*(\d+)\/(\d+)/i);
    if (listProgressMatch) {
        return {
            trackTitle: "",
            listName: listProgressMatch[1],
            progress: parseInt(listProgressMatch[2], 10),
            currentTrack: parseInt(listProgressMatch[3], 10),
            totalTracks: parseInt(listProgressMatch[4], 10),
            isComplete: false,
            isStarting: false,
            state: 'downloading',
        };
    }

    // Check for item progress bar "Item 'title' ━━━━━━━ 50%"
    // Also match the size and speed if available: "Item 'title' ━━━━━━━ 50% 1.2/2.4 MB 1.2 MB/s"
    const progressMatch = normalized.match(/(?:\[[^\]]+\]\s*)*(?:Item|Video|Track|File) '([^']+)'.*?(\d+)%(?:\s+([\d.]+\s*[KMGTPE]i?B)\/([\d.]+\s*[KMGTPE]i?B))?(?:\s+([\d.]+\s*[KMGTPE]i?B\/s))?/i);
    if (progressMatch) {
        const percent = parseInt(progressMatch[2], 10);
        const statusMessage = progressMatch[5] ? `Speed: ${progressMatch[5]}` : undefined;
        return {
            trackTitle: progressMatch[1],
            progress: percent,
            isComplete: percent >= 100,
            isStarting: false,
            state: percent >= 100 ? 'completed' : 'downloading',
            statusMessage,
        };
    }

    // Check for skipped download
    if (normalized.includes("Download skipped, since file exists")) {
        const skippedMatch = normalized.match(/since file exists:\s*'([^']+)'/);
        return {
            trackTitle: skippedMatch ? skippedMatch[1] : "",
            progress: 100,
            isComplete: true,
            isStarting: false,
            state: 'completed',
            statusMessage: "Skipped - file exists",
        };
    }

    // Check for error/skip
    if (normalized.includes("Something went wrong. Skipping")) {
        const errorMatch = normalized.match(/Skipping '([^']+)'/);
        return {
            trackTitle: errorMatch ? errorMatch[1] : "",
            progress: 0,
            isComplete: false,
            isStarting: false,
            state: 'failed',
            statusMessage: "Download failed",
        };
    }

    // Check for Atmos mode switch
    if (normalized.includes("Switching session context to Dolby Atmos")) {
        return {
            trackTitle: "",
            progress: 0,
            isComplete: false,
            isStarting: true,
            state: 'downloading',
            statusMessage: "Switching to Dolby Atmos...",
        };
    }

    if (normalized.includes("Session is now in Atmos mode")) {
        return {
            trackTitle: "",
            progress: 0,
            isComplete: false,
            isStarting: true,
            state: 'downloading',
            statusMessage: "Atmos mode active",
        };
    }

    if (normalized.includes("Session is now in Normal mode")) {
        return {
            trackTitle: "",
            progress: 0,
            isComplete: false,
            isStarting: true,
            state: 'downloading',
            statusMessage: "Normal mode active",
        };
    }

    // Check for rate limiting
    if (normalized.includes("Next download will start in")) {
        const delayMatch = normalized.match(/start in\s*([\d.]+)\s*seconds/);
        return {
            trackTitle: "",
            progress: 0,
            isComplete: false,
            isStarting: false,
            state: 'queued',
            statusMessage: delayMatch ? `Waiting ${delayMatch[1]}s...` : "Rate limited...",
        };
    }

    return null;
}

/**
 * Build tidal-dl-ng download command arguments
 */
export function buildDownloadArgs(
    url: string,
    stagingDir: string,
    audioQuality: TidalDlNgAudioQuality,
    videoQuality: TidalDlNgVideoQuality,
    isAtmos: boolean = false
): string[] {
    // tidal-dl-ng dl <url> is the main command
    // Settings are read from config file, but we can override some via CLI
    return ["dl", url];
}

/**
 * Spawn a tidal-dl-ng download process
 */
export function spawnDownload(url: string): ChildProcess {
    const env = buildTidalDlNgEnv();
    const args = ["dl", url];

    console.log(`[TIDAL-DL-NG] Running: tidal-dl-ng ${args.join(" ")}`);

    const cmd = getTidalDlNgCommand();
    return spawn(cmd.command, [...cmd.args, ...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
}

// Android TV OAuth2 credentials – supports Dolby Atmos natively.
// base64 decoded: km8T1xS355y7dd3H;vcmeGW1OuZ0fWYMCSZ6vNvSLJlT3XEpW0ambgYt5ZuI=
const TIDAL_DL_NG_CREDS = Buffer.from(
    "a204VDF4UzM1NXk3ZGQzSDt2Y21lR1cxT3VaMGZXWU1DU1o2dk52U0xKbFQzWEVwVzBhbWJnWXQ1WnVJPQ==",
    "base64"
).toString();
const [TDLNG_CLIENT_ID, TDLNG_CLIENT_SECRET] = TIDAL_DL_NG_CREDS.split(";");

/**
 * Refresh TIDAL token via OAuth2 refresh_token grant.
 *
 * tidal-dl-ng's `login` command does NOT refresh expired access tokens –
 * it only checks if a refresh_token exists. We call the Tidal OAuth2
 * token endpoint directly and write the result back to the token file
 * so both Discogenius and tidal-dl-ng stay in sync.
 */
export async function refreshToken(force: boolean = false): Promise<void> {
    const token = readTidalDlNgToken();
    if (!token?.refresh_token) {
        console.warn("⚠️ [TIDAL-DL-NG] No refresh_token available – cannot refresh");
        return;
    }

    console.log("🕖 [TIDAL-DL-NG] Refreshing Tidal access token via OAuth2...");

    try {
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token.refresh_token,
            client_id: TDLNG_CLIENT_ID,
            client_secret: TDLNG_CLIENT_SECRET,
        });

        const res = await fetch("https://auth.tidal.com/v1/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            console.error(`❌ [TIDAL-DL-NG] Token refresh failed: ${res.status} ${res.statusText} – ${errText}`);
            return;
        }

        const data = await res.json() as any;
        const newAccessToken: string = data.access_token;
        const expiresIn: number = data.expires_in || 86400; // seconds
        const newRefreshToken: string = data.refresh_token || token.refresh_token;

        const newToken: TidalDlNgToken = {
            token_type: data.token_type || "Bearer",
            access_token: newAccessToken,
            refresh_token: newRefreshToken,
            expiry_time: Math.floor(Date.now() / 1000) + expiresIn,
        };

        try {
            fs.writeFileSync(TIDAL_DL_NG_TOKEN_FILE, JSON.stringify(newToken, null, 4), "utf-8");
        } catch (e) {
            // non-critical
        }

        console.log(`✅ [TIDAL-DL-NG] Token refreshed – expires in ${(expiresIn / 3600).toFixed(1)}h`);
    } catch (error: any) {
        console.error(`❌ [TIDAL-DL-NG] Token refresh error: ${error.message}`);
    }
}

/**
 * Simple download function for direct downloads
 * Returns a promise that resolves when download completes
 */
export async function downloadWithTidalDlNg(url: string): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
        const downloadProcess = spawnDownload(url);
        let output = "";
        let errorOutput = "";

        downloadProcess.stdout?.on("data", (data) => {
            output += data.toString();
            console.log(`[TIDAL-DL-NG] ${data.toString()}`);
        });

        downloadProcess.stderr?.on("data", (data) => {
            errorOutput += data.toString();
            console.log(`[TIDAL-DL-NG] stderr: ${data.toString()}`);
        });

        downloadProcess.on("close", (code) => {
            if (code === 0) {
                resolve({ success: true, output });
            } else {
                resolve({ success: false, output, error: errorOutput || `Exit code: ${code}` });
            }
        });

        downloadProcess.on("error", (error) => {
            resolve({ success: false, output, error: error.message });
        });
    });
}

/**
 * Login result from tidal-dl-ng login command
 */
export interface TidalDlNgLoginResult {
    success: boolean;
    verificationUrl?: string;
    userCode?: string;
    expiresIn?: number;
    error?: string;
    alreadyLoggedIn?: boolean;
}

/**
 * Start tidal-dl-ng login process
 * Spawns `tidal-dl-ng login` and parses the output for the verification URL
 * The process will continue running and poll for completion, saving the token when done
 * 
 * @returns Promise with login URL info, and a reference to the running process
 */
export function startLogin(): Promise<{ result: TidalDlNgLoginResult; process: ChildProcess }> {
    return new Promise((resolve) => {
        const env = buildTidalDlNgEnv();
        const cmd = getTidalDlNgCommand();
        const loginProcess = spawn(cmd.command, [...cmd.args, "login"], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        let resolved = false;

        const parseAndResolve = () => {
            if (resolved) return;

            // Check if already logged in
            if (output.includes("You are logged in") || output.includes("looks good")) {
                resolved = true;
                resolve({
                    result: { success: true, alreadyLoggedIn: true },
                    process: loginProcess
                });
                return;
            }

            // Parse: "Visit https://link.tidal.com/XXXXX to log in, the code will expire in XXX seconds"
            const urlMatch = output.match(/Visit (https:\/\/link\.tidal\.com\/(\w+)) to log in.*expire.*?(\d+)/);
            if (urlMatch) {
                resolved = true;
                resolve({
                    result: {
                        success: true,
                        verificationUrl: urlMatch[1],
                        userCode: urlMatch[2],
                        expiresIn: parseInt(urlMatch[3], 10)
                    },
                    process: loginProcess
                });
            }
        };

        loginProcess.stdout?.on("data", (data) => {
            output += data.toString();
            console.log(`[TIDAL-DL-NG LOGIN] ${data.toString().trim()}`);
            parseAndResolve();
        });

        loginProcess.stderr?.on("data", (data) => {
            output += data.toString();
            console.log(`[TIDAL-DL-NG LOGIN] ${data.toString().trim()}`);
            parseAndResolve();
        });

        loginProcess.on("error", (error) => {
            if (!resolved) {
                resolved = true;
                resolve({
                    result: { success: false, error: error.message },
                    process: loginProcess
                });
            }
        });

        // Timeout after 30 seconds if we haven't parsed a URL
        // tidal-dl-ng can take a while to output due to Python buffering
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.log(`[TIDAL-DL-NG LOGIN] Timeout - output so far: ${output}`);
                resolve({
                    result: { success: false, error: "Timeout waiting for login URL" },
                    process: loginProcess
                });
            }
        }, 30000);
    });
}

/**
 * Run tidal-dl-ng logout
 */
export async function logout(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
        const env = buildTidalDlNgEnv();
        const cmd = getTidalDlNgCommand();
        const logoutProcess = spawn(cmd.command, [...cmd.args, "logout"], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";

        logoutProcess.stdout?.on("data", (data) => {
            output += data.toString();
        });

        logoutProcess.stderr?.on("data", (data) => {
            output += data.toString();
        });

        logoutProcess.on("close", (code) => {
            if (code === 0 || output.includes("logged out")) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: output || `Exit code: ${code}` });
            }
        });

        logoutProcess.on("error", (error) => {
            resolve({ success: false, error: error.message });
        });
    });
}

export default {
    buildTidalDlNgEnv,
    getTidalDlNgCommand,
    getDownloadSourcePath,
    initializeSettings,
    syncDiscogeniusSettings,
    checkAuth,
    parseProgress,
    spawnDownload,
    mapAudioQuality,
    mapVideoQuality,
    readSettings,
    updateSetting,
    refreshToken,
    downloadWithTidalDlNg,
    readTidalDlNgToken,
    clearTidalDlNgToken,
    clearHistory,
    startLogin,
    logout,
    ensureConfigDir,
    TIDAL_DL_NG_CONFIG_DIR,
    TIDAL_DL_NG_SETTINGS_FILE,
    TIDAL_DL_NG_TOKEN_FILE,
    getTidalDlNgCapabilitySnapshot,
};

