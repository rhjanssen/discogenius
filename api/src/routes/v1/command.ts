import { Router } from "express";
import { getCommandHistory, mapJob } from "../../services/commands/command-history.js";
import { CommandQueueService } from "../../services/commands/command-queue.js";
import { runCommandByName } from "../../services/commands/system-task-service.js";
import { getObjectBody, getRequiredString, isRequestValidationError } from "../../utils/request-validation.js";

const router = Router();

router.get("/", (req, res) => {
  try {
    const active = CommandQueueService.listJobs("%", "%", 200)
      .filter((job) => job.status === "queued" || job.status === "started")
      .map((job) => mapJob(job));
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

    const job = CommandQueueService.getById(jobId);
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
    const jobId = runCommandByName(getRequiredString(body, "name"));
    if (jobId === -1) {
      return res.status(400).json({ detail: "Unsupported command name" });
    }

    const job = CommandQueueService.getById(jobId);
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

    CommandQueueService.cancel(jobId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;



