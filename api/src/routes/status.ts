import { Router } from "express";
import { CommandQueueService } from "../services/commands/command-queue.js";
import { CommandManager } from "../services/commands/command.js";
import { streamingProviderManager } from "../services/providers/index.js";
import { getActivitySummary } from "../services/commands/command-history.js";
import type { StatusOverviewContract, TaskQueueStatContract } from "../contracts/status.js";

const router = Router();

router.get("/", (req, res) => {
    try {
        const taskQueueStats = CommandQueueService.getStats() as TaskQueueStatContract[];

        const payload: StatusOverviewContract = {
            taskQueueStats,
            activity: getActivitySummary(),
            commandStats: CommandManager.getTaskQueueStats(),
            runningCommands: CommandManager.getRunningCommands().map(c => ({
                id: c.id,
                type: c.name,
                name: c.definition.name,
                isExclusive: c.definition.isExclusive,
                isTypeExclusive: c.definition.isTypeExclusive,
                requiresDiskAccess: c.definition.requiresDiskAccess,
            })),
            rateLimitMetrics: streamingProviderManager.getDefaultStreamingProvider().getRateLimitMetrics?.(),
        };
        res.json(payload);
    } catch (error: any) {
        res.status(500).json({ detail: error.message });
    }
});

export default router;
