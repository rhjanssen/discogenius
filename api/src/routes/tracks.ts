import { Router } from "express";
import { db } from "../database.js";
import { getMediaDownloadStateMap, updateAlbumDownloadStatus } from "../services/download-state.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

const trackDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM library_files lf
    WHERE lf.media_id = media.id
      AND lf.file_type = 'track'
  )
`;

function refreshTrackState(trackId: string) {
  if (!trackId) return;

  const row = db.prepare(`
    SELECT album_id
    FROM media
    WHERE id = ? AND album_id IS NOT NULL
  `).get(trackId) as { album_id?: number | null } | undefined;

  if (row?.album_id) {
    updateAlbumDownloadStatus(String(row.album_id));
  }
}

/**
 * Tracks routes - queries the unified 'media' table where album_id IS NOT NULL
 * Tracks are media items that belong to albums (vs. videos which have type='Music Video')
 * Updated for new schema where:
 * - 'media' table replaces 'tracks' table
 * - 'id' is the primary key (INT, TIDAL track id)
 * - 'quality' replaces 'audio_quality'
 * - 'monitor' replaces 'monitored'
 */

router.get("/", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;
    const monitoredParam = req.query.monitored as string | undefined;
    const monitoredFilter =
      monitoredParam === undefined
        ? undefined
        : ["1", "true", "yes", "on"].includes(monitoredParam.toLowerCase());
    const downloadedParam = req.query.downloaded as string | undefined;
    const downloadedFilter =
      downloadedParam === undefined
        ? undefined
        : ["1", "true", "yes", "on"].includes(downloadedParam.toLowerCase());
    const libraryFilter = (req.query.library_filter as string | undefined) || 'all';

    const sortParam = (req.query.sort as string | undefined) || 'releaseDate';
    const dirParam = (req.query.dir as string | undefined) || 'desc';
    const sortDir = dirParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let query = `
      SELECT 
        media.*,
        albums.title as album_title,
        albums.cover as album_cover,
        artists.name as artist_name
      FROM media 
      LEFT JOIN albums ON media.album_id = albums.id
      LEFT JOIN artists ON media.artist_id = artists.id
    `;
    let countQuery = `
      SELECT COUNT(*) as total
      FROM media
      LEFT JOIN albums ON media.album_id = albums.id
      LEFT JOIN artists ON media.artist_id = artists.id
    `;
    const params: any[] = [];
    const countParams: any[] = [];
    const where: string[] = ["media.album_id IS NOT NULL"];

    if (search) {
      where.push("(media.title LIKE ? OR artists.name LIKE ?)");
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam);
      countParams.push(searchParam, searchParam);
    }

    if (monitoredFilter !== undefined) {
      where.push("media.monitor = ?");
      params.push(monitoredFilter ? 1 : 0);
      countParams.push(monitoredFilter ? 1 : 0);
    }

    if (downloadedFilter !== undefined) {
      where.push(downloadedFilter ? trackDownloadedPredicate : `NOT (${trackDownloadedPredicate})`);
    }

    if (libraryFilter === 'atmos') {
      where.push(`UPPER(COALESCE(media.quality, '')) = 'DOLBY_ATMOS'`);
    } else if (libraryFilter === 'stereo') {
      where.push(`UPPER(COALESCE(media.quality, '')) <> 'DOLBY_ATMOS'`);
    }

    if (where.length) {
      const whereClause = ` WHERE ${where.join(' AND ')}`;
      query += whereClause;
      countQuery += whereClause;
    }

    const orderBy = (() => {
      switch (sortParam) {
        case 'name':
          return ` ORDER BY media.title ${sortDir}, media.id ASC`;
        case 'popularity':
          return ` ORDER BY COALESCE(media.popularity, 0) ${sortDir}, media.id ASC`;
        case 'scannedAt':
          return ` ORDER BY (media.last_scanned IS NULL) ASC, media.last_scanned ${sortDir}, media.id ASC`;
        case 'releaseDate':
        default:
          return ` ORDER BY (media.release_date IS NULL) ASC, media.release_date ${sortDir}, media.id ASC`;
      }
    })();

    query += `${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const tracks = db.prepare(query).all(...params) as any[];
    const totalResult = db.prepare(countQuery).get(...countParams) as any;
    const downloadStates = getMediaDownloadStateMap(tracks.map((track) => track.id), "track");

    const transformed = tracks.map(track => ({
      ...track,
      is_monitored: Boolean(track.monitor),
      downloaded: downloadStates.get(String(track.id)) ? 1 : 0,
      is_downloaded: downloadStates.get(String(track.id)) ?? false,
    }));

    res.json({
      items: transformed,
      total: totalResult.total,
      limit,
      offset,
      hasMore: offset + tracks.length < totalResult.total
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:trackId", (req, res) => {
  try {
    const track = db.prepare(`
      SELECT 
        media.*,
        albums.title as album_title,
        albums.cover as album_cover,
        artists.name as artist_name
      FROM media 
      LEFT JOIN albums ON media.album_id = albums.id
      LEFT JOIN artists ON media.artist_id = artists.id
      WHERE media.id = ? AND media.album_id IS NOT NULL
    `).get(req.params.trackId) as any;

    if (!track) {
      return res.status(404).json({ detail: "Track not found" });
    }

    const transformed = {
      ...track,
      is_monitored: Boolean(track.monitor),
      downloaded: getMediaDownloadStateMap([track.id], "track").get(String(track.id)) ? 1 : 0,
      is_downloaded: getMediaDownloadStateMap([track.id], "track").get(String(track.id)) ?? false,
    };

    res.json(transformed);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:trackId/files", (req, res) => {
  try {
    const trackId = req.params.trackId;
    const files = db.prepare(`
      SELECT id, file_type, file_path, file_size, extension, created_at, modified_at
      FROM library_files
      WHERE media_id = ?
      ORDER BY file_type ASC, file_path ASC
    `).all(trackId) as any[];

    res.json({ items: files });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

import { seedTrack } from "../services/scanner.js";

router.post("/", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const trackId = getRequiredIdentifier(body, "id");

    const trackData = await seedTrack(trackId, { monitorArtist: true });
    const albumId = String(trackData.album_id);

    db.prepare(`
      UPDATE albums
      SET monitor = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(albumId);

    db.prepare(`
      UPDATE media
      SET monitor = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND album_id = ? AND type != 'Music Video'
    `).run(trackId, albumId);

    refreshTrackState(trackId);

    res.json({ success: true, message: "Track added", track: trackData });
  } catch (error: any) {
    console.error(`[Tracks] Failed to add track:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Toggle track monitoring via POST for the track action flow
router.post("/:trackId/monitor", (req, res) => {
  try {
    const trackId = req.params.trackId;
    const body = getObjectBody(req.body);
    const monitored = getRequiredBoolean(body, "monitored");

    const result = db.prepare(
      "UPDATE media SET monitor = ? WHERE id = ? AND album_id IS NOT NULL"
    ).run(monitored ? 1 : 0, trackId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Track not found" });
    }

    refreshTrackState(trackId);

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Tracks] Error setting monitor:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Manual override: Lock track as wanted (persists across filter runs)
router.post("/:trackId/lock-wanted", (req, res) => {
  try {
    const trackId = req.params.trackId;

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

    refreshTrackState(trackId);

    res.json({ success: true, locked: true, wanted: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Manual override: Lock track as unwanted (persists across filter runs)
router.post("/:trackId/lock-unwanted", (req, res) => {
  try {
    const trackId = req.params.trackId;

    const result = db.prepare(`
      UPDATE media
      SET monitor = 0,
          monitor_lock = 1,
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND album_id IS NOT NULL
    `).run(trackId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Track not found" });
    }

    refreshTrackState(trackId);

    res.json({ success: true, locked: true, wanted: false });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Reset override: Unlock track (let filter decide)
router.post("/:trackId/reset-override", (req, res) => {
  try {
    const trackId = req.params.trackId;

    const result = db.prepare(`
      UPDATE media
      SET monitor_lock = 0,
          locked_at = NULL
      WHERE id = ? AND album_id IS NOT NULL
    `).run(trackId);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Track not found" });
    }

    refreshTrackState(trackId);

    res.json({ success: true, locked: false });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Update track (toggle monitoring, etc.)
router.patch("/:trackId", (req, res) => {
  try {
    const trackId = req.params.trackId;
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored"], "Track update");
    const updates: string[] = [];
    const values: any[] = [];
    const monitored = getOptionalBoolean(body, "monitored");

    if (monitored !== undefined) {
      updates.push("monitor = ?");
      values.push(monitored ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.json({ success: true });
    }

    values.push(trackId);

    const result = db.prepare(`UPDATE media SET ${updates.join(", ")} WHERE id = ? AND album_id IS NOT NULL`)
      .run(...values);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Track not found" });
    }

    refreshTrackState(trackId);

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Tracks] Error updating track:`, error);
    res.status(500).json({ detail: error.message });
  }
});

export default router;
