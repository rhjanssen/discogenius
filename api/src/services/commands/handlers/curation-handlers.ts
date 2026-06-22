import { CurationService } from "../../music/curation-service.js";
import { UpgraderService } from "../../mediafiles/upgrader.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import type { CommandHandler } from "./handler-context.js";

export const handleApplyCuration: CommandHandler<"ApplyCuration"> = async (job, ctx) => {
    const baseLabel = "Managed artists";
    ctx.updateJobDescription(job, {
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
        ctx.updateJobDescription(job, {
            progress,
            description: `${baseLabel} - curating ${artistName || 'artist'} (${i + 1}/${artists.length})`,
        });

        try {
            await CurationService.processAll(artistId, {
                skipDownloadQueue: true,
                forceDownloadQueue: false,
            });
            curated++;
        } catch (error: any) {
            errors++;
            console.error(`[CommandExecutor] ApplyCuration: failed to curate ${artistName} (${artistId}):`, error?.message);
        }
    }

    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Curated ${curated} artist(s)${errors > 0 ? `, ${errors} error(s)` : ''} (${artists.length} total)`,
    });
};

export const handleDownloadMissing: CommandHandler<"DownloadMissing"> = async (job, ctx) => {
    const selectedArtistIds = Array.isArray(job.payload.artistIds)
        ? job.payload.artistIds.map((artistId) => String(artistId))
        : undefined;
    const artists = getManagedArtists({ artistIds: selectedArtistIds }) as Array<{ id: string | number; name?: string }>;
    let totalAlbums = 0;
    let totalTracks = 0;
    let totalVideos = 0;

    if (artists.length > 0) {
        ctx.updateJobDescription(job, {
            progress: 5,
            description: `Managed artists - checking monitored items (0/${artists.length})`,
        });
    }

    for (let index = 0; index < artists.length; index += 1) {
        const artist = artists[index];
        const artistName = String((artist as { name?: string }).name || "").trim();
        ctx.updateJobDescription(job, {
            progress: Math.min(90, 10 + Math.round((index / Math.max(artists.length, 1)) * 80)),
            description: artistName
                ? `Managed artists - checking monitored items for ${artistName} (${index + 1}/${artists.length})`
                : `Managed artists - checking monitored items (${index + 1}/${artists.length})`,
        });

        const queued = await CurationService.queueMonitoredItems(String(artist.id));
        totalAlbums += queued.albums;
        totalTracks += queued.tracks;
        totalVideos += queued.videos;
    }

    const total = totalAlbums + totalTracks + totalVideos;
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Queued ${total} download(s) (${totalAlbums} albums, ${totalTracks} tracks, ${totalVideos} videos)`,
    });
};

export const handleCheckUpgrades: CommandHandler<"CheckUpgrades"> = async (job, ctx) => {
    const result = await UpgraderService.checkUpgrades(true);
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Queued ${result.details.length} upgrade candidate(s)`,
    });
};

export const handleCurateArtist: CommandHandler<"CurateArtist"> = async (job) => {
    await CurationService.processAll(
        job.payload.artistId,
        {
            skipDownloadQueue: true,
            forceDownloadQueue: false,
        }
    );
};
