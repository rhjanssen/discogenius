import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { invalidateReleaseGroupDownloadStatus } from "./download-state.js";
import { getConfigSection } from "./config.js";
import { buildStreamingMediaUrl } from "./download-routing.js";

type AlbumSlotSelection = {
    slot: "stereo" | "spatial";
    selected_provider?: string | null;
    selected_provider_id: string;
    quality?: string | null;
    provider_data?: string | null;
    title?: string | null;
    artist_name?: string | null;
};

export class AlbumCommandService {
    private static releaseGroupExists(releaseGroupMbid: string): { mbid: string; artist_mbid: string } | null {
        return db.prepare("SELECT mbid, artist_mbid FROM Albums WHERE mbid = ?")
            .get(releaseGroupMbid) as { mbid: string; artist_mbid: string } | null;
    }

    private static setReleaseGroupWanted(releaseGroupMbid: string, wanted: boolean): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        const slots = includeSpatial ? ["stereo", "spatial"] : ["stereo"];
        const wantedInt = wanted ? 1 : 0;
        const upsert = db.prepare(`
            INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, wanted, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
              artist_mbid = excluded.artist_mbid,
              wanted = excluded.wanted,
              updated_at = CURRENT_TIMESTAMP
        `);

        for (const slot of slots) {
            upsert.run(releaseGroup.artist_mbid, releaseGroupMbid, slot, wantedInt);
        }

        return true;
    }

    private static setReleaseGroupLock(releaseGroupMbid: string, locked: boolean): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        const slots = includeSpatial ? ["stereo", "spatial"] : ["stereo"];
        const lockedInt = locked ? 1 : 0;
        const upsert = db.prepare(`
            INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitor_lock, locked_at, updated_at)
            VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
              artist_mbid = excluded.artist_mbid,
              monitor_lock = excluded.monitor_lock,
              locked_at = excluded.locked_at,
              updated_at = CURRENT_TIMESTAMP
        `);

        for (const slot of slots) {
            upsert.run(releaseGroup.artist_mbid, releaseGroupMbid, slot, lockedInt, lockedInt);
        }

        invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
        return true;
    }

    private static resolveSelectedProviderAlbumSelections(
        albumOrReleaseGroupId: string,
        requestedSlot?: string | null,
    ): AlbumSlotSelection[] {
        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        const normalizedRequestedSlot = String(requestedSlot || "").trim().toLowerCase();
        const preferredSlots = normalizedRequestedSlot === "spatial"
            ? ["spatial"]
            : normalizedRequestedSlot === "stereo"
                ? ["stereo"]
                : includeSpatial ? ["stereo", "spatial"] : ["stereo"];
        const placeholders = preferredSlots.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT
              rgs.slot,
              rgs.selected_provider,
              rgs.selected_provider_id,
              rgs.quality,
              rgs.provider_data,
              rg.title,
              a.name AS artist_name
            FROM ReleaseGroupSlots
            rgs
            JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
            LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
            WHERE rgs.release_group_mbid = ?
              AND rgs.wanted = 1
              AND rgs.selected_provider IS NOT NULL
              AND rgs.selected_provider_id IS NOT NULL
              AND rgs.slot IN (${placeholders})
            ORDER BY
              CASE rgs.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
              rgs.updated_at DESC
        `).all(albumOrReleaseGroupId, ...preferredSlots) as Array<Omit<AlbumSlotSelection, "selected_provider_id" | "slot"> & {
            slot?: string | null;
            selected_provider_id?: string | number | null;
        }>;

        const seenSlots = new Set<string>();
        const selections: AlbumSlotSelection[] = [];
        for (const row of rows) {
            const slot = String(row.slot || "").toLowerCase();
            if ((slot !== "stereo" && slot !== "spatial") || seenSlots.has(slot) || row.selected_provider_id == null) {
                continue;
            }
            seenSlots.add(slot);
            selections.push({
                ...row,
                slot,
                selected_provider_id: String(row.selected_provider_id),
            });
        }

        return selections;
    }

    /** Set release-group slot wanted state. Provider albums are selected offers, not catalog identity. */
    static setAlbumMonitored(albumId: string, monitored: boolean): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        if (this.setReleaseGroupWanted(albumId, monitored)) {
            invalidateReleaseGroupDownloadStatus(albumId);
            return { success: true, albumId, monitored };
        }

        return { success: false, albumId, monitored, message: 'Release group not found', status: 404 };
    }

    /** Monitor + lock a single track, optionally queue download */
    static async monitorTrack(trackId: string, shouldDownload: boolean): Promise<{ success: boolean; monitored_track?: string; trackId?: string; albumId?: string; jobId?: number | null; message?: string; status?: number }> {
        const track = db.prepare(`
            SELECT
              CAST(t.Id AS TEXT) AS local_track_id,
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
              pi.quality
            FROM Tracks t
            JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
            JOIN Albums album ON album.mbid = ar.release_group_mbid
            LEFT JOIN ArtistMetadata artist ON artist.mbid = ar.artist_mbid
            LEFT JOIN ProviderItems pi
              ON pi.entity_type IN ('track', 'recording')
             AND (
                pi.track_id = t.Id
                OR pi.track_mbid = t.mbid
                OR pi.recording_mbid = t.recording_mbid
             )
            WHERE t.mbid = ? OR CAST(t.Id AS TEXT) = ?
            ORDER BY
              CASE WHEN pi.provider_id IS NULL THEN 1 ELSE 0 END,
              COALESCE(pi.match_confidence, 0) DESC,
              CASE COALESCE(pi.match_status, '') WHEN 'verified' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
              pi.updated_at DESC
            LIMIT 1
        `).get(trackId, trackId) as any;

        if (!track) {
            return { success: false, message: 'Track not found', status: 404 };
        }

        this.setReleaseGroupWanted(String(track.release_group_mbid), true);
        invalidateReleaseGroupDownloadStatus(String(track.release_group_mbid));

        let jobId: number | null = null;
        if (shouldDownload) {
            if (!track.provider_id) {
                return {
                    success: true,
                    monitored_track: track.mbid || trackId,
                    trackId,
                    albumId: String(track.release_group_mbid),
                    jobId: null,
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
            jobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
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

        return { success: true, monitored_track: track.mbid || trackId, trackId, albumId: String(track.release_group_mbid), jobId };
    }

    /** Mark a release group wanted and queue its selected provider offer. */
    static async addAlbum(albumId: string, shouldDownload: boolean, requestedSlot?: string | null): Promise<{ success: boolean; albumId?: string; jobId?: number | null; jobIds?: number[]; status?: number; message?: string }> {
        if (!this.releaseGroupExists(albumId)) {
            return { success: false, status: 404, message: 'Release group not found' };
        }

        this.setReleaseGroupWanted(albumId, true);
        const selections = this.resolveSelectedProviderAlbumSelections(albumId, requestedSlot);
        if (selections.length === 0) {
            return {
                success: false,
                status: 409,
                message: requestedSlot
                    ? `No ${requestedSlot} provider offer is selected for this release group yet.`
                    : "No provider offer is selected for this release group yet. Connect a provider and refresh the artist before downloading.",
            };
        }

        const jobIds: number[] = [];
        if (shouldDownload) {
            for (const selection of selections) {
                let providerData: any = null;
                try {
                    providerData = selection.provider_data ? JSON.parse(selection.provider_data) : null;
                } catch {
                    providerData = null;
                }

                const providerAlbumId = selection.selected_provider_id;
                const artistName = selection.artist_name || providerData?.artist?.name || 'Unknown Artist';
                const provider = selection.selected_provider || "tidal";
                const jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                    url: buildStreamingMediaUrl("album", providerAlbumId, provider as any),
                    type: 'album',
                    provider,
                    providerId: providerAlbumId,
                    releaseGroupMbid: albumId,
                    albumId,
                    libraryRoot: selection.slot === "spatial" ? "spatial" : "music",
                    slot: selection.slot,
                    title: selection.title || providerData?.title || 'Unknown Album',
                    artist: artistName,
                    artists: [artistName].filter(Boolean),
                    cover: providerData?.cover || null,
                    quality: selection.quality || providerData?.quality || null,
                    description: `${selection.title || providerData?.title || 'Unknown Album'} by ${artistName} (${selection.slot})`,
                }, `${albumId}:${selection.slot}`, 0, 1);
                jobIds.push(jobId);
            }
        }

        return { success: true, albumId, jobId: jobIds[0] ?? null, jobIds };
    }

    /** Update album monitored and/or monitor_lock state */
    static updateAlbum(albumId: string, monitored?: boolean, monitorLock?: boolean): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitorLock === undefined) {
            return { success: true };
        }

        if (this.releaseGroupExists(albumId)) {
            if (monitored !== undefined) {
                this.setReleaseGroupWanted(albumId, monitored);
            }
            if (monitorLock !== undefined) {
                this.setReleaseGroupLock(albumId, monitorLock);
            }
            return { success: true, albumId, monitored };
        }
        return { success: false, status: 404, message: 'Release group not found' };
    }

}
