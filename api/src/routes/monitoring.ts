import { CommandTrigger } from "../services/commands/command-trigger.js";
import { Router } from "express";
import { isSqliteBusyError, runWithAsyncBusyRetry } from "../database.js";
import { parseMonitoringConfigUpdate } from "../contracts/config-updates.js";
import { getObjectBody, isRequestValidationError } from "../utils/request-validation.js";
import {
  getMonitoringStatus,
  updateMonitoringConfig,
  startMonitoring,
  stopMonitoring,
  queueMonitoringCyclePass,
  queueMetadataRefreshPass,
  queueCurationPass,
  queueDownloadMissingPass,
  queueCheckUpgradesPass,
} from "../services/commands/scheduler.js";

const router = Router();

function runMonitoringUserWrite<T>(operation: () => T): Promise<T> {
  return runWithAsyncBusyRetry(operation, 30, 200);
}

function monitoringMutationHttpStatus(error: unknown): number {
  if (isRequestValidationError(error)) return 400;
  if (isSqliteBusyError(error)) return 503;
  return 500;
}

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
        monitorNewArtists: status.config.monitor_new_artists,
        removeUnmonitoredFiles: status.config.remove_unmonitored_files,
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
router.post("/config", async (req, res) => {
  try {
    const currentStatus = getMonitoringStatus();
    const validatedUpdates = parseMonitoringConfigUpdate(getObjectBody(req.body), {
      enabled: currentStatus.config.enable_active_monitoring,
      monitorNewArtists: currentStatus.config.monitor_new_artists,
      removeUnmonitoredFiles: currentStatus.config.remove_unmonitored_files,
      lastCheckTimestamp: currentStatus.config.lastCheckTimestamp ?? undefined,
      checkInProgress: currentStatus.config.checkInProgress,
      progressArtistIndex: currentStatus.config.progressArtistIndex,
    });
    const updates: any = {};
    if ("enabled" in validatedUpdates) updates.enable_active_monitoring = validatedUpdates.enabled;
    if ("monitorNewArtists" in validatedUpdates) updates.monitor_new_artists = validatedUpdates.monitorNewArtists;
    if ("removeUnmonitoredFiles" in validatedUpdates) updates.remove_unmonitored_files = validatedUpdates.removeUnmonitoredFiles;

    const config = await runMonitoringUserWrite(() => updateMonitoringConfig(updates));

    // Convert back to camelCase for response
    const response = {
      enabled: config.enable_active_monitoring,
      monitorNewArtists: config.monitor_new_artists,
      removeUnmonitoredFiles: config.remove_unmonitored_files,
      lastCheckTimestamp: config.lastCheckTimestamp,
      checkInProgress: config.checkInProgress,
      progressArtistIndex: config.progressArtistIndex,
    };

    res.json({ success: true, config: response });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
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

const queueCurateArtists = async (_: any, res: any) => {
  try {
    const commandId = await runMonitoringUserWrite(() =>
      queueCurationPass({ trigger: CommandTrigger.Manual }),
    );

    res.json({
      success: true,
      commandId,
      message: "Queued curation for monitored artists.",
    });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
  }
};

router.post("/curate", queueCurateArtists);

// Trigger manual metadata refresh — metadata only, no local scan, curation, or downloads.
router.post("/check", async (_, res) => {
  try {
    const commandId = await runMonitoringUserWrite(() =>
      queueMetadataRefreshPass({ trigger: CommandTrigger.Manual }),
    );

    res.json({
      success: true,
      commandId,
      message: "Queued a metadata refresh command.",
    });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
  }
});

// Trigger the full metadata refresh -> local scan/import -> curation -> download workflow.
router.post("/trigger-all", async (_, res) => {
  try {
    const commandId = await runMonitoringUserWrite(() =>
      queueMonitoringCyclePass({ trigger: CommandTrigger.Manual, includeRootScan: true }),
    );

    res.json({
      success: true,
      commandId,
      message: "Queued a monitoring cycle.",
    });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
  }
});

// Queue downloads for all monitored but missing items (manual Wanted search).
// Monitored artist add already queues a scoped DownloadMissing after CurateArtist.
router.post("/download-missing", async (_, res) => {
  try {
    const commandId = await runMonitoringUserWrite(() =>
      queueDownloadMissingPass({ trigger: CommandTrigger.Manual }),
    );
    res.json({
      success: true,
      commandId,
      message: "Queued a download-missing command.",
    });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
  }
});

// Scan library for files that don't meet the current quality settings and queue upgrades
router.post("/check-upgrades", async (_, res) => {
  try {
    const commandId = await runMonitoringUserWrite(() =>
      queueCheckUpgradesPass({ trigger: CommandTrigger.Manual }),
    );
    res.json({
      success: true,
      commandId,
      message: "Queued an upgrade check command.",
    });
  } catch (error: any) {
    res.status(monitoringMutationHttpStatus(error)).json({ detail: error.message });
  }
});

export default router;




