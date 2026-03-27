import { Router } from "express";
import { db } from "../database.js";
import { getTrack } from "../services/tidal.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";
import { updateAlbumDownloadStatus } from "../services/download-state.js";
import { AlbumQueryService } from "../services/album-query-service.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

const TRUE_QUERY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_QUERY_VALUES = new Set(["0", "false", "no", "off"]);

function parseOptionalQueryBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    return parseOptionalQueryBoolean(value[0]);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_QUERY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_QUERY_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
}

function refreshAlbumState(albumId: string) {
  if (!albumId) return;
  updateAlbumDownloadStatus(albumId);
}

const parseOptionalMonitored = (value: unknown): boolean => {
  return value === undefined ? true : Boolean(value);
};

/**
 * Albums routes - updated for new schema where:
 * - 'id' is the primary key (INT, TIDAL album id)
 * - 'cover' replaces 'cover_id'
 * - 'quality' replaces 'audio_quality'
 * - 'type' replaces 'album_type'
 * - 'monitor' replaces 'monitored'
 * - 'media' table replaces 'tracks' table
 */

// Get all albums with pagination
router.get("/", (req, res) => {
  try {
    const monitoredFilter = parseOptionalQueryBoolean(req.query.monitored);
    const downloadedFilter = parseOptionalQueryBoolean(req.query.downloaded);
    const lockedFilter = parseOptionalQueryBoolean(req.query.locked);

    res.json(AlbumQueryService.listAlbums({
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      search: req.query.search as string | undefined,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
      locked: lockedFilter,
      libraryFilter: req.query.library_filter as string | undefined,
      sort: req.query.sort as string | undefined,
      dir: req.query.dir as string | undefined,
    }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:albumId", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    const album = await AlbumQueryService.getAlbum(albumId);

    if (!album) {
      return res.status(404).json({ detail: "Album not found" });
    }

    res.json(album);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:albumId/tracks", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    res.json(await AlbumQueryService.getAlbumTracks(albumId));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:albumId/monitor", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    const monitored = parseOptionalMonitored((req.body as any)?.monitored);

    const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;

    if (!albumExists) {
      if (monitored) {
        TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
        return res.status(202).json({
          success: true,
          albumId,
          monitored,
          message: 'Album not yet in library; scan queued',
        });
      }
      return res.status(404).json({ detail: "Album not found" });
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

    res.json({
      success: true,
      albumId,
      monitored,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:albumId/similar", (req, res) => {
  try {
    res.json(AlbumQueryService.getSimilarAlbums(req.params.albumId));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});


// Get other versions of an album (same version_group)
router.get("/:albumId/versions", (req, res) => {
  try {
    res.json(AlbumQueryService.getAlbumVersions(req.params.albumId));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Monitor a single track: ensure album exists, lock + optionally queue download
router.post("/track/:trackId/monitor", async (req, res) => {
  try {
    const { trackId } = req.params;
    const shouldDownload = (req.body as any)?.download !== undefined
      ? Boolean((req.body as any)?.download)
      : true;

    const trackData = await getTrack(trackId);
    const albumId = trackData?.album_id ? String(trackData.album_id) : null;
    if (!albumId) {
      return res.status(404).json({ detail: "Track missing album info" });
    }

    const trackInDb = db.prepare("SELECT id FROM media WHERE id = ?").get(trackId) as any;
    if (!trackInDb) {
      TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
      return res.status(202).json({
        success: true,
        trackId,
        albumId,
        message: 'Track not yet in library; album scan queued',
      });
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
      return res.status(404).json({ detail: "Track not found" });
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

    res.json({ success: true, monitored_track: trackId, jobId });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const albumId = getRequiredIdentifier(body, "id");
    const shouldDownload = body.download !== undefined
      ? Boolean(body.download)
      : true;

    const album = db.prepare(`
      SELECT a.id, a.title, a.cover, a.quality, ar.name as artist_name
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?
    `).get(albumId) as any;

    if (!album) {
      return res.status(404).json({ detail: "Album not found" });
    }

    // Lock album + all audio tracks as wanted
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
      const artistNames = albumArtists.map((a) => a.name);

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

    res.json({ success: true, albumId, jobId });
  } catch (error: any) {
    console.error(`[Albums] Failed to add album:`, error);
    res.status(500).json({ detail: error.message });
  }
});

router.patch("/:albumId", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored", "monitor_lock"], "Album update");
    const monitored = getOptionalBoolean(body, "monitored");
    const monitorLock = getOptionalBoolean(body, "monitor_lock");

    if (monitored === undefined && monitorLock === undefined) {
      return res.json({ success: true });
    }

    const albumExists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;
    if (!albumExists && monitored === true) {
      TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
      return res.status(202).json({
        success: true,
        albumId,
        monitored,
        message: 'Album not yet in library; scan queued',
      });
    }

    if (!albumExists) {
      return res.status(404).json({ detail: "Album not found" });
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

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    res.status(500).json({ detail: error.message });
  }
});

// Manual override: Lock album as wanted (persists across filter runs)
router.post("/:albumId/lock-wanted", async (req, res) => {
  try {
    const { albumId } = req.params;
    const shouldDownload = (req.body as any)?.download !== undefined
      ? Boolean((req.body as any)?.download)
      : true;

    const exists = db.prepare("SELECT id FROM albums WHERE id = ?").get(albumId) as any;
    if (!exists) {
      TaskQueueService.addJob(JobTypes.ScanAlbum, { albumId, forceUpdate: false }, albumId, 1, 1);
      return res.status(202).json({
        success: true,
        albumId,
        message: 'Album not yet in library; scan queued',
      });
    }

    // Set monitor=1 and monitor_lock=1 (manual want, locked from filter changes)
    const result = db.prepare(`
      UPDATE albums 
      SET monitor = 1,
          monitor_lock = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(albumId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Album not found" });
    }

    // Also lock all audio tracks on this album
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
      const album = db.prepare(`
        SELECT a.id, a.title, a.cover, a.quality, ar.name as artist_name
        FROM albums a
        LEFT JOIN artists ar ON ar.id = a.artist_id
        WHERE a.id = ?
      `).get(albumId) as any;

      const albumArtists = db.prepare(`
        SELECT a.name
        FROM album_artists aa
        JOIN artists a ON a.id = aa.artist_id
        WHERE aa.album_id = ?
      `).all(albumId) as any[];
      const artistNames = albumArtists.map((a) => a.name);

      jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
        url: `https://listen.tidal.com/album/${albumId}`,
        type: 'album',
        tidalId: albumId,
        title: album?.title || 'Unknown',
        artist: album?.artist_name || artistNames[0] || 'Unknown',
        artists: artistNames,
        cover: album?.cover || null,
        quality: album?.quality || null,
      }, albumId.toString(), 0, 1);
    }

    res.json({ success: true, locked: true, wanted: true, jobId });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Manual override: Lock album as unwanted (persists across filter runs)
router.post("/:albumId/lock-unwanted", (req, res) => {
  try {
    const { albumId } = req.params;

    // Set monitor=0 and monitor_lock=1 (manual exclusion, locked from filter changes)
    const stmt = db.prepare(`
      UPDATE albums 
      SET monitor = 0,
          monitor_lock = 1,
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `);
    const result = stmt.run(albumId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Album not found" });
    }

    // Also lock all tracks on this album
    db.prepare(`
      UPDATE media 
      SET monitor = 0,
          monitor_lock = 1,
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE album_id = ? AND type != 'Music Video'
    `).run(albumId);

    refreshAlbumState(albumId);

    res.json({ success: true, locked: true, wanted: false });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Reset override: Unlock album (let filter decide)
router.post("/:albumId/reset-override", (req, res) => {
  try {
    const { albumId } = req.params;

    // Clear monitor_lock flag - filter can now auto-set monitor status
    const stmt = db.prepare(`
      UPDATE albums 
      SET monitor_lock = 0,
          locked_at = NULL
      WHERE id = ?
    `);
    const result = stmt.run(albumId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Album not found" });
    }

    // Also unlock all tracks on this album
    db.prepare(`
      UPDATE media 
      SET monitor_lock = 0,
          locked_at = NULL
      WHERE album_id = ? AND type != 'Music Video'
    `).run(albumId);

    refreshAlbumState(albumId);

    res.json({ success: true, filter_locked: false, message: "Album unlocked - filter will re-evaluate on next run" });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
