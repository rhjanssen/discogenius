import { db } from "../../database.js";
import { Config } from "../config/config.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
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
    source_quality: string | null;
    current_quality: string | null;
    current_codec: string | null;
    current_extension: string | null;
    current_bit_depth: number | null;
    current_bitrate: number | null;
    current_sample_rate: number | null;
    album_quality: string | null;
};

const UPGRADE_HISTORY_COOLDOWN_HOURS = 24;

function hasRecentNoImprovementUpgradeAttempt(row: UpgradeCandidateRow): boolean {
    if (!row.media_id) return false;

    const mediaType = row.provider_entity_type;
    const downloadCommand = mediaType === "video" ? CommandNames.DownloadVideo : CommandNames.DownloadTrack;
    const params: Array<string | number | null> = [
        `-${UPGRADE_HISTORY_COOLDOWN_HOURS} hours`,
        downloadCommand,
        row.media_id,
        CommandNames.ImportDownload,
        row.media_id,
        mediaType,
    ];

    let albumClause = "";
    if (row.album_id) {
        albumClause = `
            OR (
                name = ?
                AND ref_id = ?
                AND json_extract(payload, '$.reason') = 'upgrade'
            )
            OR (
                name = ?
                AND ref_id = ?
                AND json_extract(payload, '$.type') = 'album'
            )
        `;
        params.push(
            CommandNames.DownloadAlbum,
            row.album_id,
            CommandNames.ImportDownload,
            row.album_id,
        );
    }

    const recent = db.prepare(`
        SELECT id
        FROM commands
        WHERE status = 'completed'
          AND COALESCE(completed_at, updated_at, created_at) >= datetime('now', ?)
          AND (
            (
                name = ?
                AND ref_id = ?
                AND json_extract(payload, '$.reason') = 'upgrade'
            )
            OR (
                name = ?
                AND ref_id = ?
                AND json_extract(payload, '$.type') = ?
            )
            ${albumClause}
          )
        ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
        LIMIT 1
    `).get(...params) as { id: number } | undefined;

    return recent != null;
}

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
        // provider resource to re-download from TrackFiles provider identity and
        // canonical ProviderItems.
        const query = db.prepare(`
        SELECT
            lf.id AS file_id,
            COALESCE(media_item.provider, lf.provider, 'tidal') AS provider,
            CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END AS provider_entity_type,
            COALESCE(
                media_item.provider_id,
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN lf.provider_id END
            ) AS media_id,
            CASE WHEN lf.file_type = 'video' THEN 'Music Video' ELSE 'track' END AS media_type,
            COALESCE(
                CASE WHEN lf.provider_entity_type = 'album' THEN lf.provider_id END,
                json_extract(media_item.match_evidence, '$.albumProviderId'),
                json_extract(media_item.data, '$.albumProviderId'),
                album_item.provider_id
            ) AS album_id,
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
            ) AS album_quality
        FROM TrackFiles lf
        LEFT JOIN ProviderItems media_item
          ON media_item.entity_type = CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END
         AND (lf.provider IS NULL OR media_item.provider = lf.provider)
         AND (
                (lf.provider_entity_type IN ('track', 'video') AND CAST(media_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT))
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
                OR (json_extract(media_item.match_evidence, '$.albumProviderId') IS NOT NULL
                    AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.match_evidence, '$.albumProviderId') AS TEXT))
                OR (json_extract(media_item.data, '$.albumProviderId') IS NOT NULL
                    AND CAST(album_item.provider_id AS TEXT) = CAST(json_extract(media_item.data, '$.albumProviderId') AS TEXT))
                OR (lf.canonical_release_group_mbid IS NOT NULL AND album_item.release_group_mbid = lf.canonical_release_group_mbid)
                OR (lf.canonical_release_mbid IS NOT NULL AND album_item.release_mbid = lf.canonical_release_mbid)
             )
        WHERE (lf.file_type = 'track' OR lf.file_type = 'video')
          AND COALESCE(
                media_item.provider_id,
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN lf.provider_id END
              ) IS NOT NULL
          ${artistId ? "AND lf.artist_id = ?" : ""}
        ORDER BY
          lf.id ASC,
          CASE
            WHEN lf.provider_entity_type IN ('track', 'video')
             AND CAST(media_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT) THEN 0
            ELSE 1
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
            ELSE 5
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
                if (hasRecentNoImprovementUpgradeAttempt(row)) {
                    console.log(`[UPGRADER] Skipping ${row.provider_entity_type} ${row.media_id}: recent upgrade attempt did not satisfy cutoff (${expectedTarget}).`);
                    continue;
                }

                result.details.push({ mediaId: String(row.media_id), type: row.media_type, reason: evaluation.reason });

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

                CommandQueueManager.push(
                    CommandNames.DownloadAlbum,
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

            const jobType = d.type === 'Music Video' ? CommandNames.DownloadVideo : CommandNames.DownloadTrack;
            console.log(`[UPGRADER] Queuing ${jobType} upgrade for ${d.mediaId}: ${d.reason}`);

            CommandQueueManager.push(
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
