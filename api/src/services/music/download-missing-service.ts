import { db } from "../../database.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { getConfigSection, type FilteringConfig } from "../config/config.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { isMusicBrainzReleaseGroupIncluded, parseMusicBrainzSecondaryTypes } from "../metadata/musicbrainz-release-group-filter.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { queueTrackAcquisitionPlan } from "./release-group-acquisition-plan.js";
import { streamingProviderManager } from "../providers/index.js";

type ReleaseGroupForCuration = {
    mbid: string;
    artist_mbid: string;
    title: string;
    primary_type?: string | null;
    secondary_types?: string | null;
};

type ReleaseGroupSlotRow = {
    id: number;
    release_group_mbid: string;
    slot: string;
    monitored: number;
    selected_provider?: string | null;
    selected_provider_id?: string | null;
    selected_release_mbid?: string | null;
    provider_cover?: string | null;
    provider_title?: string | null;
    provider_artist_name?: string | null;
    monitored_lock?: number | null;
};

type CurationTrack = {
    recordingMbid: string | null;
    normalizedTitle: string;
};

type PreferredReleaseRecordings = {
    releaseMbid: string;
    tracks: CurationTrack[];
    recordingIds: Set<string>;
    normalizedTitles: Set<string>;
};

type ArtistCurationIdentity = {
    artistId: string | null;
    artistMbid: string | null;
};

export class DownloadMissingService {
    static readonly DEFAULT_MAX_BUFFERED_DOWNLOADS = 50;

    static countActiveDownloadCommands(): number {
        const placeholders = [CommandNames.DownloadAlbum, CommandNames.DownloadTrack, CommandNames.DownloadVideo]
            .map(() => "?")
            .join(", ");
        const row = db.prepare(`
            SELECT COUNT(*) AS count
            FROM commands
            WHERE name IN (${placeholders})
              AND status IN ('queued', 'started')
        `).get(CommandNames.DownloadAlbum, CommandNames.DownloadTrack, CommandNames.DownloadVideo) as { count?: number } | undefined;

        return Number(row?.count || 0);
    }

    static async queueMonitoredItems(
        artistId?: string,
        options: { limit?: number } = {},
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ' app-wide'}...`);

        const filteringConfig = getConfigSection("filtering");
        const allowVideos = filteringConfig?.include_videos !== false;
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

        const hasActiveAlbumWork = (albumId: string) => {
            const albumIds = (albumId || "").split(";").filter(Boolean);
            if (albumIds.length === 0) return false;

            for (const id of albumIds) {
                if (hasBufferedJob([CommandNames.DownloadAlbum, CommandNames.ImportDownload], id)) {
                    return true;
                }
            }
            return false;
        };

        const formatAlbumTitle = (title: string, version?: string | null) => {
            const base = title || 'Unknown Album';
            const v = (version || '').trim();
            if (!v) return base;
            if (base.toLowerCase().includes(v.toLowerCase())) return base;
            return `${base} (${v})`;
        };

        const shouldIncludeReleaseGroup = (row: {
            slot?: string | null;
            primary_type?: string | null;
            secondary_types?: string | null;
            album_type?: string | null;
        }): boolean => isMusicBrainzReleaseGroupIncluded(row, filteringConfig);

        let albumJobs = 0;
        let trackJobs = 0;
        let videoJobs = 0;
        const albumQueuedAsAlbum = new Set<string>();

        const queueAlbumDownload = (album: {
            id: string | number;
            title: string;
            version?: string | null;
            cover?: string | null;
            quality?: string | null;
            artist_name?: string | null;
            provider?: string | null;
            releaseGroupMbid?: string | null;
            releaseMbid?: string | null;
            slot?: string | null;
        }, artistNames: string[] = []): boolean => {
            if (!hasBatchCapacity()) {
                return false;
            }
            const albumId = String(album.id);
            const slotName = String(album.slot || "album").toLowerCase();
            const releaseGroupMbid = album.releaseGroupMbid ? String(album.releaseGroupMbid) : null;
            const queueRefId = releaseGroupMbid ? `${releaseGroupMbid}:${slotName}` : albumId;
            if (
                !albumId
                || albumQueuedAsAlbum.has(queueRefId)
                || hasActiveAlbumWork(albumId)
                || hasBufferedJob([CommandNames.DownloadAlbum, CommandNames.ImportDownload], queueRefId)
            ) {
                return false;
            }

            const albumTitleFull = formatAlbumTitle(album.title, album.version);
            const artistName = album.artist_name || artistNames[0] || 'Unknown';
            const provider = album.provider || "tidal";
            CommandQueueManager.push(CommandNames.DownloadAlbum, {
                url: buildStreamingMediaUrl("album", albumId, provider as any),
                type: 'album',
                provider,
                providerId: albumId,
                releaseGroupMbid: album.releaseGroupMbid || undefined,
                releaseMbid: album.releaseMbid || null,
                albumId: album.releaseGroupMbid || undefined,
                libraryRoot: album.slot === "spatial" ? "spatial" : "music",
                slot: album.slot || undefined,
                title: albumTitleFull,
                artist: artistName,
                cover: album.cover || null,
                quality: album.quality || null,
                artists: artistNames,
                description: `${albumTitleFull} by ${artistName}`,
            }, queueRefId);
            albumQueuedAsAlbum.add(queueRefId);
            albumJobs++;
            return true;
        };

        const slotParams: any[] = [];
        let slotArtistWhere = "COALESCE(monitored_artist.monitored, 0) = 1";
        if (artistId) {
            slotArtistWhere = "monitored_artist.id = ?";
            slotParams.push(artistId);
        }
        const boundedAlbumFetch = Number.isFinite(maxToQueue);
        const albumFetchLimit = boundedAlbumFetch
            ? Math.max(Number(maxToQueue) * 5, Number(maxToQueue) + 100)
            : null;

        const selectedSlotsSql = `
            SELECT
                rgs.id,
                rgs.slot,
                rgs.release_group_mbid,
                rgs.selected_provider,
                rgs.selected_provider_id,
                rgs.selected_release_mbid,
                rgs.quality,
                rgs.match_method,
                rgs.match_evidence,
                pi.cover AS provider_cover,
                pi.title AS provider_title,
                pi.provider_artist_name AS provider_artist_name,
                rg.primary_type,
                rg.secondary_types,
                rg.title,
                monitored_artist.name as artist_name
            FROM ReleaseGroupSlots rgs
            JOIN Albums rg ON rg.id = rgs.release_group_id
            JOIN Artists monitored_artist ON monitored_artist.mbid = rgs.artist_mbid
            LEFT JOIN ProviderItems pi
              ON pi.provider = rgs.selected_provider
             AND pi.provider_id = rgs.selected_provider_id
             AND pi.entity_type = 'album'
            WHERE rgs.monitored = 1
              AND rgs.selected_provider IS NOT NULL
              AND rgs.selected_provider_id IS NOT NULL
              AND rgs.selected_release_mbid IS NOT NULL
              AND ${slotArtistWhere}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM Tracks selected_track
                  WHERE selected_track.album_release_id = rgs.selected_album_release_id
                )
                OR EXISTS (
                  SELECT 1
                  FROM Tracks missing_track
                  WHERE missing_track.album_release_id = rgs.selected_album_release_id
                    AND missing_track.id NOT IN (
                      SELECT downloaded_file.track_id
                      FROM TrackFiles downloaded_file
                      WHERE downloaded_file.file_type = 'track'
                        AND downloaded_file.library_slot = COALESCE(rgs.slot, 'stereo')
                        AND downloaded_file.track_id IS NOT NULL
                    )
                  LIMIT 1
                )
              )
            ORDER BY rg.first_release_date DESC, rg.title ASC, rgs.slot ASC
            ${boundedAlbumFetch ? "LIMIT ?" : ""}
        `;
        const selectedSlots = db.prepare(selectedSlotsSql).all(
            ...slotParams,
            ...(boundedAlbumFetch ? [albumFetchLimit] : []),
        ) as any[];

        for (const slot of selectedSlots) {
            if (!hasBatchCapacity()) {
                break;
            }
            if (!shouldIncludeReleaseGroup(slot)) {
                continue;
            }

            const artistNames = [slot.artist_name || slot.provider_artist_name].filter(Boolean);
            const plannedTracks = queueTrackAcquisitionPlan(slot, {
                canQueue: hasBatchCapacity,
                onQueued: () => { trackJobs += 1; },
            });
            if (plannedTracks.recognized) {
                continue;
            }
            queueAlbumDownload({
                id: String(slot.selected_provider_id),
                title: slot.title || slot.provider_title || null,
                version: null,
                cover: slot.provider_cover || null,
                quality: slot.quality || null,
                artist_name: slot.artist_name || slot.provider_artist_name || null,
                provider: slot.selected_provider || null,
                releaseGroupMbid: slot.release_group_mbid || null,
                releaseMbid: slot.selected_release_mbid || null,
                slot: slot.slot || null,
            }, artistNames);
        }

        if (allowVideos) {
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
                    r.artist_mbid as artist_mbid,
                    r.cover_image_url as cover_image_url,
                    artist.name as artist_name,
                    pi.provider,
                    pi.provider_id,
                    pi.quality as video_quality
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

            // One job per canonical video recording. Distinct lyric/live/audio
            // variants intentionally have distinct recording ids after video
            // clustering, so title-based grouping here would collapse them all
            // over again. Within one recording, choose the highest-priority
            // provider deterministically while preserving canonical title order.
            const offersByRecording = new Map<string, Array<{ video: any; index: number }>>();
            videos.forEach((video, index) => {
                const recordingId = String(video.recording_id || "");
                if (!recordingId) return;
                const offers = offersByRecording.get(recordingId) ?? [];
                offers.push({ video, index });
                offersByRecording.set(recordingId, offers);
            });
            const preferredVideos = Array.from(offersByRecording.values()).map((offers) => {
                offers.sort((left, right) =>
                    streamingProviderManager.getProviderPreferenceRank(String(left.video.provider || ""))
                    - streamingProviderManager.getProviderPreferenceRank(String(right.video.provider || ""))
                    || left.index - right.index);
                return offers[0].video;
            });

            for (const video of preferredVideos) {
                if (!hasBatchCapacity()) {
                    break;
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


