import { RefreshArtistService } from "../../music/refresh-artist-service.js";
import { RefreshAlbumService } from "../../music/refresh-album-service.js";
import { MediaSeedService } from "../../music/media-seed-service.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { db } from "../../../database.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import { buildMatchArtistProvidersCommand, queueArtistWorkflow } from "../../music/artist-workflow.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import { CommandNames } from "../command-names.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import type { CommandHandler } from "./handler-context.js";

export const handleRefreshArtist: CommandHandler<"RefreshArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: ctx.formatArtistPhaseDescription(job, "preparing artist refresh"),
    });
    // Metadata intake only — provider matching is deferred to a standalone
    // MatchArtistProviders command enqueued below (RefreshArtist →
    // MatchArtistProviders → RescanFolders → CurateArtist). refreshArtist returns
    // the context that command needs to stay faithful to the old inline path.
    const { artistMbid, shouldHydrateCatalog, metadataChanged, isNewArtist } = await RefreshArtistService.refreshArtist(job.payload.artistId, {
        monitorArtist: job.payload.monitorArtist ?? job.payload.monitor ?? false,
        monitorAlbums: job.payload.monitorAlbums,
        hydrateCatalog: job.payload.hydrateCatalog,
        hydrateAlbumTracks: job.payload.hydrateAlbumTracks,
        includeSimilarArtists: job.payload.includeSimilarArtists ?? true,
        seedSimilarArtists: job.payload.seedSimilarArtists ?? false,
        forceUpdate: job.payload.forceUpdate ?? false,
        deferProviderMatching: true,
        progress: (event) => {
            if (event.kind === "status") {
                ctx.updateCommandDescription(job, {
                    progress: 10,
                    description: ctx.formatArtistPhaseDescription(job, "refreshing metadata"),
                });
            }
        },
    });
    ArtistStatisticsService.refresh([job.payload.artistId]);
    ctx.updateCommandDescription(job, {
        progress: 90,
        description: ctx.formatArtistPhaseDescription(job, "metadata refreshed, matching providers"),
    });

    // Hand provider matching off to its own queued unit. That command emits
    // ARTIST_REFRESH_COMPLETE when matching finishes, so the existing
    // RescanFolders → CurateArtist chain still fires AFTER slots are selected.
    CommandQueueManager.push(
        CommandNames.MatchArtistProviders,
        buildMatchArtistProvidersCommand({
            artistId: job.payload.artistId,
            artistName: job.payload.artistName,
            artistMbid,
            shouldHydrateCatalog,
            metadataChanged,
            isNewArtist,
            workflow: job.payload.workflow,
            forceUpdate: job.payload.forceUpdate ?? false,
            monitoringCycle: job.payload.monitoringCycle,
        }),
        job.payload.artistId,
        0,
        job.trigger ?? CommandTrigger.Unspecified,
    );
};

export const handleMatchArtistProviders: CommandHandler<"MatchArtistProviders"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: ctx.formatArtistPhaseDescription(job, "matching provider availability"),
    });

    await RefreshArtistService.matchArtistProviders(
        job.payload.artistId,
        job.payload.artistMbid ?? null,
        {
            forceUpdate: job.payload.forceUpdate ?? false,
            progress: (event) => {
                if (event.kind === "albums_total") {
                    ctx.updateCommandDescription(job, {
                        progress: event.total > 0 ? 15 : 85,
                        description: event.total > 0
                            ? ctx.formatArtistPhaseDescription(job, `found ${event.total} provider releases`)
                            : ctx.formatArtistPhaseDescription(job, "no provider releases found"),
                    });
                    return;
                }

                // Tracklist fetching is the long network-bound phase; the service
                // emits an "album" event per fetched chunk so this fraction
                // actually moves (it used to sit at 0/N until the command ended).
                if (event.kind === "album") {
                    const total = Math.max(event.total, 1);
                    const progress = Math.min(75, 15 + Math.round((event.index / total) * 60));
                    ctx.updateCommandDescription(job, {
                        progress,
                        description: ctx.formatArtistPhaseDescription(job, `fetching tracklists (${event.index}/${event.total})`),
                    });
                    return;
                }

                if (event.kind === "album_tracks") {
                    const total = Math.max(event.total, 1);
                    const progress = Math.min(90, 75 + Math.round((event.index / total) * 15));
                    ctx.updateCommandDescription(job, {
                        progress,
                        description: ctx.formatArtistPhaseDescription(job, `scanning tracks (${event.index}/${event.total}: ${event.title})`),
                    });
                    return;
                }

                if (event.kind === "status") {
                    ctx.updateCommandDescription(job, {
                        progress: 85,
                        description: ctx.formatArtistPhaseDescription(job, event.message),
                    });
                }
            },
        },
        job.payload.shouldHydrateCatalog,
    );

    ArtistStatisticsService.refresh([job.payload.artistId]);
    ctx.updateCommandDescription(job, {
        progress: 95,
        description: ctx.formatArtistPhaseDescription(job, "provider matching complete"),
    });

    // Emit event so decoupled listeners (like curation.listener) can chain the
    // redundancy check / disk scan — AFTER provider slots are selected.
    appEvents.emit(AppEvent.ARTIST_REFRESH_COMPLETE, {
        artistId: job.payload.artistId,
        artistName: job.payload.artistName,
        workflow: job.payload.workflow,
        scanLibrary: job.payload.scanLibrary ?? false,
        metadataChanged: job.payload.metadataChanged ?? false,
        isNewArtist: job.payload.isNewArtist ?? false,
        forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
        monitoringCycle: job.payload.monitoringCycle,
        trigger: job.trigger ?? CommandTrigger.Unspecified,
    });
};

export const handleRefreshAlbum: CommandHandler<"RefreshAlbum"> = async (job) => {
    // RefreshAlbum means: ensure album metadata (offer, tracks, review).
    await RefreshAlbumService.refreshMetadata(job.payload.albumId, {
        forceUpdate: Boolean(job.payload?.forceUpdate),
        includeSimilarAlbums: false,
        seedSimilarAlbums: false,
    });
};

export const handleRefreshMetadata: CommandHandler<"RefreshMetadata"> = async (job, ctx) => {
    const baseLabel = "Managed artists";
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `${baseLabel} - preparing metadata refresh`,
    });

    // Resolve target artists. Staleness selection already happened upstream in
    // queueMetadataRefreshPass (dueOnly for the monitoring cycle, all managed
    // artists for a manual refresh), and the resulting ids arrive as artistIds —
    // so this handler force-queues exactly what it was handed, no second filter.
    const selectedArtistIds = Array.isArray(job.payload.artistIds)
        ? job.payload.artistIds.map((id: any) => String(id))
        : undefined;
    const allArtists = getManagedArtists({ orderByLastScanned: true, artistIds: selectedArtistIds });

    let queued = 0;
    let skipped = 0;

    for (let i = 0; i < allArtists.length; i++) {
        const artist = allArtists[i];
        const artistId = String(artist.id);
        const artistName = String((artist as any).name || '').trim();

        const progress = Math.min(90, 10 + Math.round(((i + 1) / allArtists.length) * 80));
        ctx.updateCommandDescription(job, {
            progress,
            description: `${baseLabel} - queueing ${artistName || 'artist'} (${i + 1}/${allArtists.length}, ${queued} queued, ${skipped} skipped)`,
        });

        try {
            const monitoringCycle = job.payload.monitoringCycle;
            const commandId = queueArtistWorkflow({
                artistId,
                artistName,
                workflow: monitoringCycle ? "monitoring-intake" : "metadata-refresh",
                monitoringCycle,
                priority: -1,
                trigger: job.trigger ?? CommandTrigger.Unspecified,
            });
            if (commandId !== -1) {
                queued++;
            } else {
                skipped++;
            }
        } catch (error: any) {
            console.error(`[CommandExecutor] RefreshMetadata: failed to queue ${artistName} (${artistId}):`, error?.message);
        }

        // Yield between artists so API requests/SSE aren't starved
        // during a long monitoring-cycle batch.
        await ctx.yieldToEventLoop();
    }

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Queued ${queued} artist refresh job(s), skipped ${skipped} (${allArtists.length} total)`,
    });
};

export const handleSeedVideo: CommandHandler<"SeedVideo"> = async (job, ctx) => {
    const providerId = job.payload.providerId;
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `Adding video ${providerId}`,
    });

    await MediaSeedService.seedVideo(providerId, {
        monitorArtist: job.payload.monitorArtist ?? true,
    });

    if (job.payload.monitorVideo !== false) {
        const providerItem = db.prepare(`
            SELECT recording_id AS recordingId
            FROM ProviderItems
            WHERE entity_type = 'video' AND provider_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(providerId) as { recordingId?: number | null } | undefined;

        if (providerItem?.recordingId) {
            db.prepare(`
                UPDATE Recordings
                SET monitored = CASE WHEN monitored_lock = 1 THEN monitored ELSE 1 END,
                    monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(providerItem.recordingId);
        }
    }

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Added video ${providerId}`,
    });
};
