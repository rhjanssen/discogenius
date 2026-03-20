import { Router } from "express";
import { db } from "../database.js";
import { getTrack } from "../services/tidal.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";
import { getMediaDownloadStateMap, updateAlbumDownloadStatus } from "../services/download-state.js";
import { AlbumQueryService } from "../services/album-query-service.js";
import type { AlbumTrackContract, LibraryFileContract } from "../contracts/media.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

function refreshAlbumState(albumId: string) {
  if (!albumId) return;
  updateAlbumDownloadStatus(albumId);
}

const parseOptionalMonitored = (value: unknown): boolean => {
  return value === undefined ? true : Boolean(value);
};

type AlbumTrackRow = {
  id: number | string;
  album_id: number | string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  artist_name?: string;
  album_title?: string;
  explicit?: boolean;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
};

type LibraryFileRow = {
  id: number;
  media_id: number | string | null;
  file_type: string;
  file_path: string;
  relative_path?: string;
  filename?: string;
  extension?: string;
  quality?: string | null;
  library_root?: string;
  file_size?: number;
  bitrate?: number;
  sample_rate?: number;
  bit_depth?: number;
  codec?: string;
  duration?: number;
};

function normalizeLibraryFileRow(file: LibraryFileRow): LibraryFileContract {
  return {
    id: file.id,
    media_id: file.media_id == null ? null : String(file.media_id),
    file_type: file.file_type,
    file_path: file.file_path,
    relative_path: file.relative_path,
    filename: file.filename,
    extension: file.extension,
    quality: file.quality ?? null,
    library_root: file.library_root,
    file_size: file.file_size,
    bitrate: file.bitrate,
    sample_rate: file.sample_rate,
    bit_depth: file.bit_depth,
    codec: file.codec,
    duration: file.duration,
  };
}

function getAlbumTrackRows(albumId: string): AlbumTrackRow[] {
  return db.prepare(`
    SELECT
      m.*,
      a.title as album_title,
      a.cover as album_cover,
      ar.name as artist_name
    FROM media m
    LEFT JOIN albums a ON a.id = m.album_id
    LEFT JOIN artists ar ON ar.id = m.artist_id
    WHERE m.album_id = ? AND m.type != 'Music Video'
    ORDER BY m.volume_number ASC, m.track_number ASC, m.id ASC
  `).all(albumId) as AlbumTrackRow[];
}

function getAlbumTrackStats(albumId: string): { storedTracks: number; missingTrackScans: number } {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as stored_tracks,
      SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_track_scans
    FROM media
    WHERE album_id = ? AND type != 'Music Video'
  `).get(albumId) as { stored_tracks?: number; missing_track_scans?: number } | undefined;

  return {
    storedTracks: Number(stats?.stored_tracks || 0),
    missingTrackScans: Number(stats?.missing_track_scans || 0),
  };
}

function hydrateAlbumTracks(tracks: AlbumTrackRow[]): AlbumTrackContract[] {
  const trackIds = tracks.map((track) => String(track.id));
  const downloadStates = getMediaDownloadStateMap(trackIds, "track");

  const filesByTrack = new Map<string, LibraryFileContract[]>();
  if (trackIds.length > 0) {
    const placeholders = trackIds.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT id, media_id, file_type, file_path, relative_path, filename, extension,
             quality, library_root, file_size, bitrate, sample_rate, bit_depth, codec, duration
      FROM library_files
      WHERE media_id IN (${placeholders})
        AND file_type IN ('track', 'lyrics')
      ORDER BY file_type ASC, id ASC
    `).all(...trackIds) as LibraryFileRow[];

    for (const file of files) {
      const mediaId = String(file.media_id);
      const bucket = filesByTrack.get(mediaId) || [];
      bucket.push(normalizeLibraryFileRow(file));
      filesByTrack.set(mediaId, bucket);
    }
  }

  return tracks.map((track) => {
    const trackId = String(track.id);
    const isDownloaded = downloadStates.get(trackId) ?? false;

    return {
      ...track,
      id: trackId,
      album_id: track.album_id != null ? String(track.album_id) : null,
      is_monitored: Boolean(track.monitor),
      monitor_locked: Boolean(track.monitor_lock),
      explicit: track.explicit === undefined ? undefined : Boolean(track.explicit),
      downloaded: isDownloaded,
      is_downloaded: isDownloaded,
      files: filesByTrack.get(trackId) || [],
    };
  });
}

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
    const monitoredParam = req.query.monitored as string | undefined;
    const monitoredFilter = monitoredParam === undefined
      ? undefined
      : ["1", "true", "yes", "on"].includes(monitoredParam.toLowerCase());
    const downloadedParam = req.query.downloaded as string | undefined;
    const downloadedFilter = downloadedParam === undefined
      ? undefined
      : ["1", "true", "yes", "on"].includes(downloadedParam.toLowerCase());

    res.json(AlbumQueryService.listAlbums({
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      search: req.query.search as string | undefined,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
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
    const album = db.prepare(`
      SELECT id, num_tracks, last_scanned
      FROM albums
      WHERE id = ?
    `).get(albumId) as any;

    const tracks = getAlbumTrackRows(albumId);
    if (tracks.length > 0) {
      return res.json(hydrateAlbumTracks(tracks));
    }

    res.json([]);
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
