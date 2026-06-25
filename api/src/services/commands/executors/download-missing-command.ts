import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { DownloadMissingService } from "../../music/download-missing-service.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";

export class DownloadMissingCommand implements IExecuteCommand<"DownloadMissing"> {
    async execute(job: CommandModelOf<"DownloadMissing">, ctx: CommandHandlerContext): Promise<void> {
        const selectedArtistIds = Array.isArray(job.payload.artistIds)
            ? job.payload.artistIds.map((artistId) => String(artistId))
            : undefined;

        let totalAlbums = 0;
        let totalTracks = 0;
        let totalVideos = 0;

        if (selectedArtistIds && selectedArtistIds.length > 0) {
            const artists = getManagedArtists({ artistIds: selectedArtistIds }) as Array<{ id: string | number; name?: string }>;
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
                totalAlbums += queued.albums;
                totalTracks += queued.tracks;
                totalVideos += queued.videos;
            }
        } else {
            ctx.updateCommandDescription(job, {
                progress: 10,
                description: `App-wide - checking monitored items`,
            });

            const queued = await DownloadMissingService.queueMonitoredItems();
            totalAlbums += queued.albums;
            totalTracks += queued.tracks;
            totalVideos += queued.videos;
        }

        const total = totalAlbums + totalTracks + totalVideos;
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: `Queued ${total} download(s) (${totalAlbums} albums, ${totalTracks} tracks, ${totalVideos} videos)`,
        });
    }
}
