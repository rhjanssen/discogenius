import { spawnOrpheusDownload, parseOrpheusProgress, ensureOrpheusRuntime } from "./orpheus.js";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "./download-backend.js";

export class OrpheusBackend implements DownloadBackend {
    readonly id = "orpheus";
    readonly supportedProviders = ["applemusic", "tidal"];
    readonly capabilities: Array<"stereo" | "spatial"> = ["stereo", "spatial"];

    async download(
        request: DownloadRequest,
        options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void }
    ): Promise<void> {
        await ensureOrpheusRuntime();
        const typeArg = request.entityType === "track" ? "track" : "album";
        const moduleName = request.provider === "applemusic" ? "applemusic" : "tidal";
        
        const cp = await spawnOrpheusDownload(typeArg, request.providerId, request.downloadPath, moduleName);

        if (options.signal) {
            if (options.signal.aborted) {
                cp.kill();
            } else {
                options.signal.addEventListener("abort", () => {
                    cp.kill();
                });
            }
        }

        return new Promise<void>((resolve, reject) => {
            cp.stdout?.on("data", (data: any) => {
                const str = data.toString();
                const op = parseOrpheusProgress(str);
                if (op) {
                    options.onProgress({
                        progress: op.trackProgress ?? 0,
                        currentFileNum: op.currentTrack,
                        totalFiles: op.totalTracks,
                        currentTrack: op.currentTrackName,
                        trackProgress: op.trackProgress,
                        statusMessage: op.statusMessage,
                        state: op.isEntityComplete ? 'completed' : 'downloading',
                        speed: op.speed,
                        eta: op.eta,
                        size: op.size,
                        sizeleft: op.sizeleft,
                    });
                }
            });

            cp.on("close", (code: any) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Orpheus exited with code ${code}`));
                }
            });

            cp.on("error", (err: any) => {
                reject(err);
            });
        });
    }
}
