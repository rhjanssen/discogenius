import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import { Config } from "../../config/config.js";
import { classifyNeutralAudio } from "../provider-quality.js";
import {
  APPLE_MUSIC_DOWNLOADER_DIR,
  loadStoredAppleMusicToken,
  resolveAppleStorefront,
  resolveAppleVideoMaxHeight,
  syncTokenToDownloader,
} from "./apple-music-auth.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";

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
const APPLE_SESSION_FAILURE_PATTERN =
  /reading response from device|device:\s*eof|\bckc\b|decrypt failed|sign[\s-]?in|unauthor|invalid.*(?:token|session|user)|forbidden|\b401\b|\b403\b/i;

export function describeAppleDownloaderFailure(code: number | null, errorDetail: string): string {
  const detail = (errorDetail || "").trim();
  if (APPLE_SESSION_FAILURE_PATTERN.test(detail)) {
    return "Apple Music decryption failed — the wrapper session has expired, was rejected, or is attached to a dead container network. "
      + "Re-authenticate Apple Music from the Auth page (enter the Apple ID 2FA code promptly; the wrapper only waits ~60s). "
      + "If this persists after a container restart, recreate both services: "
      + "`docker compose up -d --force-recreate discogenius apple-music-wrapper`."
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

function checkPort(host: string, port: number, timeoutMs = 250): Promise<boolean> {
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
  const [wrapperDecryptPortOpen, wrapperM3u8PortOpen] = await Promise.all([
    checkPort("127.0.0.1", 10020),
    checkPort("127.0.0.1", 20020),
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

export type AppleDownloaderProgressEvent = {
  currentFileNum?: number;
  totalFiles?: number;
  currentProviderTrackId?: string;
  currentTrack?: string;
  trackStatus?: DownloadProgress["trackStatus"];
  statusMessage?: string;
  isError?: boolean;
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
  // [✖] Errors: 0 ======="): only a nonzero error count is a failure — the
  // banner itself must not trip the generic error regex below.
  const summaryMatch = cleanLine.match(/Completed:\s*(\d+)\s*\/\s*(\d+).*Errors:\s*(\d+)/i);
  if (summaryMatch) {
    const errorCount = Number(summaryMatch[3]);
    return {
      currentFileNum: current?.currentFileNum,
      totalFiles: current?.totalFiles,
      trackStatus: errorCount > 0 ? "error" : "completed",
      statusMessage: cleanLine,
      isError: errorCount > 0 ? true : undefined,
    };
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
export class AppleMusicBackend implements DownloadBackend {
  readonly id = "apple-music-downloader";
  readonly supportedProviders = ["apple-music"];
  readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo", "spatial", "video"];

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
  ): Promise<void> {
    const token = loadStoredAppleMusicToken();
    if (!token) {
      throw new Error("Apple Music is not authenticated; cannot download");
    }
    // Reuse the established auth — write the downloader's config.yaml from the
    // same tokens our API client uses. The downloader reads config.yaml from its
    // working directory and output folders from that config, so this must be
    // job-specific rather than a fake CLI --output flag.
    syncTokenToDownloader(token, request.downloadPath);

    const providerIds = String(request.providerId || "")
      .split(";")
      .map((id) => id.trim())
      .filter(Boolean);
    if (providerIds.length === 0) {
      throw new Error("apple-music download requested without a provider ID");
    }

    const readiness = await getAppleMusicDownloaderCapabilitySnapshot();
    const missing = describeAppleDownloaderMissingPrerequisites(readiness);
    if (missing.length > 0) {
      throw new Error(`Apple Music downloader provisioning is incomplete: missing ${missing.join(", ")}.`);
    }

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

  private downloadOne(
    providerId: string,
    request: DownloadRequest,
    options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
    span: { completed: number; total: number },
  ): Promise<void> {
    const args = this.buildArgs(providerId, request);
    // stdin must be closed: on any item error the binary prompts
    // "press Enter to try again" and would block a headless slot forever
    // waiting for input. With stdin at EOF it moves on instead.
    const cp = spawn(getAppleMusicDownloaderBinary(), args, {
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

    return new Promise<void>((resolve, reject) => {
      let errorDetail = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const current: { currentFileNum?: number; totalFiles?: number; providerTrackId?: string } = {};

      const emitParsedLine = (line: string, source: "stdout" | "stderr") => {
        const event = parseAppleDownloaderProgressLine(line, current);
        if (!event) return;

        if (event.currentFileNum !== undefined) current.currentFileNum = event.currentFileNum;
        if (event.totalFiles !== undefined) current.totalFiles = event.totalFiles;
        if (event.currentProviderTrackId) current.providerTrackId = event.currentProviderTrackId;
        if (event.isError) {
          errorDetail = errorDetail || event.statusMessage || stripAnsi(line).trim();
        } else if (source === "stderr" && /error|exception|traceback/i.test(event.statusMessage || "")) {
          errorDetail = errorDetail || event.statusMessage || stripAnsi(line).trim();
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
        if (code === 0 && !errorDetail) {
          options.onProgress({
            progress: toOverallPercent(1),
            state: "downloading",
            statusMessage: `Finished ${request.entityType} ${providerId}`,
          });
          resolve();
        } else {
          reject(new Error(describeAppleDownloaderFailure(code, errorDetail)));
        }
      });
      cp.on("error", (err: Error) => reject(err));
    });
  }
}
