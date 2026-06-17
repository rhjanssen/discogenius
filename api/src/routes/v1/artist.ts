import { Router } from "express";
import { db } from "../../database.js";
import {
  queueArtistWorkflow,
} from "../../services/music/artist-workflow.js";
import {
  loadArtistWithEffectiveMonitor,
  monitorArtistAndQueueIntake,
  queueArtistRefreshScan,
  requireArtistName,
  setArtistMonitoredState,
} from "../../services/music/artist-monitoring.js";
import { MoveArtistService } from "../../services/mediafiles/move-artist-service.js";
import { ArtistQueryService } from "../../services/music/artist-query-service.js";
import { FollowedArtistsImportService } from "../../services/providers/followed-artists-import.js";
import { skyHookProxy, type LidarrArtist } from "../../services/metadata/skyhook-proxy.js";
import { registerMediaCoverProxyUrl, resolveMediaCoverProxyUrl } from "../../services/metadata/media-cover-service.js";
import { RefreshArtistService } from "../../services/music/refresh-artist-service.js";
import { ScanLevel } from "../../services/music/scan-types.js";
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
const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadArtistByMusicBrainzId(mbid: string): { id: string | number; monitor: number | null; picture?: string | null; cover_image_url?: string | null } | undefined {
  return db.prepare("SELECT id, monitored AS monitor, picture, cover_image_url FROM Artists WHERE mbid = ? LIMIT 1").get(mbid) as
    { id: string | number; monitor: number | null; picture?: string | null; cover_image_url?: string | null } | undefined;
}

function formatArtistLookupResult(artist: LidarrArtist) {
  const localArtist = loadArtistByMusicBrainzId(artist.id);
  const releaseGroupCount = Array.isArray(artist.Albums) ? artist.Albums.length : 0;
  const disambiguation = String(artist.disambiguation || "").trim();
  const details = [
    disambiguation || String(artist.type || "").trim(),
    releaseGroupCount > 0 ? `${releaseGroupCount} release groups` : null,
  ].filter(Boolean).join(" · ");

  const imageId = [
    localArtist?.picture,
    localArtist?.cover_image_url,
    skyHookProxy.getArtistImageUrl(artist),
  ].map((value) => {
    const text = value == null ? "" : String(value).trim();
    if (!text) return null;
    const resolved = resolveMediaCoverProxyUrl(text);
    if (resolved) return resolved;
    return /^\/MediaCoverProxy\//i.test(text) ? null : text;
  }).find(Boolean);

  return {
    id: localArtist?.id != null ? String(localArtist.id) : artist.id,
    mbid: artist.id,
    name: artist.artistname,
    type: "artist",
    subtitle: details || null,
    imageId: registerMediaCoverProxyUrl(imageId) || imageId,
    monitored: Boolean(localArtist?.monitor),
    in_library: Boolean(localArtist),
    quality: null,
    explicit: undefined,
  };
}

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

router.get("/", async (req, res) => {
  try {
    const monitoredFilter = parseOptionalQueryBoolean(req.query.monitored);
    const includeDownloadStats = parseOptionalQueryBoolean(req.query.includeDownloadStats) ?? true;

    res.json(ArtistQueryService.listArtists({
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      search: req.query.search as string | undefined,
      sort: req.query.sort as string | undefined,
      dir: req.query.dir as string | undefined,
      monitored: monitoredFilter,
      includeDownloadStats,
    }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/lookup", async (req, res) => {
  try {
    const term = String(req.query.term ?? req.query.query ?? "").trim();
    const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 50);

    if (!term || term.length < 2) {
      return res.status(400).json({ detail: "Search term must be at least 2 characters" });
    }

    const metadataArtists = await skyHookProxy.searchForNewArtist(term, limit);
    const seen = new Set<string>();
    const artists = metadataArtists
      .map(formatArtistLookupResult)
      .filter((artist) => {
        const key = String((artist as any).mbid || artist.id);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, limit);

    res.json({
      success: true,
      results: {
        artists,
        albums: [],
        tracks: [],
        videos: [],
      },
      remoteCatalogAvailable: false,
    });
  } catch (error: any) {
    console.error("[artists/lookup] Error:", error);
    res.status(500).json({ detail: error.message || "Artist lookup failed" });
  }
});

// Lightweight import - just adds artist IDs to database
// NOTE: Must be before /:artistId route to avoid being matched as a dynamic parameter
router.get("/import-followed-stream", async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Send heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    try {
      const providerId = typeof req.query.providerId === "string"
        ? req.query.providerId
        : typeof req.query.provider === "string"
          ? req.query.provider
          : null;
      const summary = await FollowedArtistsImportService.importFollowedArtists({
        providerId,
        onEvent: (event) => {
          const { type, ...data } = event;
          sendEvent(type, data);
        },
      });

      sendEvent('complete', summary);

      res.end();
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error: any) {
    console.error('Error importing followed artists:', error);
    sendEvent('error', {
      message: 'Failed to import followed artists',
      error: error.message
    });
    res.end();
  }
});

// Monitor an artist: Ensure basic metadata exists + set monitor=1.
// Discography scanning is a separate step (Get/Refresh Metadata or scheduled scans).
router.post("/:artistId/monitor", async (req, res) => {
  try {
    const artistId = req.params.artistId;
    const result = await setArtistMonitoredState({
      artistId,
      artistName: getOptionalString(getObjectBody(req.body), "name"),
      monitored: parseOptionalMonitored((req.body as any)?.monitored),
      priority: 1,
      trigger: 1,
    });

    if (!result) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json({
      success: true,
      artistId,
      monitored: Boolean(result.artist?.effective_monitor),
      queued: result.jobId !== -1,
      message: result.monitored
        ? "Artist monitored (scan queued)"
        : "Artist unmonitored",
    });
  } catch (error: any) {
    console.error("[artists/monitor] Error:", error);
    res.status(500).json({ detail: error.message });
  }
});

// Scan endpoint - queues a refresh & scan for the artist
router.post("/:artistId/scan", async (req, res) => {
  try {
    const artistId = req.params.artistId;

    const queued = await queueArtistRefreshScan(artistId, {
      forceUpdate: Boolean((req.body as any)?.forceUpdate),
    });

    if (!queued) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json({
      success: true,
      artistId,
      queued: queued.jobId !== -1,
      message: queued.jobId === -1
        ? "Refresh & scan already queued"
        : "Refresh & scan queued",
    });
  } catch (error: any) {
    console.error("Error scanning artist:", error);
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:artistId/path", (req, res) => {
  try {
    const artistId = req.params.artistId;
    const body = getObjectBody(req.body);
    const requestedPath = getOptionalString(body, "path");
    const moveFiles = getOptionalBoolean(body, "moveFiles") ?? false;
    const applyNamingTemplate = getOptionalBoolean(body, "applyNamingTemplate") ?? false;
    rejectUnknownKeys(body, ["path", "moveFiles", "applyNamingTemplate"], "Artist path update");

    const result = MoveArtistService.moveArtist({
      artistId,
      path: requestedPath,
      moveFiles,
      applyNamingTemplate,
    });

    if (!result) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json({
      success: true,
      artistId: result.artistId,
      artistName: result.artistName,
      path: result.path,
      oldPath: result.oldPath,
      changed: result.changed,
      queued: result.moveFilesQueued,
      jobId: result.jobId,
      renameStatus: result.renameStatus,
      message: result.moveFilesQueued
        ? "Artist path updated and file move queued"
        : result.changed
          ? "Artist path updated"
          : "Artist path unchanged",
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    console.error("[artists/path] Error:", error);
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:artistId/activity", (req, res) => {
  try {
    res.json(ArtistQueryService.getArtistActivity(req.params.artistId));
  } catch (error: any) {
    console.error("Error fetching artist activity:", error);
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:artistId", async (req, res) => {
  try {
    const artist = await ArtistQueryService.getArtistById(req.params.artistId);
    if (!artist) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json(artist);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});



router.get("/:artistId/albums", (req, res) => {
  try {
    res.json(ArtistQueryService.getArtistAlbums(req.params.artistId));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Database-backed artist page endpoint.
// Keep this route DB-first so page navigation stays responsive even while queue workers are busy.
router.get("/:artistId/page-db", async (req, res) => {
  try {
    let page = await ArtistQueryService.getArtistPageDb(req.params.artistId);
    
    // Auto-fetch collaborating artists on click
    if (!page && MUSICBRAINZ_MBID_RE.test(req.params.artistId)) {
      try {
        const queued = await queueArtistRefreshScan(req.params.artistId, { forceUpdate: true });
        if (queued) {
          page = await ArtistQueryService.getArtistPageDb(req.params.artistId);
        }
      } catch (err: any) {
        console.warn(`[artists] Failed to auto-fetch missing MBID ${req.params.artistId}:`, err.message);
      }
    }

    if (!page) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    if (
      page.needs_scan &&
      MUSICBRAINZ_MBID_RE.test(String(page.artist?.mbid || req.params.artistId)) &&
      RefreshArtistService.getScanLevel(String(page.artist?.id || req.params.artistId)) < ScanLevel.DEEP
    ) {
      const artistId = String(page.artist?.id || req.params.artistId);
      const artistName = String(page.artist?.name || artistId).trim();
      queueArtistWorkflow({
        artistId,
        artistName,
        workflow: "metadata-refresh",
        expandCreditedArtists: false,
        priority: -1,
      });
    }

    return res.json(page);
  } catch (error: any) {
    console.error('Error fetching artist page from DB:', error);
    res.status(500).json({ detail: error.message });
  }
});

router.patch("/:artistId", async (req, res) => {
  try {
    const artistId = req.params.artistId;
    const body = getObjectBody(req.body);
    const monitored = getOptionalBoolean(body, "monitored");
    rejectUnknownKeys(body, ["monitored"], "Artist update");

    if (monitored === undefined) {
      return res.json({ success: true });
    }

    const result = await setArtistMonitoredState({
      artistId,
      monitored,
      priority: 1,
      trigger: 1,
    });
    if (!result) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json({
      success: true,
      monitored: result.monitored,
      queued: result.jobId !== -1,
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    console.error(`[Artists] Error updating artist:`, error);
    res.status(500).json({ detail: error.message });
  }
});

router.delete("/:artistId", (req, res) => {
  try {
    db.prepare("DELETE FROM artists WHERE id = ?").run(req.params.artistId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/import-followed", async (req, res) => {
  try {
    const providerId = typeof (req.body as any)?.providerId === "string"
      ? (req.body as any).providerId
      : typeof (req.body as any)?.provider === "string"
        ? (req.body as any).provider
        : null;
    res.json(await FollowedArtistsImportService.importFollowedArtists({ providerId }));
  } catch (error: any) {
    console.error('Error importing followed artists:', error);
    res.status(500).json({ detail: error.message || 'Failed to import followed artists' });
  }
});

router.put("/:artistId", async (req, res) => {
  try {
    const { artistId } = req.params;
    const { monitored } = req.body;

    if (monitored === undefined) {
      return res.status(400).json({ detail: "Missing monitored field" });
    }

    const result = await setArtistMonitoredState({
      artistId,
      monitored: Boolean(monitored),
      priority: 1,
      trigger: 1,
    });
    if (!result) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    res.json({
      success: true,
      monitored: result.monitored,
      queued: result.jobId !== -1,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:artistId/curate", async (req, res) => {
  try {
    const { artistId } = req.params;
    const artist = loadArtistWithEffectiveMonitor(artistId);
    if (!artist) {
      return res.status(404).json({ detail: "Artist not found" });
    }

    const artistName = String(artist.name || "").trim() || requireArtistName(artistId);
    const jobId = queueArtistWorkflow({
      artistId,
      artistName,
      workflow: "curation",
      priority: 1,
      trigger: 1,
    });

    res.json({
      success: true,
      queued: jobId !== -1,
      jobId,
      message: `Queued curation for ${artistName}`,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});



router.post("/", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const artistId = getOptionalString(body, "mbid") ?? getRequiredIdentifier(body, "id");
    const artistName = getOptionalString(body, "name");
    rejectUnknownKeys(body, ["id", "mbid", "name"], "Artist add");

    // Ensure basic artist metadata exists and mark as monitored, then queue full scan.
    const { artist, jobId } = await monitorArtistAndQueueIntake({
      artistId,
      artistName,
      priority: 1,
      trigger: 1,
    });

    res.json({
      success: true,
      id: artist?.id != null ? String(artist.id) : artistId,
      queued: jobId !== -1,
      message: "Artist added to library (monitoring enabled, scan queued)"
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }

    console.error(`[Artists] Failed to add artist:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Artist pages are MusicBrainz/DB backed; provider offers are attached separately.
router.get("/:artistId/page", async (req, res) => {
  try {
    res.json(await ArtistQueryService.getRemoteArtistPage(req.params.artistId));
  } catch (error: any) {
    console.error(`[Artists] Failed to get artist page:`, error);
    res.status(500).json({ detail: error.message });
  }
});

// Get artist details from local database (grouped by module)
router.get("/:id/detail", async (req, res) => {
  try {
    const detail = await ArtistQueryService.getArtistDetail(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    res.json(detail);
  } catch (error: any) {
    console.error('Error fetching artist details:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
