import { Router } from "express";
import { getObjectBody, getOptionalBoolean, getOptionalInteger, isRequestValidationError, rejectUnknownKeys } from "../utils/request-validation.js";
import { getSystemTask, listSystemTasks, runSystemTask, updateSystemTaskSchedule } from "../services/system-task-service.js";

const router = Router();

router.get("/", (_req, res) => {
  try {
    res.json(listSystemTasks());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:id", (req, res) => {
  try {
    const task = getSystemTask(req.params.id);
    if (!task) {
      return res.status(404).json({ detail: "Task not found" });
    }

    res.json(task);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.patch("/:id", (req, res) => {
  try {
    const body = getObjectBody(req.body);
    rejectUnknownKeys(body, ["enabled", "intervalMinutes"]);
    const enabled = getOptionalBoolean(body, "enabled");
    const intervalMinutes = getOptionalInteger(body, "intervalMinutes");

    if (enabled === undefined && intervalMinutes === undefined) {
      return res.status(400).json({ detail: "At least one update field is required" });
    }

    if (intervalMinutes !== undefined && intervalMinutes < 1) {
      return res.status(400).json({ detail: "intervalMinutes must be at least 1" });
    }

    res.json(updateSystemTaskSchedule(req.params.id, { enabled, intervalMinutes }));
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    if (error.message?.includes("does not have editable schedule settings")) {
      return res.status(400).json({ detail: error.message });
    }
    if (error.message?.includes("Unknown system task")) {
      return res.status(404).json({ detail: "Task not found" });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:id/run", (req, res) => {
  try {
    const jobId = runSystemTask(req.params.id);
    if (jobId === -1) {
      return res.status(404).json({ detail: "Task not found" });
    }

    res.status(201).json({ id: jobId });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
