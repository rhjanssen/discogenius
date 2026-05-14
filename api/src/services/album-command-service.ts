import { db } from "../database.js";
import { streamingProviderManager } from "./providers/index.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { updateAlbumDownloadStatus } from "./download-state.js";
import { getConfigSection } from "./config.js";
import { buildStreamingMediaUrl } from "./download-routing.js";

function refreshAlbumState(albumId: string) {
    if (!albumId) return;
    updateAlbumDownloadStatus(albumId);
}

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
        return db.prepare("SELECT mbid, artist_mbid FROM mb_release_groups WHERE mbid = ?")
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
            INSERT INTO release_group_slots (artist_mbid, release_group_mbid, slot, wanted, updated_at)
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
            FROM release_group_slots
            rgs
            JOIN mb_release_groups rg ON rg.mbid = rgs.release_group_mbid
            LEFT JOIN artists a ON a.mbid = rg.artist_mbid
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
            return { success: true, albumId, monitored };
        }

        return { success: false, albumId, monitored, message: 'Release group not found', status: 404 };
    }

    /** Monitor + lock a single track, optionally queue download */
    static async monitorTrack(trackId: string, shouldDownload: boolean): Promise<{ success: boolean; monitored_track?: string; trackId?: string; albumId?: string; jobId?: number | null; message?: string; status?: number }> {
        const providerTrack = await streamingProviderManager.getDefaultStreamingProvider().getTrack(trackId);
        const trackData = (providerTrack.raw && typeof providerTrack.raw === "object")
            ? providerTrack.raw as any
            : providerTrack as any;
        const albumId = trackData?.album_id ? String(trackData.album_id) : null;
        if (!albumId) {
            return { success: false, message: 'Track missing album info', status: 404 };
        }

        const trackInDb = db.prepare("SELECT id FROM media WHERE id = ?").get(trackId) as any;
        if (!trackInDb) {
            TaskQueueService.addJob(JobTypes.RefreshAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
            return { success: true, trackId, albumId, message: 'Track not yet in library; album scan queued', status: 202 };
        }

        const result = db.prepare(`
      UPDATE media
      SET monitor = 1,
          monitor_lock = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND album_id IS NOT NULL
    `).run(trackId);

        if (result.changes === 0) {
            return { success: false, message: 'Track not found', status: 404 };
        }

        refreshAlbumState(albumId);

        const track = db.prepare(`
      SELECT m.id, m.title, m.quality, m.album_id, ar.name as artist_name, a.cover as album_cover
      FROM media m
      LEFT JOIN artists ar ON ar.id = m.artist_id
      LEFT JOIN albums a ON a.id = m.album_id
      WHERE m.id = ?
    `).get(trackId) as any;

        let jobId: number | null = null;
        if (shouldDownload) {
            const trackProviderId = String(trackId);
            jobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
                url: buildStreamingMediaUrl("track", trackProviderId),
                type: 'track',
                provider: "tidal",
                providerId: trackProviderId,
                tidalId: trackProviderId,
                title: track?.title || trackData.title || 'Unknown',
                artist: track?.artist_name || trackData.artist_name || 'Unknown',
                cover: track?.album_cover || null,
                quality: track?.quality || null,
            }, trackProviderId, 0, 1);
        }

        return { success: true, monitored_track: trackId, jobId };
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
                    tidalId: providerAlbumId,
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
            return { success: true, albumId, monitored };
        }
        return { success: false, status: 404, message: 'Release group not found' };
    }

}
