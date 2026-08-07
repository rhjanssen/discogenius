import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { DownloadBackend, DownloadProgress, DownloadRequest } from "../../download/download-backend.js";
import { Config } from "../../config/config.js";
import { configuredVideoMaxHeight } from "../provider-quality.js";
import { YOUTUBE_MUSIC_COOKIES_FILE } from "./youtube-music-auth.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const BROWSE_OR_PLAYLIST_ID = /^[A-Za-z0-9_-]{8,200}$/u;
const MEDIA_EXTENSIONS = new Set([
  ".opus", ".m4a", ".mp3", ".aac", ".ogg",
  ".mp4", ".mkv", ".webm", ".mov", ".m4v",
]);

export interface YtDlpProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnYtDlp = (
  binary: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => YtDlpProcess;

export interface YtDlpProgressEvent {
  progress: number;
  currentFileNum?: number;
  totalFiles?: number;
  currentProviderTrackId?: string;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: DownloadProgress["trackStatus"];
  speed?: string;
  eta?: string;
  statusMessage?: string;
}

const defaultSpawn: SpawnYtDlp = (binary, args, options) => (
  spawn(binary, args, options) as unknown as YtDlpProcess
);

export function getYtDlpBinary(): string {
  return process.env.YT_DLP_BIN?.trim() || "yt-dlp";
}

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/gu, "")
    .trim();
}

function optionalNumber(value: string | undefined): number | undefined {
  const parsed = Number(String(value || "").replace(/%/gu, "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function progressForItem(percent: number, index?: number, count?: number): number {
  const fraction = Math.min(100, Math.max(0, percent)) / 100;
  if (index && count) {
    return Math.round(((Math.max(1, index) - 1 + fraction) / Math.max(1, count)) * 100);
  }
  return Math.round(fraction * 100);
}

export function parseYtDlpProgressLine(line: string): YtDlpProgressEvent | null {
  const clean = stripAnsi(line);
  if (!clean) return null;

  if (clean.startsWith("DG_PROGRESS\t")) {
    const fields = clean.split("\t");
    const percent = Math.min(100, Math.max(0, Number(fields[1]?.replace(/%/gu, "").trim()) || 0));
    const currentFileNum = optionalNumber(fields[2]);
    const totalFiles = optionalNumber(fields[3]);
    const id = VIDEO_ID.test(fields[4] || "") ? fields[4] : undefined;
    const title = fields[5] && fields[5] !== "NA" ? fields[5] : id;
    const speed = fields[6] && fields[6] !== "NA" ? fields[6].trim() : undefined;
    const eta = fields[7] && fields[7] !== "NA" ? fields[7].trim() : undefined;
    return {
      progress: progressForItem(percent, currentFileNum, totalFiles),
      currentFileNum,
      totalFiles,
      currentProviderTrackId: id,
      currentTrack: title,
      trackProgress: Math.round(percent),
      trackStatus: "downloading",
      speed,
      eta,
      statusMessage: title ? `Downloading ${title}` : "Downloading from YouTube",
    };
  }

  if (clean.startsWith("DG_DONE\t")) {
    const fields = clean.split("\t");
    const currentFileNum = optionalNumber(fields[1]);
    const totalFiles = optionalNumber(fields[2]);
    const id = VIDEO_ID.test(fields[3] || "") ? fields[3] : undefined;
    const title = fields[4] && fields[4] !== "NA" ? fields[4] : id;
    return {
      progress: progressForItem(100, currentFileNum, totalFiles),
      currentFileNum,
      totalFiles,
      currentProviderTrackId: id,
      currentTrack: title,
      trackProgress: 100,
      trackStatus: "completed",
      statusMessage: title ? `Downloaded ${title}` : "Download completed",
    };
  }

  const standard = clean.match(/^\[download\]\s+([0-9.]+)%.*?(?:at\s+([^\s]+))?.*?(?:ETA\s+([^\s]+))?$/iu);
  if (standard) {
    const percent = Math.min(100, Math.max(0, Number(standard[1]) || 0));
    return {
      progress: Math.round(percent),
      trackProgress: Math.round(percent),
      trackStatus: "downloading",
      speed: standard[2],
      eta: standard[3],
      statusMessage: "Downloading from YouTube",
    };
  }
  return null;
}

function allowedYouTubeUrl(raw: string): string | null {
  if (!/^https?:\/\//iu.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("YouTube download URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("YouTube download URLs must use HTTPS and cannot contain embedded credentials.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  if (!["youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    throw new Error("Only youtube.com, music.youtube.com, and youtu.be download URLs are accepted.");
  }
  return parsed.toString();
}

export function buildYouTubeMusicSourceUrl(
  entityType: DownloadRequest["entityType"],
  providerId: string,
): string {
  const candidate = providerId.trim();
  const existingUrl = allowedYouTubeUrl(candidate);
  if (existingUrl) return existingUrl;
  if (entityType === "track" || entityType === "video") {
    if (!VIDEO_ID.test(candidate)) {
      throw new Error(`Invalid YouTube video ID: ${candidate || "(empty)"}`);
    }
    const host = entityType === "track" ? "music.youtube.com" : "www.youtube.com";
    return `https://${host}/watch?v=${candidate}`;
  }
  if (!BROWSE_OR_PLAYLIST_ID.test(candidate)) {
    throw new Error(`Invalid YouTube Music album ID: ${candidate || "(empty)"}`);
  }
  if (/^(?:OLAK5uy_|PL|RD|VL)/u.test(candidate)) {
    const playlistId = candidate.startsWith("VL") ? candidate.slice(2) : candidate;
    return `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  }
  return `https://music.youtube.com/browse/${encodeURIComponent(candidate)}`;
}

async function findMediaFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        // The output template is provider-ID-only. Requiring an 11-character
        // YouTube id here prevents a stale, human-named file from making an
        // otherwise empty job look successful.
        if (VIDEO_ID.test(path.parse(entry.name).name)) result.push(fullPath);
      }
    }
  };
  await visit(root);
  return result;
}

function abortError(): Error {
  const error = new Error("YouTube Music download aborted.");
  error.name = "AbortError";
  return error;
}

export class YtDlpBackend implements DownloadBackend {
  readonly id = "yt-dlp";
  readonly supportedProviders = ["youtube-music"];
  readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo", "video"];

  constructor(private readonly options: {
    binary?: string;
    spawnImpl?: SpawnYtDlp;
    mediaFileFinder?: (root: string) => Promise<string[]>;
    cookiesPath?: string;
  } = {}) {}

  buildArgs(request: DownloadRequest): string[] {
    const providerIds = String(request.providerId || "")
      .split(";")
      .map((id) => id.trim())
      .filter(Boolean);
    if (providerIds.length === 0) {
      throw new Error("YouTube Music download requested without a provider ID.");
    }
    const urls = providerIds.map((id) => buildYouTubeMusicSourceUrl(request.entityType, id));
    const outputTemplate = path.join(request.downloadPath, "%(id)s.%(ext)s");
    const args = [
      "--ignore-config",
      "--js-runtimes", "node",
      "--no-color",
      "--newline",
      "--no-simulate",
      "--progress",
      "--progress-template",
      "download:DG_PROGRESS\t%(progress._percent_str)s\t%(info.playlist_index)s\t%(info.playlist_count)s\t%(info.id)s\t%(info.title)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
      "--print",
      "after_move:DG_DONE\t%(playlist_index)s\t%(playlist_count)s\t%(id)s\t%(title)s\t%(filepath)s",
      "--output",
      outputTemplate,
    ];
    const cookiesPath = this.options.cookiesPath || YOUTUBE_MUSIC_COOKIES_FILE;
    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

    if (request.entityType === "video") {
      const maxHeight = configuredVideoMaxHeight(Config.getQualityConfig()?.video_quality);
      // Prefer the best stream at or below the Settings video-quality ceiling.
      const format =
        `bestvideo*[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;
      args.push("--no-playlist", "--format", format, "--merge-output-format", "mp4");
    } else {
      args.push(
        request.entityType === "album" ? "--yes-playlist" : "--no-playlist",
        "--format", "bestaudio/best",
        "--extract-audio",
        // `best` means "do not re-encode". YouTube serves AAC *or* Opus and the
        // quality tier does not decide which; forcing Opus meant decoding an
        // AAC stream and re-encoding it, a second lossy generation that can
        // only lose signal. Whatever arrives is kept, and ffprobe records what
        // it actually is at import. Converting to a library's preferred codec
        // is an output policy, not something to hide inside acquisition.
        "--audio-format", "best",
      );
    }
    args.push(...urls);
    return args;
  }

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (options.signal?.aborted) throw abortError();
    await fs.promises.mkdir(request.downloadPath, { recursive: true });
    const args = this.buildArgs(request);
    const child = (this.options.spawnImpl || defaultSpawn)(
      this.options.binary || getYtDlpBinary(),
      args,
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    options.onProgress({ progress: 0, state: "downloading", statusMessage: "Starting YouTube download" });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const errorLines: string[] = [];
      let forceKillTimer: NodeJS.Timeout | null = null;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        forceKillTimer.unref?.();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const emitLine = (line: string, source: "stdout" | "stderr") => {
        const event = parseYtDlpProgressLine(line);
        if (event) {
          options.onProgress({ ...event, state: "downloading" });
          return;
        }
        const clean = stripAnsi(line);
        if (source === "stderr" && clean && !/^\[download\]/u.test(clean)) {
          errorLines.push(clean);
          if (errorLines.length > 12) errorLines.shift();
        }
      };
      const consume = (chunk: unknown, source: "stdout" | "stderr") => {
        const previous = source === "stdout" ? stdoutBuffer : stderrBuffer;
        const raw = previous + Buffer.from(chunk as Uint8Array).toString("utf8");
        const lines = raw.split(/\r?\n|\r/gu);
        const remainder = lines.pop() || "";
        if (source === "stdout") stdoutBuffer = remainder;
        else stderrBuffer = remainder;
        for (const line of lines) emitLine(line, source);
      };

      child.stdout?.on("data", (chunk: unknown) => consume(chunk, "stdout"));
      child.stderr?.on("data", (chunk: unknown) => consume(chunk, "stderr"));
      child.on("error", (...args: unknown[]) => {
        const error = args[0] instanceof Error ? args[0] : new Error("Unable to start yt-dlp.");
        finish(() => reject(error));
      });
      child.on("close", (...args: unknown[]) => {
        const code = typeof args[0] === "number" ? args[0] : null;
        if (stdoutBuffer) emitLine(stdoutBuffer, "stdout");
        if (stderrBuffer) emitLine(stderrBuffer, "stderr");
        if (aborted || options.signal?.aborted) {
          finish(() => reject(abortError()));
          return;
        }
        if (code !== 0) {
          const detail = errorLines.at(-1);
          finish(() => reject(new Error(`yt-dlp exited with code ${code ?? "signal"}${detail ? `: ${detail}` : ""}`)));
          return;
        }
        void (async () => {
          try {
            const mediaFiles = await (this.options.mediaFileFinder || findMediaFiles)(request.downloadPath);
            if (mediaFiles.length === 0) {
              throw new Error("yt-dlp completed without producing provider-ID-named media files.");
            }
            options.onProgress({
              progress: 100,
              state: "downloading",
              statusMessage: `Downloaded ${mediaFiles.length} YouTube media file${mediaFiles.length === 1 ? "" : "s"}`,
            });
            finish(resolve);
          } catch (error) {
            finish(() => reject(error));
          }
        })();
      });
    });
  }
}
