import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { UnmappedFilesService } from "../services/unmapped-files.js";
import { getVideo } from "../services/tidal.js";
import {
    getEnumValue,
    getObjectBody,
    getRequiredIdentifier,
    getRequiredInteger,
    getRequiredIntegerArray,
    isRequestValidationError,
} from "../utils/request-validation.js";

const router = Router();
router.use(authMiddleware);
const unmappedFilesService = new UnmappedFilesService();
const fileActionValues = ["ignore", "unignore", "delete", "map"] as const;
const bulkActionValues = ["ignore", "unignore", "delete"] as const;

/**
 * GET /api/unmapped
 * Returns all unmapped local files.
 */
router.get("/", (req, res) => {
    try {
        const limit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) || 100 : undefined;
        const offset = req.query.offset ? Number.parseInt(String(req.query.offset), 10) || 0 : undefined;
        const result = unmappedFilesService.listFiles(limit, offset);

        res.json({
            ...result,
            limit: limit ?? null,
            offset: offset ?? 0,
            hasMore: limit !== undefined ? (offset ?? 0) + result.items.length < result.total : false,
        });
    } catch (e: any) {
        console.error("[Unmapped API] Error fetching unmapped files:", e);
        res.status(500).json({ error: e.message || "Failed to fetch unmapped files" });
    }
});

/**
 * POST /api/unmapped/:id/action
 * Perform an action (ignore, delete, map) on an unmapped file.
 */
router.post("/:id/action", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);

    try {
        const body = getObjectBody(req.body);
        const action = getEnumValue(body, "action", fileActionValues);

        const file = unmappedFilesService.getFile(id);
        if (!file) {
            res.status(404).json({ error: "File not found in tracking DB" });
            return;
        }

        switch (action) {
            case "ignore":
                unmappedFilesService.setIgnored(id, true);
                res.json({ success: true, message: "File ignored" });
                break;

            case "unignore":
                unmappedFilesService.setIgnored(id, false);
                res.json({ success: true, message: "File restored" });
                break;

            case "delete":
                unmappedFilesService.deleteFile(id);
                res.json({ success: true, message: "File deleted" });
                break;

            case "map":
                await unmappedFilesService.bulkMap([{ id, tidalId: getRequiredIdentifier(body, "tidalId") }]);

                res.json({ success: true, message: `Successfully mapped file` });
                break;

            default:
                res.status(400).json({ error: "Invalid action" });
                return;
        }
    } catch (e: any) {
        if (isRequestValidationError(e)) {
            return res.status(400).json({ error: e.message });
        }

        console.error(`[Unmapped API] Error performing action on ${id}:`, e);
        res.status(500).json({ error: e.message || "Failed to perform action" });
    }
});

router.post("/identify", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        const entityType = typeof body.entityType === "string" ? body.entityType : undefined;

        if (entityType === "video") {
            const tidalId = getRequiredIdentifier(body, "tidalId");
            const video = await getVideo(tidalId);
            if (!video) {
                return res.status(404).json({ success: false, error: `Video ${tidalId} not found` });
            }
            res.json({ success: true, entityType: "video", candidate: video });
            return;
        }

        const fileIds = getRequiredIntegerArray(body, "fileIds");
        const tidalAlbumId = getRequiredIdentifier(body, "tidalAlbumId");

        const result = await unmappedFilesService.identifyAgainstAlbum(fileIds, tidalAlbumId);
        res.json({ success: true, ...result });
    } catch (error: any) {
        if (isRequestValidationError(error)) {
            return res.status(400).json({ error: error.message });
        }

        console.error("[Unmapped API] Error identifying files:", error);
        res.status(500).json({ error: error.message || "Failed to identify files" });
    }
});

/**
 * POST /api/unmapped/bulk-map
 * Bulk maps unmapped files to Tidal tracks.
 */
router.post("/bulk-map", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        const rawItems = body.items;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            return res.status(400).json({ error: "Missing or invalid items payload" });
        }

        const items = rawItems.map((entry, index) => {
            const item = getObjectBody(entry, `items[${index}] must be a JSON object`);
            return {
                id: getRequiredInteger(item, "id"),
                tidalId: getRequiredIdentifier(item, "tidalId"),
            };
        });

        await unmappedFilesService.bulkMap(items);
        res.json({ success: true, message: `Successfully mapped ${items.length} files.` });
    } catch (e: any) {
        if (isRequestValidationError(e)) {
            return res.status(400).json({ error: e.message });
        }

        console.error(`[Unmapped API] Error bulk mapping files:`, e);
        res.status(500).json({ error: e.message || "Failed to bulk map files" });
    }
});

router.post("/bulk-action", async (req, res) => {
    let actionLabel = "unknown";

    try {
        const body = getObjectBody(req.body);
        const ids = getRequiredIntegerArray(body, "ids");
        const action = getEnumValue(body, "action", bulkActionValues);
        actionLabel = action;

        switch (action) {
            case "ignore": {
                const affected = unmappedFilesService.setIgnoredBulk(ids, true);
                res.json({ success: true, message: `Ignored ${affected} file${affected === 1 ? "" : "s"}` });
                return;
            }
            case "unignore": {
                const affected = unmappedFilesService.setIgnoredBulk(ids, false);
                res.json({ success: true, message: `Restored ${affected} file${affected === 1 ? "" : "s"}` });
                return;
            }
            case "delete": {
                const affected = unmappedFilesService.deleteFiles(ids);
                res.json({ success: true, message: `Deleted ${affected} file${affected === 1 ? "" : "s"}` });
                return;
            }
            default:
                res.status(400).json({ error: "Invalid action" });
                return;
        }
    } catch (e: any) {
        if (isRequestValidationError(e)) {
            return res.status(400).json({ error: e.message });
        }

        console.error(`[Unmapped API] Error performing bulk action ${actionLabel}:`, e);
        res.status(500).json({ error: e.message || "Failed to perform bulk action" });
    }
});

export default router;
