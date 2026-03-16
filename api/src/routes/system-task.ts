import { Router } from "express";
import { db } from "../database.js";
import { getScheduledTaskSnapshots } from "../services/monitoring-scheduler.js";

const router = Router();

function getTaskRunTimes(taskName: string) {
  const row = db.prepare(`
    SELECT started_at, completed_at, created_at
    FROM job_queue
    WHERE type = ?
    ORDER BY COALESCE(started_at, created_at) DESC
    LIMIT 1
  `).get(taskName) as { started_at?: string | null; completed_at?: string | null; created_at?: string | null } | undefined;

  return {
    lastStartTime: row?.started_at ?? row?.created_at ?? null,
    lastExecution: row?.completed_at ?? row?.created_at ?? null,
  };
}

router.get("/", (_req, res) => {
  try {
    const tasks = getScheduledTaskSnapshots()
      .map((task) => {
        const runTimes = getTaskRunTimes(task.taskName);
        return {
          id: task.key,
          name: task.name,
          taskName: task.taskName,
          interval: task.intervalMinutes,
          enabled: task.enabled,
          active: task.active,
          lastExecution: runTimes.lastExecution ?? task.lastQueuedAt,
          lastStartTime: runTimes.lastStartTime ?? task.lastQueuedAt,
          nextExecution: task.nextRunAt,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    res.json(tasks);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:id", (req, res) => {
  try {
    const task = getScheduledTaskSnapshots().find((item) => item.key === req.params.id);
    if (!task) {
      return res.status(404).json({ detail: "Task not found" });
    }

    const runTimes = getTaskRunTimes(task.taskName);

    res.json({
      id: task.key,
      name: task.name,
      taskName: task.taskName,
      interval: task.intervalMinutes,
      enabled: task.enabled,
      active: task.active,
      lastExecution: runTimes.lastExecution ?? task.lastQueuedAt,
      lastStartTime: runTimes.lastStartTime ?? task.lastQueuedAt,
      nextExecution: task.nextRunAt,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
