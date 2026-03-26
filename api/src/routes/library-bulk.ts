import { Router } from "express";
import { LibraryBulkActionService, LIBRARY_BULK_ACTIONS, LIBRARY_BULK_ENTITIES } from "../services/library-bulk-actions.js";
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

        const result = await LibraryBulkActionService.apply(entity, action, ids);
        res.json({
            success: true,
            ...result,
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
