import { db } from "../../database.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { invalidateReleaseGroupDownloadStatus } from "../download/download-state.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { queueAcquisitionPlan } from "./acquisition-plan-executor.js";

export class AlbumCommandService {
    private static releaseGroupExists(releaseGroupMbid: string): { id: number; mbid: string } | null {
        return db.prepare("SELECT id, mbid FROM Albums WHERE mbid = ?")
            .get(releaseGroupMbid) as { id: number; mbid: string } | null;
    }

    private static setReleaseGroupMonitored(releaseGroupMbid: string, monitored: boolean): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        db.prepare(`
            INSERT INTO LibraryReleaseGroups (
              library_id, release_group_id, monitored, selection_mode,
              locked, reason, curation_version, updated_at
            )
            SELECT id, ?, ?, 'manual', 0, 'user', 1, CURRENT_TIMESTAMP
            FROM Libraries
            WHERE enabled = 1
            ON CONFLICT(library_id, release_group_id) DO UPDATE SET
              monitored = excluded.monitored,
              selection_mode = 'manual',
              reason = 'user',
              updated_at = CURRENT_TIMESTAMP
        `).run(releaseGroup.id, Number(monitored));

        return true;
    }

    private static setReleaseGroupMonitoredLock(releaseGroupMbid: string, locked: boolean): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        db.prepare(`
            INSERT INTO LibraryReleaseGroups (
              library_id, release_group_id, monitored, selection_mode,
              locked, reason, curation_version, updated_at
            )
            SELECT id, ?, 0, 'manual', ?, 'user', 1, CURRENT_TIMESTAMP
            FROM Libraries
            WHERE enabled = 1
            ON CONFLICT(library_id, release_group_id) DO UPDATE SET
              selection_mode = 'manual',
              locked = excluded.locked,
              reason = 'user',
              updated_at = CURRENT_TIMESTAMP
        `).run(releaseGroup.id, Number(locked));

        invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
        return true;
    }

    /** Set release-group wanted state for every enabled library. */
    static setAlbumMonitored(albumId: string, monitored: boolean): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        if (this.setReleaseGroupMonitored(albumId, monitored)) {
            invalidateReleaseGroupDownloadStatus(albumId);
            return { success: true, albumId, monitored };
        }

        return { success: false, albumId, monitored, message: 'Release group not found', status: 404 };
    }

    /** Monitor + lock a single track, optionally queue download */
    static async monitorTrack(trackId: string, shouldDownload: boolean): Promise<{ success: boolean; monitored_track?: string; trackId?: string; albumId?: string; commandId?: number | null; message?: string; status?: number }> {
        const track = db.prepare(`
            SELECT
              CAST(t.id AS TEXT) AS local_track_id,
              t.mbid,
              t.title,
              t.release_mbid,
              t.recording_mbid,
              ar.release_group_mbid,
              ar.artist_mbid,
              album.title AS album_title,
              artist.name AS artist_name,
              pi.provider,
              pi.provider_id,
              pi.title AS provider_title,
              pi.version,
              COALESCE(variant.provider_quality_label, variant.quality_class) AS quality
            FROM Tracks t
            JOIN AlbumEditions ar ON ar.id = t.album_edition_id
            JOIN Albums album ON album.id = ar.release_group_id
            LEFT JOIN ArtistMetadata artist ON artist.id = album.artist_metadata_id
            LEFT JOIN ProviderTrackMatches provider_match
              ON provider_match.track_id = t.id
             AND provider_match.match_state = 'accepted'
            LEFT JOIN ProviderEditionMembers provider_member
              ON provider_member.id = provider_match.provider_edition_member_id
            LEFT JOIN ProviderItems pi
              ON pi.id = provider_member.member_item_id
             AND pi.entity_type = 'track'
            LEFT JOIN ProviderItemAudioVariants variant
              ON variant.id = (
                SELECT candidate.id
                FROM ProviderItemAudioVariants candidate
                WHERE candidate.provider_item_id = pi.id
                  AND candidate.availability = 'available'
                ORDER BY
                  CASE candidate.quality_class
                    WHEN 'hires-lossless' THEN 0
                    WHEN 'lossless' THEN 1
                    WHEN 'lossy' THEN 2
                    ELSE 3
                  END,
                  candidate.id
                LIMIT 1
             )
            WHERE t.mbid = ? OR CAST(t.id AS TEXT) = ?
            ORDER BY
              CASE WHEN pi.provider_id IS NULL THEN 1 ELSE 0 END,
              CASE WHEN provider_match.decision_source = 'manual' THEN 0 ELSE 1 END,
              COALESCE(provider_match.confidence, 0) DESC,
              pi.updated_at DESC
            LIMIT 1
        `).get(trackId, trackId) as any;

        if (!track) {
            return { success: false, message: 'Track not found', status: 404 };
        }

        this.setReleaseGroupMonitored(String(track.release_group_mbid), true);
        invalidateReleaseGroupDownloadStatus(String(track.release_group_mbid));

        let commandId: number | null = null;
        if (shouldDownload) {
            if (!track.provider_id) {
                return {
                    success: true,
                    monitored_track: track.mbid || trackId,
                    trackId,
                    albumId: String(track.release_group_mbid),
                    commandId: null,
                    message: "Track monitored; no provider offer is selected for download",
                    status: 202,
                };
            }
            const trackProviderId = String(track.provider_id);
            const provider = track.provider || "tidal";
            const title = String(track.title || track.provider_title || "Unknown").trim();
            const version = String(track.version || "").trim();
            const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
                ? `${title} (${version})`
                : title;
            const artistName = track.artist_name || "Unknown";
            commandId = CommandQueueManager.push(CommandNames.DownloadTrack, {
                url: buildStreamingMediaUrl("track", trackProviderId, provider as any),
                type: 'track',
                provider,
                providerId: trackProviderId,
                canonicalTrackId: String(track.local_track_id),
                canonicalTrackMbid: track.mbid || null,
                canonicalRecordingMbid: track.recording_mbid || null,
                releaseGroupMbid: track.release_group_mbid || undefined,
                releaseMbid: track.release_mbid || null,
                title: displayTitle,
                artist: artistName,
                albumTitle: track.album_title || null,
                quality: track?.quality || null,
            }, String(track.local_track_id), 0, 1);
        }

        return { success: true, monitored_track: track.mbid || trackId, trackId, albumId: String(track.release_group_mbid), commandId };
    }

    /** Mark a release group wanted and queue its selected provider offer. */
    static async addAlbum(albumId: string, shouldDownload: boolean, requestedSlot?: string | null): Promise<{ success: boolean; albumId?: string; commandId?: number | null; commandIds?: number[]; status?: number; message?: string }> {
        if (!this.releaseGroupExists(albumId)) {
            return { success: false, status: 404, message: 'Release group not found' };
        }

        this.setReleaseGroupMonitored(albumId, true);
        const normalizedPlanIds = (db.prepare(`
            SELECT plan.id
            FROM AcquisitionPlans plan
            JOIN LibraryReleases library_release
              ON library_release.id = plan.library_release_id
            JOIN Libraries library ON library.id = library_release.library_id
            JOIN AlbumEditions release ON release.id = library_release.edition_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE release_group.mbid = ?
              AND plan.state = 'current'
              AND library.enabled = 1
              AND (
                ? IS NULL
                OR LOWER(library.name) = LOWER(?)
                OR (? = 'stereo' AND LOWER(library.name) NOT LIKE '%spatial%')
              )
            ORDER BY library.id, plan.id
        `).all(
            albumId,
            requestedSlot ?? null,
            requestedSlot ?? null,
            requestedSlot ?? null,
        ) as Array<{ id: number }>).map(({ id }) => id);
        if (shouldDownload && normalizedPlanIds.length === 0) {
            return {
                success: false,
                status: 409,
                message: requestedSlot
                    ? `No current acquisition plan exists for the ${requestedSlot} library.`
                    : "No current acquisition plan exists for this release group. Connect a provider and refresh the artist before downloading.",
            };
        }
        const commandIds: number[] = [];
        if (shouldDownload) {
            for (const planId of normalizedPlanIds) {
                const queued = queueAcquisitionPlan(db, planId);
                if (queued.commandId != null) commandIds.push(queued.commandId);
            }
            return { success: true, albumId, commandId: commandIds[0] ?? null, commandIds };
        }

        return { success: true, albumId, commandId: commandIds[0] ?? null, commandIds };
    }

    /** Update album monitored and/or monitor_lock state */
    static updateAlbum(albumId: string, monitored?: boolean, monitoredLock?: boolean): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitoredLock === undefined) {
            return { success: true };
        }

        if (this.releaseGroupExists(albumId)) {
            if (monitored !== undefined) {
                this.setReleaseGroupMonitored(albumId, monitored);
            }
            if (monitoredLock !== undefined) {
                this.setReleaseGroupMonitoredLock(albumId, monitoredLock);
            }
            return { success: true, albumId, monitored };
        }
        return { success: false, status: 404, message: 'Release group not found' };
    }

}


