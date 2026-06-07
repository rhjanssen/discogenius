import { Router } from "express";
import { db } from "../database.js";
import { invalidateReleaseGroupDownloadStatus } from "../services/download-state.js";
import {
  getTrackDetail,
  getTrackFiles,
  listTracks,
} from "../services/track-query-service.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredBoolean,
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

function getCanonicalTrackReleaseGroup(trackId: string): { release_group_mbid: string; artist_mbid: string } | null {
  const row = db.prepare(`
    SELECT release.release_group_mbid, release.artist_mbid
    FROM Tracks track
    JOIN AlbumReleases release ON release.mbid = track.release_mbid
    WHERE track.mbid = ?
    LIMIT 1
  `).get(trackId) as { release_group_mbid?: string | null; artist_mbid?: string | null } | undefined;

  if (!row?.release_group_mbid || !row.artist_mbid) {
    return null;
  }

  return {
    release_group_mbid: String(row.release_group_mbid),
    artist_mbid: String(row.artist_mbid),
  };
}

function setCanonicalTrackMonitoring(trackId: string, monitored: boolean): boolean {
  const canonicalTrack = getCanonicalTrackReleaseGroup(trackId);
  if (!canonicalTrack) {
    return false;
  }

  const wanted = monitored ? 1 : 0;
  const result = db.prepare(`
    UPDATE ReleaseGroupSlots
    SET wanted = ?, updated_at = CURRENT_TIMESTAMP
    WHERE release_group_mbid = ?
  `).run(wanted, canonicalTrack.release_group_mbid);

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ReleaseGroupSlots (
        artist_mbid, release_group_mbid, slot, wanted, match_status, updated_at
      ) VALUES (?, ?, 'stereo', ?, 'unmatched', CURRENT_TIMESTAMP)
      ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
        wanted = excluded.wanted,
        updated_at = CURRENT_TIMESTAMP
    `).run(canonicalTrack.artist_mbid, canonicalTrack.release_group_mbid, wanted);
  }

  invalidateReleaseGroupDownloadStatus(canonicalTrack.release_group_mbid);
  return true;
}

function hasCanonicalTrack(trackId: string): boolean {
  return Boolean(getCanonicalTrackReleaseGroup(trackId));
}

router.get("/", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;
    const monitoredFilter = parseOptionalQueryBoolean(req.query.monitored);
    const downloadedFilter = parseOptionalQueryBoolean(req.query.downloaded);
    const lockedFilter = parseOptionalQueryBoolean(req.query.locked);
    const libraryFilter = (req.query.library_filter as string | undefined) || 'all';

    const sortParam = (req.query.sort as string | undefined) || 'releaseDate';
    const dirParam = (req.query.dir as string | undefined) || 'desc';
    const sortDir = dirParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    res.json(listTracks({
      limit,
      offset,
      search,
      monitored: monitoredFilter,
      downloaded: downloadedFilter,
      locked: lockedFilter,
      libraryFilter,
      sort: sortParam,
      dir: sortDir,
    }));
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
    rejectUnknownKeys(body, ["monitored", "monitor_lock"], "Track update");
    const monitored = getOptionalBoolean(body, "monitored");
    const monitorLock = getOptionalBoolean(body, "monitor_lock");

    if (monitored === undefined && monitorLock === undefined) {
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
