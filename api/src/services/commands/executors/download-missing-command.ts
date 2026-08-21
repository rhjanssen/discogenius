import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { DownloadMissingService } from "../../music/download-missing-service.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";

/**
 * Discover monitored missing media and enqueue Download* commands once, then exit.
 *
 * Concurrency belongs to the command worker / per-type caps (active-slot limits),
 * not a long-running refill loop that holds this command open while capping a
 * "buffer" of pending Download* rows.
 */
export class DownloadMissingCommand implements IExecuteCommand<"DownloadMissing"> {
    private async queueForScope(
        artistIds: string[] | undefined,
        ctx: CommandHandlerContext,
        job: CommandModelOf<"DownloadMissing">,
    ): Promise<{ albums: number; tracks: number; videos: number; alreadyQueued: number }> {
        const total = { albums: 0, tracks: 0, videos: 0, alreadyQueued: 0 };

        if (artistIds && artistIds.length > 0) {
            const artists = getManagedArtists({ artistIds }) as Array<{ id: string | number; name?: string }>;
            for (let index = 0; index < artists.length; index += 1) {
                const artist = artists[index];
                const artistName = String((artist as { name?: string }).name || "").trim();
                ctx.updateCommandDescription(job, {
                    progress: Math.min(90, 10 + Math.round((index / Math.max(artists.length, 1)) * 80)),
                    description: artistName
                        ? `Managed artists - checking monitored items for ${artistName} (${index + 1}/${artists.length})`
                        : `Managed artists - checking monitored items (${index + 1}/${artists.length})`,
                });

                const queued = await DownloadMissingService.queueMonitoredItems(String(artist.id));
                ArtistStatisticsService.refresh([String(artist.id)]);
                total.albums += queued.albums;
                total.tracks += queued.tracks;
                total.videos += queued.videos;
                total.alreadyQueued += queued.alreadyQueued;
            }
            return total;
        }

        ctx.updateCommandDescription(job, {
            progress: 10,
            description: "App-wide - checking monitored items",
        });
        return DownloadMissingService.queueMonitoredItems();
    }

    async execute(job: CommandModelOf<"DownloadMissing">, ctx: CommandHandlerContext): Promise<void> {
        const selectedArtistIds = Array.isArray(job.payload.artistIds)
            ? job.payload.artistIds.map((artistId) => String(artistId))
            : undefined;

        const queued = await this.queueForScope(selectedArtistIds, ctx, job);
        const total = queued.albums + queued.tracks + queued.videos;
        const alreadyQueued = queued.alreadyQueued ?? 0;

        ctx.updateCommandDescription(job, {
            progress: 100,
            description: total > 0
                ? `Queued ${total} download(s) (${queued.albums} albums, ${queued.tracks} tracks, ${queued.videos} videos)`
                : alreadyQueued > 0
                    ? `${alreadyQueued} missing album(s) already waiting in the download queue`
                    : "Wanted check complete: no monitored missing media found",
        });
    }
}
