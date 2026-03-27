import { Router } from "express";
import { db } from "../database.js";
import { parseMonitoringConfigUpdate } from "../contracts/config-updates.js";
import { getObjectBody, isRequestValidationError } from "../utils/request-validation.js";
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
} from "../services/task-scheduler.js";

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
        monitorNewArtists: status.config.monitor_new_artists,
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
    const currentStatus = getMonitoringStatus();
    const validatedUpdates = parseMonitoringConfigUpdate(getObjectBody(req.body), {
      enabled: currentStatus.config.enable_active_monitoring,
      scanIntervalHours: currentStatus.config.scan_interval_hours,
      startHour: currentStatus.config.start_hour,
      durationHours: currentStatus.config.duration_hours,
      monitorNewArtists: currentStatus.config.monitor_new_artists,
      removeUnmonitoredFiles: currentStatus.config.remove_unmonitored_files,
      artistRefreshDays: currentStatus.config.artist_refresh_days,
      albumRefreshDays: currentStatus.config.album_refresh_days,
      trackRefreshDays: currentStatus.config.track_refresh_days,
      videoRefreshDays: currentStatus.config.video_refresh_days,
      lastCheckTimestamp: currentStatus.config.lastCheckTimestamp ?? undefined,
      checkInProgress: currentStatus.config.checkInProgress,
      progressArtistIndex: currentStatus.config.progressArtistIndex,
    });
    const updates: any = {};
    if ("enabled" in validatedUpdates) updates.enable_active_monitoring = validatedUpdates.enabled;
    if ("startHour" in validatedUpdates) updates.start_hour = validatedUpdates.startHour;
    if ("durationHours" in validatedUpdates) updates.duration_hours = validatedUpdates.durationHours;
    if ("scanIntervalHours" in validatedUpdates) updates.scan_interval_hours = validatedUpdates.scanIntervalHours;
    if ("monitorNewArtists" in validatedUpdates) updates.monitor_new_artists = validatedUpdates.monitorNewArtists;
    if ("removeUnmonitoredFiles" in validatedUpdates) updates.remove_unmonitored_files = validatedUpdates.removeUnmonitoredFiles;
    if ("artistRefreshDays" in validatedUpdates) updates.artist_refresh_days = validatedUpdates.artistRefreshDays;
    if ("albumRefreshDays" in validatedUpdates) updates.album_refresh_days = validatedUpdates.albumRefreshDays;
    if ("trackRefreshDays" in validatedUpdates) updates.track_refresh_days = validatedUpdates.trackRefreshDays;
    if ("videoRefreshDays" in validatedUpdates) updates.video_refresh_days = validatedUpdates.videoRefreshDays;

    const config = updateMonitoringConfig(updates);

    // Convert back to camelCase for response
    const response = {
      enabled: config.enable_active_monitoring,
      scanIntervalHours: config.scan_interval_hours,
      startHour: config.start_hour,
      durationHours: config.duration_hours,
      monitorNewArtists: config.monitor_new_artists,
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
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
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




