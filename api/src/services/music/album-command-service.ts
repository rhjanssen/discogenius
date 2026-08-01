import { db } from "../../database.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { invalidateReleaseGroupDownloadStatus } from "../download/download-state.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { queueAcquisitionPlan } from "./acquisition-plan-executor.js";
import {
    monitorAlbumInLibraries,
    resolveScopedLibraryIds,
    unmonitorAlbumInLibraries,
    type AlbumLibraryScope,
} from "./library-album-monitoring.js";

export class AlbumCommandService {
    private static releaseGroupExists(releaseGroupMbid: string): { id: number; mbid: string } | null {
        return db.prepare("SELECT id, mbid FROM Albums WHERE mbid = ?")
            .get(releaseGroupMbid) as { id: number; mbid: string } | null;
    }

    private static setReleaseGroupMonitored(
        releaseGroupMbid: string,
        monitored: boolean,
        scope: AlbumLibraryScope,
    ): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        const libraryIds = resolveScopedLibraryIds(db, scope);
        db.transaction(() => {
            if (monitored) {
                monitorAlbumInLibraries(db, releaseGroup.id, libraryIds, {
                    reason: "user",
                    actor: "user",
                });
            } else {
                unmonitorAlbumInLibraries(db, releaseGroup.id, libraryIds, { actor: "user" });
            }
        })();

        return true;
    }

    /**
     * Lock or unlock an Album in the named Libraries.
     *
     * A lock protects an Album that is monitored; it is not a way to record an
     * opinion about one that is not. Locking therefore never creates a
     * `LibraryAlbums` row — an unmonitored Album has nothing to protect, and a
     * row created to hold a lock would claim the Album is monitored.
     */
    private static setReleaseGroupMonitoredLock(
        releaseGroupMbid: string,
        locked: boolean,
        scope: AlbumLibraryScope,
    ): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        const libraryIds = resolveScopedLibraryIds(db, scope);
        if (libraryIds.length > 0) {
            const update = db.prepare(`
                UPDATE LibraryAlbums
                SET locked = ?, selection_mode = 'manual', reason = 'user',
                    updated_at = CURRENT_TIMESTAMP
                WHERE library_id = ? AND release_group_id = ?
            `);
            db.transaction(() => {
                for (const libraryId of libraryIds) {
                    update.run(Number(locked), libraryId, releaseGroup.id);
                }
            })();
        }

        // One Album-level lock, one meaning, one row. Curation, acquisition
        // planning and the edition-selection UX all read LibraryAlbums.locked;
        // there is no second per-edition lock to propagate to and therefore
        // none to drift out of step with this one. The lock covers the
        // monitored state, the curated edition set, the representative edition
        // and the selected acquisition plan alike.
        invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
        return true;
    }

    /** Set release-group wanted state in the Libraries the caller named. */
    static setAlbumMonitored(
        albumId: string,
        monitored: boolean,
        scope: AlbumLibraryScope,
    ): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        if (this.setReleaseGroupMonitored(albumId, monitored, scope)) {
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

        // Monitoring a track monitors its Album across the audio Libraries. The
        // Video Library never takes part: it holds canonical video Recordings,
        // which are curated through LibraryVideos, not through Albums.
        this.setReleaseGroupMonitored(
            String(track.release_group_mbid),
            true,
            { kind: "all-audio-libraries" },
        );
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

        this.setReleaseGroupMonitored(albumId, true, { kind: "all-audio-libraries" });
        const normalizedPlanIds = (db.prepare(`
            SELECT plan.id
            FROM SelectedAcquisitionPlans plan
            JOIN LibraryEditions library_release
              ON library_release.id = plan.library_edition_id
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

    /** Update album monitored and/or monitor_lock state in the named Libraries. */
    static updateAlbum(
        albumId: string,
        monitored: boolean | undefined,
        monitoredLock: boolean | undefined,
        scope: AlbumLibraryScope,
    ): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitoredLock === undefined) {
            return { success: true };
        }

        if (this.releaseGroupExists(albumId)) {
            if (monitored !== undefined) {
                this.setReleaseGroupMonitored(albumId, monitored, scope);
            }
            if (monitoredLock !== undefined) {
                this.setReleaseGroupMonitoredLock(albumId, monitoredLock, scope);
            }
            return { success: true, albumId, monitored };
        }
        return { success: false, status: 404, message: 'Release group not found' };
    }

}


