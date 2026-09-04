import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  DownloadBackend,
  DownloadProgress,
  DownloadRequest,
} from "../../download/download-backend.js";
import { configuredAudioQuality } from "../../config/config.js";
import { getDeezerConfigDir, loadDeezerCredentials } from "./deezer-auth.js";

const MEDIA_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"]);

export interface StreamripRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onLine(line: string): void;
}

export type StreamripErrorKind =
  | "configuration"
  | "authentication"
  | "entitlement"
  | "geography"
  | "quality"
  | "unavailable"
  | "transient"
  | "unknown";

export interface StreamripClassifiedError {
  kind: StreamripErrorKind;
  permanent: boolean;
  message: string;
}

export interface StreamripRunResult {
  exitCode: number | null;
  outputTail: string;
  classifiedErrors: StreamripClassifiedError[];
  producedFiles: string[];
}

export type StreamripCommandRunner = (
  command: string,
  args: string[],
  options: StreamripRunOptions,
) => Promise<StreamripRunResult>;

export function getStreamripBinary(): string {
  return process.env.STREAMRIP_BIN?.trim() || "/opt/streamrip-venv/bin/rip";
}

export function getStreamripConfigPath(): string {
  return path.join(getDeezerConfigDir(), "streamrip.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/gu, "/"));
}

/**
 * Provider-owned Streamrip config. File/folder templates use Deezer resource
 * ids, so the canonical importer never has to infer a track from a title.
 */
export function renderStreamripConfig(arl: string): string {
  const configDir = getDeezerConfigDir();
  return `[downloads]
folder = "/downloads"
source_subdirectories = false
disc_subdirectories = false
concurrency = true
max_connections = 6
requests_per_minute = 60
verify_ssl = true

[qobuz]
quality = 3
download_booklets = false
use_auth_token = false
email_or_userid = ""
password_or_token = ""
app_id = ""
secrets = []

[tidal]
quality = 3
download_videos = false
user_id = ""
country_code = ""
access_token = ""
refresh_token = ""
token_expiry = ""

[deezer]
quality = 2
arl = ${tomlString(arl)}
use_deezloader = false
deezloader_warnings = true

[soundcloud]
quality = 0
client_id = ""
app_version = ""

[youtube]
quality = 0
download_videos = false
video_downloads_folder = "/downloads/videos"

[database]
downloads_enabled = false
downloads_path = ${tomlString(path.join(configDir, "downloads.db"))}
failed_downloads_enabled = false
failed_downloads_path = ${tomlString(path.join(configDir, "failed-downloads.db"))}

[conversion]
enabled = false
codec = "FLAC"
sampling_rate = 48000
bit_depth = 24
lossy_bitrate = 320

[qobuz_filters]
extras = false
repeats = false
non_albums = false
features = false
non_studio_albums = false
non_remaster = false

[artwork]
embed = true
embed_size = "large"
embed_max_width = -1
save_artwork = true
saved_max_width = -1

[metadata]
set_playlist_to_album = true
renumber_playlist_tracks = false
exclude = []

[filepaths]
add_singles_to_folder = false
folder_format = "{id}"
track_format = "{id}"
restrict_characters = false
truncate_to = 120

[lastfm]
source = "deezer"
fallback_source = ""

[cli]
text_output = true
progress_bars = false
max_search_results = 100

[misc]
version = "2.0.6"
check_for_updates = false
`;
}

export function syncDeezerStreamripConfig(): string | null {
  const credentials = loadDeezerCredentials();
  if (!credentials) return null;
  const target = getStreamripConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderStreamripConfig(credentials.arl), { encoding: "utf8", mode: 0o600 });
  return target;
}

export function buildStreamripArgs(request: DownloadRequest): string[] {
  if (request.entityType === "video") {
    throw new Error("Deezer does not expose music-video downloads.");
  }
  const streamripQuality = streamripQualityCeiling(request.quality);
  const kind = request.entityType === "album" ? "album" : "track";
  const resourceUrl = `https://www.deezer.com/${kind}/${encodeURIComponent(request.providerId)}`;
  return [
    "--config-path",
    getStreamripConfigPath(),
    "--folder",
    request.downloadPath,
    "--no-db",
    "--no-progress",
    "--quality",
    streamripQuality,
    "url",
    resourceUrl,
  ];
}

const STREAMRIP_LEVEL_RANK = { "0": 0, "1": 1, "2": 2 } as const;

function streamripLevelFromOffer(quality: string | null | undefined): "0" | "1" | "2" {
  const normalized = String(quality || "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
  if (normalized === "low" || normalized.includes("128")) return "0";
  if (
    normalized === "normal"
    || normalized === "lossy"
    || normalized.includes("mp3")
    || normalized.includes("320")
  ) return "1";
  return "2";
}

function streamripLevelFromSettings(configured: "low" | "normal" | "high" | "max"): "0" | "1" | "2" {
  if (configured === "low") return "0";
  if (configured === "normal") return "1";
  // Deezer HiFi tops out at 16-bit FLAC (streamrip 2). There is no 24-bit rung.
  return "2";
}

export function streamripQualityCeiling(
  quality: string | null | undefined,
  configuredQuality: "low" | "normal" | "high" | "max" = configuredAudioQuality(),
): "0" | "1" | "2" {
  const fromOffer = streamripLevelFromOffer(quality);
  const fromSettings = streamripLevelFromSettings(configuredQuality);
  return STREAMRIP_LEVEL_RANK[fromOffer] > STREAMRIP_LEVEL_RANK[fromSettings]
    ? fromSettings
    : fromOffer;
}

function mediaFilesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(absolute);
    }
  }
  return result;
}

export function redactStreamripOutput(value: string): string {
  return String(value || "")
    .replace(/((?:arl|cookie|token)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{64,}\b/gu, "[redacted]");
}

export function classifyStreamripOutput(output: string): StreamripClassifiedError[] {
  const lines = redactStreamripOutput(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors: StreamripClassifiedError[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let kind: StreamripErrorKind | null = null;
    let permanent = true;
    if (/error processing media item:\s*['"]id['"]|keyerror:\s*['"]id['"]/iu.test(line)) {
      kind = "configuration";
    } else if (/invalid\s+arl|arl\s+(?:expired|invalid)|authentication|not logged in|login required/iu.test(line)) {
      kind = "authentication";
    } else if (/wronglicense|license.*(?:denied|invalid)|entitlement|subscription required/iu.test(line)) {
      kind = "entitlement";
    } else if (/not available in (?:your|this) country|geo(?:graphically)?[- ]?restricted/iu.test(line)) {
      kind = "geography";
    } else if (/quality.*(?:unavailable|not available|restricted)|format.*not available/iu.test(line)) {
      kind = "quality";
    } else if (/not found|no longer available|unavailable/iu.test(line)) {
      kind = "unavailable";
    } else if (/rate.?limit|too many requests|timeout|temporar|network|connection/iu.test(line)) {
      kind = "transient";
      permanent = false;
    } else if (/\berror\b|\bfailed\b|traceback/iu.test(line)) {
      kind = "unknown";
      permanent = false;
    }
    if (!kind) continue;
    const key = `${kind}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ kind, permanent, message: line.slice(0, 500) });
  }
  return errors;
}

export function streamripProgressForLine(line: string): DownloadProgress | null {
  const normalized = line.trim();
  if (!normalized) return null;
  if (/error|failed|unavailable/iu.test(normalized)) {
    return { progress: 5, state: "downloading", statusMessage: normalized, trackStatus: "error" };
  }
  if (/downloaded|completed|saved/iu.test(normalized)) {
    return { progress: 90, state: "downloading", statusMessage: normalized, trackStatus: "completed" };
  }
  if (/downloading|resolving|fetching/iu.test(normalized)) {
    return { progress: 10, state: "downloading", statusMessage: normalized, trackStatus: "downloading" };
  }
  return null;
}

export const runStreamripCommand: StreamripCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 300_000);
  timeoutId.unref?.();

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Streamrip often prints failures on stdout (text_output=true); keep a
  // combined recent tail so exit-1 is never "unknown error" with an empty stderr.
  let outputTail = "";
  const buffers = { stdout: "", stderr: "" };

  const consume = (source: "stdout" | "stderr", chunk: Buffer | string) => {
    buffers[source] += chunk.toString();
    const lines = buffers[source].split(/\r?\n/u);
    buffers[source] = lines.pop() || "";
    for (const line of lines) {
      const redacted = redactStreamripOutput(line);
      outputTail = `${outputTail}\n${redacted}`.trim().slice(-4000);
      options.onLine(redacted);
    }
  };
  child.stdout.on("data", (chunk) => consume("stdout", chunk));
  child.stderr.on("data", (chunk) => consume("stderr", chunk));

  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abort);
    for (const source of ["stdout", "stderr"] as const) {
      if (buffers[source].trim()) {
        const leftover = redactStreamripOutput(buffers[source].trim());
        outputTail = `${outputTail}\n${leftover}`.trim().slice(-4000);
        options.onLine(leftover);
      }
    }
    if (timedOut) {
      reject(new Error("Deezer download timed out after 300 seconds."));
    } else if (options.signal?.aborted) {
      reject(new Error("Deezer download cancelled."));
    } else {
      const producedFiles = mediaFilesUnder(options.cwd);
      resolve({
        exitCode: code,
        outputTail,
        classifiedErrors: classifyStreamripOutput(outputTail),
        producedFiles,
      });
    }
  });
});

export class StreamripDeezerBackend implements DownloadBackend {
  readonly id = "streamrip-deezer";
  readonly supportedProviders = ["deezer"];
  readonly capabilities: Array<"stereo"> = ["stereo"];

  constructor(private readonly runner: StreamripCommandRunner = runStreamripCommand) {}

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (!loadDeezerCredentials()) {
      throw new Error("Connect Deezer with an ARL cookie before downloading.");
    }
    syncDeezerStreamripConfig();
    fs.mkdirSync(request.downloadPath, { recursive: true });
    options.onProgress({ progress: 1, state: "downloading", statusMessage: "Starting Deezer download" });
    const result = await this.runner(getStreamripBinary(), buildStreamripArgs(request), {
      cwd: request.downloadPath,
      signal: options.signal,
      onLine: (line) => {
        const progress = streamripProgressForLine(line);
        if (progress) options.onProgress(progress);
      },
    });
    const producedFiles = result.producedFiles.length > 0
      ? result.producedFiles
      : mediaFilesUnder(request.downloadPath);
    const errors = result.classifiedErrors.length > 0
      ? result.classifiedErrors
      : classifyStreamripOutput(result.outputTail);
    const errorSummary = errors.map((error) => `${error.kind}: ${error.message}`).join("; ");
    if (result.exitCode !== 0 && producedFiles.length === 0) {
      throw new Error(
        `Streamrip exited with ${result.exitCode ?? "unknown"}: ${errorSummary || result.outputTail || "unknown error"}`,
      );
    }
    if (producedFiles.length === 0) {
      throw new Error(
        `Streamrip produced no Deezer media files${errorSummary ? `: ${errorSummary}` : ""}.`,
      );
    }
    if (errors.length > 0 && request.entityType !== "album") {
      throw new Error(`Streamrip reported a Deezer item failure: ${errorSummary}`);
    }
    if (errors.length > 0) {
      options.onProgress({
        progress: 95,
        state: "downloading",
        statusMessage: `Deezer download produced ${producedFiles.length} file(s) with skipped items`,
        trackStatus: "error",
      });
    }
    options.onProgress({ progress: 100, state: "downloading", statusMessage: "Deezer download complete" });
  }
}
