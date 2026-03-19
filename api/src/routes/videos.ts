import { Router } from "express";
import { db } from "../database.js";
import { getMediaDownloadStateMap, updateArtistDownloadStatusFromMedia } from "../services/download-state.js";
import { queueArtistBrowseHydration } from "../services/browse-hydration.js";
import { seedVideo } from "../services/scanner.js";
import type { VideoDetailContract } from "../contracts/media.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

const videoDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM library_files lf
    WHERE lf.media_id = media.id
      AND lf.file_type = 'video'
  )
`;

function refreshVideoState(videoId: string) {
  if (!videoId) return;
  updateArtistDownloadStatusFromMedia(videoId);
}

/**
 * Videos routes - queries the unified 'media' table with type='Music Video'
 * Updated for new schema where:
 * - 'media' table replaces 'videos' table
 * - 'id' is the primary key (INT, TIDAL video id)
 * - 'quality' is surfaced from the current video file when available,
 *   falling back to the source quality stored on media
 * - 'monitor' replaces 'monitored'
 */

router.get("/", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
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

    const sortParam = (req.query.sort as string | undefined) || 'releaseDate';
    const dirParam = (req.query.dir as string | undefined) || 'desc';
    const sortDir = dirParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let query = `
      SELECT 
        media.*,
        COALESCE((
          SELECT lf.quality
          FROM library_files lf
          WHERE lf.media_id = media.id
            AND lf.file_type = 'video'
          ORDER BY lf.verified_at DESC, lf.id DESC
          LIMIT 1
        ), media.quality) as current_quality,
        artists.name as artist_name
      FROM media 
      LEFT JOIN artists ON media.artist_id = artists.id
    `;

    let countQuery = `
      SELECT COUNT(*) as total
      FROM media
      LEFT JOIN artists ON media.artist_id = artists.id
    `;
    const params: any[] = [];
    const countParams: any[] = [];
    const where: string[] = ["media.type = 'Music Video'"];

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
      where.push(downloadedFilter ? videoDownloadedPredicate : `NOT (${videoDownloadedPredicate})`);
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

    const videos = db.prepare(query).all(...params) as any[];
    const totalResult = db.prepare(countQuery).get(...countParams) as any;
    const downloadStates = getMediaDownloadStateMap(videos.map((video) => video.id), "video");

    const transformed = videos.map((video): VideoDetailContract => {
      const { current_quality, ...rest } = video;
      const isDownloaded = downloadStates.get(String(video.id)) ?? false;
      return {
        ...rest,
        id: String(rest.id),
        artist_id: String(rest.artist_id),
        explicit: rest.explicit === undefined ? undefined : Boolean(rest.explicit),
        quality: current_quality || video.quality,
        cover_id: video.cover || null,
        is_monitored: Boolean(video.monitor),
        monitor_locked: Boolean(video.monitor_lock),
        downloaded: isDownloaded,
        is_downloaded: isDownloaded,
      };
    });

    res.json({
      items: transformed,
      total: totalResult.total,
      limit,
      offset,
      hasMore: offset + videos.length < totalResult.total
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    const queryVideo = () => db.prepare(`
      SELECT 
        media.*,
        COALESCE((
          SELECT lf.quality
          FROM library_files lf
          WHERE lf.media_id = media.id
            AND lf.file_type = 'video'
          ORDER BY lf.verified_at DESC, lf.id DESC
          LIMIT 1
        ), media.quality) as current_quality,
        artists.name as artist_name
      FROM media 
      LEFT JOIN artists ON media.artist_id = artists.id
      WHERE media.id = ? AND media.type = 'Music Video'
    `).get(req.params.videoId) as any;

    let video = queryVideo();

    if (!video) {
      try {
        await seedVideo(req.params.videoId, { monitorArtist: false });
      } catch {
        // Keep response behavior unchanged; return 404 below if still missing.
      }
      video = queryVideo();
    }

    if (!video) {
      return res.status(404).json({ detail: "Video not found" });
    }

    if (video.artist_id) {
      try {
        const artistRow = db.prepare(
          "SELECT last_scanned FROM artists WHERE id = ?"
        ).get(video.artist_id) as { last_scanned?: string | null } | undefined;
        if (!artistRow?.last_scanned) {
          queueArtistBrowseHydration(String(video.artist_id), video.artist_name || undefined);
        }
      } catch {
        // Browse hydration is best-effort and should not fail video rendering.
      }
    }

    const { current_quality, ...rest } = video;
    const downloadState = getMediaDownloadStateMap([video.id], "video").get(String(video.id)) ?? false;
    const transformed: VideoDetailContract = {
      ...rest,
      id: String(rest.id),
      artist_id: String(rest.artist_id),
      explicit: rest.explicit === undefined ? undefined : Boolean(rest.explicit),
      quality: current_quality || video.quality,
      cover_id: video.cover || null,
      is_monitored: Boolean(video.monitor),
      monitor_locked: Boolean(video.monitor_lock),
      downloaded: downloadState,
      is_downloaded: downloadState,
    };

    res.json(transformed);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const tidalId = getRequiredIdentifier(body, "id");

    const videoData = await seedVideo(tidalId, { monitorArtist: true });

    db.prepare(`
      UPDATE media
      SET monitor = 1,
          monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND type = 'Music Video'
    `).run(tidalId);

    refreshVideoState(tidalId);

    res.json({ success: true, message: "Video added", video: videoData });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Videos] Failed to add video:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Update video (toggle monitoring, etc.)
router.patch("/:videoId", (req, res) => {
  try {
    const videoId = req.params.videoId;
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored", "monitor_lock"], "Video update");
    const updates: string[] = [];
    const values: any[] = [];
    const monitored = getOptionalBoolean(body, "monitored");
    const monitorLock = getOptionalBoolean(body, "monitor_lock");

    if (monitored !== undefined) {
      updates.push("monitor = ?");
      values.push(monitored ? 1 : 0);
    }

    if (monitorLock !== undefined) {
      updates.push("monitor_lock = ?");
      values.push(monitorLock ? 1 : 0);
      updates.push("locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END");
      values.push(monitorLock ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.json({ success: true });
    }

    values.push(videoId);

    const result = db.prepare(`UPDATE media SET ${updates.join(", ")} WHERE id = ? AND type = 'Music Video'`)
      .run(...values);

    if (result.changes === 0) {
      return res.status(404).json({ detail: "Video not found" });
    }

    refreshVideoState(videoId);

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Videos] Error updating video:`, error);
    res.status(500).json({ detail: error.message });
  }
});

export default router;
