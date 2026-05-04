import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { CONFIG_DIR, REPO_ROOT } from "./config.js";
import { Config } from "./config.js";
import type { TidalAuthToken } from "./providers/tidal/tidal-auth.js";
import { resolveOrpheusTidalModuleConfig } from "./provider-client-config.js";
import {
    checkCommandAvailability,
    checkWritablePath,
    rollupHealthStatus,
    type BackendCapabilitySnapshot,
} from "../utils/health.js";

const IS_WINDOWS = process.platform === "win32";
const IS_DOCKER = process.env.DOCKER === "true";

function resolveManagedPath(rawPath: string): string {
    return path.isAbsolute(rawPath) ? rawPath : path.join(REPO_ROOT, rawPath);
}

const DEFAULT_ORPHEUS_RUNTIME_DIR = IS_DOCKER
    ? "/opt/orpheusdl"
    : path.join(REPO_ROOT, ".runtime", "orpheusdl");
const ORPHEUS_RUNTIME_DIR = process.env.ORPHEUSDL_ROOT?.trim()
    ? resolveManagedPath(process.env.ORPHEUSDL_ROOT)
    : DEFAULT_ORPHEUS_RUNTIME_DIR;
const ORPHEUS_STATE_DIR = process.env.ORPHEUSDL_STATE_DIR?.trim()
    ? resolveManagedPath(process.env.ORPHEUSDL_STATE_DIR)
    : path.join(CONFIG_DIR, "orpheusdl");
const ORPHEUS_SETTINGS_DIR = path.join(ORPHEUS_STATE_DIR, "config");
const ORPHEUS_SETTINGS_FILE = path.join(ORPHEUS_SETTINGS_DIR, "settings.json");
const ORPHEUS_LOGIN_STORAGE_FILE = path.join(ORPHEUS_SETTINGS_DIR, "loginstorage.bin");
const ORPHEUS_RUNTIME_CONFIG_DIR = path.join(ORPHEUS_RUNTIME_DIR, "config");
const ORPHEUS_ENTRYPOINT = path.join(ORPHEUS_RUNTIME_DIR, "orpheus.py");
const ORPHEUS_VENV_DIR = path.join(ORPHEUS_RUNTIME_DIR, ".venv");
const REPO_VENV_PYTHON = path.join(REPO_ROOT, ".venv", IS_WINDOWS ? "Scripts/python.exe" : "bin/python");
const ORPHEUS_PYTHON_BIN = process.env.ORPHEUSDL_PYTHON_BIN?.trim()
    || (IS_DOCKER ? path.join(DEFAULT_ORPHEUS_RUNTIME_DIR, ".venv", "bin", "python") : path.join(ORPHEUS_VENV_DIR, IS_WINDOWS ? "Scripts/python.exe" : "bin/python"));
const ORPHEUS_BOOTSTRAP_PYTHON = process.env.ORPHEUSDL_BOOTSTRAP_PYTHON?.trim()
    || (!IS_DOCKER && fs.existsSync(REPO_VENV_PYTHON) ? REPO_VENV_PYTHON : "python3");
const ORPHEUS_CORE_REPO = process.env.ORPHEUSDL_CORE_REPO?.trim() || "https://github.com/OrfiTeam/OrpheusDL.git";
const ORPHEUS_TIDAL_REPO = process.env.ORPHEUSDL_TIDAL_REPO?.trim() || "https://github.com/Dniel97/orpheusdl-tidal.git";
const LEGACY_STATE_RUNTIME_ENTRIES = [
    ".git",
    ".gitignore",
    ".venv",
    "README.md",
    "extensions",
    "modules",
    "moduletesting.py",
    "orpheus",
    "orpheus.py",
    "requirements.txt",
    "utils",
];

let runtimeReady: Promise<void> | null = null;

function getOrpheusClientConfig() {
    return resolveOrpheusTidalModuleConfig(process.env);
}

function mergeDirectory(sourceDir: string, targetDir: string, options?: { skip?: Set<string> }): void {
    const skip = options?.skip || new Set<string>();

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (skip.has(entry.name)) {
            continue;
        }

        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            mergeDirectory(sourcePath, targetPath);
            continue;
        }

        fs.copyFileSync(sourcePath, targetPath);
    }
}

async function cloneRepoIntoRuntime(repoUrl: string, targetDir: string, options?: { skip?: string[] }): Promise<void> {
    if (!fs.existsSync(targetDir) || fs.readdirSync(targetDir).length === 0) {
        await runCommand("git", ["clone", "--depth", "1", repoUrl, targetDir], path.dirname(targetDir));
        return;
    }

    const tempDir = path.join(path.dirname(targetDir), `.orpheus-bootstrap-${Date.now()}`);
    await runCommand("git", ["clone", "--depth", "1", repoUrl, tempDir], path.dirname(tempDir));

    try {
        mergeDirectory(tempDir, targetDir, { skip: new Set(options?.skip || []) });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        });

        child.on("error", (error) => reject(error));
    });
}

function runPythonScript(command: string, script: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ["-c", script], {
            cwd,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        });

        child.on("error", (error) => reject(error));
    });
}

function cleanupLegacyStateRuntimeFiles(): void {
    for (const entry of LEGACY_STATE_RUNTIME_ENTRIES) {
        const entryPath = path.join(ORPHEUS_STATE_DIR, entry);
        if (!fs.existsSync(entryPath)) {
            continue;
        }

        fs.rmSync(entryPath, { recursive: true, force: true });
    }
}

function ensureRuntimeConfigLink(): void {
    try {
        const stat = (() => { try { return fs.lstatSync(ORPHEUS_RUNTIME_CONFIG_DIR); } catch { return null; } })();
        if (stat?.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(ORPHEUS_RUNTIME_CONFIG_DIR);
            if (linkTarget === ORPHEUS_SETTINGS_DIR) {
                return;
            }
        }

        if (stat) {
            fs.rmSync(ORPHEUS_RUNTIME_CONFIG_DIR, { recursive: true, force: true });
        }
    } catch {
        try { fs.rmSync(ORPHEUS_RUNTIME_CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    fs.symlinkSync(
        ORPHEUS_SETTINGS_DIR,
        ORPHEUS_RUNTIME_CONFIG_DIR,
        IS_WINDOWS ? "junction" : "dir",
    );
}

function ensureRuntimeDirs(): void {
    if (!fs.existsSync(ORPHEUS_STATE_DIR)) {
        fs.mkdirSync(ORPHEUS_STATE_DIR, { recursive: true });
    }
    if (!IS_DOCKER && !fs.existsSync(ORPHEUS_RUNTIME_DIR)) {
        fs.mkdirSync(ORPHEUS_RUNTIME_DIR, { recursive: true });
    }
    if (!fs.existsSync(ORPHEUS_SETTINGS_DIR)) {
        fs.mkdirSync(ORPHEUS_SETTINGS_DIR, { recursive: true });
    }

    cleanupLegacyStateRuntimeFiles();
    ensureRuntimeConfigLink();
}

function buildOrpheusSettings(downloadPath: string) {
    const quality = Config.getQualityConfig();
    const metadata = Config.getMetadataConfig();
    const mainResolution = typeof metadata.album_cover_resolution === "number" ? metadata.album_cover_resolution : 1280;

    return {
        global: {
            general: {
                download_path: downloadPath,
                download_quality: quality.audio_quality === "max"
                    ? "hifi"
                    : quality.audio_quality === "high"
                        ? "lossless"
                        : quality.audio_quality === "normal"
                            ? "high"
                            : "low",
                search_limit: 10,
            },
            artist_downloading: {
                return_credited_albums: true,
                separate_tracks_skip_downloaded: true,
            },
            formatting: {
                album_format: "{id}",
                playlist_format: "{creator}/{name}{explicit}",
                track_filename_format: "{track_number}",
                single_full_path_format: "{album_id}/{track_number}",
                enable_zfill: true,
                force_album_format: false,
            },
            codecs: {
                proprietary_codecs: true,
                spatial_codecs: true,
            },
            module_defaults: {
                lyrics: "default",
                covers: "default",
                credits: "default",
            },
            lyrics: {
                embed_lyrics: Boolean(quality.embed_lyrics),
                embed_synced_lyrics: Boolean(quality.embed_synced_lyrics ?? false),
                save_synced_lyrics: Boolean(metadata.save_lyrics),
            },
            covers: {
                embed_cover: Boolean(quality.embed_cover),
                main_compression: "high",
                main_resolution: mainResolution,
                save_external: false,
                external_format: "jpg",
                external_compression: "low",
                external_resolution: mainResolution,
                save_animated_cover: false,
            },
            playlist: {
                save_m3u: false,
                paths_m3u: "absolute",
                extended_m3u: false,
            },
            advanced: {
                advanced_login_system: false,
                codec_conversions: {
                    alac: "flac",
                    wav: "flac",
                },
                conversion_flags: {
                    flac: {
                        compression_level: "5",
                    },
                },
                conversion_keep_original: false,
                cover_variance_threshold: 8,
                debug_mode: false,
                disable_subscription_checks: false,
                enable_undesirable_conversions: false,
                ignore_existing_files: false,
                ignore_different_artists: true,
            },
        },
        extensions: {},
        modules: {
            tidal: {
                tv_atmos_token: getOrpheusClientConfig().clientId,
                tv_atmos_secret: getOrpheusClientConfig().clientSecret,
                mobile_atmos_hires_token: getOrpheusClientConfig().mobileAtmosToken,
                mobile_hires_token: getOrpheusClientConfig().mobileHiresToken,
                enable_mobile: false,
                prefer_ac4: false,
                fix_mqa: false,
            },
        },
    };
}

async function bootstrapRuntime(): Promise<void> {
    ensureRuntimeDirs();

    if (IS_DOCKER) {
        // Toolchain is baked into the image at /opt/orpheusdl.
        // Only state dirs and the config symlink are needed at runtime.
        return;
    }

    if (!fs.existsSync(ORPHEUS_ENTRYPOINT)) {
        await cloneRepoIntoRuntime(ORPHEUS_CORE_REPO, ORPHEUS_RUNTIME_DIR, { skip: ["config"] });
    }

    const moduleDir = path.join(ORPHEUS_RUNTIME_DIR, "modules", "tidal");
    if (!fs.existsSync(moduleDir)) {
        await runCommand("git", ["clone", "--depth", "1", "--recurse-submodules", ORPHEUS_TIDAL_REPO, moduleDir], ORPHEUS_RUNTIME_DIR);
    }

    if (!fs.existsSync(ORPHEUS_PYTHON_BIN)) {
        await runCommand(ORPHEUS_BOOTSTRAP_PYTHON, ["-m", "venv", ORPHEUS_VENV_DIR], ORPHEUS_RUNTIME_DIR);
    }

    await runCommand(ORPHEUS_PYTHON_BIN, ["-m", "pip", "install", "--upgrade", "pip"], ORPHEUS_RUNTIME_DIR);
    await runCommand(ORPHEUS_PYTHON_BIN, ["-m", "pip", "install", "-r", "requirements.txt"], ORPHEUS_RUNTIME_DIR);
    if (fs.existsSync(path.join(moduleDir, "requirements.txt"))) {
        await runCommand(ORPHEUS_PYTHON_BIN, ["-m", "pip", "install", "-r", path.join("modules", "tidal", "requirements.txt")], ORPHEUS_RUNTIME_DIR);
    }
}

export async function ensureOrpheusRuntime(): Promise<void> {
    if (!runtimeReady) {
        runtimeReady = bootstrapRuntime();
    }
    await runtimeReady;
}

export function getOrpheusCapabilitySnapshot(): BackendCapabilitySnapshot {
    const runtimeDirCheck = IS_DOCKER
        ? {
            scope: "orpheus.runtime",
            status: fs.existsSync(ORPHEUS_ENTRYPOINT) ? "ok" as const : "error" as const,
            message: fs.existsSync(ORPHEUS_ENTRYPOINT)
                ? "Orpheus runtime is baked into Docker image"
                : "Orpheus runtime not found in Docker image",
            details: { path: ORPHEUS_RUNTIME_DIR },
        }
        : checkWritablePath("orpheus.runtime", ORPHEUS_RUNTIME_DIR, {
            kind: "dir",
            displayName: "Orpheus runtime directory",
        });
    const stateDirCheck = checkWritablePath("orpheus.state", ORPHEUS_STATE_DIR, {
        kind: "dir",
        displayName: "Orpheus state directory",
    });
    const entrypointCheck = IS_DOCKER
        ? {
            scope: "orpheus.entrypoint",
            status: fs.existsSync(ORPHEUS_ENTRYPOINT) ? "ok" as const : "error" as const,
            message: fs.existsSync(ORPHEUS_ENTRYPOINT)
                ? "Orpheus entrypoint present in Docker image"
                : "Orpheus entrypoint not found in Docker image",
            details: { path: ORPHEUS_ENTRYPOINT },
        }
        : checkWritablePath("orpheus.entrypoint", ORPHEUS_ENTRYPOINT, {
            kind: "file",
            displayName: "Orpheus entrypoint",
        });
    const gitCheck = IS_DOCKER
        ? { scope: "orpheus.git", status: "ok" as const, message: "Git not required in Docker (toolchain baked in)", details: {} }
        : checkCommandAvailability("orpheus.git", "git", "Git");
    const pythonCheck = checkCommandAvailability("orpheus.python", IS_DOCKER ? "python3" : ORPHEUS_BOOTSTRAP_PYTHON, "Python");
    const sessionExists = fs.existsSync(ORPHEUS_LOGIN_STORAGE_FILE);
    const sessionCheck = sessionExists
        ? {
            scope: "orpheus.session",
            status: "ok" as const,
            message: "Orpheus session token is present",
            details: { path: ORPHEUS_LOGIN_STORAGE_FILE },
        }
        : {
            scope: "orpheus.session",
            status: "warning" as const,
            message: "Orpheus session token is not present yet",
            details: { path: ORPHEUS_LOGIN_STORAGE_FILE },
        };

    const checks = [
        runtimeDirCheck,
        stateDirCheck,
        entrypointCheck,
        gitCheck,
        pythonCheck,
        sessionCheck,
    ];
    const status = rollupHealthStatus(checks);
    const available = !checks.some((check) => check.status === "error");
    const ready = available && sessionExists && fs.existsSync(ORPHEUS_ENTRYPOINT);
    const notes: string[] = [];

    if (!sessionExists) {
        notes.push("Authenticate with TIDAL before attempting Orpheus downloads.");
    }
    if (!fs.existsSync(ORPHEUS_ENTRYPOINT)) {
        notes.push(IS_DOCKER
            ? "Orpheus runtime not found in Docker image — rebuild the image."
            : "Orpheus runtime has not been bootstrapped yet.");
    }

    return {
        name: "orpheus",
        status,
        available,
        ready,
        capabilities: {
            audio: true,
            video: false,
            atmos: true,
            highResAudio: true,
            playlists: true,
        },
        checks,
        notes,
    };
}

export async function syncOrpheusSettings(downloadPath: string = Config.getDownloadPath()): Promise<void> {
    ensureRuntimeDirs();
    fs.writeFileSync(ORPHEUS_SETTINGS_FILE, JSON.stringify(buildOrpheusSettings(downloadPath), null, 2), "utf-8");
}

export async function syncTokenToOrpheusSession(token: TidalAuthToken): Promise<void> {
    ensureRuntimeDirs();

    const expiresAt = token.expires_at ?? null;
    const countryCode = token.user?.countryCode || "US";
    const expiresAtLiteral = expiresAt === null ? "None" : String(expiresAt);
    const userIdLiteral = token.user?.userId ? JSON.stringify(String(token.user.userId)) : "None";

    const script = [
        "import os, pickle",
        "from datetime import datetime, timezone",
        "token = {",
        `    'access_token': ${JSON.stringify(token.access_token)},`,
        `    'refresh_token': ${JSON.stringify(token.refresh_token)},`,
        `    'expires_at': ${expiresAtLiteral},`,
        `    'user_id': ${userIdLiteral},`,
        `    'country_code': ${JSON.stringify(countryCode)},`,
        "}",
        `storage_path = ${JSON.stringify(ORPHEUS_LOGIN_STORAGE_FILE)}`,
        "temp_path = storage_path + '.tmp'",
        "os.makedirs(os.path.dirname(storage_path), exist_ok=True)",
        "expires_value = datetime.fromtimestamp(token['expires_at'], timezone.utc) if token['expires_at'] else None",
        "payload = {",
        "  'advancedmode': False,",
        "  'modules': {",
        "    'tidal': {",
        "      'selected': 'default',",
        "      'sessions': {",
        "        'default': {",
        "          'clear_session': False,",
        "          'custom_data': {",
        "            'sessions': {",
        "              'TV': {",
        "                'access_token': token['access_token'],",
        "                'refresh_token': token['refresh_token'],",
        "                'expires': expires_value,",
        "                'user_id': token['user_id'],",
        "                'country_code': token['country_code'],",
        "              }",
        "            }",
        "          }",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
        "try:",
        "    with open(temp_path, 'wb') as fh:",
        "        pickle.dump(payload, fh, protocol=pickle.HIGHEST_PROTOCOL)",
        "        fh.flush()",
        "        os.fsync(fh.fileno())",
        "    os.replace(temp_path, storage_path)",
        "except Exception:",
        "    if os.path.exists(temp_path):",
        "        os.remove(temp_path)",
        "    raise",
    ].join("\n");

    const pythonBin = fs.existsSync(ORPHEUS_PYTHON_BIN) ? ORPHEUS_PYTHON_BIN : ORPHEUS_BOOTSTRAP_PYTHON;
    await runPythonScript(pythonBin, script, ORPHEUS_RUNTIME_DIR);
}

export function clearOrpheusSession(): void {
    try {
        if (fs.existsSync(ORPHEUS_LOGIN_STORAGE_FILE)) {
            fs.unlinkSync(ORPHEUS_LOGIN_STORAGE_FILE);
        }
    } catch (error) {
        console.error("[ORPHEUS] Failed to clear session:", error);
    }
}

export interface OrpheusProgress {
    entityType?: "album" | "playlist" | "track";
    entityName?: string;
    currentTrack?: number;
    totalTracks?: number;
    currentTrackName?: string;
    trackProgress?: number;
    isTrackComplete?: boolean;
    isTrackFailed?: boolean;
    isEntityComplete?: boolean;
    speed?: string;
    eta?: string;
    size?: number;
    sizeleft?: number;
    statusMessage?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function normalizeProgressOutput(output: string): string {
    return output.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "").trim();
}

function parseScaledBytes(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const match = value.trim().match(/^([\d.]+)\s*([KMGTPE]?)(?:i?B?)?$/i);
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) {
        return undefined;
    }

    const unit = match[2].toUpperCase();
    const powerMap: Record<string, number> = {
        "": 0,
        K: 1,
        M: 2,
        G: 3,
        T: 4,
        P: 5,
        E: 6,
    };
    const power = powerMap[unit];
    if (power === undefined) {
        return undefined;
    }

    return Math.round(amount * (1024 ** power));
}

export function parseOrpheusProgress(output: string): OrpheusProgress | null {
    const normalized = normalizeProgressOutput(output);
    if (!normalized) {
        return null;
    }

    const entityStartMatch = normalized.match(/^=== Downloading (album|playlist|track) (.+?) \(([^)]+)\) ===$/i);
    if (entityStartMatch) {
        return {
            entityType: entityStartMatch[1].toLowerCase() as "album" | "playlist" | "track",
            entityName: entityStartMatch[2],
            statusMessage: normalized,
        };
    }

    const trackCounterMatch = normalized.match(/^Track (\d+)\/(\d+)$/);
    if (trackCounterMatch) {
        return {
            currentTrack: Number(trackCounterMatch[1]),
            totalTracks: Number(trackCounterMatch[2]),
        };
    }

    const trackStartMatch = normalized.match(/^=== Downloading track (.+?) \(([^)]+)\) ===$/i);
    if (trackStartMatch) {
        return {
            entityType: "track",
            currentTrackName: trackStartMatch[1],
            statusMessage: `Downloading ${trackStartMatch[1]}`,
        };
    }

    const progressBarMatch = normalized.match(/(\d{1,3})%\|[^|]*\|\s*([\d.]+\s*[KMGTPE]?(?:i?B?)?)\/([\d.]+\s*[KMGTPE]?(?:i?B?)?)\s*\[(\d{1,2}:\d{2}(?::\d{2})?)<([^,\]]+),\s*([^\]]+)\]/i);
    if (progressBarMatch) {
        const size = parseScaledBytes(progressBarMatch[3]);
        const transferred = parseScaledBytes(progressBarMatch[2]);
        return {
            trackProgress: Number(progressBarMatch[1]),
            size,
            sizeleft: size !== undefined && transferred !== undefined
                ? Math.max(0, size - transferred)
                : undefined,
            eta: progressBarMatch[5].trim() === "?" ? undefined : progressBarMatch[5].trim(),
            speed: progressBarMatch[6].trim() === "?B/s" ? undefined : progressBarMatch[6].trim(),
        };
    }

    const trackDoneMatch = normalized.match(/^=== Track ([^)]+?) downloaded ===$/i);
    if (trackDoneMatch) {
        return {
            isTrackComplete: true,
            statusMessage: normalized,
        };
    }

    const trackFailedMatch = normalized.match(/^=== Track ([^)]+?) failed ===$/i);
    if (trackFailedMatch) {
        return {
            isTrackFailed: true,
            statusMessage: normalized,
        };
    }

    const entityDoneMatch = normalized.match(/^=== (Album|Playlist) (.+?) downloaded ===$/i);
    if (entityDoneMatch) {
        return {
            entityType: entityDoneMatch[1].toLowerCase() as "album" | "playlist",
            entityName: entityDoneMatch[2],
            isEntityComplete: true,
            statusMessage: normalized,
        };
    }

    if (
        normalized.includes("Downloading track file")
        || normalized.startsWith("Downloading album cover")
        || normalized.startsWith("Downloading playlist cover")
        || normalized.startsWith("Retrieving lyrics")
        || normalized.startsWith("Retrieving credits")
    ) {
        return { statusMessage: normalized };
    }

    return null;
}

export async function spawnOrpheusDownload(
    type: "album" | "track" | "playlist",
    sourceId: string,
    downloadPath: string,
): Promise<ChildProcess> {
    await ensureOrpheusRuntime();
    await syncOrpheusSettings(downloadPath);

    return spawn(
        ORPHEUS_PYTHON_BIN,
        ["orpheus.py", "-o", downloadPath, "download", "tidal", type, sourceId],
        {
            cwd: ORPHEUS_RUNTIME_DIR,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
}

export {
    ORPHEUS_ENTRYPOINT,
    ORPHEUS_LOGIN_STORAGE_FILE,
    ORPHEUS_RUNTIME_DIR,
    ORPHEUS_SETTINGS_FILE,
};
