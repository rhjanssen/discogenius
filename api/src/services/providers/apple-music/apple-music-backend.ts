import { spawnDownloadProcess as spawn } from "../../download/download-child-process.js";
import fs from "fs";
import path from "path";
import net from "net";
import { setTimeout as wait } from "node:timers/promises";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import { Config } from "../../config/config.js";
import { classifyNeutralAudio } from "../provider-quality.js";
import {
  APPLE_MUSIC_DOWNLOADER_DIR,
  AppleMusicAuthToken,
  handleAppleDecryptFailure,
  handleAppleDecryptSuccess,
  loadStoredAppleMusicToken,
  resolveAppleStorefront,
  resolveAppleVideoMaxHeight,
  requestWrapperServerRestart,
  resolveAppleWrapperHost,
  syncTokenToDownloader,
} from "./apple-music-auth.js";
import { ProviderAuthError } from "../provider-auth-error.js";
import { recordProviderAuthFailure, recordProviderAuthOk } from "../provider-auth-state.js";
import { ProviderUnavailableError } from "../../download/provider-unavailable-error.js";
import { db, withSqliteWriteGate } from "../../../database.js";
import { markAcquisitionPlanningStale } from "../../music/acquisition-planning-control.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";
import { getAppleAlbumTracks } from "./apple-music-catalog.js";

export function getAppleMusicDownloaderBinary(): string {
  return process.env.APPLE_MUSIC_DL_BIN || "apple-music-dl";
}

function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

function isLikelyProviderId(value: string): boolean {
  return /^\d{5,}$/.test(value.trim()) || /^pl\.[\w-]+$/.test(value.trim());
}

// The decryption wrapper returns EOF / CKC / sign-in errors when the Apple Music
// session behind it has expired or been rejected — the downloader surfaces that
// as cryptic strings like "Error reading response from device: EOF". Translate
// those into one actionable instruction instead of leaking the raw wrapper text.
export const APPLE_SESSION_FAILURE_PATTERN =
  /reading response from device|device:\s*eof|\bckc\b|decrypt failed|sign[\s-]?in|unauthor|invalid.*(?:token|session|user)|forbidden|\b401\b|\b403\b/i;

export const APPLE_DECRYPT_FAILURE_PATTERN =
  /\bdecrypt(?:ing|ion)?\b.*?\bfailed\b|\bfailed\b.*?\bdecrypt(?:ing|ion)?\b|failed to run v2(?::\s*decrypt)?|reading response from device|device:\s*eof|\bckc\b|decryption wrapper/i;

export function isAppleDecryptFailure(text: string): boolean {
  return APPLE_DECRYPT_FAILURE_PATTERN.test(text || "");
}

export function isAppleSessionFailure(text: string): boolean {
  return APPLE_SESSION_FAILURE_PATTERN.test(text || "") || isAppleDecryptFailure(text);
}

export function isAppleUnavailableTrackError(text: string): boolean {
  const clean = stripAnsi(text || "").trim();
  if (!clean) return false;
  if (/Unavailable,\s*trying to dl aac/i.test(clean)) return false;
  if (APPLE_SESSION_FAILURE_PATTERN.test(clean)) return false;
  if (isAppleDecryptFailure(clean)) return false;
  if (/503\s+Service\s+Unavailable/i.test(clean)) return false;
  return /Unavailable/i.test(clean) || /Failed to dl aac-lc/i.test(clean);
}

export function listDownloadedMediaFiles(dirPath: string): Set<string> {
  const files = new Set<string>();
  if (!fs.existsSync(dirPath)) return files;
  const walk = (current: string) => {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && /\.(m4a|mp4|flac|alac|mp3|aac)$/i.test(entry.name)) {
          files.add(full);
        }
      }
    } catch {
      // ignore read errors
    }
  };
  walk(dirPath);
  return files;
}

export function countDownloadedMediaFiles(dirPath: string, initialFiles?: Set<string>): number {
  if (!fs.existsSync(dirPath)) return 0;
  const currentFiles = listDownloadedMediaFiles(dirPath);
  if (!initialFiles || initialFiles.size === 0) return currentFiles.size;
  let count = 0;
  for (const file of currentFiles) {
    if (!initialFiles.has(file)) count++;
  }
  return count;
}

export function resolveAppleAlbumTrackIds(
  providerAlbumId: string,
  deps: { database?: import("better-sqlite3").Database } = {},
): string[] {
  try {
    const database = deps.database ?? (db as import("better-sqlite3").Database | undefined);
    if (!database) return [];
    const rows = database.prepare(`
      SELECT member_item.provider_id
      FROM ProviderItems album_item
      JOIN ProviderEditionMembers mem ON mem.provider_edition_item_id = album_item.id
      JOIN ProviderItems member_item ON member_item.id = mem.member_item_id
      WHERE album_item.provider = 'apple-music'
        AND album_item.entity_type IN ('release', 'album')
        AND album_item.provider_id = ?
      ORDER BY mem.medium_position, mem.position
    `).all(providerAlbumId) as Array<{ provider_id: string }>;
    return rows.map((r) => r.provider_id).filter(Boolean);
  } catch {
    return [];
  }
}

export async function recordUnavailableAppleTrack(
  providerTrackId: string,
  reason: string,
  deps: {
    database?: import("better-sqlite3").Database;
    markStale?: () => string;
  } = {},
): Promise<void> {
  try {
    const database = deps.database ?? (db as import("better-sqlite3").Database | undefined);
    if (!database) return;
    const markStale = deps.markStale ?? markAcquisitionPlanningStale;
    await withSqliteWriteGate(() => {
      database.prepare(`
        UPDATE ProviderItems
        SET availability = 'unavailable', availability_reason = ?, checked_at = ?
        WHERE provider = 'apple-music' AND entity_type = 'track' AND provider_id = ?
      `).run(reason, new Date().toISOString(), providerTrackId);
      markStale();
    }, "apple-music:record-unavailable-track");
  } catch (error) {
    console.warn(`[APPLE-MUSIC] Failed to mark track ${providerTrackId} unavailable:`, error);
  }
}

export function describeAppleDownloaderFailure(code: number | null, errorDetail: string): string {
  const detail = (errorDetail || "").trim();
  if (isAppleSessionFailure(detail) || isAppleDecryptFailure(detail)) {
    return "Apple Music decryption failed because the wrapper session expired or Apple rejected it. "
      + "Re-authenticate Apple Music from the Auth page (enter the Apple ID 2FA code promptly; the wrapper only waits ~60s). "
      + "If this persists, check the wrapper log for an Apple account playback-limit error before replacing the saved session."
      + `${detail ? ` [downloader: ${detail}]` : ""}`;
  }
  return `apple-music-downloader exited with code ${code}${detail ? `: ${detail}` : ""}`;
}

export function resolveAppleMusicProviderStorefront(): string {
  return loadStoredAppleMusicToken()?.storefront || resolveAppleStorefront();
}

type AppleAudioQualitySetting = "low" | "normal" | "high" | "max";

function configuredAppleAudioQuality(): AppleAudioQualitySetting {
  try {
    const configured = String(Config.getQualityConfig()?.audio_quality || "max").trim().toLowerCase();
    if (configured === "low" || configured === "normal" || configured === "high" || configured === "max") {
      return configured;
    }
  } catch {
    // Config can be unavailable during early bootstrap; preserve the historical
    // highest-quality default in that case.
  }
  return "max";
}

/**
 * Translate the global stereo ceiling into apple-music-dl's existing modes.
 * The tool exposes one AAC mode (Apple's 256 kbps floor) plus an ALAC sample
 * rate ceiling, so Low and Normal intentionally share AAC while High caps ALAC
 * at 48 kHz and Max allows the offer's highest lossless tier.
 */
export function appleAudioQualityArgs(
  requestedQuality: string | null | undefined,
  configuredQuality: AppleAudioQualitySetting = configuredAppleAudioQuality(),
): string[] {
  const requestedNeutral = appleMusicQualityMapping.toNeutralAudio(requestedQuality)
    ?? classifyNeutralAudio(requestedQuality);

  if (configuredQuality === "low" || configuredQuality === "normal") {
    return ["--aac"];
  }
  if (requestedNeutral === "lossy") {
    return ["--aac"];
  }
  if (configuredQuality === "high") {
    return ["--alac-max", "48000"];
  }
  if (requestedNeutral === "hires-lossless") {
    return ["--alac-max", "192000"];
  }
  if (requestedNeutral === "lossless") {
    return ["--alac-max", "48000"];
  }
  return [];
}

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\") || command.includes(":")) {
    return fs.existsSync(command);
  }
  const pathExts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of pathExts) {
      if (fs.existsSync(`${dir}${process.platform === "win32" ? "\\" : "/"}${command}${ext}`)) {
        return true;
      }
    }
  }
  return false;
}

function checkPort(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export type AppleMusicDownloaderCapabilitySnapshot = {
  authenticated: boolean;
  downloaderBinary: string;
  downloaderBinaryAvailable: boolean;
  mp4BoxAvailable: boolean;
  mp4DecryptAvailable: boolean;
  wrapperDecryptPortOpen: boolean;
  wrapperM3u8PortOpen: boolean;
  downloaderConfigExists: boolean;
  downloaderWorkingDirectory: string;
};

export async function getAppleMusicDownloaderCapabilitySnapshot(): Promise<AppleMusicDownloaderCapabilitySnapshot> {
  const downloaderBinary = getAppleMusicDownloaderBinary();
  const wrapperHost = resolveAppleWrapperHost();
  const [wrapperDecryptPortOpen, wrapperM3u8PortOpen] = await Promise.all([
    checkPort(wrapperHost, 10020),
    checkPort(wrapperHost, 20020),
  ]);
  return {
    authenticated: Boolean(loadStoredAppleMusicToken()),
    downloaderBinary,
    downloaderBinaryAvailable: commandExists(downloaderBinary),
    mp4BoxAvailable: commandExists("MP4Box"),
    mp4DecryptAvailable: commandExists("mp4decrypt"),
    wrapperDecryptPortOpen,
    wrapperM3u8PortOpen,
    downloaderConfigExists: fs.existsSync(`${APPLE_MUSIC_DOWNLOADER_DIR}${process.platform === "win32" ? "\\" : "/"}config.yaml`),
    downloaderWorkingDirectory: APPLE_MUSIC_DOWNLOADER_DIR,
  };
}

export function describeAppleDownloaderMissingPrerequisites(
  snapshot: AppleMusicDownloaderCapabilitySnapshot,
): string[] {
  const missing: string[] = [];
  if (!snapshot.downloaderBinaryAvailable) {
    missing.push(`downloader binary (${snapshot.downloaderBinary})`);
  }
  if (!snapshot.mp4BoxAvailable) {
    missing.push("MP4Box");
  }
  if (!snapshot.wrapperDecryptPortOpen) {
    missing.push("decryption wrapper port 10020");
  }
  if (!snapshot.wrapperM3u8PortOpen) {
    missing.push("decryption wrapper port 20020");
  }
  return missing;
}

/** A wrapper restart is transient; absent binaries or authentication are not. */
export async function waitForAppleMusicDownloaderReadiness(
  readSnapshot = getAppleMusicDownloaderCapabilitySnapshot,
  options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {},
): Promise<AppleMusicDownloaderCapabilitySnapshot> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const snapshot = await readSnapshot();
    options.signal?.throwIfAborted();
    const missing = describeAppleDownloaderMissingPrerequisites(snapshot);
    if (!snapshot.authenticated || !missing.length || missing.some(item => !item.startsWith("decryption wrapper port")) || Date.now() >= deadline) return snapshot;
    await wait(Math.min(options.pollMs ?? 1_000, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
  }
}

function onlyWrapperPortsMissing(snapshot: AppleMusicDownloaderCapabilitySnapshot, missing: string[]): boolean {
  return snapshot.authenticated && missing.length > 0 && missing.every((item) => item.startsWith("decryption wrapper port"));
}

/**
 * Pre-download wrapper check (no periodic polling): if the decryption ports do
 * not answer, ask the supervisor to restart the hung server and wait for the
 * ports. When they still do not answer, raise a provider hold so Apple jobs
 * wait behind a banner instead of failing one by one.
 */
export async function ensureAppleWrapperReadyForDownload(
  deps: {
    readSnapshot?: () => Promise<AppleMusicDownloaderCapabilitySnapshot>;
    requestRestart?: () => boolean;
    signal?: AbortSignal;
    initialTimeoutMs?: number;
    restartTimeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<AppleMusicDownloaderCapabilitySnapshot> {
  const readSnapshot = deps.readSnapshot ?? getAppleMusicDownloaderCapabilitySnapshot;
  const pollMs = deps.pollMs ?? 1_000;
  let snapshot = await waitForAppleMusicDownloaderReadiness(readSnapshot, {
    signal: deps.signal, timeoutMs: deps.initialTimeoutMs ?? 10_000, pollMs,
  });
  let missing = describeAppleDownloaderMissingPrerequisites(snapshot);
  if (!onlyWrapperPortsMissing(snapshot, missing)) return snapshot;

  console.warn(`[APPLE-MUSIC] Decryption wrapper unreachable before download (${missing.join(", ")}); requesting wrapper restart.`);
  const requested = (deps.requestRestart ?? requestWrapperServerRestart)();
  if (requested) {
    snapshot = await waitForAppleMusicDownloaderReadiness(readSnapshot, {
      signal: deps.signal, timeoutMs: deps.restartTimeoutMs ?? 90_000, pollMs,
    });
    missing = describeAppleDownloaderMissingPrerequisites(snapshot);
    if (!onlyWrapperPortsMissing(snapshot, missing)) {
      if (!missing.length) {
        console.log("[APPLE-MUSIC] Decryption wrapper answered again after restart.");
        await recordProviderAuthOk("apple-music", { probedAt: new Date().toISOString() }).catch(() => undefined);
      }
      return snapshot;
    }
  }
  const authMsg = `Apple Music decryption wrapper is not answering (${missing.join(", ")})${requested ? " even after a restart" : ""}; Apple downloads are on hold until it responds.`;
  await recordProviderAuthFailure("apple-music", authMsg).catch(() => undefined);
  throw new ProviderAuthError(
    "apple-music",
    authMsg,
    "wrapper_unreachable",
  );
}

export type AppleDownloaderProgressEvent = {
  currentFileNum?: number;
  totalFiles?: number;
  currentProviderTrackId?: string;
  currentTrack?: string;
  trackStatus?: DownloadProgress["trackStatus"];
  statusMessage?: string;
  isError?: boolean;
  summary?: {
    completed: number;
    total: number;
    errors: number;
  };
};

export function parseAppleDownloaderProgressLine(
  line: string,
  current?: { currentFileNum?: number; totalFiles?: number; providerTrackId?: string },
): AppleDownloaderProgressEvent | null {
  const cleanLine = stripAnsi(line).trim();
  if (!cleanLine) return null;

  const trackMatch = cleanLine.match(/^Track\s+(\d+)\s+of\s+(\d+):\s*(.+)?$/i);
  if (trackMatch) {
    return {
      currentFileNum: Number(trackMatch[1]),
      totalFiles: Number(trackMatch[2]),
      statusMessage: cleanLine,
      trackStatus: "downloading",
    };
  }

  if (isLikelyProviderId(cleanLine)) {
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      currentProviderTrackId: cleanLine,
      currentTrack: cleanLine,
      trackStatus: "downloading",
      statusMessage: `Downloading ${cleanLine}`,
    };
  }

  if (/^(Downloaded|Decrypted)$/i.test(cleanLine)) {
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      currentProviderTrackId: current?.providerTrackId,
      currentTrack: current?.providerTrackId,
      trackStatus: cleanLine.toLowerCase() === "downloaded" ? "downloading" : "completed",
      statusMessage: cleanLine,
    };
  }

  if (/already exists locally/i.test(cleanLine)) {
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      currentProviderTrackId: current?.providerTrackId,
      currentTrack: current?.providerTrackId,
      trackStatus: "completed",
      statusMessage: cleanLine,
    };
  }

  // Final summary banner ("======= [✔] Completed: 1/1 | [⚠] Warnings: 0 |
  // [✖] Errors: 0 ======="): only a zero completed count with nonzero error count is a failure flag
  const summaryMatch = cleanLine.match(/Completed:\s*(\d+)\s*\/\s*(\d+).*Errors:\s*(\d+)/i);
  if (summaryMatch) {
    const completedCount = Number(summaryMatch[1]);
    const totalCount = Number(summaryMatch[2]);
    const errorCount = Number(summaryMatch[3]);
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      trackStatus: completedCount > 0 ? "completed" : (errorCount > 0 ? "error" : "completed"),
      statusMessage: cleanLine,
      isError: completedCount === 0 && errorCount > 0 ? true : undefined,
      summary: {
        completed: completedCount,
        total: totalCount,
        errors: errorCount,
      },
    };
  }

  // Upstream exit notice when exit-on-error: true triggers after errors
  if (/Error detected,\s*(?:exiting|press Enter)/i.test(cleanLine)) {
    return { statusMessage: cleanLine };
  }

  // Upstream apple-music-dl logs "Unavailable, trying to dl aac-lc" when the
  // preferred ALAC/Atmos stream is missing and it falls back to AAC-LC. That is
  // a codec fallback, not a hard failure — treating it as isError previously
  // failed whole album jobs that exited 0 after a successful AAC download.
  if (/Unavailable,\s*trying to dl aac/i.test(cleanLine)) {
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      currentProviderTrackId: current?.providerTrackId,
      currentTrack: current?.providerTrackId,
      trackStatus: "downloading",
      statusMessage: cleanLine,
    };
  }

  if (/Unavailable|Invalid media-user-token|Failed|Error|Exception/i.test(cleanLine) && !/lyric|lrc/i.test(cleanLine)) {
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      currentProviderTrackId: current?.providerTrackId,
      currentTrack: current?.providerTrackId,
      trackStatus: "error",
      statusMessage: cleanLine,
      isError: true,
    };
  }

  return { statusMessage: cleanLine };
}

/**
 * Download backend that wraps the OSS `zhaarey/apple-music-downloader` (Go),
 * mirroring how TiddlBackend wraps tiddl for TIDAL.
 *
 * The catalog/metadata side of the Apple Music adapter is fully implemented and
 * usable; the live binary download path additionally requires (a) the Go
 * downloader binary on PATH and (b) the companion decryption `wrapper` service
 * running. Readiness is reported through provider diagnostics before download
 * attempts, so callers fail with actionable prerequisites instead of silently
 * producing empty downloads.
 */
export interface AppleMusicBackendDeps {
  spawn?: typeof spawn;
  recordUnavailableTrack?: (providerTrackId: string, reason: string) => Promise<void> | void;
  countMediaFiles?: (dirPath: string, initialFiles?: Set<string>) => number;
  listMediaFiles?: (dirPath: string) => Set<string>;
  preflight?: (request?: DownloadRequest, options?: { signal?: AbortSignal }) => Promise<void>;
  loadToken?: () => AppleMusicAuthToken | null;
  syncToken?: (token: AppleMusicAuthToken | null, downloadPath?: string | null) => void;
  getAlbumTracks?: (providerAlbumId: string) => Promise<Array<{ id: string }>>;
  database?: import("better-sqlite3").Database;
}

export class AppleMusicBackend implements DownloadBackend {
  readonly id = "apple-music-downloader";
  readonly supportedProviders = ["apple-music"];
  readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo", "spatial", "video"];
  private readonly deps: {
    spawn: typeof spawn;
    recordUnavailableTrack: (providerTrackId: string, reason: string) => Promise<void> | void;
    countMediaFiles: (dirPath: string, initialFiles?: Set<string>) => number;
    listMediaFiles: (dirPath: string) => Set<string>;
    preflight: (request?: DownloadRequest, options?: { signal?: AbortSignal }) => Promise<void>;
    loadToken: () => AppleMusicAuthToken | null;
    syncToken: (token: AppleMusicAuthToken | null, downloadPath?: string | null) => void;
    getAlbumTracks?: (providerAlbumId: string) => Promise<Array<{ id: string }>>;
    database?: import("better-sqlite3").Database;
  };

  constructor(deps: AppleMusicBackendDeps = {}) {
    this.deps = {
      spawn: deps.spawn ?? spawn,
      recordUnavailableTrack: deps.recordUnavailableTrack ?? recordUnavailableAppleTrack,
      countMediaFiles: deps.countMediaFiles ?? countDownloadedMediaFiles,
      listMediaFiles: deps.listMediaFiles ?? listDownloadedMediaFiles,
      preflight: deps.preflight ?? ((request, options) => this.defaultPreflight(request, options)),
      loadToken: deps.loadToken ?? loadStoredAppleMusicToken,
      syncToken: deps.syncToken ?? syncTokenToDownloader,
      getAlbumTracks: deps.getAlbumTracks ?? (async (id: string) => {
        try {
          const tracks = await getAppleAlbumTracks(id);
          return tracks.map((t) => ({ id: t.providerId }));
        } catch {
          return [];
        }
      }),
      database: deps.database,
    };
  }

  async preflight(request?: DownloadRequest, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.deps.preflight(request, options);
  }

  private async defaultPreflight(_request?: DownloadRequest, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.deps.loadToken()) {
      throw new Error("Apple Music is not authenticated; cannot download");
    }
    const missing = describeAppleDownloaderMissingPrerequisites(await ensureAppleWrapperReadyForDownload({ signal: options.signal }));
    if (missing.length > 0) {
      throw new Error(`Apple Music downloader provisioning is incomplete: missing ${missing.join(", ")}.`);
    }
  }

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    const token = this.deps.loadToken();
    if (!token) {
      throw new Error("Apple Music is not authenticated; cannot download");
    }
    // Reuse the established auth — write the downloader's config.yaml from the
    // same tokens our API client uses. The downloader reads config.yaml from its
    // working directory and output folders from that config, so this must be
    // job-specific rather than a fake CLI --output flag.
    this.deps.syncToken(token, request.downloadPath);

    const providerIds = String(request.providerId || "")
      .split(";")
      .map((id) => id.trim())
      .filter(Boolean);
    if (providerIds.length === 0) {
      throw new Error("apple-music download requested without a provider ID");
    }

    await this.preflight(request, { signal: options.signal });

    await fs.promises.mkdir(request.downloadPath, { recursive: true });
    for (let index = 0; index < providerIds.length; index++) {
      if (options.signal?.aborted) {
        throw new Error("Download aborted");
      }
      await this.downloadOne(providerIds[index], request, options, {
        completed: index,
        total: providerIds.length,
      });
    }
  }

  /**
   * Construct the binary invocation for one Apple Music resource. Extracted so
   * argument construction is unit-testable independent of process spawning.
   */
  buildArgs(providerId: string, request: DownloadRequest): string[] {
    const storefront = resolveAppleMusicProviderStorefront();
    const typeSegment = request.entityType === "track"
      ? "song"
      : request.entityType === "video"
        ? "music-video"
        : "album";
    const url = `https://music.apple.com/${storefront}/${typeSegment}/${providerId}`;
    const args: string[] = [];
    if (request.entityType === "video") {
      args.push("--mv-audio-type", "atmos");
      // Per-job ceiling must match the managed config.yaml mv-max; otherwise a
      // concurrent stereo download that rewrote config to 1080 would clamp 4K
      // jobs that only inherited the file-level default.
      args.push("--mv-max", String(resolveAppleVideoMaxHeight()));
    } else {
      // Resource scope and audio mode are independent upstream flags. In
      // particular, a single song still needs --atmos/--aac when its selected
      // library slot requests that variant.
      if (request.entityType === "track") {
        args.push("--song");
      }

      const quality = String(request.quality || "").trim();
      if (request.slot === "spatial" || /atmos|spatial/i.test(quality)) {
        args.push("--atmos");
      } else {
        args.push(...appleAudioQualityArgs(quality));
      }
    }
    args.push(url);
    return args;
  }

  private executeProcess(
    providerId: string,
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
    span: { completed: number; total: number },
    albumTrackIds?: string[],
    completedTrackIds?: Set<string>,
    completedTrackIndices?: Set<number>,
    unavailableTracks: Map<string, string> = new Map(),
  ): Promise<{
    code: number | null;
    summaryCompleted?: number;
    completedTracksCount: number;
    sessionErrorDetail?: string;
    fatalOtherError?: string;
    totalFiles?: number;
  }> {
    const args = this.buildArgs(providerId, request);
    // stdin must be closed: on any item error the binary prompts
    // "press Enter to try again" and would block a headless slot forever
    // waiting for input. With stdin at EOF it moves on instead.
    const cp = this.deps.spawn(getAppleMusicDownloaderBinary(), args, {
      cwd: APPLE_MUSIC_DOWNLOADER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    if (options.signal) {
      if (options.signal.aborted) {
        cp.kill();
      } else {
        options.signal.addEventListener("abort", () => cp.kill());
      }
    }

    const toOverallPercent = (subFraction: number): number => {
      const bounded = Math.min(1, Math.max(0, subFraction));
      return Math.round(((span.completed + bounded) / span.total) * 100);
    };

    return new Promise((resolve) => {
      let sessionErrorDetail = "";
      let fatalOtherError = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let completedTracksCount = 0;
      let summaryCompleted: number | undefined;
      const current: { currentFileNum?: number; totalFiles?: number; providerTrackId?: string } = {};

      const emitParsedLine = (line: string, source: "stdout" | "stderr") => {
        const cleanLine = stripAnsi(line).trim();
        if (!cleanLine) return;

        // Upstream notice when exit-on-error triggers after errors; must not be treated as fatal error
        if (/Error detected,\s*(?:exiting|press Enter)/i.test(cleanLine)) {
          return;
        }

        const event = parseAppleDownloaderProgressLine(line, current);
        if (!event) return;

        if (event.currentFileNum !== undefined) {
          if (current.currentFileNum !== event.currentFileNum) {
            current.providerTrackId = undefined;
          }
          current.currentFileNum = event.currentFileNum;
        }
        if (event.totalFiles !== undefined) current.totalFiles = event.totalFiles;
        if (event.currentProviderTrackId) current.providerTrackId = event.currentProviderTrackId;

        if (event.summary) {
          summaryCompleted = event.summary.completed;
        }

        if (event.trackStatus === "completed") {
          completedTracksCount++;
          if (current.providerTrackId) completedTrackIds?.add(current.providerTrackId);
          if (current.currentFileNum) completedTrackIndices?.add(current.currentFileNum - 1);
        }

        if (event.isError && !event.summary) {
          if (isAppleSessionFailure(cleanLine)) {
            sessionErrorDetail = sessionErrorDetail || cleanLine;
            cp.kill();
          } else if (isAppleUnavailableTrackError(cleanLine)) {
            const trackId = event.currentProviderTrackId
              || current.providerTrackId
              || (albumTrackIds && current.currentFileNum ? albumTrackIds[current.currentFileNum - 1] : undefined)
              || (request.trackIds && current.currentFileNum ? request.trackIds[current.currentFileNum - 1] : undefined)
              || (request.entityType === "track" ? providerId : undefined);
            const trackKey = trackId || `file-${current.currentFileNum || (unavailableTracks.size + 1)}`;
            unavailableTracks.set(trackKey, cleanLine);
          } else {
            fatalOtherError = fatalOtherError || event.statusMessage || cleanLine;
            cp.kill();
          }
        } else if (source === "stderr" && /error|exception|traceback/i.test(event.statusMessage || "")) {
          if (isAppleSessionFailure(cleanLine)) {
            sessionErrorDetail = sessionErrorDetail || cleanLine;
            cp.kill();
          } else if (isAppleUnavailableTrackError(cleanLine)) {
            const trackId = event.currentProviderTrackId
              || current.providerTrackId
              || (albumTrackIds && current.currentFileNum ? albumTrackIds[current.currentFileNum - 1] : undefined)
              || (request.trackIds && current.currentFileNum ? request.trackIds[current.currentFileNum - 1] : undefined)
              || (request.entityType === "track" ? providerId : undefined);
            const trackKey = trackId || `file-${current.currentFileNum || (unavailableTracks.size + 1)}`;
            unavailableTracks.set(trackKey, cleanLine);
          } else {
            fatalOtherError = fatalOtherError || event.statusMessage || cleanLine;
            cp.kill();
          }
        }

        const totalFiles = event.totalFiles ?? current.totalFiles;
        const currentFileNum = event.currentFileNum ?? current.currentFileNum;
        const trackStatus = event.trackStatus;
        const completedItems = totalFiles && currentFileNum
          ? Math.max(0, currentFileNum - (trackStatus === "completed" ? 0 : 1))
          : 0;
        // Only emit a percent when the tool reports Track N of M (file-level
        // progress). Single-file / video runs rarely do — leave progress unset
        // so the queue shows an indeterminate bar instead of a fake ramp.
        const progress = totalFiles
          ? toOverallPercent(Math.min(1, completedItems / totalFiles))
          : null;
        options.onProgress({
          progress,
          currentFileNum: currentFileNum ?? 1,
          totalFiles: totalFiles ?? 1,
          currentTrack: event.currentTrack,
          currentProviderTrackId: event.currentProviderTrackId,
          trackStatus,
          statusMessage: event.statusMessage,
          state: "downloading",
        });
      };

      const consumeLines = (chunk: Buffer, source: "stdout" | "stderr") => {
        const raw = (source === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString();
        const lines = raw.split(/\r?\n|\r/g);
        const remainder = lines.pop() ?? "";
        if (source === "stdout") {
          stdoutBuffer = remainder;
        } else {
          stderrBuffer = remainder;
        }
        for (const line of lines) {
          emitParsedLine(line, source);
        }
      };

      cp.stdout?.on("data", (data: Buffer) => consumeLines(data, "stdout"));
      cp.stderr?.on("data", (data: Buffer) => consumeLines(data, "stderr"));
      cp.on("close", (code: number | null) => {
        if (stdoutBuffer) emitParsedLine(stdoutBuffer, "stdout");
        if (stderrBuffer) emitParsedLine(stderrBuffer, "stderr");

        resolve({
          code,
          summaryCompleted,
          completedTracksCount,
          sessionErrorDetail: sessionErrorDetail || undefined,
          fatalOtherError: fatalOtherError || undefined,
          totalFiles: current.totalFiles,
        });
      });
      cp.on("error", (err: Error) => {
        resolve({
          code: 1,
          completedTracksCount,
          fatalOtherError: err.message,
        });
      });
    });
  }

  private async downloadAlbum(
    providerId: string,
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
    span: { completed: number; total: number },
  ): Promise<void> {
    const initialFiles = this.deps.listMediaFiles(request.downloadPath);
    let albumTrackIds = request.trackIds && request.trackIds.length > 0
      ? [...request.trackIds]
      : resolveAppleAlbumTrackIds(providerId, { database: this.deps.database });
    if (albumTrackIds.length === 0 && this.deps.getAlbumTracks) {
      try {
        const tracks = await this.deps.getAlbumTracks(providerId);
        albumTrackIds = tracks.map((t) => t.id);
      } catch {
        // ignore
      }
    }

    const completedTrackIds = new Set<string>();
    const completedTrackIndices = new Set<number>();
    const unavailableTracks = new Map<string, string>();

    const primaryResult = await this.executeProcess(
      providerId,
      request,
      options,
      span,
      albumTrackIds,
      completedTrackIds,
      completedTrackIndices,
      unavailableTracks,
    );

    const decryptErrorDetail = primaryResult.sessionErrorDetail
      || (primaryResult.fatalOtherError && (isAppleSessionFailure(primaryResult.fatalOtherError) || isAppleDecryptFailure(primaryResult.fatalOtherError))
        ? primaryResult.fatalOtherError : undefined);

    if (decryptErrorDetail) {
      await handleAppleDecryptFailure(decryptErrorDetail).catch(() => undefined);
      throw new ProviderAuthError(
        "apple-music",
        describeAppleDownloaderFailure(primaryResult.code, decryptErrorDetail),
        "session_expired",
      );
    }

    if (primaryResult.fatalOtherError) {
      throw new Error(describeAppleDownloaderFailure(primaryResult.code, primaryResult.fatalOtherError));
    }

    // Determine unattempted tracks
    const unattemptedTrackIds: string[] = [];
    if (albumTrackIds.length > 0) {
      for (let i = 0; i < albumTrackIds.length; i++) {
        const id = albumTrackIds[i];
        const isCompleted = completedTrackIds.has(id) || completedTrackIndices.has(i);
        const isUnavailable = unavailableTracks.has(id) || unavailableTracks.has(`file-${i + 1}`);
        if (!isCompleted && !isUnavailable) {
          unattemptedTrackIds.push(id);
        }
      }
    }

    // If upstream exit-on-error stopped the album after an unavailable track,
    // issue follow-up single track downloads for the remaining unattempted tracks.
    if (unattemptedTrackIds.length > 0 && unavailableTracks.size > 0) {
      for (const trackId of unattemptedTrackIds) {
        if (options.signal?.aborted) {
          throw new Error("Download aborted");
        }
        try {
          await this.downloadOne(
            trackId,
            {
              ...request,
              entityType: "track",
              providerId: trackId,
            },
            {
              signal: options.signal,
              onProgress: (subProgress) => {
                const totalTracks = albumTrackIds.length || 1;
                const completedCount = completedTrackIds.size + unavailableTracks.size;
                const overallSubFraction = Math.min(1, completedCount / totalTracks);
                const overallPercent = Math.round(((span.completed + overallSubFraction) / span.total) * 100);
                options.onProgress({
                  ...subProgress,
                  progress: overallPercent,
                  totalFiles: totalTracks,
                  currentFileNum: completedCount + 1,
                });
              },
            },
            span,
          );
          completedTrackIds.add(trackId);
        } catch (err: any) {
          if (err instanceof ProviderUnavailableError) {
            unavailableTracks.set(trackId, err.message);
          } else if (err instanceof ProviderAuthError) {
            throw err;
          } else if (isAppleUnavailableTrackError(err?.message)) {
            unavailableTracks.set(trackId, String(err?.message || "Unavailable"));
          } else {
            throw err;
          }
        }
      }
    }

    const newFilesCount = this.deps.countMediaFiles(request.downloadPath, initialFiles);
    const hasCompletedFiles = completedTrackIds.size > 0
      || primaryResult.completedTracksCount > 0
      || (primaryResult.summaryCompleted ?? 0) > 0
      || newFilesCount > 0;

    if (!hasCompletedFiles) {
      if (unavailableTracks.size > 0) {
        throw new ProviderUnavailableError(
          "apple-music",
          "album",
          providerId,
          `All tracks unavailable: ${Array.from(unavailableTracks.values())[0]}`,
        );
      }
      throw new Error(describeAppleDownloaderFailure(primaryResult.code, primaryResult.fatalOtherError || "No tracks downloaded"));
    }

    if (unavailableTracks.size > 0) {
      await Promise.all(
        Array.from(unavailableTracks.entries()).map(([trackKey, reason]) => {
          let resolvedId = trackKey;
          if (resolvedId.startsWith("file-")) {
            const match = resolvedId.match(/^file-(\d+)$/);
            const fileNum = match ? parseInt(match[1], 10) : undefined;
            if (fileNum && albumTrackIds && fileNum > 0 && fileNum <= albumTrackIds.length) {
              resolvedId = albumTrackIds[fileNum - 1];
            } else if (fileNum) {
              const dbTrackIds = resolveAppleAlbumTrackIds(providerId, { database: this.deps.database });
              if (fileNum > 0 && fileNum <= dbTrackIds.length) {
                resolvedId = dbTrackIds[fileNum - 1];
              }
            }
          }
          if (!resolvedId.startsWith("file-")) {
            return this.deps.recordUnavailableTrack(resolvedId, reason);
          }
          return Promise.resolve();
        }),
      );
    }

    const unavailableCount = unavailableTracks.size;
    if (unavailableCount === 0) {
      await handleAppleDecryptSuccess().catch(() => undefined);
    }
    const warningMessage = unavailableCount > 0
      ? `Completed with ${unavailableCount} unavailable track(s) [${Array.from(unavailableTracks.entries()).map(([id, r]) => `${id}: ${r}`).join("; ")}]`
      : undefined;

    options.onProgress({
      progress: Math.round(((span.completed + 1) / span.total) * 100),
      state: "downloading",
      statusMessage: unavailableCount > 0
        ? `Finished album with ${unavailableCount} unavailable track(s)`
        : `Finished album ${providerId}`,
      warningMessage,
      ...(unavailableCount > 0 ? { outcome: "completedWithWarning" as const } : {}),
    });
  }

  private async downloadOne(
    providerId: string,
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
    span: { completed: number; total: number },
  ): Promise<void> {
    if (request.entityType === "album") {
      return this.downloadAlbum(providerId, request, options, span);
    }

    const unavailableTracks = new Map<string, string>();
    const result = await this.executeProcess(
      providerId,
      request,
      options,
      span,
      undefined,
      undefined,
      undefined,
      unavailableTracks,
    );

    const decryptErrorDetail = result.sessionErrorDetail
      || (result.fatalOtherError && (isAppleSessionFailure(result.fatalOtherError) || isAppleDecryptFailure(result.fatalOtherError))
        ? result.fatalOtherError : undefined);

    if (decryptErrorDetail) {
      await handleAppleDecryptFailure(decryptErrorDetail).catch(() => undefined);
      throw new ProviderAuthError(
        "apple-music",
        describeAppleDownloaderFailure(result.code, decryptErrorDetail),
        "session_expired",
      );
    }

    if (result.fatalOtherError) {
      throw new Error(describeAppleDownloaderFailure(result.code, result.fatalOtherError));
    }

    if (request.entityType === "track") {
      if (unavailableTracks.has(providerId) || unavailableTracks.size > 0 || (result.code !== 0 && isAppleUnavailableTrackError(result.fatalOtherError || ""))) {
        const reason = unavailableTracks.get(providerId) || Array.from(unavailableTracks.values())[0] || result.fatalOtherError || "Unavailable";
        throw new ProviderUnavailableError("apple-music", "track", providerId, reason);
      }
      if (result.code === 0 && !result.fatalOtherError) {
        await handleAppleDecryptSuccess().catch(() => undefined);
        options.onProgress({
          progress: Math.round(((span.completed + 1) / span.total) * 100),
          state: "downloading",
          statusMessage: `Finished track ${providerId}`,
        });
        return;
      }
      throw new Error(describeAppleDownloaderFailure(result.code, result.fatalOtherError || ""));
    }

    // Video:
    if (result.code === 0 && !result.fatalOtherError) {
      await handleAppleDecryptSuccess().catch(() => undefined);
      options.onProgress({
        progress: Math.round(((span.completed + 1) / span.total) * 100),
        state: "downloading",
        statusMessage: `Finished video ${providerId}`,
      });
      return;
    }
    throw new Error(describeAppleDownloaderFailure(result.code, result.fatalOtherError || ""));
  }
}
