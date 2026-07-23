import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { DownloadBackend, DownloadProgress, DownloadRequest } from "../../download/download-backend.js";
import { getYtDlpBinary, parseYtDlpProgressLine, type SpawnYtDlp } from "../youtube-music/yt-dlp-backend.js";
import {
  loadSoundCloudCredentials,
  SOUNDCLOUD_COOKIES_FILE,
} from "./soundcloud-auth.js";
import {
  resolveSoundCloudMediaUrl,
  soundcloudApiRequest,
  soundcloudResourceId,
  type SoundCloudFetchLike,
  type SoundCloudPlaylistResource,
  type SoundCloudTrackResource,
} from "./soundcloud-api.js";

const TRACK_ID = /^\d{1,18}$/u;
const MEDIA_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".opus", ".ogg", ".mp4", ".webm"]);

export type SpawnSoundCloudYtDlp = SpawnYtDlp;

function abortError(): Error {
  const error = new Error("SoundCloud download aborted.");
  error.name = "AbortError";
  return error;
}

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/gu, "")
    .trim();
}

export function buildSoundCloudSourceUrl(
  entityType: DownloadRequest["entityType"],
  providerId: string,
): string {
  const candidate = providerId.trim();
  if (/^https?:\/\//iu.test(candidate)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("SoundCloud download URL is invalid.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("SoundCloud download URLs must use HTTPS without embedded credentials.");
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    if (!["soundcloud.com", "on.soundcloud.com", "m.soundcloud.com"].includes(host)) {
      throw new Error("Only soundcloud.com download URLs are accepted.");
    }
    return parsed.toString();
  }
  if (!TRACK_ID.test(candidate)) {
    throw new Error(`Invalid SoundCloud id: ${candidate || "(empty)"}`);
  }
  if (entityType === "album") {
    // yt-dlp's SoundcloudPlaylistIE only resolves numeric playlist ids on the
    // api host; the public soundcloud.com/playlists/<id> form 404s (falls
    // through to the track extractor). Mirror the api-host track branch below.
    return `https://api.soundcloud.com/playlists/${candidate}`;
  }
  return `https://api.soundcloud.com/tracks/${candidate}`;
}

async function findSoundCloudMediaFiles(root: string): Promise<string[]> {
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
        if (TRACK_ID.test(path.parse(entry.name).name)) result.push(fullPath);
      }
    }
  };
  await visit(root);
  return result;
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return ".m4a";
  if (normalized.includes("opus")) return ".opus";
  if (normalized.includes("ogg")) return ".ogg";
  return ".mp3";
}

async function downloadHttpFile(
  url: string,
  destination: string,
  options: { signal?: AbortSignal; fetchImpl?: SoundCloudFetchLike },
): Promise<void> {
  const fetchImpl = options.fetchImpl || (fetch as unknown as SoundCloudFetchLike);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Discogenius/1.0)" },
  });
  if (!response.ok) {
    throw new Error(`SoundCloud media download failed (${response.status}).`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  const anyResponse = response as unknown as {
    body?: ReadableStream<Uint8Array> | null;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  try {
    if (anyResponse.body && typeof Readable.fromWeb === "function") {
      const nodeStream = Readable.fromWeb(anyResponse.body as import("node:stream/web").ReadableStream);
      await pipeline(nodeStream, fs.createWriteStream(temporary), { signal: options.signal });
    } else {
      if (options.signal?.aborted) throw abortError();
      const buffer = Buffer.from(await anyResponse.arrayBuffer());
      await fs.promises.writeFile(temporary, buffer);
    }
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export class SoundCloudBackend implements DownloadBackend {
  readonly id = "soundcloud-yt-dlp";
  readonly supportedProviders = ["soundcloud"];
  readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo"];

  constructor(private readonly options: {
    binary?: string;
    spawnImpl?: SpawnSoundCloudYtDlp;
    mediaFileFinder?: (root: string) => Promise<string[]>;
    cookiesPath?: string;
    fetchImpl?: SoundCloudFetchLike;
    preferNative?: boolean;
  } = {}) {}

  buildYtDlpArgs(request: DownloadRequest): string[] {
    const providerIds = String(request.providerId || "")
      .split(";")
      .map((id) => id.trim())
      .filter(Boolean);
    if (providerIds.length === 0) {
      throw new Error("SoundCloud download requested without a provider ID.");
    }
    const urls = providerIds.map((id) => buildSoundCloudSourceUrl(request.entityType, id));
    const outputTemplate = path.join(request.downloadPath, "%(id)s.%(ext)s");
    const args = [
      "--ignore-config",
      "--no-color",
      "--newline",
      "--no-simulate",
      "--progress",
      "--progress-template",
      "download:DG_PROGRESS\t%(progress._percent_str)s\t%(info.playlist_index)s\t%(info.playlist_count)s\t%(id)s\t%(info.title)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
      "--print",
      "after_move:DG_DONE\t%(playlist_index)s\t%(playlist_count)s\t%(id)s\t%(title)s\t%(filepath)s",
      "--output",
      outputTemplate,
      request.entityType === "album" ? "--yes-playlist" : "--no-playlist",
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
    ];
    const credentials = loadSoundCloudCredentials();
    if (credentials?.oauthToken) {
      args.push("--add-header", `Authorization:OAuth ${credentials.oauthToken}`);
    }
    if (credentials?.clientId) {
      args.push("--add-header", `X-SoundCloud-Client-Id:${credentials.clientId}`);
    }
    const cookiesPath = this.options.cookiesPath || SOUNDCLOUD_COOKIES_FILE;
    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);
    args.push(...urls);
    return args;
  }

  private async downloadTrackNative(
    trackId: string,
    downloadPath: string,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void; index?: number; total?: number },
  ): Promise<boolean> {
    const track = await soundcloudApiRequest<SoundCloudTrackResource>(
      `/tracks/${encodeURIComponent(trackId)}`,
      { fetchImpl: this.options.fetchImpl },
    );
    const title = String(track.title || trackId);
    const policy = String(track.policy || "").toUpperCase();
    if (policy === "SNIP") {
      throw new Error(
        `SoundCloud track ${trackId} (${title}) is preview-only for this account (policy=SNIP). A Go+ session may unlock full streams.`,
      );
    }

    const media = await resolveSoundCloudMediaUrl(track, { fetchImpl: this.options.fetchImpl });
    if (!media || media.protocol !== "progressive") {
      return false;
    }
    const destination = path.join(downloadPath, `${trackId}${extensionForMime(media.mimeType)}`);
    options.onProgress({
      progress: options.index && options.total
        ? Math.round(((options.index - 1) / options.total) * 100)
        : 5,
      state: "downloading",
      currentProviderTrackId: trackId,
      currentTrack: title,
      currentFileNum: options.index,
      totalFiles: options.total,
      trackStatus: "downloading",
      statusMessage: `Downloading ${title}`,
    });
    await downloadHttpFile(media.url, destination, {
      signal: options.signal,
      fetchImpl: this.options.fetchImpl,
    });
    options.onProgress({
      progress: options.index && options.total
        ? Math.round((options.index / options.total) * 100)
        : 100,
      state: "downloading",
      currentProviderTrackId: trackId,
      currentTrack: title,
      currentFileNum: options.index,
      totalFiles: options.total,
      trackProgress: 100,
      trackStatus: "completed",
      statusMessage: `Downloaded ${title}`,
    });
    return true;
  }

  private async tryNativeDownload(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<boolean> {
    if (this.options.preferNative === false) return false;
    const ids = String(request.providerId || "").split(";").map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return false;

    if (request.entityType === "album") {
      const playlistId = soundcloudResourceId(ids[0]);
      const playlist = await soundcloudApiRequest<SoundCloudPlaylistResource>(
        `/playlists/${encodeURIComponent(playlistId)}?representation=full`,
        { fetchImpl: this.options.fetchImpl },
      );
      const tracks = (playlist.tracks || [])
        .map((track) => soundcloudResourceId(track.id))
        .filter((id) => TRACK_ID.test(id));
      if (tracks.length === 0) return false;
      let completed = 0;
      for (let index = 0; index < tracks.length; index += 1) {
        if (options.signal?.aborted) throw abortError();
        const ok = await this.downloadTrackNative(tracks[index]!, request.downloadPath, {
          signal: options.signal,
          onProgress: options.onProgress,
          index: index + 1,
          total: tracks.length,
        });
        if (!ok) return false;
        completed += 1;
      }
      return completed > 0;
    }

    if (request.entityType !== "track") return false;
    let allOk = true;
    for (let index = 0; index < ids.length; index += 1) {
      if (options.signal?.aborted) throw abortError();
      const ok = await this.downloadTrackNative(soundcloudResourceId(ids[index]), request.downloadPath, {
        signal: options.signal,
        onProgress: options.onProgress,
        index: index + 1,
        total: ids.length,
      });
      if (!ok) {
        allOk = false;
        break;
      }
    }
    return allOk;
  }

  private async downloadWithYtDlp(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (options.signal?.aborted) throw abortError();
    await fs.promises.mkdir(request.downloadPath, { recursive: true });
    const args = this.buildYtDlpArgs(request);
    const child = (this.options.spawnImpl || ((binary, spawnArgs, spawnOptions) => (
      spawn(binary, spawnArgs, spawnOptions) as unknown as ReturnType<SpawnYtDlp>
    )))(
      this.options.binary || getYtDlpBinary(),
      args,
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    options.onProgress({ progress: 0, state: "downloading", statusMessage: "Starting SoundCloud download" });

    await new Promise<void>((resolve, reject) => {
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
          options.onProgress({
            ...event,
            state: "downloading",
            statusMessage: event.statusMessage?.replace(/YouTube/gu, "SoundCloud") || "Downloading from SoundCloud",
          });
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
        const error = args[0] instanceof Error ? args[0] : new Error("Unable to start yt-dlp for SoundCloud.");
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
          finish(() => reject(new Error(
            `yt-dlp SoundCloud download exited with code ${code ?? "signal"}${detail ? `: ${detail}` : ""}`,
          )));
          return;
        }
        void (async () => {
          try {
            const mediaFiles = await (this.options.mediaFileFinder || findSoundCloudMediaFiles)(request.downloadPath);
            if (mediaFiles.length === 0) {
              throw new Error("yt-dlp completed without producing SoundCloud provider-ID-named media files.");
            }
            options.onProgress({
              progress: 100,
              state: "downloading",
              statusMessage: `Downloaded ${mediaFiles.length} SoundCloud media file${mediaFiles.length === 1 ? "" : "s"}`,
            });
            finish(resolve);
          } catch (error) {
            finish(() => reject(error));
          }
        })();
      });
    });
  }

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (options.signal?.aborted) throw abortError();
    await fs.promises.mkdir(request.downloadPath, { recursive: true });

    try {
      const nativeOk = await this.tryNativeDownload(request, options);
      if (nativeOk) {
        const mediaFiles = await (this.options.mediaFileFinder || findSoundCloudMediaFiles)(request.downloadPath);
        if (mediaFiles.length > 0) return;
      }
    } catch (error) {
      // Native path may fail on encrypted/Go+ tracks; fall through to yt-dlp.
      if (error instanceof Error && error.name === "AbortError") throw error;
      options.onProgress({
        progress: 0,
        state: "downloading",
        statusMessage: error instanceof Error
          ? `Native SoundCloud stream unavailable (${error.message}); trying yt-dlp`
          : "Native SoundCloud stream unavailable; trying yt-dlp",
      });
    }

    await this.downloadWithYtDlp(request, options);
  }
}
