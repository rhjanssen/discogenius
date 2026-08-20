import { Router } from "express";
import { db, runWithAsyncBusyRetry } from "../../database.js";
import { CommandNames } from "../../services/commands/command-names.js";
import { CommandQueueManager } from "../../services/commands/command-queue-manager.js";
import { CommandTrigger } from "../../services/commands/command-trigger.js";
import { emitLibraryUpdated } from "../../services/commands/app-events.js";
import {
  deletionScopeFromRequest,
  scopeToOptions,
} from "../../services/mediafiles/library-deletion-scope.js";
import { deleteVideoLibraryFiles } from "../../services/mediafiles/library-file-delete-service.js";
import {
  applyManualVideoPlacement,
  keepLibraryVideo,
  resolveVideoLibraryIds,
  selectLibraryVideo,
  unselectLibraryVideo,
  VideoPlacementError,
} from "../../services/music/library-video-monitoring.js";
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


/**
 * Manage → Delete library files for a video (disk + TrackFiles). Keeps catalog Recording.
 */
router.delete("/:videoId/files", (req, res) => {
  try {
    const scope = deletionScopeFromRequest({
      libraryId: req.query.libraryId,
      allLibraries: req.query.allLibraries,
    });
    const result = deleteVideoLibraryFiles(req.params.videoId, scopeToOptions(scope));
    res.json({ success: true, ...result });
  } catch (error: any) {
    if (error?.status === 400) {
      return res.status(400).json({ detail: error.message });
    }
    if (error?.status === 404) {
      return res.status(404).json({ detail: error.message || "Video not found" });
    }
    console.error(`[Videos] Failed to delete video files:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Update video (toggle monitoring, etc.)
router.patch("/:videoId", (req, res) => {
  try {
    const videoId = req.params.videoId;
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored", "monitored_lock", "placement", "keep"], "Video update");
    const monitored = getOptionalBoolean(body, "monitored");
    const monitoredLock = getOptionalBoolean(body, "monitored_lock");
    const keep = getOptionalBoolean(body, "keep");
    const placementBody = body.placement;
    if (monitored === undefined && monitoredLock === undefined && keep === undefined && placementBody === undefined) {
      return res.json({ success: true });
    }

    let placementInput: { mode: "separated" } | { mode: "inline"; inlineTrackId: number } | undefined;
    if (placementBody !== undefined) {
      if (!placementBody || typeof placementBody !== "object" || Array.isArray(placementBody)) {
        return res.status(400).json({ detail: "placement must be an object" });
      }
      const mode = (placementBody as { mode?: unknown }).mode;
      const inlineTrackId = (placementBody as { inlineTrackId?: unknown }).inlineTrackId;
      if (mode !== "separated" && mode !== "inline") {
        return res.status(400).json({ detail: "placement.mode must be separated or inline" });
      }
      if (mode === "inline") {
        if (typeof inlineTrackId !== "number" || !Number.isInteger(inlineTrackId) || inlineTrackId <= 0) {
          return res.status(400).json({ detail: "placement.inlineTrackId must be a positive integer" });
        }
        placementInput = { mode: "inline", inlineTrackId };
      } else {
        placementInput = { mode: "separated" };
      }
    }

    const recording = db.prepare(`
      SELECT id FROM Recordings
      WHERE is_video = 1 AND CAST(id AS TEXT) = CAST(? AS TEXT)
    `).get(videoId) as { id: number } | undefined;
    if (!recording) {
      return res.status(404).json({ detail: "Video not found" });
    }

    // Monitoring a video is a Video Library selecting it, not a flag on the
    // canonical recording — a video may be wanted by one video library and not
    // another. `monitored_lock` is the user saying "I chose this one", which is
    // recorded as a manual selection so curation leaves it alone.
    const videoLibraryIds = resolveVideoLibraryIds(db);
    const applied = db.transaction(() => {
      for (const libraryId of videoLibraryIds) {
        const existing = db.prepare(`
          SELECT selection_mode FROM LibraryVideos
          WHERE library_id = ? AND video_recording_id = ?
        `).get(libraryId, recording.id) as { selection_mode: string } | undefined;

        if (monitored === false) {
          unselectLibraryVideo(db, libraryId, recording.id);
          continue;
        }
        if (monitored === true || (monitoredLock === true && !existing)) {
          selectLibraryVideo(db, {
            libraryId,
            videoRecordingId: recording.id,
            // Placement is decided by video curation; a bare monitor request
            // says nothing about where the file belongs.
            placement: { mode: "separated" },
            selectionMode: monitoredLock === true ? "manual" : "auto",
            reason: "user",
          });
          continue;
        }
        if (monitoredLock !== undefined && existing) {
          db.prepare(`
            UPDATE LibraryVideos
            SET selection_mode = ?, updated_at = CURRENT_TIMESTAMP
            WHERE library_id = ? AND video_recording_id = ?
          `).run(monitoredLock ? "manual" : "auto", libraryId, recording.id);
        }
      }
      // Unmonitor wins over keep. Keep is the user retaining an `inline_only`
      // loser that curation would otherwise leave unselected.
      if (keep === true && monitored !== false) {
        keepLibraryVideo(db, recording.id);
      }
      if (placementInput) {
        return applyManualVideoPlacement(db, recording.id, placementInput);
      }
      return null;
    })();
    if (applied?.artistId) {
      CommandQueueManager.push(
        CommandNames.RenameFiles,
        { artistId: applied.artistId, fileTypes: ["video"], applyAll: true },
        applied.artistId,
        1,
        CommandTrigger.Manual,
      );
    }

    emitLibraryUpdated({
      reason: monitored === false ? "video-unmonitored" : "video-monitoring-updated",
      libraryIds: videoLibraryIds,
    });

    return res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error) || error instanceof VideoPlacementError || error?.status === 400) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Videos] Error updating video:`, error);
    res.status(500).json({ detail: error.message });
  }
});

export default router;
