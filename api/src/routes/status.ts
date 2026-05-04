import { Router } from "express";
import { TaskQueueService } from "../services/queue.js";
import { CommandManager } from "../services/command.js";
import { getRateLimitMetrics } from "../services/providers/tidal/tidal.js";
import { getActivitySummary } from "../services/command-history.js";
import type { StatusOverviewContract, TaskQueueStatContract } from "../contracts/status.js";

const router = Router();

router.get("/", (req, res) => {
    try {
        const taskQueueStats = TaskQueueService.getStats() as TaskQueueStatContract[];

        const payload: StatusOverviewContract = {
            taskQueueStats,
            activity: getActivitySummary(),
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

export default router;
