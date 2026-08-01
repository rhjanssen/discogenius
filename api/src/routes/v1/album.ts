import { Router } from "express";
import { AlbumQueryService } from "../../services/music/album-query-service.js";
import { AlbumCommandService } from "../../services/music/album-command-service.js";
import {
  deletionScopeFromRequest,
  scopeToOptions,
} from "../../services/mediafiles/library-deletion-scope.js";
import { deleteReleaseGroupLibraryFiles } from "../../services/mediafiles/library-file-delete-service.js";
import { LibraryReleaseSelectionService } from "../../services/music/library-release-selection-service.js";
import { db } from "../../database.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredIdentifier,
  getRequiredInteger,
  isRequestValidationError,
  rejectUnknownKeys,
  RequestValidationError,
} from "../../utils/request-validation.js";

const router = Router();

/**
 * Exclusive ("use only this") is the default, matching a normal click. Additive
 * is the deliberate Ctrl/Cmd-click or the explicit "Monitor alongside current
 * editions" control.
 */
function parseSelectionMode(
  body: Record<string, unknown>,
): "exclusive" | "additive" | undefined {
  const mode = body.mode;
  if (mode === undefined || mode === null) return undefined;
  if (mode !== "exclusive" && mode !== "additive") {
    throw new Error('mode must be "exclusive" or "additive"');
  }
  return mode;
}

/**
 * Which Libraries an Album command touches. Never inferred.
 *
 * Monitoring an Album in Stereo says nothing about Spatial, and the Video
 * Library is not an audio Library at all. A caller therefore names one Library,
 * or says `allLibraries` and means every audio Library on purpose.
 */
function parseAlbumLibraryScope(
  body: Record<string, unknown>,
): { kind: "library"; libraryId: number } | { kind: "all-audio-libraries" } {
  const libraryId = getOptionalInteger(body, "libraryId");
  const allLibraries = getOptionalBoolean(body, "allLibraries");
  if (libraryId != null && allLibraries === true) {
    throw new RequestValidationError('Pass either "libraryId" or "allLibraries", not both');
  }
  if (libraryId != null) return { kind: "library", libraryId };
  if (allLibraries === true) return { kind: "all-audio-libraries" };
  throw new RequestValidationError(
    'A library scope is required: pass "libraryId" for one library, or "allLibraries": true to apply to every audio library',
  );
}

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

// MusicBrainz release-group album routes. provider IDs are handled as selected
// offers by command/download services, not as catalog identity.
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
      provider: req.query.provider as string | undefined,
      qualityTier: req.query.quality_tier as string | undefined,
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
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["monitored", "libraryId", "allLibraries"], "Album monitor");
    const monitored = parseOptionalMonitored(body.monitored);
    const scope = parseAlbumLibraryScope(body);
    const result = AlbumCommandService.setAlbumMonitored(albumId, monitored, scope);

    if (result.status === 404) {
      return res.status(404).json({ detail: "Album not found" });
    }

    const { status, ...responseBody } = result;
    res.status(status || 200).json(responseBody);
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

// Get MusicBrainz releases belonging to the release group.
router.get("/:albumId/versions", async (req, res) => {
  try {
    res.json(await AlbumQueryService.getAlbumVersions(req.params.albumId));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:albumId/library-availability", (req, res) => {
  try {
    res.json(new LibraryReleaseSelectionService(db).getAvailability(req.params.albumId));
  } catch (error: any) {
    const status = String(error?.message || "").startsWith("Unknown release group") ? 404 : 500;
    res.status(status).json({ detail: error.message });
  }
});

router.patch("/:albumId/libraries/:libraryId/selection", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    rejectUnknownKeys(
      body,
      ["editionId", "providerEditionMatchId", "mode"],
      "Library release selection",
    );
    res.json(new LibraryReleaseSelectionService(db).selectRelease({
      releaseGroupMbid: req.params.albumId,
      libraryId: Number.parseInt(req.params.libraryId, 10),
      editionId: getRequiredInteger(body, "editionId"),
      providerEditionMatchId: getOptionalInteger(body, "providerEditionMatchId"),
      mode: parseSelectionMode(body),
    }));
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(error?.status === 409 ? 409 : 400).json({ detail: error.message });
  }
});

/**
 * Stop monitoring one Edition in one Library. Never deletes files — that is a
 * separate, explicit deletion command.
 */
router.delete("/:albumId/libraries/:libraryId/selection/:editionId", (req, res) => {
  try {
    res.json(new LibraryReleaseSelectionService(db).removeEdition({
      releaseGroupMbid: req.params.albumId,
      libraryId: Number.parseInt(req.params.libraryId, 10),
      editionId: Number.parseInt(req.params.editionId, 10),
    }));
  } catch (error: any) {
    res.status(error?.status === 409 ? 409 : 400).json({ detail: error.message });
  }
});

/** Make an already-monitored Edition the Primary one for its Album. */
router.patch("/:albumId/libraries/:libraryId/representative", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["editionId"], "Representative edition");
    res.json(new LibraryReleaseSelectionService(db).makeRepresentative({
      releaseGroupMbid: req.params.albumId,
      libraryId: Number.parseInt(req.params.libraryId, 10),
      editionId: getRequiredInteger(body, "editionId"),
    }));
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(error?.status === 409 ? 409 : 400).json({ detail: error.message });
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
    const slot = getOptionalString(body, "slot");
    const shouldDownload = body.download !== undefined
      ? Boolean(body.download)
      : true;
    rejectUnknownKeys(body, ["id", "download", "slot"], "Album add");

    const result = await AlbumCommandService.addAlbum(albumId, shouldDownload, slot);

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
    rejectUnknownKeys(
      body,
      ["monitored", "monitored_lock", "libraryId", "allLibraries"],
      "Album update",
    );
    const monitored = getOptionalBoolean(body, "monitored");
    const monitoredLock = getOptionalBoolean(body, "monitored_lock");
    if (monitored === undefined && monitoredLock === undefined) {
      return res.status(200).json({ success: true });
    }
    const scope = parseAlbumLibraryScope(body);

    const result = AlbumCommandService.updateAlbum(albumId, monitored, monitoredLock, scope);

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

/**
 * Delete files for an album (Manage → Delete files).
 * Query: libraryId=N or allLibraries=true (required when several libraries are
 * configured), slot=stereo|spatial (optional), unmonitor=true (optional).
 */
router.delete("/:albumId/files", (req, res) => {
  try {
    const albumId = req.params.albumId;
    const slotRaw = typeof req.query.slot === "string" ? req.query.slot.trim().toLowerCase() : "";
    const slot = slotRaw === "stereo" || slotRaw === "spatial" ? slotRaw : undefined;
    const unmonitor = parseOptionalQueryBoolean(req.query.unmonitor) === true;
    const scope = deletionScopeFromRequest({
      libraryId: req.query.libraryId,
      allLibraries: req.query.allLibraries,
    });
    const result = deleteReleaseGroupLibraryFiles(albumId, {
      ...scopeToOptions(scope),
      slot,
      unmonitor,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    if (error?.status === 400) {
      return res.status(400).json({ detail: error.message });
    }
    if (error?.status === 404) {
      return res.status(404).json({ detail: error.message || "Album not found" });
    }
    console.error(`[Albums] Failed to delete album files:`, error);
    res.status(500).json({ detail: error.message });
  }
});

/**
 * Choose which persisted acquisition plan a library executes for an edition,
 * or hand the choice back to the planner.
 */
router.patch("/:albumId/libraries/:libraryId/plan", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["editionId", "planKey", "automatic", "mode"], "Library plan selection");
    const service = new LibraryReleaseSelectionService(db);
    const editionId = getRequiredInteger(body, "editionId");
    const libraryId = Number.parseInt(req.params.libraryId, 10);
    const automatic = getOptionalBoolean(body, "automatic") === true;
    const planKey = getOptionalString(body, "planKey");

    if (automatic) {
      if (planKey) {
        return res.status(400).json({
          detail: "Specify either planKey or automatic, not both",
        });
      }
      return res.json(service.revertPlanToAutomatic({
        releaseGroupMbid: req.params.albumId,
        libraryId,
        editionId,
      }));
    }
    if (!planKey) {
      return res.status(400).json({ detail: "planKey is required unless automatic is true" });
    }
    res.json(service.choosePlan({
      releaseGroupMbid: req.params.albumId,
      libraryId,
      editionId,
      planKey,
      mode: parseSelectionMode(body),
    }));
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(error?.status === 409 ? 409 : 400).json({ detail: error.message });
  }
});

export default router;
