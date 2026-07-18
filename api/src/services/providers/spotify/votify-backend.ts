import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  DownloadBackend,
  DownloadProgress,
  DownloadRequest,
} from "../../download/download-backend.js";
import type { SpotifyAuthStore } from "./spotify-auth.js";
import { spotifyAuthStore } from "./spotify-auth.js";

export const VOTIFY_PIP_REQUIREMENT = "votify[librespot]==1.9.9";
const MEDIA_EXTENSIONS = new Set([".ogg", ".opus", ".mp3", ".m4a", ".mp4", ".flac", ".wav", ".webm"]);

export function getVotifyBinary(): string {
  return process.env.SPOTIFY_VOTIFY_BIN || "votify";
}

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .trim();
}

export interface VotifyProgressEvent {
  currentFileNum?: number;
  currentTrack?: string;
  trackStatus?: DownloadProgress["trackStatus"];
  statusMessage: string;
  errorCount?: number;
}

export function parseVotifyProgressLine(line: string): VotifyProgressEvent | null {
  const clean = stripAnsi(line);
  if (!clean) return null;
  const downloading = clean.match(/\[Track\s+(\d+)\]\s+Downloading\s+"([^"]+)"/i);
  if (downloading) {
    return {
      currentFileNum: Number(downloading[1]),
      currentTrack: downloading[2],
      trackStatus: "downloading",
      statusMessage: clean,
    };
  }
  const skipped = clean.match(/\[Track\s+(\d+)\]\s+Skipping\s+"([^"]+)"(?::\s*(.*))?/i);
  if (skipped) {
    return {
      currentFileNum: Number(skipped[1]),
      currentTrack: skipped[2],
      trackStatus: "skipped",
      statusMessage: clean,
    };
  }
  const failed = clean.match(/\[Track\s+(\d+)\].*Error\s+(?:downloading|fetching media)(?:\s+"([^"]+)")?/i);
  if (failed) {
    return {
      currentFileNum: Number(failed[1]),
      currentTrack: failed[2],
      trackStatus: "error",
      statusMessage: clean,
    };
  }
  const summary = clean.match(/Finished with\s+(\d+)\s+error\(s\)/i);
  if (summary) {
    return {
      trackStatus: Number(summary[1]) > 0 ? "error" : "completed",
      statusMessage: clean,
      errorCount: Number(summary[1]),
    };
  }
  return { statusMessage: clean };
}

export interface VotifyRunRequest {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  onLine(line: string, source: "stdout" | "stderr"): void;
}

export interface VotifyRunResult {
  code: number | null;
}

export type VotifyRunner = (request: VotifyRunRequest) => Promise<VotifyRunResult>;

/** Spawn adapter kept separate so backend tests can use a deterministic runner. */
export const runVotifyProcess: VotifyRunner = async (request) => new Promise((resolve, reject) => {
  if (request.signal?.aborted) {
    const error = new Error("Spotify download aborted");
    error.name = "AbortError";
    reject(error);
    return;
  }

  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;
  const abort = () => child.kill("SIGTERM");
  request.signal?.addEventListener("abort", abort, { once: true });

  const consume = (chunk: Buffer | string, source: "stdout" | "stderr") => {
    const combined = (source === "stdout" ? stdoutBuffer : stderrBuffer) + String(chunk);
    const lines = combined.split(/\r?\n|\r/g);
    const remainder = lines.pop() ?? "";
    if (source === "stdout") stdoutBuffer = remainder;
    else stderrBuffer = remainder;
    for (const line of lines) request.onLine(line, source);
  };
  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    request.signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    request.signal?.removeEventListener("abort", abort);
    if (stdoutBuffer) request.onLine(stdoutBuffer, "stdout");
    if (stderrBuffer) request.onLine(stderrBuffer, "stderr");
    resolve({ code });
  });
});

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\") || command.includes(":")) {
    return fs.existsSync(command);
  }
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return directories.some((directory) => extensions.some((extension) =>
    fs.existsSync(path.join(directory, `${command}${extension}`)),
  ));
}

function cookiesFileReady(cookiesPath: string | null | undefined): boolean {
  if (!cookiesPath) return false;
  try {
    return fs.statSync(cookiesPath).isFile() && fs.statSync(cookiesPath).size > 0;
  } catch {
    return false;
  }
}

async function findMediaFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(entryPath);
    }
  };
  await visit(directory);
  return found;
}

export function resolveVotifyAudioQuality(raw: string | null | undefined): "vorbis-low" | "vorbis-medium" | "vorbis-high" {
  const normalized = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!normalized || normalized === "lossy" || normalized === "standard" || normalized === "high" || normalized === "vorbis-medium" || normalized === "160") {
    return "vorbis-medium";
  }
  if (normalized === "low" || normalized === "vorbis-low" || normalized === "96") return "vorbis-low";
  if (normalized === "vorbis-high" || normalized === "320" || normalized === "premium") return "vorbis-high";
  if (/lossless|hi-?res|flac|atmos|spatial|aac/.test(normalized)) {
    throw new Error(`Spotify quality ${raw} is not supported by the baseline Vorbis backend`);
  }
  return "vorbis-medium";
}

export interface VotifyCapabilitySnapshot {
  binary: string;
  binaryAvailable: boolean;
  cookiesPath: string | null;
  cookiesAvailable: boolean;
  installRequirement: string;
}

export class VotifyBackend implements DownloadBackend {
  readonly id = "votify";
  readonly supportedProviders = ["spotify"];
  readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo"];

  constructor(private readonly dependencies: {
    authStore?: SpotifyAuthStore;
    runner?: VotifyRunner;
    binary?: () => string;
    binaryAvailable?: (binary: string) => boolean;
    mediaFiles?: (directory: string) => Promise<string[]>;
  } = {}) {}

  getCapabilitySnapshot(): VotifyCapabilitySnapshot {
    const binary = (this.dependencies.binary ?? getVotifyBinary)();
    const cookiesPath = (this.dependencies.authStore ?? spotifyAuthStore).load()?.cookiesPath ?? null;
    return {
      binary,
      binaryAvailable: (this.dependencies.binaryAvailable ?? commandExists)(binary),
      cookiesPath,
      cookiesAvailable: cookiesFileReady(cookiesPath),
      installRequirement: VOTIFY_PIP_REQUIREMENT,
    };
  }

  buildArgs(request: DownloadRequest, cookiesPath: string): string[] {
    if (request.entityType === "video" || (request.slot && request.slot !== "stereo")) {
      throw new Error("Spotify's baseline Votify backend supports stereo audio only");
    }
    const quality = resolveVotifyAudioQuality(request.quality);
    const resourceType = request.entityType === "track" ? "track" : "album";
    const url = `https://open.spotify.com/${resourceType}/${request.providerId}`;
    return [
      "--no-config-file",
      "--no-exceptions",
      "--wait-interval", "0",
      "--session-type", "librespot",
      "--cookies-path", cookiesPath,
      "--output", request.downloadPath,
      "--temp", path.join(request.downloadPath, ".votify-tmp"),
      "--album-folder-template", ".",
      "--compilation-folder-template", ".",
      "--no-album-folder-template", ".",
      "--single-disc-file-template", "{media_id}",
      "--multi-disc-file-template", "{media_id}",
      "--no-album-file-template", "{media_id}",
      "--audio-quality", quality,
      "--no-synced-lyrics-file",
      "--overwrite",
      url,
    ];
  }

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (options.signal?.aborted) {
      const error = new Error("Spotify download aborted");
      error.name = "AbortError";
      throw error;
    }
    if (!request.providerId.trim()) throw new Error("Spotify download requested without a provider ID");
    const snapshot = this.getCapabilitySnapshot();
    if (!snapshot.binaryAvailable) {
      throw new Error(`Votify is unavailable; install ${VOTIFY_PIP_REQUIREMENT} (binary: ${snapshot.binary})`);
    }
    if (!snapshot.cookiesAvailable || !snapshot.cookiesPath) {
      throw new Error("Spotify downloads require a readable Netscape cookies.txt file");
    }

    await fs.promises.mkdir(request.downloadPath, { recursive: true });
    let reportedErrorCount = 0;
    let lastError = "";
    const runner = this.dependencies.runner ?? runVotifyProcess;
    const result = await runner({
      command: snapshot.binary,
      args: this.buildArgs(request, snapshot.cookiesPath),
      cwd: request.downloadPath,
      signal: options.signal,
      onLine: (line, source) => {
        const event = parseVotifyProgressLine(line);
        if (!event) return;
        if (event.errorCount !== undefined) reportedErrorCount = event.errorCount;
        if (event.trackStatus === "error" || (source === "stderr" && /error|exception|critical/i.test(event.statusMessage))) {
          lastError = event.statusMessage;
        }
        options.onProgress({
          progress: event.trackStatus === "completed" ? 95 : event.currentFileNum ? Math.min(90, 5 + event.currentFileNum * 10) : 5,
          currentFileNum: event.currentFileNum,
          currentTrack: event.currentTrack,
          trackStatus: event.trackStatus,
          statusMessage: event.statusMessage,
          state: "downloading",
        });
      },
    });

    if (options.signal?.aborted) {
      const error = new Error("Spotify download aborted");
      error.name = "AbortError";
      throw error;
    }
    if (result.code !== 0 || reportedErrorCount > 0) {
      throw new Error(`Votify failed${result.code == null ? "" : ` with exit code ${result.code}`}${lastError ? `: ${lastError}` : ""}`);
    }
    const mediaFiles = await (this.dependencies.mediaFiles ?? findMediaFiles)(request.downloadPath);
    if (!mediaFiles.length) {
      throw new Error("Votify reported success but produced no media files");
    }
    options.onProgress({
      progress: 100,
      trackStatus: "completed",
      statusMessage: `Downloaded ${mediaFiles.length} Spotify media file${mediaFiles.length === 1 ? "" : "s"}`,
      state: "downloading",
    });
  }
}
