import { db } from "../../database.js";
import { Config } from "../config/config.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { updateAlbumDownloadStatus } from "../download/download-state.js";
import { downloadProcessor } from "../download/download-processor.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { normalizeAudioQualityTag } from "../config/quality.js";
import { UpgradableSpecification } from "../config/upgradable-specification.js";
import { readIntEnv } from "../../utils/env.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { providerResolvedAlbumIdSql } from "../providers/provider-item-artist-scope.js";

export type UpgradeDetail = {
    mediaId: string;
    type: string;
    reason: string;
    provider: string;
    albumId: string | null;
};

export type UpgradeResult = {
    tracks: number;
    videos: number;
    albums: number;
    details: UpgradeDetail[];
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

type AlbumUpgradeTarget = {
    provider: string;
    albumId: string;
};

const UPGRADE_HISTORY_COOLDOWN_HOURS = 24;

function normalizeProviderId(value: string | null | undefined): string | null {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized || null;
}

function albumUpgradeKey(provider: string, albumId: string): string {
    return `${provider}\0${albumId}`;
}

/**
 * How many track resources this provider's release actually carries. Counted
 * through ProviderEditionMembers — the release's own tracklist occurrences —
 * and scoped by the full provider identity, because a release id is unique only
 * within a provider.
 *
 * The count is what stops a foreign album id with zero tracks from enqueueing a
 * whole-album re-download, so an unresolvable release must count as zero.
 */
function countProviderAlbumTracks(provider: string, albumId: string): number {
    const row = db.prepare(`
        SELECT COUNT(DISTINCT member.member_item_id) AS cnt
        FROM ProviderItems release_item
        JOIN ProviderEditionMembers member
          ON member.provider_edition_item_id = release_item.id
        JOIN ProviderItems member_item
          ON member_item.id = member.member_item_id
         AND member_item.entity_type = 'track'
        WHERE release_item.provider = ?
          AND release_item.entity_type = 'release'
          AND CAST(release_item.provider_id AS TEXT) = CAST(? AS TEXT)
    `).get(provider, albumId) as { cnt: number } | undefined;
    return Number(row?.cnt) || 0;
}

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
        // canonical ProviderItems. Never default a missing provider to TIDAL —
        // foreign album/track IDs must stay on their owning backend.
        // One row per file. The provider resource is resolved by internal identity
        // first (TrackFiles.provider_item_id), then by the full provider triple
        // snapshot, then through the typed match edge for the file's canonical
        // track/recording — never by a bare provider_id, and never by MBID shadow
        // columns on ProviderItems, which no longer exist.
        //
        // Source quality is the provider's SOURCE CAPABILITY: the best available
        // ProviderItemAudioVariants row for audio, video_quality for video. It is
        // deliberately not the file's imported quality — that is lf.quality below,
        // and comparing the two is the whole point of the upgrade check.
        const query = db.prepare(`
        SELECT
            lf.id AS file_id,
            COALESCE(media_item.provider, lf.provider) AS provider,
            CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END AS provider_entity_type,
            COALESCE(
                CAST(media_item.provider_id AS TEXT),
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN CAST(lf.provider_id AS TEXT) END
            ) AS media_id,
            CASE WHEN lf.file_type = 'video' THEN 'Music Video' ELSE 'track' END AS media_type,
            COALESCE(
                CASE WHEN lf.provider_entity_type = 'release' THEN CAST(lf.provider_id AS TEXT) END,
                ${providerResolvedAlbumIdSql({ itemAlias: "media_item", libraryIdExpr: "lf.library_id" })}
            ) AS album_id,
            CASE
                WHEN lf.file_type = 'video' THEN media_item.video_quality
                ELSE (
                    SELECT variant.provider_quality_label
                    FROM ProviderItemAudioVariants variant
                    WHERE variant.provider_item_id = media_item.id
                      AND variant.availability NOT IN ('unavailable', 'restricted')
                      AND variant.provider_quality_label IS NOT NULL
                    ORDER BY
                      CASE variant.quality_class
                        WHEN 'spatial' THEN 0
                        WHEN 'hires-lossless' THEN 1
                        WHEN 'lossless' THEN 2
                        ELSE 3
                      END,
                      COALESCE(variant.bit_depth, 0) DESC,
                      COALESCE(variant.sample_rate, 0) DESC,
                      variant.id DESC
                    LIMIT 1
                )
            END AS source_quality,
            lf.quality      AS current_quality,
            lf.codec        AS current_codec,
            lf.extension    AS current_extension,
            lf.bit_depth    AS current_bit_depth,
            lf.bitrate      AS current_bitrate,
            lf.sample_rate  AS current_sample_rate,
            -- Album-level source capability, kept as the fallback it always was:
            -- the best available variant across the resolved provider release's
            -- member tracks. Correlates on the release item resolved below.
            (
                SELECT variant.provider_quality_label
                FROM ProviderEditionMembers album_member
                JOIN ProviderItemAudioVariants variant
                  ON variant.provider_item_id = album_member.member_item_id
                WHERE album_member.provider_edition_item_id = album_item.id
                  AND variant.availability NOT IN ('unavailable', 'restricted')
                  AND variant.provider_quality_label IS NOT NULL
                ORDER BY
                  CASE variant.quality_class
                    WHEN 'spatial' THEN 0
                    WHEN 'hires-lossless' THEN 1
                    WHEN 'lossless' THEN 2
                    ELSE 3
                  END,
                  COALESCE(variant.bit_depth, 0) DESC,
                  COALESCE(variant.sample_rate, 0) DESC,
                  variant.id DESC
                LIMIT 1
            ) AS album_quality
        FROM TrackFiles lf
        LEFT JOIN ProviderItems media_item
          ON media_item.id = COALESCE(
                lf.provider_item_id,
                (
                  SELECT snapshot.id
                  FROM ProviderItems snapshot
                  WHERE snapshot.entity_type = CASE WHEN lf.file_type = 'video' THEN 'video' ELSE 'track' END
                    AND lf.provider IS NOT NULL
                    AND snapshot.provider = lf.provider
                    AND lf.provider_entity_type IN ('track', 'video')
                    AND CAST(snapshot.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
                  LIMIT 1
                ),
                (
                  -- Typed edge for the file's canonical track. Scoped to the file's
                  -- provider when it has one; a match that hits more than one
                  -- provider resource resolves to nothing rather than guessing.
                  SELECT CASE WHEN COUNT(DISTINCT matched.id) = 1 THEN MAX(matched.id) END
                  FROM ProviderTrackMatches typed_match
                  JOIN ProviderEditionMembers typed_member
                    ON typed_member.id = typed_match.provider_edition_member_id
                  JOIN ProviderItems matched
                    ON matched.id = typed_member.member_item_id
                   AND matched.entity_type = 'track'
                  WHERE lf.file_type <> 'video'
                    AND typed_match.match_state = 'accepted'
                    AND (
                      (lf.track_id IS NOT NULL AND typed_match.track_id = lf.track_id)
                      OR (lf.recording_id IS NOT NULL AND typed_match.recording_id = lf.recording_id)
                    )
                    AND (lf.provider IS NULL OR matched.provider = lf.provider)
                ),
                (
                  -- Same, for a video file: ProviderVideoMatches is the only
                  -- video -> recording link.
                  SELECT CASE WHEN COUNT(DISTINCT matched.id) = 1 THEN MAX(matched.id) END
                  FROM ProviderVideoMatches typed_match
                  JOIN ProviderItems matched
                    ON matched.id = typed_match.provider_video_item_id
                   AND matched.entity_type = 'video'
                  WHERE lf.file_type = 'video'
                    AND typed_match.match_state = 'accepted'
                    AND lf.recording_id IS NOT NULL
                    AND typed_match.recording_id = lf.recording_id
                    AND (lf.provider IS NULL OR matched.provider = lf.provider)
                )
             )
        -- The provider release the album context resolved to, looked up by the full
        -- identity so a colliding id from another provider cannot supply its quality.
        LEFT JOIN ProviderItems album_item
          ON album_item.entity_type = 'release'
         AND album_item.provider = COALESCE(media_item.provider, lf.provider)
         AND CAST(album_item.provider_id AS TEXT) = CAST(
               COALESCE(
                 CASE WHEN lf.provider_entity_type = 'release' THEN CAST(lf.provider_id AS TEXT) END,
                 ${providerResolvedAlbumIdSql({ itemAlias: "media_item", libraryIdExpr: "lf.library_id" })}
               ) AS TEXT)
        WHERE (lf.file_type = 'track' OR lf.file_type = 'video')
          AND COALESCE(
                CAST(media_item.provider_id AS TEXT),
                CASE WHEN lf.provider_entity_type IN ('track', 'video') THEN CAST(lf.provider_id AS TEXT) END
              ) IS NOT NULL
          ${artistId ? "AND lf.artist_id = ?" : ""}
        ORDER BY lf.id ASC
    `);

        const rows = (artistId ? query.all(artistId) : query.all()) as UpgradeCandidateRow[];

        const result: UpgradeResult = { tracks: 0, videos: 0, albums: 0, details: [] };
        const albumsNeedingUpgrade = new Map<string, AlbumUpgradeTarget>();

        let rowsLoopCounter = 0;
        for (const row of rows) {
            rowsLoopCounter++;
            await this.maybeYield(rowsLoopCounter);

            const provider = normalizeProviderId(row.provider);
            if (!provider || !row.media_id) {
                console.log(`[UPGRADER] Skipping ${row.provider_entity_type} ${row.media_id}: missing provider identity.`);
                continue;
            }

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

                const albumId = row.album_id ? String(row.album_id) : null;
                result.details.push({
                    mediaId: String(row.media_id),
                    type: row.media_type,
                    reason: evaluation.reason,
                    provider,
                    albumId,
                });

                if (row.media_type === 'Music Video') {
                    result.videos++;
                } else {
                    result.tracks++;
                    if (albumId) {
                        albumsNeedingUpgrade.set(albumUpgradeKey(provider, albumId), { provider, albumId });
                    }
                }
            }
        }

        // Queue upgrades at album level where possible — more efficient than per-track downloads
        const trackMediaIdsQueuedViaAlbum = new Set<string>();
        let albumsLoopCounter = 0;
        let albumTrackTransferLoopCounter = 0;
        for (const { provider, albumId } of albumsNeedingUpgrade.values()) {
            albumsLoopCounter++;
            await this.maybeYield(albumsLoopCounter);

            const albumTracksToUpgrade = result.details.filter(
                d => d.type !== 'Music Video'
                    && d.provider === provider
                    && d.albumId === albumId
            );

            // Count tracks for THIS provider only. Never assume TIDAL — a foreign
            // album id with zero TIDAL tracks used to still enqueue DownloadAlbum.
            const totalAlbumTracks = countProviderAlbumTracks(provider, albumId);
            if (totalAlbumTracks <= 0) {
                console.log(`[UPGRADER] Skipping album-level upgrade for ${provider} album ${albumId}: no provider tracks found.`);
                continue;
            }

            // Only queue as album if a significant portion needs upgrading (≥50% or ≥3 tracks)
            if (albumTracksToUpgrade.length >= 3 || albumTracksToUpgrade.length >= totalAlbumTracks * 0.5) {
                console.log(`[UPGRADER] Queuing ${provider} album ${albumId} for upgrade (${albumTracksToUpgrade.length}/${totalAlbumTracks} tracks need upgrade)`);

                updateAlbumDownloadStatus(albumId);

                CommandQueueManager.push(
                    CommandNames.DownloadAlbum,
                    {
                        providerId: albumId,
                        provider,
                        type: "album",
                        reason: "upgrade",
                        url: buildStreamingMediaUrl("album", albumId, provider),
                    },
                    albumId,
                    -5
                );
                result.albums++;

                for (const d of albumTracksToUpgrade) {
                    albumTrackTransferLoopCounter++;
                    await this.maybeYield(albumTrackTransferLoopCounter);
                    trackMediaIdsQueuedViaAlbum.add(`${d.provider}\0${d.mediaId}`);
                }
            }
        }

        // Queue remaining individual track/video upgrades (not covered by album downloads)
        let detailsLoopCounter = 0;
        for (const d of result.details) {
            detailsLoopCounter++;
            await this.maybeYield(detailsLoopCounter);

            if (trackMediaIdsQueuedViaAlbum.has(`${d.provider}\0${d.mediaId}`)) continue;

            const isVideo = d.type === 'Music Video';
            const jobType = isVideo ? CommandNames.DownloadVideo : CommandNames.DownloadTrack;
            const mediaType = isVideo ? "video" : "track";
            console.log(`[UPGRADER] Queuing ${jobType} upgrade for ${d.provider}:${d.mediaId}: ${d.reason}`);

            CommandQueueManager.push(
                jobType,
                {
                    providerId: d.mediaId,
                    provider: d.provider,
                    type: mediaType,
                    reason: "upgrade",
                    url: buildStreamingMediaUrl(mediaType, d.mediaId, d.provider),
                },
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
