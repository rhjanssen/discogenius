import { db } from "../database.js";
import { Config, getConfigSection } from "./config.js";
import { LibraryFilesService } from "./library-files.js";
import { readIntEnv } from "../utils/env.js";
import { WantedQueueService } from "./wanted-queue-service.js";
import { buildCurationDecisions } from "./curation-decision-service.js";

interface Album {
    id: string;
    title: string;
    version?: string;
    type: string;
    quality: string;
    cover?: string | null;
    explicit: number;
    num_tracks: number;
    monitor: number;
    tracks?: Track[];
    tags?: string[]; // Populated from albums.quality column
    monitor_lock?: number;
    redundant?: string;
    module?: string;
    group_type?: string;
    version_group_id?: number; // Provider-derived same-edition group, e.g. clean/explicit/quality variants
    mbid?: string | null;
    mb_release_group_id?: string | null;
    upc?: string | null;
    mb_primary?: string | null;
    mb_secondary?: string | null;
}

interface Track {
    id: string;
    isrc: string;
    title: string;
}

export class CurationService {
    private static readonly REDUNDANCY_YIELD_EVERY = readIntEnv("DISCOGENIUS_REDUNDANCY_YIELD_EVERY", 20, 10);

    private static async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private static async maybeYield(counter: number): Promise<void> {
        if (counter > 0 && counter % this.REDUNDANCY_YIELD_EVERY === 0) {
            await this.yieldToEventLoop();
        }
    }

    static async processRedundancy(artistId: string, libraryType: 'music' | 'atmos' | 'video' = 'music'): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        console.log(`⚖️ [Redundancy] Processing ${libraryType} curation for artist ${artistId}...`);

        try {
            const monitoringConfig = getConfigSection("monitoring");
            const curationConfig = getConfigSection("filtering");
            const qualityConfig = Config.getQualityConfig();

            // 1. Get ALL albums for artist (via album_artists, not albums.artist_id)
            const allArtistAlbums = db.prepare(`
                SELECT a.*, aa.group_type as group_type, aa.module as module, aa.version_group_id as version_group_id
                FROM albums a
                JOIN album_artists aa ON a.id = aa.album_id
                WHERE aa.artist_id = ?
            `).all(artistId) as Album[];

            if (allArtistAlbums.length === 0) {
                console.log(`   No albums found for artist ${artistId} (${libraryType}).`);
                return { newAlbums: 0, upgradedAlbums: 0 };
            }

            // 2. Fetch tracks for ALL albums (quality info is now in albums.quality)
            const albumIds = allArtistAlbums.map(a => a.id);
            const tracks = db.prepare(`
                SELECT id, album_id, isrc, title
                FROM media
                WHERE album_id IN (${albumIds.map(() => '?').join(',')})
                  AND type != 'Music Video'
            `).all(...albumIds) as (Track & { album_id: string })[];

            // Map tracks to albums
            const tracksByAlbum = new Map<string, Track[]>();
            let trackMappingCounter = 0;
            for (const track of tracks) {
                if (!tracksByAlbum.has(track.album_id)) {
                    tracksByAlbum.set(track.album_id, []);
                }
                tracksByAlbum.get(track.album_id)!.push(track);
                trackMappingCounter++;
                await this.maybeYield(trackMappingCounter);
            }

            for (const album of allArtistAlbums) {
                album.tracks = tracksByAlbum.get(album.id) || [];
                // Quality tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS) is now in album.quality
                album.tags = album.quality ? [album.quality.toUpperCase()] : [];
            }

            console.log(`   Analyzing ${allArtistAlbums.length} albums with ${tracks.length} tracks...`);

            const decisionResult = await buildCurationDecisions({
                albums: allArtistAlbums,
                libraryType,
                curationConfig,
                qualityConfig,
                yieldEvery: CurationService.REDUNDANCY_YIELD_EVERY,
            });

            const qualifiedAlbums = decisionResult.qualifiedAlbums as Album[];

            if (libraryType === "atmos") {
                console.log(`   ${qualifiedAlbums.length} albums with DOLBY_ATMOS quality`);
            } else if (libraryType === "music") {
                console.log(`   ${qualifiedAlbums.length} albums with stereo quality (LOSSLESS/HIRES_LOSSLESS)`);
            }

            console.log(`   After category filters: ${decisionResult.includedAlbums.length} included, ${qualifiedAlbums.length - decisionResult.includedAlbums.length} excluded`);

            if (curationConfig?.enable_redundancy_filter !== false) {
                console.log(`   Grouped into ${decisionResult.editionGroupCount} edition groups`);
                console.log(`   ${decisionResult.afterEditionCount} releases after edition grouping`);
            } else {
                console.log(`   Redundancy disabled: keeping all versions/editions (no edition curation)`);
            }

            console.log(`   After ISRC dedup: ${decisionResult.afterTrackSetDedupCount} releases (from ${decisionResult.afterEditionCount}) [quality/explicit dedup applied]`);
            if (decisionResult.subsetFilteringApplied) {
                console.log(`   Curating subsets (unified)...`);
            } else {
                console.log(`   Redundancy disabled: skipping subset curation`);
            }

            // Count by type for logging
            const albumCount = decisionResult.finalSelection.filter(a => (a.type || '').toUpperCase() === 'ALBUM').length;
            const epCount = decisionResult.finalSelection.filter(a => (a.type || '').toUpperCase() === 'EP').length;
            const singleCount = decisionResult.finalSelection.filter(a => (a.type || '').toUpperCase() === 'SINGLE').length;
            const otherCount = decisionResult.finalSelection.length - albumCount - epCount - singleCount;
            console.log(`   Final selection: ${albumCount} albums, ${epCount} EPs, ${singleCount} singles, ${otherCount} other`);

            // --- Apply Updates only to albums that qualify for this library type ---
            const updates: any[] = [];
            let newAlbums = 0;
            const upgradedAlbums = 0;
            let albumUpdatePrepCounter = 0;

            // CRITICAL: Only process albums that qualify for this library type
            // This prevents the atmos pass from overwriting stereo albums (and vice versa)
            for (const album of qualifiedAlbums) {
                albumUpdatePrepCounter++;
                await this.maybeYield(albumUpdatePrepCounter);

                const decision = decisionResult.decisionsByAlbumId.get(String(album.id));
                if (!decision) continue;

                // Lock mechanism: Respect manual lock
                if (album.monitor_lock === 1) {
                    // If locked, do not change monitoring status!
                    // Effectively we skip adding it to updates list to preserve current state.
                    // OR we force it to its current monitored state?
                    // Better to skipping update entirely.
                    continue;
                }

                const nextMonitor = decision.monitor ? 1 : 0;
                const nextRedundant = decision.redundant ?? null;
                const currentRedundant = album.redundant ?? null;
                if (Number(album.monitor || 0) === nextMonitor && currentRedundant === nextRedundant) {
                    continue;
                }

                // Prepare update
                updates.push({
                    id: album.id,
                    monitor: nextMonitor,
                    redundant: nextRedundant,
                });

                if (decision.monitor && !album.monitor) newAlbums++;
            }

            // Batch Update DB
            // Re-check monitor_lock at write time to avoid races with lock toggles while yielded processing is in flight.
            const updateStmt = db.prepare(`
                UPDATE albums SET 
                    monitor = ?, 
                    redundant = ?
                WHERE id = ?
                  AND (monitor_lock = 0 OR monitor_lock IS NULL)
            `);

            if (updates.length > 0) {
                db.transaction(() => {
                    for (const update of updates) {
                        updateStmt.run(
                            update.monitor,
                            update.redundant,
                            update.id
                        );
                    }
                })();
            }

            console.log(`   Updated ${updates.length} albums.`);

            // --- Video Logic ---
            // Videos are controlled by the filtering config's include_videos setting
            const shouldMonitorVideos = curationConfig.include_videos !== false;
            const videos = db.prepare("SELECT * FROM media WHERE artist_id = ? AND type = 'Music Video'").all(artistId) as any[];

            const videoUpdates: any[] = [];
            let videoUpdatePrepCounter = 0;
            for (const video of videos) {
                videoUpdatePrepCounter++;
                await this.maybeYield(videoUpdatePrepCounter);

                // Only update if not locked
                const v: any = video;
                if (v.monitor_lock === 1) continue;
                const nextMonitor = shouldMonitorVideos ? 1 : 0;
                if (Number(v.monitor || 0) === nextMonitor) continue;

                videoUpdates.push({ id: video.id, monitor: nextMonitor });
            }

            // Re-check monitor_lock at write time to avoid races with lock toggles while yielded processing is in flight.
            const vidUpdateStmt = db.prepare("UPDATE media SET monitor = ? WHERE id = ? AND type = 'Music Video' AND (monitor_lock = 0 OR monitor_lock IS NULL)");
            if (videoUpdates.length > 0) {
                db.transaction(() => {
                    for (const update of videoUpdates) {
                        vidUpdateStmt.run(update.monitor, update.id);
                    }
                })();
            }
            console.log(`   Updated ${videoUpdates.length} videos.`);

            console.log(`✅ [Redundancy] Artist ${artistId} filtering complete.`);
            return { newAlbums, upgradedAlbums };
        } finally {
            // Processing complete
        }
    }

    static async queueMonitoredItems(
        artistId?: string
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ''}...`);

        const result = WantedQueueService.queueWantedItems({ artistId });
        console.log(`[Queue] Ensured queue has ${result.albums} albums, ${result.tracks} tracks, ${result.videos} videos.`);
        return result;
    }

    /**
     * Process redundancy for all library types based on config
     * When include_atmos is enabled, also processes Atmos albums as a separate pass
     * 
     * @param artistId - Artist ID to process
     * @param options.skipDownloadQueue - If true, apply curation only and do not queue downloads
     */
    static async processAll(
        artistId: string,
        options: { skipDownloadQueue?: boolean; forceDownloadQueue?: boolean } = {}
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        const curationConfig = getConfigSection("filtering");
        const monitoringConfig = getConfigSection("monitoring");

        // Always process music first
        const musicResult = await this.processRedundancy(artistId, 'music');
        let totalNew = musicResult.newAlbums;
        let totalUpgraded = musicResult.upgradedAlbums;

        // If Atmos is enabled, also process Atmos albums
        if (curationConfig.include_atmos === true) {
            console.log(`🎧 [Redundancy] Also processing Dolby Atmos for artist ${artistId}...`);
            const atmosResult = await this.processRedundancy(artistId, 'atmos');
            totalNew += atmosResult.newAlbums;
            totalUpgraded += atmosResult.upgradedAlbums;
        } else {
            // CRITICAL: If Atmos is disabled, ensure we UNMONITOR any Atmos albums that might have been monitored previously
            // Otherwise, turning off the toggle doesn't stop monitoring existing items.
            // Use album_artists join (not albums.artist_id) to match the same set of albums that curation processes.
            db.prepare(`
                UPDATE albums 
                SET monitor = 0, redundant = 'filtered'
                WHERE id IN (
                    SELECT a.id FROM albums a
                    JOIN album_artists aa ON a.id = aa.album_id
                    WHERE aa.artist_id = ? AND UPPER(a.quality) = 'DOLBY_ATMOS' AND a.monitor = 1 AND a.monitor_lock = 0
                )
            `).run(artistId);

            // Also update tracks on those Atmos albums
            db.prepare(`
                UPDATE media
                SET monitor = 0
                WHERE album_id IN (
                    SELECT a.id FROM albums a
                    JOIN album_artists aa ON a.id = aa.album_id
                    WHERE aa.artist_id = ? AND UPPER(a.quality) = 'DOLBY_ATMOS'
                ) AND type != 'Music Video' AND monitor = 1 AND monitor_lock = 0
            `).run(artistId);
        }

        // Cascade to tracks after all processing
        await this.cascadeToTracks(artistId);

        if (monitoringConfig.remove_unmonitored_files === true) {
            const cleanup = LibraryFilesService.pruneUnmonitoredFiles(artistId);
            if (cleanup.deleted > 0 || cleanup.missing > 0 || cleanup.errors > 0) {
                console.log(`[LibraryFiles] Cleanup for artist ${artistId}: ${cleanup.deleted} deleted, ${cleanup.missing} missing, ${cleanup.errors} errors.`);
            }
        }

        // Always prune metadata files whose type was disabled in config
        // (independent of remove_unmonitored_files — this is about settings, not monitoring)
        const metaCleanup = LibraryFilesService.pruneDisabledMetadataFiles(artistId);
        if (metaCleanup.deleted > 0 || metaCleanup.missing > 0 || metaCleanup.errors > 0) {
            console.log(`[LibraryFiles] Disabled metadata cleanup for artist ${artistId}: ${metaCleanup.deleted} deleted, ${metaCleanup.missing} missing, ${metaCleanup.errors} errors.`);
        }

        // Intentionally avoid a full empty-directory sweep per artist here.
        // Prune methods already perform targeted parent cleanup, and repeated full-tree scans
        // can block API responsiveness when curation backlogs process many artists.

        if (options.skipDownloadQueue !== undefined || options.forceDownloadQueue !== undefined) {
            console.log(
                `[Queue] Ignoring legacy curation auto-queue flags for artist ${artistId}; ` +
                `DownloadMissing remains the dedicated queueing path.`
            );
        }

        return { newAlbums: totalNew, upgradedAlbums: totalUpgraded };
    }

    /**
     * Ensure all tracks inherit monitor status from their parent album
     * This is called after album monitoring is applied to sync tracks
     */
    static async cascadeToTracks(artistId: string): Promise<void> {
        console.log(`[Redundancy] Cascading monitor status to tracks for artist ${artistId}...`);

        const result = db.prepare(`
            UPDATE media
            SET monitor = (
                SELECT a.monitor
                FROM albums a
                WHERE a.id = media.album_id
            )
            WHERE type != 'Music Video'
              AND album_id IN (
                SELECT aa.album_id
                FROM album_artists aa
                WHERE aa.artist_id = ?
              )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
              AND monitor != (
                SELECT a.monitor
                FROM albums a
                WHERE a.id = media.album_id
              )
        `).run(artistId);

        const updatedTracks = (result as any).changes || 0;

        if (updatedTracks > 0) {
            console.log(`[Redundancy] Updated ${updatedTracks} tracks to match album monitor status`);
        }
    }
}
