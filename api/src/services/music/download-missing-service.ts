import { db } from "../../database.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { getConfigSection, type FilteringConfig } from "../config/config.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { getEnabledDownloadLibrarySlots } from "../download/download-library-slots.js";
import { queueAcquisitionPlan } from "./acquisition-plan-executor.js";
import { compareVideoOffersByQualityThenProvider } from "./video-offer-resolver.js";
import { resolveVideoTypeSuffix } from "../mediafiles/video-naming.js";
import {
  canVideoPlaceInline,
  requiresAlbumLinkedVideosOnly,
} from "../mediafiles/video-folder-layout.js";
import { isVideoVariantDownloadAllowed } from "./video-type-filter.js";

export class DownloadMissingService {
    static async queueMonitoredItems(
        artistId?: string,
        options: { limit?: number } = {},
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ' app-wide'}...`);

        const filteringConfig = getConfigSection("filtering");
        const enabledLibrarySlots = getEnabledDownloadLibrarySlots();
        const allowVideos = enabledLibrarySlots.video;
        // Optional limit remains for tests / callers that want a soft cap; the
        // DownloadMissing command itself queues without chunking (worker
        // concurrency is the active-slot limit, like qBittorrent).
        const maxToQueue = Number.isInteger(options.limit) && Number(options.limit) > 0
            ? Number(options.limit)
            : Number.POSITIVE_INFINITY;
        const queuedTotal = () => albumJobs + trackJobs + videoJobs;
        const hasBatchCapacity = () => queuedTotal() < maxToQueue;

        const hasBufferedJob = (types: string[], refId: string) => {
            const placeholders = types.map(() => '?').join(', ');
            const existing = db.prepare(`
                SELECT id FROM commands
                WHERE name IN (${placeholders}) AND ref_id = ? AND status IN ('queued', 'started', 'failed')
            `).get(...types, refId);
            return Boolean(existing);
        };

        let albumJobs = 0;
        const trackJobs = 0;
        let videoJobs = 0;

        const normalizedPlanIds = (db.prepare(`
            SELECT plan.id
            FROM AcquisitionPlans plan
            JOIN LibraryReleases library_release
              ON library_release.id = plan.library_release_id
            JOIN Libraries library ON library.id = library_release.library_id
            JOIN AlbumReleases release ON release.id = library_release.release_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            JOIN LibraryReleaseGroups library_release_group
              ON library_release_group.library_id = library_release.library_id
             AND library_release_group.release_group_id = release.release_group_id
             AND library_release_group.monitored = 1
            LEFT JOIN ArtistMetadata primary_artist
              ON primary_artist.id = release_group.artist_metadata_id
            WHERE plan.state = 'current'
              AND library.enabled = 1
              AND (
                ? IS NULL
                OR primary_artist.mbid = COALESCE(
                  (SELECT mbid FROM Artists WHERE id = ? LIMIT 1),
                  ?
                )
              )
              AND EXISTS (
                SELECT 1
                FROM AcquisitionPlanTracks plan_track
                JOIN Tracks plan_track_catalog ON plan_track_catalog.id = plan_track.track_id
                WHERE plan_track.plan_id = plan.id
                  AND NOT EXISTS (
                    SELECT 1
                    FROM TrackFiles file
                    WHERE file.library_id = library_release.library_id
                      AND file.album_release_id = library_release.release_id
                      AND file.track_id = plan_track.track_id
                      AND file.recording_id = plan_track_catalog.recording_id
                      AND file.file_class = 'audio'
                  )
              )
            ORDER BY release_group.first_release_date DESC, release_group.title, library.id
            ${Number.isFinite(maxToQueue) ? "LIMIT ?" : ""}
        `).all(
            artistId ?? null,
            artistId ?? null,
            artistId ?? null,
            ...(Number.isFinite(maxToQueue) ? [Math.max(Number(maxToQueue) * 5, Number(maxToQueue) + 100)] : []),
        ) as Array<{ id: number }>).map(({ id }) => id);
        for (const planId of normalizedPlanIds) {
            const queued = queueAcquisitionPlan(db, planId, {
                canQueue: hasBatchCapacity,
                onQueued: () => { albumJobs += 1; },
            });
            if (!queued.queued && !hasBatchCapacity()) break;
        }

        if (allowVideos) {
            const pathConfig = getConfigSection("path");
            const inlineOnlyVideos = requiresAlbumLinkedVideosOnly(pathConfig?.video_folder_layout);
            const hasImportedVideoFile = (
                recordingIdColumn: string,
                recordingMbidColumn: string,
                providerColumn: string,
                providerIdColumn: string,
            ) => `
                EXISTS (
                    SELECT 1
                    FROM TrackFiles lf
                    WHERE lf.file_type = 'video'
                      AND (
                        lf.recording_id = ${recordingIdColumn}
                        OR (lf.canonical_recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = ${recordingMbidColumn})
                        OR (
                            lf.provider_entity_type = 'video'
                            AND lf.provider = ${providerColumn}
                            AND CAST(lf.provider_id AS TEXT) = CAST(${providerIdColumn} AS TEXT)
                        )
                      )
                )
            `;

            let videosQuery = `
                SELECT
                    CAST(r.id AS TEXT) as recording_id,
                    r.mbid as recording_mbid,
                    r.title as video_title,
                    r.video_variant as video_variant,
                    r.artist_mbid as artist_mbid,
                    r.cover_image_url as cover_image_url,
                    artist.name as artist_name,
                    pi.provider,
                    pi.provider_id,
                    pi.quality as quality
                FROM Recordings r
                LEFT JOIN ArtistMetadata artist ON artist.mbid = r.artist_mbid
                LEFT JOIN Artists managed_artist ON managed_artist.mbid = r.artist_mbid
                JOIN ProviderItems pi
                  ON pi.entity_type = 'video'
                 AND (
                    pi.recording_id = r.id
                    OR (r.mbid IS NOT NULL AND pi.recording_mbid = r.mbid)
                 )
                WHERE r.is_video = 1
                  AND r.monitored = 1
                  AND pi.provider_id IS NOT NULL
                  AND NOT ${hasImportedVideoFile('r.id', 'r.mbid', 'pi.provider', 'pi.provider_id')}
            `;
            const videoParams: any[] = [];
            if (artistId) {
                videosQuery += " AND managed_artist.id = ?";
                videoParams.push(artistId);
            } else {
                videosQuery += " AND managed_artist.monitored = 1";
            }
            videosQuery += `
                ORDER BY
                  r.title ASC,
                  COALESCE(pi.match_confidence, 0) DESC,
                  CASE COALESCE(pi.match_status, '') WHEN 'verified' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
                  pi.updated_at DESC
                ${Number.isFinite(maxToQueue) ? "LIMIT ?" : ""}
            `;
            if (Number.isFinite(maxToQueue)) {
                videoParams.push(Math.max(Number(maxToQueue) * 5, Number(maxToQueue) + 100));
            }

            const videos = db.prepare(videosQuery).all(...videoParams) as any[];

            // Within one video recording, keep the best provider offer. Then collapse
            // further to one job per related audio track + Plex type suffix so inline
            // layout never queues TIDAL + Apple copies of the same official MV.
            // Distinct lyric/live variants keep different suffixes and stay separate.
            const sortOffers = (
                left: { video: any; index: number },
                right: { video: any; index: number },
            ) =>
                compareVideoOffersByQualityThenProvider(
                    {
                        provider: String(left.video.provider || ""),
                        quality: left.video.quality,
                        provider_id: String(left.video.provider_id || ""),
                    },
                    {
                        provider: String(right.video.provider || ""),
                        quality: right.video.quality,
                        provider_id: String(right.video.provider_id || ""),
                    },
                )
                || left.index - right.index;

            const offersByRecording = new Map<string, Array<{ video: any; index: number }>>();
            videos.forEach((video, index) => {
                const recordingId = String(video.recording_id || "");
                if (!recordingId) return;
                const offers = offersByRecording.get(recordingId) ?? [];
                offers.push({ video, index });
                offersByRecording.set(recordingId, offers);
            });
            const preferredPerRecording = Array.from(offersByRecording.values()).map((offers) => {
                offers.sort(sortOffers);
                return { video: offers[0].video, index: offers[0].index };
            });

            const relatedAudioStmt = db.prepare(`
                SELECT CAST(target_recording_id AS TEXT) AS audio_recording_id
                FROM RecordingRelations
                WHERE CAST(source_recording_id AS TEXT) = ?
                  AND relation_type = 'provider_video_for'
                ORDER BY COALESCE(confidence, 0) DESC, id ASC
                LIMIT 1
            `);
            const importedVideosForAudioStmt = db.prepare(`
                SELECT
                    COALESCE(r.title, '') AS video_title,
                    r.video_variant AS video_variant
                FROM TrackFiles lf
                LEFT JOIN ProviderItems pi
                  ON pi.entity_type = 'video'
                 AND pi.provider = lf.provider
                 AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
                LEFT JOIN Recordings r
                  ON r.id = COALESCE(lf.recording_id, pi.recording_id)
                JOIN RecordingRelations rr
                  ON CAST(rr.source_recording_id AS TEXT) = CAST(COALESCE(lf.recording_id, pi.recording_id) AS TEXT)
                 AND rr.relation_type = 'provider_video_for'
                WHERE lf.file_type = 'video'
                  AND CAST(rr.target_recording_id AS TEXT) = ?
            `);
            const offersByInlineSlot = new Map<string, Array<{ video: any; index: number }>>();
            for (const entry of preferredPerRecording) {
                const recordingId = String(entry.video.recording_id || "");
                const related = relatedAudioStmt.get(recordingId) as { audio_recording_id?: string } | undefined;
                const plexType = resolveVideoTypeSuffix(entry.video.video_title, entry.video.video_variant);
                const slotKey = related?.audio_recording_id
                    ? `audio:${related.audio_recording_id}:${plexType}`
                    : `video:${recordingId}:${plexType}`;
                const bucket = offersByInlineSlot.get(slotKey) ?? [];
                bucket.push(entry);
                offersByInlineSlot.set(slotKey, bucket);
            }
            const preferredVideos = Array.from(offersByInlineSlot.values()).flatMap((offers) => {
                offers.sort(sortOffers);
                const winner = offers[0].video;
                const recordingId = String(winner.recording_id || "");
                const related = relatedAudioStmt.get(recordingId) as { audio_recording_id?: string } | undefined;
                if (related?.audio_recording_id) {
                    const plexType = resolveVideoTypeSuffix(winner.video_title, winner.video_variant);
                    const imported = importedVideosForAudioStmt.all(related.audio_recording_id) as Array<{
                        video_title?: string;
                        video_variant?: string | null;
                    }>;
                    // Slot already filled by another recording (e.g. TIDAL official
                    // MV imported while Apple's sibling still looks "missing").
                    // Upgrades are handled by CheckUpgrades, not download-missing.
                    if (imported.some((row) =>
                        resolveVideoTypeSuffix(row.video_title, row.video_variant) === plexType
                    )) {
                        return [];
                    }
                }
                return [winner];
            });

            for (const video of preferredVideos) {
                if (!hasBatchCapacity()) {
                    break;
                }
                // Type filters skip unchecked variants (lyric/live/OMV). Existing
                // imported files are never deleted by this path.
                if (!isVideoVariantDownloadAllowed(video.video_variant, filteringConfig as FilteringConfig)) {
                    continue;
                }
                // inline_only: skip orphans that would only land in the separated
                // video library (no provider_video_for + monitored stereo RG).
                if (inlineOnlyVideos && !canVideoPlaceInline(video.recording_id)) {
                    continue;
                }
                const recordingId = String(video.recording_id || "");
                const providerId = String(video.provider_id || "");
                const queueRefId = recordingId ? `recording:${recordingId}:video` : `provider:${providerId}:video`;
                if (!recordingId || !providerId) continue;
                if (hasBufferedJob([CommandNames.DownloadVideo, CommandNames.ImportDownload], queueRefId)) {
                    continue;
                }

                const artistName = video.artist_name || 'Unknown';
                const title = video.video_title || 'Unknown Video';
                const provider = video.provider || "tidal";

                CommandQueueManager.push(CommandNames.DownloadVideo, {
                    url: buildStreamingMediaUrl("video", providerId, provider as any),
                    type: 'video',
                    provider,
                    providerId,
                    canonicalRecordingId: recordingId,
                    canonicalRecordingMbid: video.recording_mbid || null,
                    title,
                    artist: artistName,
                    cover: video.cover_image_url || null,
                    quality: video.video_quality || null,
                    artists: [artistName],
                    description: `${title} by ${artistName}`,
                }, queueRefId);
                videoJobs++;
            }
        }

        console.log(`[Queue] Ensured queue has ${albumJobs} albums, ${trackJobs} tracks, ${videoJobs} videos.`);
        return { albums: albumJobs, tracks: trackJobs, videos: videoJobs };
    }
}


