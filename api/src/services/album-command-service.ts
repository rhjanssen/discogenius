import { db } from "../database.js";
import { getTrack } from "./tidal.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { updateAlbumDownloadStatus } from "./download-state.js";

function refreshAlbumState(albumId: string) {
    if (!albumId) return;
    updateAlbumDownloadStatus(albumId);
}

export class AlbumCommandService {
    /** Set album + unlocked tracks monitored state */
    static setAlbumMonitored(albumId: string, monitored: boolean): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;

        if (!albumExists) {
            if (monitored) {
                TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
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
            TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
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
    static addAlbum(albumId: string, shouldDownload: boolean): { success: boolean; albumId?: string; jobId?: number | null; status?: number; message?: string } {
        const album = db.prepare(`
      SELECT a.id, a.title, a.cover, a.quality, ar.name as artist_name
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?
    `).get(albumId) as any;

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
    `).run(albumId);

        db.prepare(`
      UPDATE media
      SET monitor = 1,
          monitor_lock = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE album_id = ? AND type != 'Music Video'
    `).run(albumId);

        refreshAlbumState(albumId);

        let jobId: number | null = null;
        if (shouldDownload) {
            const albumArtists = db.prepare(`
        SELECT a.name
        FROM album_artists aa
        JOIN artists a ON a.id = aa.artist_id
        WHERE aa.album_id = ?
      `).all(albumId) as any[];
            const artistNames = albumArtists.map((a: any) => a.name);

            jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                url: `https://listen.tidal.com/album/${albumId}`,
                type: 'album',
                tidalId: albumId,
                title: album.title,
                artist: album.artist_name || artistNames[0] || 'Unknown',
                artists: artistNames,
                cover: album.cover || null,
                quality: album.quality || null,
            }, albumId, 0, 1);
        }

        return { success: true, albumId, jobId };
    }

    /** Update album monitored and/or monitor_lock state */
    static updateAlbum(albumId: string, monitored?: boolean, monitorLock?: boolean): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitorLock === undefined) {
            return { success: true };
        }

        const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;
        if (!albumExists && monitored === true) {
            TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
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
