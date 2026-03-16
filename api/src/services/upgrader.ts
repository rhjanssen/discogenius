import { db } from "../database.js";
import { Config } from "./config.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { updateAlbumDownloadStatus } from "./download-state.js";
import { downloadProcessor } from "./download-processor.js";
import { normalizeAudioQualityTag } from "./quality.js";
import { UpgradableSpecification } from "./upgradable-specification.js";
import { readIntEnv } from "../utils/env.js";

export type UpgradeResult = {
    tracks: number;
    videos: number;
    albums: number;
    details: { mediaId: string; type: string; reason: string }[];
};

export class UpgraderService {
    private static readonly UPGRADE_YIELD_EVERY = readIntEnv("DISCOGENIUS_UPGRADER_YIELD_EVERY", 100, 10);

    private static async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private static async maybeYield(counter: number): Promise<void> {
        if (counter > 0 && counter % this.UPGRADE_YIELD_EVERY === 0) {
            await this.yieldToEventLoop();
        }
    }

    /**
     * Scans the library for files that don't meet the current quality settings
     * and queues them for re-download.
     *
     * @param force  Skip the `upgrade_existing_files` config check (used by manual trigger)
     * @param artistId Optional artist ID to restrict the scan
     */
    static async checkUpgrades(force = false, artistId?: string): Promise<UpgradeResult> {
        console.log(`🔍 [UPGRADER] Checking library for quality upgrades${artistId ? ` (Artist: ${artistId})` : ''}...`);

        const qualityConfig = Config.getQualityConfig();
        if (!force && !qualityConfig.upgrade_existing_files) {
            console.log("⏭️ [UPGRADER] Upgrade existing files is disabled in settings. Skipping.");
            return { tracks: 0, videos: 0, albums: 0, details: [] };
        }
        const qualityProfile = UpgradableSpecification.buildEffectiveProfile(qualityConfig);

        // Apply quality settings to actual downloaded library media.
        // Several UI download actions queue items directly, so relying on `monitor = 1`
        // misses legitimate library content such as videos added from search/download buttons.
        const query = db.prepare(`
        SELECT
            m.id            as media_id,
            m.type          as media_type,
            m.album_id      as album_id,
            m.quality       as source_quality,
            lf.quality      as current_quality,
            lf.codec        as current_codec,
            lf.extension    as current_extension,
            lf.bit_depth    as current_bit_depth,
            lf.bitrate      as current_bitrate,
            a.quality       as album_quality,
            uq.status       as upgrade_status,
            uq.target_quality as upgrade_target
        FROM media m
        JOIN library_files lf ON lf.media_id = m.id
        LEFT JOIN albums a ON a.id = m.album_id
        LEFT JOIN upgrade_queue uq ON uq.media_id = m.id
                WHERE (lf.file_type = 'track' OR lf.file_type = 'video')
          ${artistId ? "AND m.artist_id = ?" : ""}
    `);

        const rows = (artistId ? query.all(artistId) : query.all()) as any[];

        const result: UpgradeResult = { tracks: 0, videos: 0, albums: 0, details: [] };
        const albumsNeedingUpgrade = new Set<string>();

        let rowsLoopCounter = 0;
        for (const row of rows) {
            rowsLoopCounter++;
            await this.maybeYield(rowsLoopCounter);

            const normalizedCurrentQuality = normalizeAudioQualityTag(row.current_quality);
            let evaluation;

            if (row.media_type === 'Music Video') {
                evaluation = UpgradableSpecification.evaluateVideoChange({
                    profile: qualityProfile,
                    currentQuality: row.current_quality,
                    extension: row.current_extension,
                });
            } else if (normalizedCurrentQuality === "DOLBY_ATMOS") {
                // Atmos files are managed by curation (include_atmos toggle), not the upgrader.
                // When Atmos is disabled, curation unmonitors the items and
                // remove_unmonitored_files handles file deletion.
                continue;
            } else {
                evaluation = UpgradableSpecification.evaluateAudioChange({
                    profile: qualityProfile,
                    currentQuality: row.current_quality,
                    sourceQuality: row.source_quality || row.album_quality,
                    codec: row.current_codec,
                    extension: row.current_extension,
                });
            }

            if (evaluation.needsChange) {
                const expectedTarget = evaluation.targetQuality
                    || (row.media_type === 'Music Video' ? qualityProfile.videoCutoff : qualityProfile.audioCutoff);
                // If this specific upgrade path was previously marked 'skipped' (e.g. Tidal doesn't offer it), do not queue it again
                // If there's an active upgrade or skipped record targeting this OR HIGHER, skip
                if (row.upgrade_status === 'skipped' && row.upgrade_target === expectedTarget) {
                    // We know Tidal doesn't have it. Skip to prevent infinite loops.
                    continue;
                }

                result.details.push({ mediaId: String(row.media_id), type: row.media_type, reason: evaluation.reason });

                // Register intent in the upgrade queue table
                db.prepare(`
                INSERT INTO upgrade_queue (media_id, album_id, current_quality, target_quality, reason, status)
                VALUES (?, ?, ?, ?, ?, 'pending')
                ON CONFLICT DO UPDATE SET 
                    status = 'pending',
                    target_quality = excluded.target_quality,
                    reason = excluded.reason,
                    current_quality = excluded.current_quality
            `).run(
                    row.media_id,
                    row.album_id || null,
                    normalizedCurrentQuality || row.current_quality || 'UNKNOWN',
                    expectedTarget,
                    evaluation.reason
                );

                if (row.media_type === 'Music Video') {
                    result.videos++;
                } else {
                    result.tracks++;
                    if (row.album_id) {
                        albumsNeedingUpgrade.add(String(row.album_id));
                    }
                }
            }
        }

        // Queue upgrades at album level where possible — more efficient than per-track downloads
        const trackMediaIdsQueuedViaAlbum = new Set<string>();
        let albumsLoopCounter = 0;
        let albumTrackTransferLoopCounter = 0;
        for (const albumId of albumsNeedingUpgrade) {
            albumsLoopCounter++;
            await this.maybeYield(albumsLoopCounter);

            const albumTracksToUpgrade = result.details.filter(
                d => d.type !== 'Music Video' && rows.some(r => String(r.media_id) === d.mediaId && String(r.album_id) === albumId)
            );

            // Only queue as album if a significant portion needs upgrading (≥50% or ≥3 tracks)
            const totalAlbumTracks = (db.prepare(
                `SELECT COUNT(*) as cnt FROM media WHERE album_id = ? AND type != 'Music Video'`
            ).get(albumId) as any)?.cnt || 0;

            if (albumTracksToUpgrade.length >= 3 || albumTracksToUpgrade.length >= totalAlbumTracks * 0.5) {
                console.log(`[UPGRADER] Queuing album ${albumId} for upgrade (${albumTracksToUpgrade.length}/${totalAlbumTracks} tracks need upgrade)`);

                updateAlbumDownloadStatus(albumId);

                TaskQueueService.addJob(
                    JobTypes.DownloadAlbum,
                    { tidalId: albumId, reason: 'upgrade' },
                    albumId,
                    -5
                );
                result.albums++;

                for (const d of albumTracksToUpgrade) {
                    albumTrackTransferLoopCounter++;
                    await this.maybeYield(albumTrackTransferLoopCounter);
                    trackMediaIdsQueuedViaAlbum.add(d.mediaId);
                }
            }
        }

        // Queue remaining individual track upgrades (not covered by album downloads)
        let detailsLoopCounter = 0;
        for (const d of result.details) {
            detailsLoopCounter++;
            await this.maybeYield(detailsLoopCounter);

            if (trackMediaIdsQueuedViaAlbum.has(d.mediaId)) continue;

            const jobType = d.type === 'Music Video' ? JobTypes.DownloadVideo : JobTypes.DownloadTrack;
            console.log(`[UPGRADER] Queuing ${jobType} upgrade for ${d.mediaId}: ${d.reason}`);

            TaskQueueService.addJob(
                jobType,
                { tidalId: d.mediaId, reason: 'upgrade' },
                d.mediaId,
                -5
            );
        }

        console.log(`✅ [UPGRADER] Queued upgrades: ${result.albums} albums, ${result.tracks} tracks, ${result.videos} videos (${result.details.length} total items).`);

        // Kick the download processor
        downloadProcessor.processQueue().catch(err => {
            console.error('[UPGRADER] Error triggering download processor:', err);
        });

        return result;
    }
}
