import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  DownloadBackend,
  DownloadProgress,
  DownloadRequest,
} from "../../download/download-backend.js";
import { getDeezerConfigDir, loadDeezerCredentials } from "./deezer-auth.js";

const MEDIA_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"]);

export interface StreamripRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onLine(line: string): void;
}

export type StreamripCommandRunner = (
  command: string,
  args: string[],
  options: StreamripRunOptions,
) => Promise<void>;

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
  const quality = String(request.quality || "").toLowerCase();
  const streamripQuality = quality.includes("lossy") || quality.includes("mp3") ? "1" : "2";
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
      outputTail = `${outputTail}\n${line}`.trim().slice(-4000);
      options.onLine(line);
    }
  };
  child.stdout.on("data", (chunk) => consume("stdout", chunk));
  child.stderr.on("data", (chunk) => consume("stderr", chunk));

  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    options.signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.once("close", (code, signal) => {
    options.signal?.removeEventListener("abort", abort);
    for (const source of ["stdout", "stderr"] as const) {
      if (buffers[source].trim()) {
        const leftover = buffers[source].trim();
        outputTail = `${outputTail}\n${leftover}`.trim().slice(-4000);
        options.onLine(leftover);
      }
    }
    if (options.signal?.aborted) {
      reject(new Error("Deezer download cancelled."));
    } else if (code === 0) {
      resolve();
    } else {
      reject(new Error(`Streamrip exited with ${signal || code}: ${outputTail || "unknown error"}`));
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
    await this.runner(getStreamripBinary(), buildStreamripArgs(request), {
      cwd: request.downloadPath,
      signal: options.signal,
      onLine: (line) => {
        const progress = streamripProgressForLine(line);
        if (progress) options.onProgress(progress);
      },
    });
    if (mediaFilesUnder(request.downloadPath).length === 0) {
      throw new Error("Streamrip exited successfully but produced no Deezer media files.");
    }
    options.onProgress({ progress: 100, state: "downloading", statusMessage: "Deezer download complete" });
  }
}
