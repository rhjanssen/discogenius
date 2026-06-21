import { spawn } from "child_process";
import fs from "fs";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import {
  APPLE_MUSIC_DOWNLOADER_DIR,
  loadStoredAppleMusicToken,
  syncTokenToDownloader,
} from "./apple-music-auth.js";

/** Whether the OSS apple-music-downloader binary path is fully wired. */
export const APPLE_MUSIC_DOWNLOAD_ENABLED = String(
  process.env.APPLE_MUSIC_DOWNLOAD_ENABLED ?? "",
).trim().toLowerCase() === "true";

export function getAppleMusicDownloaderBinary(): string {
  return process.env.APPLE_MUSIC_DL_BIN || "apple-music-downloader";
}

/**
 * Download backend that wraps the OSS `zhaarey/apple-music-downloader` (Go),
 * mirroring how TiddlBackend wraps tiddl for TIDAL.
 *
 * The catalog/metadata side of the Apple Music adapter is fully implemented and
 * usable; the live binary download path additionally requires (a) the Go
 * downloader binary on PATH and (b) the companion decryption `wrapper` service
 * running, neither of which can be exercised without live Apple credentials.
 * That last leg is gated behind APPLE_MUSIC_DOWNLOAD_ENABLED and the provider
 * reports `download: false` until it is turned on, so callers degrade
 * gracefully (DATA_MODEL_TARGET §4 scope realism).
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
    // same tokens our API client uses.
    syncTokenToDownloader(token);

    const providerIds = String(request.providerId || "")
      .split(";")
      .map((id) => id.trim())
      .filter(Boolean);
    if (providerIds.length === 0) {
      throw new Error("apple-music download requested without a provider ID");
    }

    if (!APPLE_MUSIC_DOWNLOAD_ENABLED) {
      // TODO(U2): wire the live binary leg once Apple credentials + the zhaarey
      // decryption wrapper are available in the runtime. Until then the metadata
      // side is fully functional and this leg fails loudly rather than silently
      // producing empty downloads.
      throw new Error(
        "Apple Music downloads are not enabled in this build. " +
        "Set APPLE_MUSIC_DOWNLOAD_ENABLED=true and provision the apple-music-downloader binary + decryption wrapper.",
      );
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
    const url = `https://music.apple.com/album/${providerId}`;
    const args: string[] = ["--config", APPLE_MUSIC_DOWNLOADER_DIR, "--output", request.downloadPath];
    if (request.entityType === "video") {
      args.push("--mv-audio-type", "atmos");
    } else if (request.quality && /atmos|spatial/i.test(request.quality)) {
      args.push("--atmos");
    } else if (request.quality && /hi.?res/i.test(request.quality)) {
      args.push("--alac-max", "192000");
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
    const cp = spawn(getAppleMusicDownloaderBinary(), args);

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
      cp.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (!line) return;
        options.onProgress({ progress: toOverallPercent(0.5), state: "downloading", statusMessage: line });
      });
      cp.stderr?.on("data", (data: Buffer) => {
        const str = data.toString();
        if (/error|exception/i.test(str)) {
          errorDetail = errorDetail || str.trim().split(/\r?\n/)[0];
        }
      });
      cp.on("close", (code: number | null) => {
        if (code === 0 && !errorDetail) {
          options.onProgress({
            progress: toOverallPercent(1),
            state: "downloading",
            statusMessage: `Finished ${request.entityType} ${providerId}`,
          });
          resolve();
        } else {
          reject(new Error(`apple-music-downloader exited with code ${code}${errorDetail ? `: ${errorDetail}` : ""}`));
        }
      });
      cp.on("error", (err: Error) => reject(err));
    });
  }
}
