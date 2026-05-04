import { Router } from "express";
import { AlbumQueryService } from "../services/album-query-service.js";
import { AlbumCommandService } from "../services/album-command-service.js";
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

router.get("/:albumId/page", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    const albumPage = await AlbumQueryService.getAlbumPage(albumId);

    if (!albumPage) {
      return res.status(404).json({ detail: "Album not found" });
    }

    res.json(albumPage);
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
    const result = AlbumCommandService.setAlbumMonitored(albumId, monitored);

    if (result.status === 404) {
      return res.status(404).json({ detail: "Album not found" });
    }

    const { status, ...body } = result;
    res.status(status || 200).json(body);
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

    const result = await AlbumCommandService.monitorTrack(trackId, shouldDownload);

    if (result.status === 404) {
      return res.status(404).json({ detail: result.message || "Track not found" });
    }

    const { status, message, ...body } = result;
    res.status(status || 200).json(message ? { ...body, message } : body);
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

    const result = await AlbumCommandService.addAlbum(albumId, shouldDownload);

    if (result.status === 404) {
      return res.status(404).json({ detail: result.message || "Album not found" });
    }
    if (result.status && result.status >= 400) {
      return res.status(result.status).json({ detail: result.message || "Album request failed" });
    }

    const { status, message, ...body2 } = result;
    res.status(status || 200).json(body2);
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

    const result = AlbumCommandService.updateAlbum(albumId, monitored, monitorLock);

    if (result.status === 404) {
      return res.status(404).json({ detail: result.message || "Album not found" });
    }

    const { status, message, ...body2 } = result;
    res.status(status || 200).json(message ? { ...body2, albumId, monitored, message } : body2);
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    res.status(500).json({ detail: error.message });
  }
});

export default router;
