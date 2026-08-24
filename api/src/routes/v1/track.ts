import { Router } from "express";
import { runWithAsyncBusyRetry } from "../../database.js";
import {
  deletionScopeFromRequest,
  scopeToOptions,
} from "../../services/mediafiles/library-deletion-scope.js";
import { deleteTrackLibraryFiles } from "../../services/mediafiles/library-file-delete-service.js";
import {
  getTrackDetail,
  getTrackFiles,
  listTracks,
} from "../../services/music/track-query-service.js";
import {
  parseBoundedQueryInteger,
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

router.get("/", async (req, res) => {
  try {
    const limit = parseBoundedQueryInteger(req.query.limit, 100, { min: 1, max: 200 });
    const offset = parseBoundedQueryInteger(req.query.offset, 0);
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

export default router;
