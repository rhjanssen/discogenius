import { Router } from "express";
import { getCommandHistory, mapJob } from "../services/command-history.js";
import { TaskQueueService } from "../services/queue.js";
import {
  queueCheckUpgradesPass,
  queueCurationPass,
  queueDownloadMissingPass,
  queueMonitoringCyclePass,
  queueHousekeepingPass,
  queueMetadataRefreshPass,
  queueRescanFoldersPass,
} from "../services/monitoring-scheduler.js";
import { getObjectBody, getRequiredString, isRequestValidationError } from "../utils/request-validation.js";

const router = Router();

function normalizeCommandName(name: unknown): string {
  return String(name || "").trim().toLowerCase();
}

function startCommand(name: string): number {
  switch (normalizeCommandName(name)) {
    case "refreshmetadata":
      return queueMetadataRefreshPass({ trigger: 1 });
    case "monitoringcycle":
      return queueMonitoringCyclePass({ trigger: 1, includeRootScan: true });
    case "applycuration":
      return queueCurationPass({ trigger: 1 });
    case "downloadmissing":
      return queueDownloadMissingPass({ trigger: 1 });
    case "checkupgrades":
      return queueCheckUpgradesPass({ trigger: 1 });
    case "housekeeping":
      return queueHousekeepingPass({ trigger: 1 });
    case "rescanfolders":
      return queueRescanFoldersPass({ trigger: 1, fullProcessing: false });
    default:
      return -1;
  }
}

router.get("/", (req, res) => {
  try {
    const active = TaskQueueService.listJobs("%", "%", 200)
      .filter((job) => job.status === "pending" || job.status === "processing")
      .map(mapJob);
    const historyLimit = Math.max(0, parseInt(String(req.query.limit || "50"), 10) || 50);
    const historyOffset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
    const history = getCommandHistory(historyLimit, historyOffset);

    res.json([...active, ...history]);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:id", (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ detail: "Invalid command id" });
    }

    const job = TaskQueueService.getById(jobId);
    if (!job) {
      return res.status(404).json({ detail: "Command not found" });
    }

    res.json(mapJob(job));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const jobId = startCommand(getRequiredString(body, "name"));
    if (jobId === -1) {
      return res.status(400).json({ detail: "Unsupported command name" });
    }

    const job = TaskQueueService.getById(jobId);
    res.status(201).json(job ? mapJob(job) : { id: jobId });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ detail: "Invalid command id" });
    }

    TaskQueueService.cancel(jobId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
