import { Router } from "express";
import { db } from "../database.js";
import {
  queueArtistWorkflow,
} from "../services/artist-workflow.js";
import {
  loadArtistWithEffectiveMonitor,
  monitorArtistAndQueueIntake,
  queueArtistRefreshScan,
  requireArtistName,
  setArtistMonitoredState,
} from "../services/artist-monitoring.js";
import { ArtistQueryService } from "../services/artist-query-service.js";
import { FollowedArtistsImportService } from "../services/followed-artists-import.js";
import {
  getObjectBody,
  getOptionalBoolean,
  getRequiredIdentifier,
  isRequestValidationError,
  rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

const parseOptionalMonitored = (value: unknown): boolean => {
  return value === undefined ? true : Boolean(value);
};

router.get("/", async (req, res) => {
  try {
    const monitoredParam = req.query.monitored as string | undefined;
    const monitoredFilter = monitoredParam === undefined
      ? undefined
      : ["1", "true", "yes", "on"].includes(monitoredParam.toLowerCase());
    const includeDownloadStatsParam = req.query.includeDownloadStats as string | undefined;
    const includeDownloadStats = includeDownloadStatsParam === undefined
      ? true
      : ["1", "true", "yes", "on"].includes(includeDownloadStatsParam.toLowerCase());

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
      const summary = await FollowedArtistsImportService.importFollowedArtists({
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
    const page = await ArtistQueryService.getArtistPageDb(req.params.artistId);
    if (!page) {
      return res.status(404).json({ detail: "Artist not found" });
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

router.post("/import-followed", async (_, res) => {
  try {
    res.json(await FollowedArtistsImportService.importFollowedArtists());
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

router.post("/:artistId/redundancy", async (req, res) => {
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
    const artistId = getRequiredIdentifier(body, "id");

    // Ensure basic artist metadata exists and mark as monitored, then queue full scan.
    const { jobId } = await monitorArtistAndQueueIntake({
      artistId,
      priority: 1,
      trigger: 1,
    });

    res.json({
      success: true,
      id: artistId,
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

// Get artist page from Tidal (for dynamic layout on Artist Detail Page)
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
