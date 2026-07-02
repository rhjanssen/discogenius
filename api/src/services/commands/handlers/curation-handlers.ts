import { CurationService } from "../../music/curation-service.js";
import { DownloadMissingService } from "../../music/download-missing-service.js";
import { UpgraderService } from "../../mediafiles/upgrader.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import type { CommandHandler } from "./handler-context.js";

export const handleApplyCuration: CommandHandler<"ApplyCuration"> = async (job, ctx) => {
    const baseLabel = "Managed artists";
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `${baseLabel} - preparing curation`,
    });

    const selectedCurationArtistIds = Array.isArray(job.payload.artistIds)
        ? job.payload.artistIds.map((id: any) => String(id))
        : undefined;
    const artists = getManagedArtists({ orderByLastScanned: true, artistIds: selectedCurationArtistIds });

    let curated = 0;
    let errors = 0;

    for (let i = 0; i < artists.length; i++) {
        const artist = artists[i];
        const artistId = String(artist.id);
        const artistName = String((artist as any).name || '').trim();

        const progress = Math.min(90, 10 + Math.round(((i + 1) / artists.length) * 80));
        ctx.updateCommandDescription(job, {
            progress,
            description: `${baseLabel} - curating ${artistName || 'artist'} (${i + 1}/${artists.length})`,
        });

        try {
            await CurationService.processAll(artistId, {
                skipDownloadQueue: true,
                forceDownloadQueue: false,
            });
            ArtistStatisticsService.refresh([artistId]);
            curated++;
        } catch (error: any) {
            errors++;
            console.error(`[CommandExecutor] ApplyCuration: failed to curate ${artistName} (${artistId}):`, error?.message);
        }
    }

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Curated ${curated} artist(s)${errors > 0 ? `, ${errors} error(s)` : ''} (${artists.length} total)`,
    });
};

export const handleDownloadMissing: CommandHandler<"DownloadMissing"> = async (job, ctx) => {
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
};

export const handleCheckUpgrades: CommandHandler<"CheckUpgrades"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 10,
        description: "Tracked files - comparing against quality profile cutoffs",
    });
    const result = await UpgraderService.checkUpgrades(true);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Queued ${result.details.length} upgrade candidate(s)`,
    });
};

export const handleCurateArtist: CommandHandler<"CurateArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 10,
        description: ctx.formatArtistPhaseDescription(job, "applying release monitoring rules"),
    });
    await CurationService.processAll(
        job.payload.artistId,
        {
            skipDownloadQueue: true,
            forceDownloadQueue: false,
        }
    );
    ctx.updateCommandDescription(job, {
        progress: 90,
        description: ctx.formatArtistPhaseDescription(job, "updating artist statistics"),
    });
    ArtistStatisticsService.refresh([job.payload.artistId]);
};
