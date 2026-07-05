import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { DownloadMissingService } from "../../music/download-missing-service.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import { CommandQueueManager } from "../command-queue-manager.js";

export class DownloadMissingCommand implements IExecuteCommand<"DownloadMissing"> {
    private static readonly REFILL_INTERVAL_MS = 5_000;

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private shouldContinue(jobId: number): boolean {
        const current = CommandQueueManager.get(jobId);
        return current?.status === "started";
    }

    private async queueBatchForScope(
        artistIds: string[] | undefined,
        limit: number,
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        let remaining = limit;
        const total = { albums: 0, tracks: 0, videos: 0 };

        if (artistIds && artistIds.length > 0) {
            const artists = getManagedArtists({ artistIds }) as Array<{ id: string | number; name?: string }>;
            for (const artist of artists) {
                if (remaining <= 0) break;
                const queued = await DownloadMissingService.queueMonitoredItems(String(artist.id), { limit: remaining });
                ArtistStatisticsService.refresh([String(artist.id)]);
                total.albums += queued.albums;
                total.tracks += queued.tracks;
                total.videos += queued.videos;
                remaining -= queued.albums + queued.tracks + queued.videos;
            }
            return total;
        }

        return DownloadMissingService.queueMonitoredItems(undefined, { limit });
    }

    async execute(job: CommandModelOf<"DownloadMissing">, ctx: CommandHandlerContext): Promise<void> {
        const selectedArtistIds = Array.isArray(job.payload.artistIds)
            ? job.payload.artistIds.map((artistId) => String(artistId))
            : undefined;

        let totalAlbums = 0;
        let totalTracks = 0;
        let totalVideos = 0;
        let idlePasses = 0;

        while (this.shouldContinue(job.id)) {
            const buffered = DownloadMissingService.countActiveDownloadCommands();
            const refillLimit = Math.max(0, DownloadMissingService.DEFAULT_MAX_BUFFERED_DOWNLOADS - buffered);

            ctx.updateCommandDescription(job, {
                progress: 10,
                description: `${buffered} active/queued download(s); checking wanted media`,
            });

            const queued = refillLimit > 0
                ? await this.queueBatchForScope(selectedArtistIds, refillLimit)
                : { albums: 0, tracks: 0, videos: 0 };
            const queuedCount = queued.albums + queued.tracks + queued.videos;
            totalAlbums += queued.albums;
            totalTracks += queued.tracks;
            totalVideos += queued.videos;

            if (queuedCount > 0) {
                idlePasses = 0;
                const total = totalAlbums + totalTracks + totalVideos;
                ctx.updateCommandDescription(job, {
                    progress: 50,
                    description: `Queued ${total} wanted download(s); keeping up to ${DownloadMissingService.DEFAULT_MAX_BUFFERED_DOWNLOADS} buffered`,
                });
            } else {
                const activeAfter = DownloadMissingService.countActiveDownloadCommands();
                if (activeAfter === 0) {
                    idlePasses++;
                } else {
                    idlePasses = 0;
                }

                if (idlePasses >= 2) {
                    break;
                }

                ctx.updateCommandDescription(job, {
                    progress: 75,
                    description: activeAfter > 0
                        ? `Waiting for ${activeAfter} active/queued download(s) before the next wanted check`
                        : "Confirming no wanted media remains",
                });
            }

            await this.sleep(DownloadMissingCommand.REFILL_INTERVAL_MS);
        }

        const total = totalAlbums + totalTracks + totalVideos;
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: total > 0
                ? `Wanted check complete: queued ${total} download(s) (${totalAlbums} albums, ${totalTracks} tracks, ${totalVideos} videos)`
                : "Wanted check complete: no monitored missing media found",
        });
    }
}
