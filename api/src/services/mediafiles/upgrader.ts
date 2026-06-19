import { db } from "../../database.js";
import { Config } from "../config/config.js";
import { JobTypes, TaskQueueService } from "../jobs/queue.js";
import { updateAlbumDownloadStatus } from "../download/download-state.js";
import { downloadProcessor } from "../download/download-processor.js";
import { normalizeAudioQualityTag } from "../config/quality.js";
import { UpgradableSpecification } from "../config/upgradable-specification.js";
import { readIntEnv } from "../../utils/env.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";

export type UpgradeResult = {
    tracks: number;
    videos: number;
    albums: number;
    details: { mediaId: string; type: string; reason: string }[];
};

type UpgradeCandidateRow = {
    file_id: number;
    provider: string | null;
    provider_entity_type: "track" | "video";
    media_id: string | null;
    media_type: string;
    album_id: string | null;
    legacy_media_id: string | null;
    legacy_album_id: string | null;
    source_quality: string | null;
    current_quality: string | null;
    current_codec: string | null;
    current_extension: string | null;
    current_bit_depth: number | null;
    current_bitrate: number | null;
    current_sample_rate: number | null;
    album_quality: string | null;
    upgrade_status: string | null;
    upgrade_target: string | null;
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
        const qualityProfile = UpgradableSpecification.buildEffectiveProfile(
            force ? { ...qualityConfig, upgrade_existing_files: true } : qualityConfig
        );

        // Apply quality settings to actual downloaded library files. Resolve the
        // provider resource to re-download from TrackFiles canonical identity +
        // ProviderItems; ProviderMedia/ProviderAlbums are compatibility shadows.
        const query = db.prepare(`
        SELECT
            lf.id AS file_id,
            COALESCE(media_item.provider, lf.provider, 'tidal') AS provider,
            CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END AS provider_entity_type,
            COALESCE(
                media_item.provider_id,
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN lf.provider_id END,
                lf.media_id
            ) AS media_id,
            CASE WHEN lf.file_type = 'video' THEN 'Music Video' ELSE 'track' END AS media_type,
            COALESCE(
                CASE WHEN lf.provider_entity_type = 'album' THEN lf.provider_id END,
                json_extract(media_item.match_evidence, '$.albumProviderId'),
                json_extract(media_item.data, '$.albumProviderId'),
                album_item.provider_id,
                lf.album_id
            ) AS album_id,
            lf.media_id AS legacy_media_id,
            lf.album_id AS legacy_album_id,
            COALESCE(
                media_item.quality,
                json_extract(media_item.data, '$.quality'),
                json_extract(media_item.data, '$.audioQuality')
            ) AS source_quality,
            lf.quality      AS current_quality,
            lf.codec        AS current_codec,
            lf.extension    AS current_extension,
            lf.bit_depth    AS current_bit_depth,
            lf.bitrate      AS current_bitrate,
            lf.sample_rate  AS current_sample_rate,
            COALESCE(
                album_item.quality,
                json_extract(album_item.data, '$.quality'),
                json_extract(album_item.data, '$.audioQuality')
            ) AS album_quality,
            uq.status       AS upgrade_status,
            uq.target_quality AS upgrade_target
        FROM TrackFiles lf
        LEFT JOIN ProviderItems media_item
          ON media_item.entity_type = CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END
         AND (lf.provider IS NULL OR media_item.provider = lf.provider)
         AND (
                (lf.provider_entity_type IN ('track', 'video') AND CAST(media_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT))
                OR (lf.media_id IS NOT NULL AND CAST(media_item.provider_id AS TEXT) = CAST(lf.media_id AS TEXT))
                OR (lf.track_id IS NOT NULL AND media_item.track_id = lf.track_id)
                OR (lf.recording_id IS NOT NULL AND media_item.recording_id = lf.recording_id)
                OR (lf.canonical_track_mbid IS NOT NULL AND media_item.track_mbid = lf.canonical_track_mbid)
                OR (lf.canonical_recording_mbid IS NOT NULL AND media_item.recording_mbid = lf.canonical_recording_mbid)
             )
        LEFT JOIN ProviderItems album_item
          ON album_item.entity_type = 'album'
         AND (COALESCE(lf.provider, media_item.provider) IS NULL OR album_item.provider = COALESCE(lf.provider, media_item.provider))
         AND (
                (lf.provider_entity_type = 'album' AND CAST(album_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT))
                OR (lf.album_id IS NOT NULL AND CAST(album_item.provider_id AS TEXT) = CAST(lf.album_id AS TEXT))
                OR (json_extract(media_item.match_evidence, '$.albumProviderId') IS NOT NULL
                    AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.match_evidence, '$.albumProviderId') AS TEXT))
                OR (json_extract(media_item.data, '$.albumProviderId') IS NOT NULL
                    AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.data, '$.albumProviderId') AS TEXT))
                OR (lf.canonical_release_group_mbid IS NOT NULL AND album_item.release_group_mbid = lf.canonical_release_group_mbid)
                OR (lf.canonical_release_mbid IS NOT NULL AND album_item.release_mbid = lf.canonical_release_mbid)
             )
        LEFT JOIN upgrade_queue uq
          ON (
               uq.provider = COALESCE(media_item.provider, lf.provider, 'tidal')
               AND uq.entity_type = CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END
               AND CAST(uq.provider_id AS TEXT) = CAST(COALESCE(
                    media_item.provider_id,
                    CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN lf.provider_id END,
                    lf.media_id
               ) AS TEXT)
             )
          OR (lf.media_id IS NOT NULL AND CAST(uq.media_id AS TEXT) = CAST(lf.media_id AS TEXT))
        WHERE (lf.file_type = 'track' OR lf.file_type = 'video')
          AND COALESCE(
                media_item.provider_id,
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN lf.provider_id END,
                lf.media_id
              ) IS NOT NULL
          ${artistId ? "AND lf.artist_id = ?" : ""}
        ORDER BY
          lf.id ASC,
          CASE
            WHEN lf.provider_entity_type IN ('track', 'video')
             AND CAST(media_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT) THEN 0
            WHEN lf.media_id IS NOT NULL
             AND CAST(media_item.provider_id AS TEXT) = CAST(lf.media_id AS TEXT) THEN 1
            ELSE 2
          END,
          CASE
            WHEN lf.provider_entity_type = 'album'
             AND CAST(album_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT) THEN 0
            WHEN json_extract(media_item.match_evidence, '$.albumProviderId') IS NOT NULL
             AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.match_evidence, '$.albumProviderId') AS TEXT) THEN 1
            WHEN json_extract(media_item.data, '$.albumProviderId') IS NOT NULL
             AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.data, '$.albumProviderId') AS TEXT) THEN 2
            WHEN lf.canonical_release_mbid IS NOT NULL
             AND album_item.release_mbid = lf.canonical_release_mbid THEN 3
            WHEN lf.canonical_release_group_mbid IS NOT NULL
             AND album_item.release_group_mbid = lf.canonical_release_group_mbid THEN 4
            WHEN lf.album_id IS NOT NULL
             AND CAST(album_item.provider_id AS TEXT) = CAST(lf.album_id AS TEXT) THEN 5
            ELSE 6
          END,
          CASE album_item.library_slot WHEN COALESCE(lf.library_slot, 'stereo') THEN 0 ELSE 1 END,
          media_item.updated_at DESC,
          album_item.updated_at DESC,
          media_item.provider_id ASC,
          album_item.provider_id ASC
    `);

        const rawRows = (artistId ? query.all(artistId) : query.all()) as UpgradeCandidateRow[];
        const rows: UpgradeCandidateRow[] = [];
        const seenFileIds = new Set<number>();
        for (const row of rawRows) {
            if (seenFileIds.has(row.file_id)) continue;
            seenFileIds.add(row.file_id);
            rows.push(row);
        }

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
            } else if (isSpatialAudioQuality(normalizedCurrentQuality)) {
                // Spatial files are managed by curation (include_spatial toggle), not the upgrader.
                // When spatial audio is disabled, curation unmonitors the items and
                // remove_unmonitored_files handles file deletion.
                continue;
            } else {
                evaluation = UpgradableSpecification.evaluateAudioChange({
                    profile: qualityProfile,
                    currentQuality: row.current_quality,
                    sourceQuality: row.source_quality || row.album_quality,
                    codec: row.current_codec,
                    extension: row.current_extension,
                    bitDepth: row.current_bit_depth,
                    sampleRate: row.current_sample_rate,
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

                if (row.media_id) {
                    const provider = row.provider || "tidal";
                    const legacyMediaId = row.legacy_media_id || null;
                    const legacyAlbumId = row.legacy_album_id || null;
                    const albumProviderId = row.album_id || null;
                    const currentQuality = normalizedCurrentQuality || row.current_quality || 'UNKNOWN';
                    const updateResult = db.prepare(`
                    UPDATE upgrade_queue
                    SET
                        status = 'pending',
                        target_quality = ?,
                        reason = ?,
                        current_quality = ?,
                        provider = ?,
                        entity_type = ?,
                        provider_id = ?,
                        album_provider_id = COALESCE(?, album_provider_id),
                        track_file_id = COALESCE(?, track_file_id),
                        media_id = COALESCE(?, media_id),
                        album_id = COALESCE(?, album_id)
                    WHERE (
                        provider = ?
                        AND entity_type = ?
                        AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                    )
                    OR (? IS NOT NULL AND CAST(media_id AS TEXT) = CAST(? AS TEXT))
                    `).run(
                        expectedTarget,
                        evaluation.reason,
                        currentQuality,
                        provider,
                        row.provider_entity_type,
                        row.media_id,
                        albumProviderId,
                        row.file_id,
                        legacyMediaId,
                        legacyAlbumId,
                        provider,
                        row.provider_entity_type,
                        row.media_id,
                        legacyMediaId,
                        legacyMediaId
                    );

                    if (updateResult.changes === 0) {
                        db.prepare(`
                        INSERT INTO upgrade_queue (
                            media_id, album_id, provider, entity_type, provider_id,
                            album_provider_id, track_file_id, current_quality,
                            target_quality, reason, status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                        ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                            status = 'pending',
                            target_quality = excluded.target_quality,
                            reason = excluded.reason,
                            current_quality = excluded.current_quality,
                            album_provider_id = COALESCE(excluded.album_provider_id, upgrade_queue.album_provider_id),
                            track_file_id = COALESCE(excluded.track_file_id, upgrade_queue.track_file_id),
                            media_id = COALESCE(excluded.media_id, upgrade_queue.media_id),
                            album_id = COALESCE(excluded.album_id, upgrade_queue.album_id)
                    `).run(
                            legacyMediaId,
                            legacyAlbumId,
                            provider,
                            row.provider_entity_type,
                            row.media_id,
                            albumProviderId,
                            row.file_id,
                            currentQuality,
                            expectedTarget,
                            evaluation.reason
                        );
                    }
                }

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
            const totalAlbumTracks = (db.prepare(`
                SELECT COUNT(*) as cnt FROM ProviderItems
                WHERE provider = 'tidal'
                  AND entity_type = 'track'
                  AND json_extract(data, '$.albumProviderId') = ?
            `).get(albumId) as any)?.cnt || 0;

            if (albumTracksToUpgrade.length >= 3 || albumTracksToUpgrade.length >= totalAlbumTracks * 0.5) {
                console.log(`[UPGRADER] Queuing album ${albumId} for upgrade (${albumTracksToUpgrade.length}/${totalAlbumTracks} tracks need upgrade)`);

                updateAlbumDownloadStatus(albumId);

                TaskQueueService.addJob(
                    JobTypes.DownloadAlbum,
                    { providerId: albumId, reason: 'upgrade' },
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
                { providerId: d.mediaId, reason: 'upgrade' },
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
