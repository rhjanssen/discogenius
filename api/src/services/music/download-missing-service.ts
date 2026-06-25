import { db, runChunkedWrite } from "../../database.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { getConfigSection, type FilteringConfig } from "../config/config.js";
import { LibraryFilesService, resolvePlexVideoSuffix } from "../mediafiles/library-files.js";
import { baseComparableTitle } from "../mediafiles/import-matching-utils.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { isMusicBrainzReleaseGroupIncluded, parseMusicBrainzSecondaryTypes } from "../metadata/musicbrainz-release-group-filter.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";

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
    provider_data?: string | null;
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

    static async queueMonitoredItems(
        artistId?: string
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ' app-wide'}...`);

        const filteringConfig = getConfigSection("filtering");
        const allowVideos = filteringConfig?.include_videos !== false;

        const hasActiveJob = (types: string[], refId: string) => {
            const placeholders = types.map(() => '?').join(', ');
            const existing = db.prepare(`
                SELECT id FROM commands
                WHERE name IN (${placeholders}) AND ref_id = ? AND status IN ('queued', 'started')
            `).get(...types, refId);
            return Boolean(existing);
        };

        const hasActiveAlbumWork = (albumId: string) => {
            const albumIds = (albumId || "").split(";").filter(Boolean);
            if (albumIds.length === 0) return false;

            for (const id of albumIds) {
                if (hasActiveJob([CommandNames.DownloadAlbum, CommandNames.ImportDownload], id)) {
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
        const trackJobs = 0;
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
            const albumId = String(album.id);
            const slotName = String(album.slot || "album").toLowerCase();
            const releaseGroupMbid = album.releaseGroupMbid ? String(album.releaseGroupMbid) : null;
            const queueRefId = releaseGroupMbid ? `${releaseGroupMbid}:${slotName}` : albumId;
            if (
                !albumId
                || albumQueuedAsAlbum.has(queueRefId)
                || hasActiveAlbumWork(albumId)
                || hasActiveJob([CommandNames.DownloadAlbum, CommandNames.ImportDownload], queueRefId)
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

        const selectedSlots = db.prepare(`
            SELECT
                rgs.id,
                rgs.slot,
                rgs.release_group_mbid,
                rgs.selected_provider,
                rgs.selected_provider_id,
                rgs.selected_release_mbid,
                rgs.quality,
                rgs.provider_data,
                rg.primary_type,
                rg.secondary_types,
                rg.title,
                monitored_artist.name as artist_name,
                COUNT(t.mbid) as total_tracks,
                SUM(CASE WHEN tf.id IS NOT NULL THEN 1 ELSE 0 END) as downloaded_tracks
            FROM ReleaseGroupSlots rgs
            JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
            JOIN Artists monitored_artist ON monitored_artist.mbid = rgs.artist_mbid
            LEFT JOIN Tracks t ON t.release_mbid = rgs.selected_release_mbid
            LEFT JOIN Recordings recording ON recording.mbid = t.recording_mbid AND COALESCE(recording.is_video, 0) = 0
            LEFT JOIN TrackFiles tf ON tf.file_type = 'track' 
                                   AND tf.library_slot = COALESCE(rgs.slot, 'stereo') 
                                   AND (
                                        tf.canonical_track_mbid = t.mbid 
                                        OR (tf.canonical_recording_mbid = t.recording_mbid AND t.recording_mbid IS NOT NULL)
                                   )
            WHERE rgs.monitored = 1
              AND rgs.selected_provider IS NOT NULL
              AND rgs.selected_provider_id IS NOT NULL
              AND rgs.selected_release_mbid IS NOT NULL
              AND ${slotArtistWhere}
            GROUP BY rgs.id
            HAVING total_tracks = 0 OR downloaded_tracks < total_tracks
            ORDER BY rg.first_release_date DESC, rg.title ASC, rgs.slot ASC
        `).all(...slotParams) as any[];

        for (const slot of selectedSlots) {
            if (!shouldIncludeReleaseGroup(slot)) {
                continue;
            }

            let providerData: any = null;
            try {
                providerData = slot.provider_data ? JSON.parse(String(slot.provider_data)) : null;
            } catch {
                providerData = null;
            }
            const artistNames = [slot.artist_name || providerData?.artist?.name].filter(Boolean);
            queueAlbumDownload({
                id: String(slot.selected_provider_id),
                title: providerData?.title || slot.title,
                version: providerData?.version || null,
                cover: providerData?.cover || null,
                quality: slot.quality || providerData?.quality || null,
                artist_name: slot.artist_name || providerData?.artist?.name || null,
                provider: slot.selected_provider || null,
                releaseGroupMbid: slot.release_group_mbid || null,
                releaseMbid: slot.selected_release_mbid || null,
                slot: slot.slot || null,
            }, artistNames);
        }

        if (allowVideos) {
            const hasImportedVideoFile = (recordingMbidColumn: string, providerIdColumn: string) => `
                EXISTS (
                    SELECT 1
                    FROM TrackFiles lf
                    WHERE lf.file_type = 'video'
                      AND (
                        (lf.canonical_recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = ${recordingMbidColumn})
                        OR (lf.provider_entity_type = 'video' AND CAST(lf.provider_id AS TEXT) = CAST(${providerIdColumn} AS TEXT))
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
                  AND NOT ${hasImportedVideoFile('r.mbid', 'pi.provider_id')}
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
            `;

            const videos = db.prepare(videosQuery).all(...videoParams) as any[];

            const videoTypeRank: Record<string, number> = {
                "-video": 0,
                "-lyrics": 1,
                "-live": 2,
                "-concert": 3,
                "-behindthescenes": 4,
                "-interview": 5,
            };
            const videoGroupKey = (artistMbid: unknown, title: unknown) => {
                const base = baseComparableTitle(String(title || "")) || String(title || "").trim().toLowerCase();
                return `${String(artistMbid || "")}:${base}`;
            };

            const importedVideoGroups = new Set<string>(
                (db.prepare(`
                    SELECT r.artist_mbid AS artist_mbid, r.title AS title
                    FROM TrackFiles lf
                    JOIN Recordings r
                      ON (lf.canonical_recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = r.mbid)
                      OR (lf.provider_entity_type = 'video' AND EXISTS (
                            SELECT 1 FROM ProviderItems pv
                            WHERE pv.entity_type = 'video'
                              AND CAST(pv.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
                              AND pv.recording_id = r.id
                          ))
                    WHERE lf.file_type = 'video' AND r.is_video = 1
                `).all() as Array<{ artist_mbid: string | null; title: string | null }>)
                    .map((row) => videoGroupKey(row.artist_mbid, row.title)),
            );

            const rankedVideos = videos
                .map((video, index) => ({
                    video,
                    index,
                    groupKey: videoGroupKey(video.artist_mbid, video.video_title),
                    typeRank: videoTypeRank[resolvePlexVideoSuffix(video.video_title)] ?? 9,
                    officialRank: /\\bofficial\\b/i.test(String(video.video_title || "")) ? 0 : 1,
                }))
                .sort((left, right) =>
                    left.groupKey.localeCompare(right.groupKey)
                    || left.typeRank - right.typeRank
                    || left.officialRank - right.officialRank
                    || left.index - right.index,
                );

            const queuedRecordings = new Set<string>();
            const queuedGroups = new Set<string>();
            for (const { video, groupKey } of rankedVideos) {
                const recordingId = String(video.recording_id || "");
                const providerId = String(video.provider_id || "");
                const queueRefId = recordingId ? `recording:${recordingId}:video` : `provider:${providerId}:video`;
                if (!recordingId || !providerId || queuedRecordings.has(recordingId)) continue;
                if (queuedGroups.has(groupKey) || importedVideoGroups.has(groupKey)) continue;
                if (hasActiveJob([CommandNames.DownloadVideo, CommandNames.ImportDownload], queueRefId)) {
                    queuedGroups.add(groupKey);
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
                queuedRecordings.add(recordingId);
                queuedGroups.add(groupKey);
                videoJobs++;
            }
        }

        console.log(`[Queue] Ensured queue has ${albumJobs} albums, ${trackJobs} tracks, ${videoJobs} videos.`);
        return { albums: albumJobs, tracks: trackJobs, videos: videoJobs };
    }
}

