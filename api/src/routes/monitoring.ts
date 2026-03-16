import { Router } from "express";
import { db } from "../database.js";
import {
  getMonitoringStatus,
  updateMonitoringConfig,
  startMonitoring,
  stopMonitoring,
  checkNowStreaming,
  queueMonitoringCyclePass,
  queueMetadataRefreshPass,
  queueCurationPass,
  queueDownloadMissingPass,
  queueCheckUpgradesPass,
} from "../services/monitoring-scheduler.js";

const router = Router();

// Get monitoring status and config
router.get("/status", (_, res) => {
  try {
    const status = getMonitoringStatus();

    // Convert snake_case to camelCase for frontend
    const response = {
      running: status.running,
      checking: status.checking,
      config: {
        enabled: status.config.enable_active_monitoring,
        scanIntervalHours: status.config.scan_interval_hours,
        startHour: status.config.start_hour,
        durationHours: status.config.duration_hours,
        removeUnmonitoredFiles: status.config.remove_unmonitored_files,
        artistRefreshDays: status.config.artist_refresh_days,
        albumRefreshDays: status.config.album_refresh_days,
        trackRefreshDays: status.config.track_refresh_days,
        videoRefreshDays: status.config.video_refresh_days,
        lastCheckTimestamp: status.config.lastCheckTimestamp,
        checkInProgress: status.config.checkInProgress,
        progressArtistIndex: status.config.progressArtistIndex,
      },
    };

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Update monitoring config
router.post("/config", (req, res) => {
  try {
    const {
      enabled,
      startHour,
      durationHours,
      scanIntervalHours,
      removeUnmonitoredFiles,
      artistRefreshDays,
      albumRefreshDays,
      trackRefreshDays,
      videoRefreshDays,
    } = req.body;

    const updates: any = {};
    if (enabled !== undefined) updates.enable_active_monitoring = enabled;
    if (startHour !== undefined) updates.start_hour = startHour;
    if (durationHours !== undefined) updates.duration_hours = durationHours;
    if (scanIntervalHours !== undefined) updates.scan_interval_hours = scanIntervalHours;
    if (removeUnmonitoredFiles !== undefined) updates.remove_unmonitored_files = removeUnmonitoredFiles;
    if (artistRefreshDays !== undefined) updates.artist_refresh_days = artistRefreshDays;
    if (albumRefreshDays !== undefined) updates.album_refresh_days = albumRefreshDays;
    if (trackRefreshDays !== undefined) updates.track_refresh_days = trackRefreshDays;
    if (videoRefreshDays !== undefined) updates.video_refresh_days = videoRefreshDays;

    const config = updateMonitoringConfig(updates);

    // Convert back to camelCase for response
    const response = {
      enabled: config.enable_active_monitoring,
      scanIntervalHours: config.scan_interval_hours,
      startHour: config.start_hour,
      durationHours: config.duration_hours,
      removeUnmonitoredFiles: config.remove_unmonitored_files,
      artistRefreshDays: config.artist_refresh_days,
      albumRefreshDays: config.album_refresh_days,
      trackRefreshDays: config.track_refresh_days,
      videoRefreshDays: config.video_refresh_days,
      lastCheckTimestamp: config.lastCheckTimestamp,
      checkInProgress: config.checkInProgress,
      progressArtistIndex: config.progressArtistIndex,
    };

    res.json({ success: true, config: response });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Start monitoring
router.post("/start", (_, res) => {
  try {
    startMonitoring();
    res.json({ success: true, message: "Monitoring started" });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Stop monitoring
router.post("/stop", (_, res) => {
  try {
    stopMonitoring();
    res.json({ success: true, message: "Monitoring stopped" });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

const queueCurateArtists = (_: any, res: any) => {
  try {
    const jobId = queueCurationPass({ trigger: 1 });

    res.json({
      success: true,
      jobId,
      message: "Queued curation for monitored artists.",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
};

router.post("/curate", queueCurateArtists);

// Trigger manual metadata refresh — metadata only, no local scan, curation, or downloads.
router.post("/check", (_, res) => {
  try {
    const jobId = queueMetadataRefreshPass({ trigger: 1 });

    res.json({
      success: true,
      jobId,
      message: "Queued a metadata refresh command.",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Trigger the full metadata refresh -> local scan/import -> curation -> download workflow.
router.post("/trigger-all", (_, res) => {
  try {
    const jobId = queueMonitoringCyclePass({ trigger: 1, includeRootScan: true });

    res.json({
      success: true,
      jobId,
      message: "Queued a monitoring cycle.",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Streaming version of check for real-time progress
router.get("/check-stream", async (_, res) => {
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
    const result = await checkNowStreaming(sendEvent);

    sendEvent('complete', {
      success: true,
      newAlbums: result.newAlbums,
      artists: result.artists,
      message: `Found ${result.newAlbums} new album(s) from ${result.artists} monitored artist(s)`
    });

    res.end();
  } catch (error: any) {
    sendEvent('error', {
      message: 'Failed to check for new releases',
      error: error.message
    });
    res.end();
  }
});

// Queue downloads for all monitored but missing items
// Separate from scanning - allows user to review curation before downloading
router.post("/download-missing", async (_, res) => {
  try {
    const jobId = queueDownloadMissingPass({ trigger: 1 });
    res.json({
      success: true,
      jobId,
      message: "Queued a download-missing command.",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Scan library for files that don't meet the current quality settings and queue upgrades
router.post("/check-upgrades", async (_, res) => {
  try {
    const jobId = queueCheckUpgradesPass({ trigger: 1 });
    res.json({
      success: true,
      jobId,
      message: "Queued an upgrade check command.",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
