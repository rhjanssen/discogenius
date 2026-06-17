import { spawn } from "child_process";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import {
    buildTiddlEnv,
    capTiddlTrackQuality,
    getTiddlBinary,
    mapAudioQualityToTiddl,
    syncTiddlSettings,
} from "./tiddl.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";

export { TIDDL_CONFIG_DIR, TIDDL_AUTH_FILE, getTiddlCapabilitySnapshot } from "./tiddl.js";

function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

export class TiddlBackend implements DownloadBackend {
    readonly id = "tiddl";
    readonly supportedProviders = ["tidal"];
    readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo", "spatial", "video"];

    async download(
        request: DownloadRequest,
        options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void }
    ): Promise<void> {
        // Slot selections can combine multiple provider releases ("id1;id2") when
        // no single release covers the target tracklist. Download them in order
        // into the same workspace; the import step matches files per track.
        const providerIds = String(request.providerId || "")
            .split(";")
            .map((id) => id.trim())
            .filter(Boolean);
        if (providerIds.length === 0) {
            throw new Error("tiddl download requested without a provider ID");
        }

        syncTiddlSettings();

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

    private downloadOne(
        providerId: string,
        request: DownloadRequest,
        options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
        span: { completed: number; total: number },
    ): Promise<void> {
        const url = `https://tidal.com/browse/${request.entityType}/${providerId}`;
        // Per-job CLI args (these override the global config.toml). Scan path is
        // pinned to this job's own workspace so skip_existing only matches files
        // from THIS job — never another concurrent job's downloads.
        const args: string[] = [
            "download",
            "--path", request.downloadPath,
            "--scan-path", request.downloadPath,
        ];

        if (request.entityType === "video") {
            args.push("--videos", "only");
        } else {
            const isSpatial = isSpatialAudioQuality(request.quality);
            args.push("-q", capTiddlTrackQuality(mapAudioQualityToTiddl(request.quality), isSpatial));
            // Spatial slot: Atmos only. Stereo slot: allow Atmos so an Atmos-only
            // release can still fill the stereo slot when no stereo release exists.
            args.push("--dolby-atmos", isSpatial ? "only" : "allow");
            // Audio jobs never pull music videos bundled with the album/artist.
            args.push("--videos", "none");
        }

        args.push("url", url);

        const cp = spawn(getTiddlBinary(), args, { env: buildTiddlEnv() });

        if (options.signal) {
            if (options.signal.aborted) {
                cp.kill();
            } else {
                options.signal.addEventListener("abort", () => {
                    cp.kill();
                });
            }
        }

        const toOverallPercent = (subFraction: number): number => {
            const bounded = Math.min(1, Math.max(0, subFraction));
            return Math.round(((span.completed + bounded) / span.total) * 100);
        };

        return new Promise<void>((resolve, reject) => {
            let lastPercent = toOverallPercent(0);
            let hasProcessingError = false;
            let errorDetail = "";

            cp.stdout?.on("data", (data: Buffer) => {
                const lines = data.toString().split(/\r?\n|\r/g);
                for (const line of lines) {
                    const cleanLine = stripAnsi(line).trim();
                    if (!cleanLine) continue;

                    // "not a MP4 file" is a tiddl-handled fallback; "no longer
                    // available" tracks are skipped rather than fatal.
                    if (
                        cleanLine.includes("Error:")
                        && !cleanLine.includes("not a MP4 file")
                        && !cleanLine.includes("no longer available")
                    ) {
                        hasProcessingError = true;
                        errorDetail = errorDetail || cleanLine;
                    }

                    if (cleanLine.includes("Total Progress")) {
                        const match = cleanLine.match(/(\d+)\/(\d+)/);
                        if (match) {
                            const current = parseInt(match[1], 10);
                            const total = parseInt(match[2], 10);
                            lastPercent = toOverallPercent(total > 0 ? current / total : 0);
                            options.onProgress({
                                progress: lastPercent,
                                currentFileNum: current,
                                totalFiles: total,
                                state: "downloading",
                                statusMessage: cleanLine,
                            });
                        }
                    } else if (cleanLine.includes("Exists") || cleanLine.includes("Downloaded") || cleanLine.includes("Total downloads")) {
                        options.onProgress({
                            progress: lastPercent,
                            statusMessage: cleanLine,
                            state: "downloading",
                        });
                    }
                }
            });

            cp.stderr?.on("data", (data: Buffer) => {
                const str = stripAnsi(data.toString());
                if (str.includes("Error:") || str.includes("Exception:") || str.includes("Traceback")) {
                    hasProcessingError = true;
                    errorDetail = errorDetail || str.trim().split(/\r?\n/)[0];
                }
            });

            cp.on("close", (code: number | null) => {
                if (code === 0 && !hasProcessingError) {
                    options.onProgress({
                        progress: toOverallPercent(1),
                        state: "downloading",
                        statusMessage: `Finished ${request.entityType} ${providerId}`,
                    });
                    resolve();
                } else {
                    reject(new Error(
                        `tiddl exited with code ${code}${errorDetail ? `: ${errorDetail}` : ""}`,
                    ));
                }
            });

            cp.on("error", (err: Error) => {
                reject(err);
            });
        });
    }
}
