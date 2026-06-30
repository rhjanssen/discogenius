import { Router } from "express";
import { runWithAsyncBusyRetry } from "../database.js";
import { CommandNames } from "../services/commands/command-names.js";
import { CommandQueueManager } from "../services/commands/command-queue-manager.js";
import { LIBRARY_BULK_ACTIONS, LIBRARY_BULK_ENTITIES } from "../services/music/library-bulk-actions.js";
import {
    getEnumValue,
    getObjectBody,
    getRequiredIdentifierArray,
    isRequestValidationError,
    rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();

router.post("/", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        rejectUnknownKeys(body, ["entity", "action", "ids"], "Library bulk action");

        const entity = getEnumValue(body, "entity", LIBRARY_BULK_ENTITIES);
        const action = getEnumValue(body, "action", LIBRARY_BULK_ACTIONS);
        const ids = getRequiredIdentifierArray(body, "ids");

        const commandId = await runWithAsyncBusyRetry(() =>
            CommandQueueManager.push(
                CommandNames.LibraryBulkAction,
                {
                    entity,
                    action,
                    entityIds: ids,
                    title: "Library bulk action",
                    description: `Applying ${action} to ${ids.length} ${entity}${ids.length === 1 ? "" : "s"}`,
                },
                `library-bulk:${entity}:${action}:${ids.join(",")}`,
            ),
        );

        res.status(202).json({
            success: true,
            queued: commandId !== -1,
            commandId,
            message: `Queued bulk ${action} for ${ids.length} ${entity}${ids.length === 1 ? "" : "s"}.`,
        });
    } catch (error: any) {
        if (isRequestValidationError(error)) {
            return res.status(400).json({ detail: error.message });
        }

        console.error("[LibraryBulk] Bulk action failed:", error);
        res.status(500).json({ detail: error.message });
    }
});

export default router;
