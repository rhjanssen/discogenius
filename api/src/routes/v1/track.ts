import { Router } from "express";
import { db, runWithAsyncBusyRetry } from "../../database.js";
import { invalidateReleaseGroupDownloadStatus } from "../../services/download/download-state.js";
import {
  deletionScopeFromRequest,
  scopeToOptions,
} from "../../services/mediafiles/library-deletion-scope.js";
import { deleteTrackLibraryFiles } from "../../services/mediafiles/library-file-delete-service.js";
import { LibraryFilesService } from "../../services/mediafiles/library-files.js";
import {
  monitorAlbumInLibraries,
  resolveScopedLibraryIds,
  unmonitorAlbumInLibraries,
} from "../../services/music/library-album-monitoring.js";
import {
  getTrackDetail,
  getTrackFiles,
  listTracks,
} from "../../services/music/track-query-service.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredBoolean,
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

function getCanonicalTrackReleaseGroup(trackId: string): { release_group_id: number; release_group_mbid: string } | null {
  const row = db.prepare(`
    SELECT release_group.id AS release_group_id, release_group.mbid AS release_group_mbid
    FROM Tracks track
    JOIN AlbumEditions release ON release.id = track.album_edition_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    WHERE track.mbid = ?
    LIMIT 1
  `).get(trackId) as { release_group_id?: number | null; release_group_mbid?: string | null } | undefined;

  if (row?.release_group_id == null || !row.release_group_mbid) {
    return null;
  }

  return {
    release_group_id: Number(row.release_group_id),
    release_group_mbid: String(row.release_group_mbid),
  };
}

function setCanonicalTrackMonitoring(trackId: string, monitored: boolean): boolean {
  const canonicalTrack = getCanonicalTrackReleaseGroup(trackId);
  if (!canonicalTrack) {
    return false;
  }

  // A track belongs to an Album, and an Album is monitored per audio Library.
  // The Video Library is excluded: it curates canonical video Recordings, not
  // Albums, so a track action has nothing to say about it.
  const libraryIds = resolveScopedLibraryIds(db, { kind: "all-audio-libraries" });
  db.transaction(() => {
    if (monitored) {
      monitorAlbumInLibraries(db, canonicalTrack.release_group_id, libraryIds, {
        reason: "track_monitor_action",
        actor: "user",
      });
    } else {
      unmonitorAlbumInLibraries(db, canonicalTrack.release_group_id, libraryIds, {
        actor: "user",
      });
    }
  })();

  if (!monitored) {
    LibraryFilesService.pruneUnmonitoredForReleaseGroup(canonicalTrack.release_group_mbid);
  }

  invalidateReleaseGroupDownloadStatus(canonicalTrack.release_group_mbid);
  return true;
}

function hasCanonicalTrack(trackId: string): boolean {
  return Boolean(getCanonicalTrackReleaseGroup(trackId));
}

router.get("/", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;
    const monitoredFilter = parseOptionalQueryBoolean(req.query.monitored);
    const downloadedFilter = parseOptionalQueryBoolean(req.query.downloaded);
    const lockedFilter = parseOptionalQueryBoolean(req.query.locked);
    const libraryFilter = (req.query.library_filter as string | undefined) || 'all';
    const providerFilter = req.query.provider as string | undefined;
    const qualityTierFilter = req.query.quality_tier as string | undefined;

    const sortParam = (req.query.sort as string | undefined) || 'releaseDate';
    const dirParam = (req.query.dir as string | undefined) || 'desc';
    const sortDir = dirParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    res.json(await runWithAsyncBusyRetry(() => listTracks({
      limit,
      offset,
      search,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
      locked: lockedFilter,
      libraryFilter,
      provider: providerFilter,
      qualityTier: qualityTierFilter,
      sort: sortParam,
      dir: sortDir,
    }), 20, 100));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:trackId", (req, res) => {
  try {
    const track = getTrackDetail(req.params.trackId);

    if (!track) {
      return res.status(404).json({ detail: "Track not found" });
    }

    res.json(track);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:trackId/files", (req, res) => {
  try {
    res.json({ items: getTrackFiles(req.params.trackId) });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

/**
 * Manage → Delete files for a track (disk + TrackFiles). Keeps catalog rows.
 */
router.delete("/:trackId/files", (req, res) => {
  try {
    const scope = deletionScopeFromRequest({
      libraryId: req.query.libraryId,
      allLibraries: req.query.allLibraries,
    });
    const result = deleteTrackLibraryFiles(req.params.trackId, scopeToOptions(scope));
    res.json({ success: true, ...result });
  } catch (error: any) {
    if (error?.status === 400) {
      return res.status(400).json({ detail: error.message });
    }
    if (error?.status === 404) {
      return res.status(404).json({ detail: error.message || "Track not found" });
    }
    console.error(`[Tracks] Failed to delete track files:`, error);
    res.status(500).json({ detail: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const trackId = getRequiredIdentifier(body, "id");

    if (!setCanonicalTrackMonitoring(trackId, true)) {
      return res.status(404).json({ detail: "Track not found" });
    }

    const track = getTrackDetail(trackId);

    res.json({ success: true, message: "Track added", track });
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

    if (!setCanonicalTrackMonitoring(trackId, monitored)) {
      return res.status(404).json({ detail: "Track not found" });
    }

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Tracks] Error setting monitor:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Update track (toggle monitoring, lock, etc.)
router.patch("/:trackId", (req, res) => {
  try {
    const trackId = req.params.trackId;
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored", "monitored_lock"], "Track update");
    const monitored = getOptionalBoolean(body, "monitored");
    const monitoredLock = getOptionalBoolean(body, "monitored_lock");

    if (monitored === undefined && monitoredLock === undefined) {
      return res.json({ success: true });
    }

    if (!hasCanonicalTrack(trackId)) {
      return res.status(404).json({ detail: "Track not found" });
    }

    if (monitored !== undefined) {
      setCanonicalTrackMonitoring(trackId, monitored);
    }
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
