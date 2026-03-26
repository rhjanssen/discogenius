import { Router } from "express";
import { db } from "../database.js";
import { updateArtistDownloadStatusFromMedia } from "../services/download-state.js";
import { seedVideo } from "../services/scanner.js";
import { getVideoDetail, listVideos } from "../services/video-query-service.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

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
    res.json(listVideos({
      limit,
      offset,
      search,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
      sort: sortParam,
      dir: sortDir,
    }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    let video = getVideoDetail(req.params.videoId);

    if (!video) {
      try {
        await seedVideo(req.params.videoId, { monitorArtist: false });
      } catch {
        // Keep response behavior unchanged; return 404 below if still missing.
      }
      video = getVideoDetail(req.params.videoId);
    }

    if (!video) {
      return res.status(404).json({ detail: "Video not found" });
    }

    res.json(video);
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
