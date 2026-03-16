import { Router } from "express";
import { TaskQueueService, type AnyJobPayload, JobType, JobTypes } from "../services/queue.js";
import { RedundancyService } from "../services/redundancy.js";
import {
  getObjectBody,
  getOptionalIdentifier,
  getOptionalInteger,
  getRequiredIdentifier,
  isRequestValidationError,
} from "../utils/request-validation.js";

const router = Router();
const allowedJobTypes = new Set<string>(Object.values(JobTypes));

// Get task queue items
router.get("/", (req, res) => {
  const status = req.query.status as string || '%';
  const type = req.query.type as string || '%';
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;

  const items = TaskQueueService.listJobs(type, status, limit, offset);
  const total = TaskQueueService.countJobs(type, status);

  res.json({
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  });
});

// Add task
router.post("/add", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const type = getRequiredIdentifier(body, "type");
    if (!allowedJobTypes.has(type)) {
      return res.status(400).json({ error: "Unsupported job type" });
    }

    const payload = getObjectBody(body.payload, "payload must be a JSON object");
    const priority = getOptionalInteger(body, "priority") ?? 0;
    const refId = getOptionalIdentifier(body, "ref_id");

    const id = TaskQueueService.addJob(type as JobType, payload as AnyJobPayload, refId, priority);
    res.json({ id, message: "Task added" });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: error.message });
  }
});

// Clear completed tasks
router.post("/clear-completed", (req, res) => {
  TaskQueueService.clearCompleted();
  res.json({ message: "Completed tasks cleared" });
});

// Retry task
router.post("/:id/retry", (req, res) => {
  const { id } = req.params;
  const jobId = parseInt(id, 10);
  if (Number.isNaN(jobId)) {
    return res.status(400).json({ error: "Invalid job ID" });
  }

  const job = TaskQueueService.getById(jobId);
  if (!job) {
    return res.status(404).json({ error: "Task not found" });
  }

  if (job.status === "processing") {
    return res.status(409).json({ error: "Task is processing" });
  }

  TaskQueueService.retry(jobId);
  res.json({ message: "Task retried" });
});

// Cancel task (delete from task queue view)
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const jobId = parseInt(id, 10);
  if (Number.isNaN(jobId)) {
    return res.status(400).json({ error: "Invalid job ID" });
  }

  const job = TaskQueueService.getById(jobId);
  if (!job) {
    return res.status(404).json({ error: "Task not found" });
  }

  if (job.status === "processing") {
    return res.status(409).json({ error: "Task is processing" });
  }

  TaskQueueService.cancel(jobId);
  res.json({ message: "Task cancelled" });
});

// Process Monitored Items
router.post("/process-monitored", async (req, res) => {
  try {
    const body = getObjectBody(req.body ?? {});
    const artistId = getOptionalIdentifier(body, "artistId");
    const queued = await RedundancyService.queueMonitoredItems(artistId);
    const count = queued.albums + queued.tracks + queued.videos;
    res.json({
      message: `Added ${count} item(s) to download queue (${queued.albums} albums, ${queued.tracks} tracks, ${queued.videos} videos)`,
      count,
      ...queued,
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
