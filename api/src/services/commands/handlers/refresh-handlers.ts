import { RefreshArtistService } from "../../music/refresh-artist-service.js";
import { RefreshAlbumService } from "../../music/refresh-album-service.js";
import { MediaSeedService } from "../../music/media-seed-service.js";
import { getManagedArtists, isArtistLibraryMonitored } from "../../music/managed-artists.js";
import { db } from "../../../database.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import {
    ARTIST_WORKFLOW_PRIORITY,
    buildMatchArtistProvidersCommand,
    nextArtistWorkflowPriority,
    queueArtistWorkflow,
} from "../../music/artist-workflow.js";
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
    // MatchArtistProviders command. The selected workflow decides whether that
    // is followed by a disk scan and curation; Refresh & Scan deliberately ends
    // after its disk scan. refreshArtist returns the context the match command
    // needs to stay faithful to the old inline path.
    const {
        artistMbid,
        shouldHydrateCatalog,
        metadataChanged,
        isNewArtist,
        creditedArtistMbids,
    } = await RefreshArtistService.refreshArtist(job.payload.artistId, {
        monitorArtist: job.payload.monitorArtist ?? false,
        monitorAlbums: job.payload.monitorAlbums,
        hydrateCatalog: job.payload.hydrateCatalog,
        hydrateAlbumTracks: job.payload.hydrateAlbumTracks,
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

    if (job.worker_id && !CommandQueueManager.isExecutionOwner(job.id, job.worker_id)) {
        return;
    }

    // Lidarr: ArtistMetadata holds every credited name; Artists holds who you
    // follow. Discogenius matches that with ArtistMetadata vs LibraryArtists.
    // Collaborators still get a full MusicBrainz discography so Search and
    // unmonitored artist cards can discover them — but that work stays inside
    // this command (Lidarr's RefreshArtist loops artists in one job). One
    // RefreshArtist + MatchArtistProviders row per collaborator is what
    // produced 5,300 queue items and wedged SQLite. They are not LibraryArtists,
    // so they are not matched for download until the user adds them.
    if (
        isArtistLibraryMonitored(job.payload.artistId)
        && creditedArtistMbids.length > 0
    ) {
        const uniqueMbids = Array.from(new Set(creditedArtistMbids));
        const marks = uniqueMbids.map(() => "?").join(", ");
        const untouched = db.prepare(`
            SELECT mbid, name
            FROM ArtistMetadata
            WHERE mbid IN (${marks})
              AND content_hash IS NULL
            ORDER BY name COLLATE NOCASE, mbid
        `).all(...uniqueMbids) as Array<{ mbid: string; name: string }>;
        for (let index = 0; index < untouched.length; index += 1) {
            const credited = untouched[index];
            ctx.updateCommandDescription(job, {
                progress: 50 + Math.floor(((index + 1) / Math.max(untouched.length, 1)) * 35),
                description: ctx.formatArtistPhaseDescription(
                    job,
                    `cataloguing collaborator ${index + 1}/${untouched.length}: ${credited.name}`,
                ),
            });
            await RefreshArtistService.refreshArtist(credited.mbid, {
                monitorArtist: false,
                hydrateCatalog: true,
                hydrateAlbumTracks: true,
                deferProviderMatching: true,
                forceUpdate: false,
            });
            await ctx.yieldToEventLoop();
        }
    }

    if (!isArtistLibraryMonitored(job.payload.artistId)) {
        RefreshArtistService.markArtistRefreshComplete(job.payload.artistId);
        return;
    }

    // Hand provider matching off to its own queued unit. That command emits
    // ARTIST_REFRESH_COMPLETE when matching finishes, so any workflow-specific
    // disk scan and curation run only after provider slots are selected.
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
        nextArtistWorkflowPriority(job.priority),
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

    // A deferred refresh is not complete until provider matching succeeds.
    // Fresh artists that only rebuild selections (`shouldHydrateCatalog=false`)
    // already carry a valid watermark and must not be artificially re-stamped.
    if (job.payload.shouldHydrateCatalog) {
        RefreshArtistService.markArtistRefreshComplete(job.payload.artistId);
    }

    ArtistStatisticsService.refresh([job.payload.artistId]);
    ctx.updateCommandDescription(job, {
        progress: 95,
        description: ctx.formatArtistPhaseDescription(job, "provider matching complete"),
    });

    // A watchdog may have reclaimed this attempt while the handler was
    // finishing an external call. Do not let the stale attempt fan out the
    // next artist stages.
    if (job.worker_id && !CommandQueueManager.isExecutionOwner(job.id, job.worker_id)) {
        return;
    }

    // Emit event so decoupled listeners (like curation.listener) can chain the
    // redundancy check / disk scan — AFTER provider slots are selected.
    appEvents.emit(AppEvent.ARTIST_REFRESH_COMPLETE, {
        commandId: job.id,
        workerId: job.worker_id ?? undefined,
        artistId: job.payload.artistId,
        artistName: job.payload.artistName,
        workflow: job.payload.workflow,
        scanLibrary: job.payload.scanLibrary ?? false,
        metadataChanged: job.payload.metadataChanged ?? false,
        isNewArtist: job.payload.isNewArtist ?? false,
        monitoringCycle: job.payload.monitoringCycle,
        trigger: job.trigger ?? CommandTrigger.Unspecified,
        priority: job.priority ?? 0,
    });
};

export const handleRefreshAlbum: CommandHandler<"RefreshAlbum"> = async (job) => {
    // RefreshAlbum means: ensure album metadata (offer, tracks, review).
    await RefreshAlbumService.refreshMetadata(job.payload.albumId, {
        forceUpdate: Boolean(job.payload?.forceUpdate),
        provider: job.payload.provider,
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
        if (job.worker_id && !CommandQueueManager.isExecutionOwner(job.id, job.worker_id)) {
            return;
        }
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
                priority: ARTIST_WORKFLOW_PRIORITY.MONITORED_BATCH_BASE,
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
        provider: job.payload.provider,
    });

    if (job.payload.monitorVideo !== false) {
        const providerItem = db.prepare(`
            SELECT MIN(video_match.recording_id) AS recordingId
            FROM ProviderItems item
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = item.id
             AND video_match.match_state = 'accepted'
            WHERE item.entity_type = 'video'
              AND item.provider_id = ?
              AND (? IS NULL OR item.provider = ?)
            HAVING COUNT(DISTINCT video_match.recording_id) = 1
        `).get(
            providerId,
            job.payload.provider || null,
            job.payload.provider || null,
        ) as { recordingId?: number | null } | undefined;

        if (providerItem?.recordingId) {
            // Seeding a video selects it into every Video Library. A
            // selection the user already made by hand is left alone.
            db.prepare(`
                INSERT INTO LibraryVideos (
                                    library_id, video_recording_id, selection_mode,
                                    placement_mode, reason, selected_at, updated_at
                                )
                                SELECT library.id, ?, 'auto', 'separated',
                                       'seed_video', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                                FROM Libraries library
                                JOIN quality_profiles library_quality_profile
                                  ON library_quality_profile.id = library.quality_profile_id
                                WHERE library.enabled = 1
                                  AND EXISTS (
                                    SELECT 1
                                    FROM json_each(COALESCE(library_quality_profile.allowed_source_formats, '[]')) allowed_format
                                    WHERE allowed_format.value = 'video'
                                  )
                                ON CONFLICT(library_id, video_recording_id) DO NOTHING
            `).run(providerItem.recordingId);
        }
    }

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Added video ${providerId}`,
    });
};
