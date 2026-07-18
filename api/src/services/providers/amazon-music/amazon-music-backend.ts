import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";
import type { DownloadBackend, DownloadProgress, DownloadRequest } from "../../download/download-backend.js";
import { assertPathInsideRoot, assertSafeDownloadResourceId, safeProviderMediaFilename } from "../../download/download-path-safety.js";
import { amazonMusicApiRequest, unwrapAmazonData } from "./amazon-music-api.js";
import { getAmazonMusicConfigDir, loadAmazonMusicCredentials } from "./amazon-music-auth.js";

const MEDIA_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".eac3", ".ec3", ".ac4"]);

export interface AmazonMusicCatalogTrack {
  id: string;
  title: string;
  isrc?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;
}

export interface AmazonMusicFileTags {
  title?: string | null;
  isrc?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;
}

export type AmazonMusicTagReader = (filePath: string) => Promise<AmazonMusicFileTags>;
export type AmazonMusicRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onLine(line: string): void;
  },
) => Promise<void>;

export function getAmazonMusicPython(): string {
  return process.env.AMAZON_MUSIC_PYTHON?.trim() || "/opt/amazon-music-venv/bin/python";
}

export function getAmazonMusicBridgePath(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(current, "amazon-download-bridge.py"),
    path.resolve(current, "../../../../../src/services/providers/amazon-music/amazon-download-bridge.py"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

export function amazonQualityForRequest(request: DownloadRequest): string {
  if (request.slot === "spatial") return "Atmos_EC-3";
  const quality = String(request.quality || "").toLowerCase();
  if (/hi.?res|uhd|max|master/u.test(quality)) return "Max";
  if (/lossless|flac|\bhd\b/u.test(quality)) return "High";
  return "Normal";
}

export function buildAmazonMusicBridgeArgs(request: DownloadRequest): string[] {
  if (request.entityType === "video") throw new Error("Amazon Music video downloads are not supported.");
  const temporary = path.join(request.downloadPath, ".amazon-temp");
  return [
    getAmazonMusicBridgePath(),
    "--id", request.providerId,
    "--type", request.entityType,
    "--quality", amazonQualityForRequest(request),
    "--output", request.downloadPath,
    "--temp", temporary,
    "--workers", "2",
  ];
}

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function listMediaFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".amazon-temp") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(absolute);
    }
  }
  return output;
}

export const readAmazonMusicFileTags: AmazonMusicTagReader = async (filePath) => {
  try {
    const metadata = await parseFile(filePath, { duration: false, skipCovers: true });
    const isrc = Array.isArray(metadata.common.isrc) ? metadata.common.isrc[0] : metadata.common.isrc;
    return {
      title: metadata.common.title || null,
      isrc: isrc || null,
      trackNumber: metadata.common.track?.no || null,
      volumeNumber: metadata.common.disk?.no || null,
    };
  } catch {
    return {};
  }
};

export async function normalizeAmazonMusicDownloadFilenames(
  root: string,
  tracks: AmazonMusicCatalogTrack[],
  tagReader: AmazonMusicTagReader = readAmazonMusicFileTags,
): Promise<number> {
  const expectedIds = new Set(tracks.map((track) => assertSafeDownloadResourceId(track.id)));
  let matched = 0;
  for (const filePath of listMediaFiles(root)) {
    const base = path.basename(filePath, path.extname(filePath));
    if (expectedIds.has(base)) {
      matched += 1;
      continue;
    }
    const tags = await tagReader(filePath);
    const normalizedTitle = normalizeText(tags.title);
    let candidates = tracks.filter((track) => tags.isrc && track.isrc && track.isrc.toUpperCase() === tags.isrc.toUpperCase());
    if (candidates.length === 0 && tags.trackNumber) {
      candidates = tracks.filter((track) => track.trackNumber === tags.trackNumber
        && (!tags.volumeNumber || !track.volumeNumber || track.volumeNumber === tags.volumeNumber)
        && (!normalizedTitle || normalizeText(track.title) === normalizedTitle));
    }
    if (candidates.length === 0 && normalizedTitle) {
      candidates = tracks.filter((track) => normalizeText(track.title) === normalizedTitle);
    }
    if (candidates.length !== 1) continue;
    const target = assertPathInsideRoot(
      root,
      path.join(path.dirname(filePath), safeProviderMediaFilename(candidates[0].id, path.extname(filePath).toLowerCase())),
    );
    if (target !== filePath) {
      if (fs.existsSync(target)) throw new Error(`Amazon Music output collision for provider track ${candidates[0].id}.`);
      fs.renameSync(filePath, target);
    }
    matched += 1;
  }
  return matched;
}

export function amazonProgressForLine(line: string): DownloadProgress | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("DG_PROGRESS ")) {
    try {
      const payload = JSON.parse(trimmed.slice("DG_PROGRESS ".length)) as { progress?: number; message?: string };
      return { progress: Number(payload.progress || 0), state: "downloading", statusMessage: payload.message || trimmed };
    } catch {
      return null;
    }
  }
  if (/failed|error|not found|no suitable/iu.test(trimmed)) {
    return { progress: 5, state: "downloading", statusMessage: trimmed, trackStatus: "error" };
  }
  if (/downloaded|success/iu.test(trimmed)) {
    return { progress: 90, state: "downloading", statusMessage: trimmed, trackStatus: "completed" };
  }
  return null;
}

export const runAmazonMusicBridge: AmazonMusicRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let errorOutput = "";
  const buffers = { stdout: "", stderr: "" };
  const consume = (source: "stdout" | "stderr", chunk: Buffer | string) => {
    buffers[source] += chunk.toString();
    const lines = buffers[source].split(/\r?\n/u);
    buffers[source] = lines.pop() || "";
    for (const line of lines) {
      if (source === "stderr") errorOutput = `${errorOutput}\n${line}`.trim().slice(-4000);
      options.onLine(line);
    }
  };
  child.stdout.on("data", (chunk) => consume("stdout", chunk));
  child.stderr.on("data", (chunk) => consume("stderr", chunk));
  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => reject(error));
  child.once("close", (code, signal) => {
    options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) reject(new Error("Amazon Music download cancelled."));
    else if (code === 0) resolve();
    else reject(new Error(`Amazon Music downloader exited with ${signal || code}: ${errorOutput || "unknown error"}`));
  });
});

function rawTrackRows(payload: any): any[] {
  const data = unwrapAmazonData<any>(payload) || {};
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tracks)) return data.tracks;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function catalogTrack(row: any): AmazonMusicCatalogTrack | null {
  const id = String(row?.id || row?.asin || row?.track_id || "").trim();
  if (!id) return null;
  return {
    id,
    title: String(row?.title || row?.name || ""),
    isrc: row?.isrc || row?.external_ids?.isrc || null,
    trackNumber: Number(row?.track_number || row?.trackNumber || row?.position || 0) || null,
    volumeNumber: Number(row?.disc_number || row?.volumeNumber || row?.disc || 0) || null,
  };
}

export class AmazonMusicBackend implements DownloadBackend {
  readonly id = "amazon-music-cli";
  readonly supportedProviders = ["amazon-music"];
  readonly capabilities: Array<"stereo" | "spatial"> = ["stereo", "spatial"];

  constructor(
    private readonly runner: AmazonMusicRunner = runAmazonMusicBridge,
    private readonly tagReader: AmazonMusicTagReader = readAmazonMusicFileTags,
  ) {}

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    assertSafeDownloadResourceId(request.providerId);
    const credentials = loadAmazonMusicCredentials();
    if (!credentials) throw new Error("Connect the Amazon Music API dependency before downloading.");
    fs.mkdirSync(request.downloadPath, { recursive: true });
    options.onProgress({ progress: 1, state: "downloading", statusMessage: "Starting Amazon Music download" });
    await this.runner(getAmazonMusicPython(), buildAmazonMusicBridgeArgs(request), {
      cwd: request.downloadPath,
      env: {
        ...process.env,
        AMAZON_MUSIC_API_TOKEN: credentials.accessToken,
        AMAZON_MUSIC_API_BASE: credentials.apiBase,
      },
      signal: options.signal,
      onLine: (line) => {
        const progress = amazonProgressForLine(line);
        if (progress) options.onProgress(progress);
      },
    });

    let tracks: AmazonMusicCatalogTrack[];
    if (request.entityType === "track") {
      tracks = [{ id: request.providerId, title: "" }];
      const files = listMediaFiles(request.downloadPath);
      if (files.length === 1 && path.basename(files[0], path.extname(files[0])) !== request.providerId) {
        const target = assertPathInsideRoot(
          request.downloadPath,
          path.join(path.dirname(files[0]), safeProviderMediaFilename(request.providerId, path.extname(files[0]).toLowerCase())),
        );
        if (fs.existsSync(target)) {
          throw new Error(`Amazon Music output collision for provider track ${request.providerId}.`);
        }
        fs.renameSync(files[0], target);
      }
    } else {
      const album = await amazonMusicApiRequest<any>("album", { id: request.providerId });
      tracks = rawTrackRows(album).map(catalogTrack).filter((item): item is AmazonMusicCatalogTrack => Boolean(item));
      await normalizeAmazonMusicDownloadFilenames(request.downloadPath, tracks, this.tagReader);
    }
    const named = listMediaFiles(request.downloadPath)
      .filter((filePath) => tracks.some((track) => path.basename(filePath, path.extname(filePath)) === track.id));
    if (named.length === 0) {
      throw new Error("Amazon Music downloader produced no provider-identifiable media files.");
    }
    options.onProgress({ progress: 100, state: "completed", statusMessage: "Amazon Music download complete" });
  }
}
