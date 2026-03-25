import { Router } from "express";
import { TaskQueueService } from "../services/queue.js";
import { CommandManager } from "../services/command.js";
import { getRateLimitMetrics } from "../services/tidal.js";
import { countPendingTasks, getActiveCommands, getCommandHistory, getPendingTasks } from "../services/command-history.js";
import type { ActivityListResponseContract, StatusOverviewContract, TaskQueueStatContract } from "../contracts/status.js";

const router = Router();

router.get("/", (req, res) => {
    try {
        const taskQueueStats = TaskQueueService.getStats() as TaskQueueStatContract[];

        const payload: StatusOverviewContract = {
            activeJobs: getActiveCommands(100),
            jobHistory: getCommandHistory(50, 0),
            taskQueueStats,
            commandStats: CommandManager.getTaskQueueStats(),
            runningCommands: CommandManager.getRunningCommands().map(c => ({
                id: c.id,
                type: c.type,
                name: c.definition.name,
                isExclusive: c.definition.isExclusive,
                isTypeExclusive: c.definition.isTypeExclusive,
                requiresDiskAccess: c.definition.requiresDiskAccess,
            })),
            rateLimitMetrics: getRateLimitMetrics(),
        };
        res.json(payload);
    } catch (error: any) {
        res.status(500).json({ detail: error.message });
    }
});

router.get("/tasks", (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || "100"), 10) || 100));
        const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
        const total = countPendingTasks();
        const items = getPendingTasks(limit, offset);

        const payload: ActivityListResponseContract = {
            items,
            total,
            limit,
            offset,
            hasMore: offset + items.length < total,
        };

        res.json(payload);
    } catch (error: any) {
        res.status(500).json({ detail: error.message });
    }
});

router.get("/history", (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        res.json({
            jobHistory: getCommandHistory(limit, offset)
        });
    } catch (error: any) {
        res.status(500).json({ detail: error.message });
    }
});

export default router;
