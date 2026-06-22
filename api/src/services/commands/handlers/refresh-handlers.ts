import { RefreshArtistService } from "../../music/refresh-artist-service.js";
import { RefreshAlbumService } from "../../music/refresh-album-service.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { shouldRefreshArtist } from "../../config/refresh-policy.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import type { CommandHandler } from "./handler-context.js";

export const handleRefreshArtist: CommandHandler<"RefreshArtist"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
        progress: 5,
        description: ctx.formatArtistPhaseDescription(job, "preparing artist refresh"),
    });
    if (job.payload.scanDepth === "basic") {
        // Credit-only collaborator intake: canonical metadata
        // without provider catalog/video/slot hydration.
        await RefreshArtistService.scanBasic(job.payload.artistId, {
            monitorArtist: job.payload.monitorArtist ?? job.payload.monitor ?? false,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
            forceUpdate: job.payload.forceUpdate ?? false,
        });
        ctx.updateJobDescription(job, {
            progress: 100,
            description: ctx.formatArtistPhaseDescription(job, "metadata refreshed"),
        });
        return;
    }
    await RefreshArtistService.scanDeep(job.payload.artistId, {
        monitorArtist: job.payload.monitorArtist ?? job.payload.monitor ?? false,
        monitorAlbums: job.payload.monitorAlbums,
        hydrateCatalog: job.payload.hydrateCatalog,
        hydrateAlbumTracks: job.payload.hydrateAlbumTracks,
        includeSimilarArtists: job.payload.includeSimilarArtists ?? true,
        seedSimilarArtists: job.payload.seedSimilarArtists ?? false,
        forceUpdate: job.payload.forceUpdate ?? false,
        expandCreditedArtists: job.payload.expandCreditedArtists ?? true,
        progress: (event) => {
            if (event.kind === "status") {
                ctx.updateJobDescription(job, {
                    progress: 10,
                    description: ctx.formatArtistPhaseDescription(job, "refreshing metadata"),
                });
                return;
            }

            if (event.kind === "albums_total") {
                ctx.updateJobDescription(job, {
                    progress: event.total > 0 ? 15 : 75,
                    description: event.total > 0
                        ? ctx.formatArtistPhaseDescription(job, `indexing releases (0/${event.total})`)
                        : ctx.formatArtistPhaseDescription(job, "no releases found"),
                });
                return;
            }

            if (event.kind === "album") {
                const total = Math.max(event.total, 1);
                const progress = Math.min(45, 15 + Math.round((event.index / total) * 30));
                ctx.updateJobDescription(job, {
                    progress,
                    description: ctx.formatArtistPhaseDescription(job, `indexing releases (${event.index}/${event.total})`),
                });
            }

            if (event.kind === "album_tracks") {
                const total = Math.max(event.total, 1);
                const progress = Math.min(85, 45 + Math.round((event.index / total) * 40));
                ctx.updateJobDescription(job, {
                    progress,
                    description: ctx.formatArtistPhaseDescription(job, `scanning tracks (${event.index}/${event.total}: ${event.title})`),
                });
            }
        },
    });
    ctx.updateJobDescription(job, {
        progress: 90,
        description: ctx.formatArtistPhaseDescription(job, "finalizing version groups"),
    });

    // Emit event so decoupled listeners (like curation.listener) can chain the redundancy check
    appEvents.emit(AppEvent.ARTIST_SCANNED, {
        artistId: job.payload.artistId,
        artistName: job.payload.artistName,
        workflow: job.payload.workflow,
        scanLibrary: job.payload.scanLibrary ?? false,
        forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
        trigger: job.trigger ?? CommandTrigger.Unspecified,
    });
};

export const handleRefreshAlbum: CommandHandler<"RefreshAlbum"> = async (job) => {
    // RefreshAlbum means: ensure album SHALLOW metadata (tracks + review + similar)
    await RefreshAlbumService.scanShallow(job.payload.albumId, {
        forceUpdate: Boolean(job.payload?.forceUpdate),
        includeSimilarAlbums: false,
        seedSimilarAlbums: false,
    });
};

export const handleRefreshMetadata: CommandHandler<"RefreshMetadata"> = async (job, ctx) => {
    const baseLabel = "Managed artists";
    ctx.updateJobDescription(job, {
        progress: 5,
        description: `${baseLabel} - preparing metadata refresh`,
    });

    // Resolve target artists (monitoring cycle uses dueOnly with staleness skip)
    const selectedArtistIds = Array.isArray(job.payload.artistIds)
        ? job.payload.artistIds.map((id: any) => String(id))
        : undefined;
    const allArtists = getManagedArtists({ orderByLastScanned: true, artistIds: selectedArtistIds });

    let refreshed = 0;
    let skipped = 0;

    for (let i = 0; i < allArtists.length; i++) {
        const artist = allArtists[i];
        const artistId = String(artist.id);
        const artistName = String((artist as any).name || '').trim();

        // Staleness skip: check if artist needs refresh
        if (!selectedArtistIds && !shouldRefreshArtist({
            artistId,
            lastScanned: (artist as any).last_scanned,
        })) {
            skipped++;
            continue;
        }

        const progress = Math.min(90, 10 + Math.round(((i + 1) / allArtists.length) * 80));
        ctx.updateJobDescription(job, {
            progress,
            description: `${baseLabel} - refreshing ${artistName || 'artist'} (${i + 1}/${allArtists.length}, ${refreshed} refreshed, ${skipped} skipped)`,
        });

        try {
            await RefreshArtistService.scanDeep(artistId, {
                monitorArtist: Boolean((artist as any).monitor),
                hydrateCatalog: true,
                hydrateAlbumTracks: false,
                includeSimilarArtists: false,
                seedSimilarArtists: false,
            });
            refreshed++;

            const monitoringCycle = Boolean(job.payload.monitoringCycle);

            // Emit event so per-artist pipeline can chain (curation listener handles this)
            appEvents.emit(AppEvent.ARTIST_SCANNED, {
                artistId,
                artistName,
                workflow: monitoringCycle ? 'monitoring-intake' : 'metadata-refresh',
                monitoringCycle: job.payload.monitoringCycle,
                scanLibrary: monitoringCycle,
                forceDownloadQueue: false,
                trigger: job.trigger ?? CommandTrigger.Unspecified,
            });
        } catch (error: any) {
            console.error(`[CommandExecutor] RefreshMetadata: failed to refresh ${artistName} (${artistId}):`, error?.message);
        }

        // Yield between artists so API requests/SSE aren't starved
        // during a long monitoring-cycle batch.
        await ctx.yieldToEventLoop();
    }

    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Refreshed ${refreshed} artist(s), skipped ${skipped} (${allArtists.length} total)`,
    });
};
