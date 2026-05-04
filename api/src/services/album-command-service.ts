import { db } from "../database.js";
import { getTrack } from "./providers/tidal/tidal.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { updateAlbumDownloadStatus } from "./download-state.js";
import { getConfigSection } from "./config.js";
import { RefreshAlbumService } from "./refresh-album-service.js";

function refreshAlbumState(albumId: string) {
    if (!albumId) return;
    updateAlbumDownloadStatus(albumId);
}

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

        const includeAtmos = getConfigSection("filtering").include_atmos === true;
        const slots = includeAtmos ? ["stereo", "spatial"] : ["stereo"];
        const wantedInt = wanted ? 1 : 0;
        const upsert = db.prepare(`
            INSERT INTO release_group_slots (artist_mbid, release_group_mbid, slot, wanted, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(artist_mbid, release_group_mbid, slot) DO UPDATE SET
              wanted = excluded.wanted,
              updated_at = CURRENT_TIMESTAMP
        `);

        for (const slot of slots) {
            upsert.run(releaseGroup.artist_mbid, releaseGroupMbid, slot, wantedInt);
        }

        return true;
    }

    private static resolveSelectedProviderAlbumId(albumOrReleaseGroupId: string): string | null {
        const album = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumOrReleaseGroupId) as any;
        if (album) {
            return albumOrReleaseGroupId;
        }

        const includeAtmos = getConfigSection("filtering").include_atmos === true;
        const preferredSlots = includeAtmos ? ["stereo", "spatial"] : ["stereo"];
        const placeholders = preferredSlots.map(() => "?").join(",");
        const row = db.prepare(`
            SELECT selected_provider_id
            FROM release_group_slots
            WHERE release_group_mbid = ?
              AND wanted = 1
              AND selected_provider = 'tidal'
              AND selected_provider_id IS NOT NULL
              AND slot IN (${placeholders})
            ORDER BY
              CASE slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
              updated_at DESC
            LIMIT 1
        `).get(albumOrReleaseGroupId, ...preferredSlots) as { selected_provider_id?: string | number | null } | undefined;

        return row?.selected_provider_id == null ? null : String(row.selected_provider_id);
    }

    /** Set album + unlocked tracks monitored state */
    static setAlbumMonitored(albumId: string, monitored: boolean): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;

        if (!albumExists) {
            if (this.setReleaseGroupWanted(albumId, monitored)) {
                return { success: true, albumId, monitored };
            }
            if (monitored) {
                TaskQueueService.addJob(JobTypes.RefreshAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
                return { success: true, albumId, monitored, message: 'Album not yet in library; scan queued', status: 202 };
            }
            return { success: false, albumId, monitored, message: 'Album not found', status: 404 };
        }

        const monitorInt = monitored ? 1 : 0;
        db.prepare(`
      UPDATE albums
      SET monitor = ?,
          monitored_at = CASE
            WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
            ELSE monitored_at
          END
      WHERE id = ?
    `).run(monitorInt, monitorInt, albumId);

        db.prepare(`
      UPDATE media
      SET monitor = ?,
          monitored_at = CASE
            WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
            ELSE monitored_at
          END
      WHERE album_id = ?
        AND type != 'Music Video'
        AND COALESCE(monitor_lock, 0) = 0
    `).run(monitorInt, monitorInt, albumId);

        refreshAlbumState(albumId);
        return { success: true, albumId, monitored };
    }

    /** Monitor + lock a single track, optionally queue download */
    static async monitorTrack(trackId: string, shouldDownload: boolean): Promise<{ success: boolean; monitored_track?: string; trackId?: string; albumId?: string; jobId?: number | null; message?: string; status?: number }> {
        const trackData = await getTrack(trackId);
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
            jobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
                url: `https://listen.tidal.com/track/${trackId}`,
                type: 'track',
                tidalId: trackId,
                title: track?.title || trackData.title || 'Unknown',
                artist: track?.artist_name || trackData.artist_name || 'Unknown',
                cover: track?.album_cover || null,
                quality: track?.quality || null,
            }, trackId.toString(), 0, 1);
        }

        return { success: true, monitored_track: trackId, jobId };
    }

    /** Lock album + all audio tracks as wanted, optionally queue download */
    static async addAlbum(albumId: string, shouldDownload: boolean): Promise<{ success: boolean; albumId?: string; jobId?: number | null; status?: number; message?: string }> {
        const resolvedAlbumId = this.resolveSelectedProviderAlbumId(albumId);
        if (!resolvedAlbumId) {
            if (this.releaseGroupExists(albumId)) {
                return {
                    success: false,
                    status: 409,
                    message: "No provider offer is selected for this release group yet. Connect a provider and refresh the artist before downloading.",
                };
            }
            return { success: false, status: 404, message: 'Album not found' };
        }

        let album = db.prepare(`
      SELECT a.id, a.title, a.cover, a.quality, ar.name as artist_name
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?
    `).get(resolvedAlbumId) as any;

        if (!album) {
            await RefreshAlbumService.scanShallow(resolvedAlbumId, {
                includeSimilarAlbums: false,
                seedSimilarAlbums: false,
                resolveMusicBrainz: false,
            });
            album = db.prepare(`
        SELECT a.id, a.title, a.cover, a.quality, ar.name as artist_name
        FROM albums a
        LEFT JOIN artists ar ON ar.id = a.artist_id
        WHERE a.id = ?
      `).get(resolvedAlbumId) as any;
        }

        if (!album) {
            return { success: false, status: 404, message: 'Album not found' };
        }

        db.prepare(`
      UPDATE albums
      SET monitor = 1,
          monitor_lock = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(resolvedAlbumId);

        db.prepare(`
      UPDATE media
      SET monitor = 1,
          monitor_lock = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE album_id = ? AND type != 'Music Video'
    `).run(resolvedAlbumId);

        refreshAlbumState(resolvedAlbumId);

        let jobId: number | null = null;
        if (shouldDownload) {
            const albumArtists = db.prepare(`
        SELECT a.name
        FROM album_artists aa
        JOIN artists a ON a.id = aa.artist_id
        WHERE aa.album_id = ?
      `).all(resolvedAlbumId) as any[];
            const artistNames = albumArtists.map((a: any) => a.name);

            jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                url: `https://listen.tidal.com/album/${resolvedAlbumId}`,
                type: 'album',
                tidalId: resolvedAlbumId,
                title: album.title,
                artist: album.artist_name || artistNames[0] || 'Unknown',
                artists: artistNames,
                cover: album.cover || null,
                quality: album.quality || null,
            }, resolvedAlbumId, 0, 1);
        }

        return { success: true, albumId: resolvedAlbumId, jobId };
    }

    /** Update album monitored and/or monitor_lock state */
    static updateAlbum(albumId: string, monitored?: boolean, monitorLock?: boolean): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitorLock === undefined) {
            return { success: true };
        }

        const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;
        if (!albumExists && this.releaseGroupExists(albumId)) {
            if (monitored !== undefined) {
                this.setReleaseGroupWanted(albumId, monitored);
            }
            return { success: true, albumId, monitored };
        }
        if (!albumExists && monitored === true) {
            TaskQueueService.addJob(JobTypes.RefreshAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
            return { success: true, albumId, monitored, status: 202, message: 'Album not yet in library; scan queued' };
        }
        if (!albumExists) {
            return { success: false, status: 404, message: 'Album not found' };
        }

        if (monitored !== undefined) {
            const monitorInt = monitored ? 1 : 0;
            db.prepare(`
        UPDATE albums
        SET monitor = ?,
            monitored_at = CASE
              WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
              ELSE monitored_at
            END
        WHERE id = ?
      `).run(monitorInt, monitorInt, albumId);

            db.prepare(`
        UPDATE media
        SET monitor = ?,
            monitored_at = CASE
              WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
              ELSE monitored_at
            END
        WHERE album_id = ?
          AND type != 'Music Video'
          AND COALESCE(monitor_lock, 0) = 0
      `).run(monitorInt, monitorInt, albumId);
        }

        if (monitorLock !== undefined) {
            const lockInt = monitorLock ? 1 : 0;

            db.prepare(`
        UPDATE albums
        SET monitor_lock = ?,
            locked_at = CASE
              WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP)
              ELSE NULL
            END
        WHERE id = ?
      `).run(lockInt, lockInt, albumId);

            db.prepare(`
        UPDATE media
        SET monitor_lock = ?,
            locked_at = CASE
              WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP)
              ELSE NULL
            END
        WHERE album_id = ?
          AND type != 'Music Video'
      `).run(lockInt, lockInt, albumId);
        }

        refreshAlbumState(albumId);
        return { success: true };
    }

}
