import { Router } from "express";
import { reconcileMediaServers } from "../services/media-servers/media-server-reconcile.js";
import { CommandNames } from "../services/commands/command-names.js";
import { CommandQueueManager } from "../services/commands/command-queue-manager.js";
import { CommandPriority, CommandTrigger } from "../services/commands/command-trigger.js";
import { withDbWrite } from "../database.js";

const router = Router();

router.post("/reconcile", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRunQuery = typeof req.query.dryRun === "string" ? req.query.dryRun : undefined;
    const dryRun = dryRunQuery !== undefined
      ? dryRunQuery !== "false" && dryRunQuery !== "0"
      : body.dryRun !== false;
    const queue = body.queue === true;

    if (queue && !dryRun) {
      const commandId = await withDbWrite(() =>
        CommandQueueManager.push(
          CommandNames.ReconcileMediaServers,
          { dryRun: false },
          "reconcile-media-servers",
          CommandPriority.Interactive,
          CommandTrigger.Manual,
        ),
      );
      return res.json({ success: true, queued: commandId !== -1, commandId });
    }

    const report = await reconcileMediaServers({ dryRun });
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ detail: message });
  }
});

export default router;
