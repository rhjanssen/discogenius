import { Router } from "express";
import { db, runWithAsyncBusyRetry } from "../../database.js";
import { CommandNames } from "../../services/commands/command-names.js";
import { CommandQueueManager } from "../../services/commands/command-queue-manager.js";
import { CommandTrigger } from "../../services/commands/command-trigger.js";
import { getVideoDetail, listVideos } from "../../services/music/video-query-service.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getOptionalString,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../../utils/request-validation.js";

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

router.get("/", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;
    const monitoredFilter = parseOptionalQueryBoolean(req.query.monitored);
    const downloadedFilter = parseOptionalQueryBoolean(req.query.downloaded);
    const lockedFilter = parseOptionalQueryBoolean(req.query.locked);
    const providerFilter = req.query.provider as string | undefined;

    const sortParam = (req.query.sort as string | undefined) || 'releaseDate';
    const dirParam = (req.query.dir as string | undefined) || 'desc';
    const sortDir = dirParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    res.json(listVideos({
      limit,
      offset,
      search,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
      locked: lockedFilter,
      provider: providerFilter,
      sort: sortParam,
      dir: sortDir,
    }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:videoId", async (req, res) => {
  try {
    const video = getVideoDetail(req.params.videoId);

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
    const providerId = getRequiredIdentifier(body, "id");
    const provider = getOptionalString(body, "provider");

    const commandId = await runWithAsyncBusyRetry(
      () => CommandQueueManager.push(
        CommandNames.SeedVideo,
        {
          providerId,
          provider,
          monitorArtist: true,
          monitorVideo: true,
          description: `Add video ${providerId}`,
        },
        provider ? `${provider}:${providerId}` : providerId,
        1,
        CommandTrigger.Manual,
      ),
      30,
      200,
    );

    res.status(202).json({
      success: true,
      queued: commandId !== -1,
      commandId,
      message: "Video add queued",
    });
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
    rejectUnknownKeys(body, ["monitored", "monitored_lock"], "Video update");
    const updates: string[] = [];
    const values: any[] = [];
    const monitored = getOptionalBoolean(body, "monitored");
    const monitoredLock = getOptionalBoolean(body, "monitored_lock");

    if (monitored !== undefined) {
      updates.push("monitored = ?");
      values.push(monitored ? 1 : 0);
    }

    if (monitoredLock !== undefined) {
      updates.push("monitored_lock = ?");
      values.push(monitoredLock ? 1 : 0);
      updates.push("locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END");
      values.push(monitoredLock ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.json({ success: true });
    }

    values.push(videoId);

    const canonicalUpdates = updates
      .map((update) => update
        .replace(/^monitored = \?$/, "monitored = ?")
        .replace(/^monitored_lock = \?$/, "monitored_lock = ?")
        .replace(/^locked_at = /, "locked_at = "))
      .concat("updated_at = CURRENT_TIMESTAMP");

    const canonicalResult = db.prepare(`
      UPDATE Recordings
      SET ${canonicalUpdates.join(", ")}
      WHERE is_video = 1 AND CAST(id AS TEXT) = CAST(? AS TEXT)
    `).run(...values);

    if (canonicalResult.changes > 0) {
      return res.json({ success: true });
    }

    return res.status(404).json({ detail: "Video not found" });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Videos] Error updating video:`, error);
    res.status(500).json({ detail: error.message });
  }
});

export default router;
