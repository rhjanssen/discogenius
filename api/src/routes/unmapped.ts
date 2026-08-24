import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { runWithAsyncBusyRetry } from "../database.js";
import { CommandNames } from "../services/commands/command-names.js";
import { CommandQueueManager } from "../services/commands/command-queue-manager.js";
import { UnmappedFilesService } from "../services/mediafiles/unmapped-files.js";
import {
    getEnumValue,
    getObjectBody,
    getRequiredIdentifier,
    getRequiredInteger,
    getRequiredIntegerArray,
    isRequestValidationError,
    parseBoundedQueryInteger,
    rejectUnknownKeys,
} from "../utils/request-validation.js";

const router = Router();
router.use(authMiddleware);
const unmappedFilesService = new UnmappedFilesService();
const fileActionValues = ["ignore", "unignore", "delete", "map"] as const;
const bulkActionValues = ["ignore", "unignore", "delete"] as const;

function queueCanonicalVideoImport(canonicalVideo: {
    libraryId: number;
    mappings: Array<{ unmappedFileId: number; recordingId: number }>;
}): Promise<number> {
    const sortedIds = canonicalVideo.mappings
        .map((mapping) => mapping.unmappedFileId)
        .sort((left, right) => left - right);
    return runWithAsyncBusyRetry(() =>
        CommandQueueManager.push(
            CommandNames.ImportUnmappedFiles,
            {
                canonicalVideo,
                title: "Importing canonical videos",
                description: `Importing ${canonicalVideo.mappings.length} mapped video${canonicalVideo.mappings.length === 1 ? "" : "s"}`,
            },
            `canonical-video-import:${canonicalVideo.libraryId}:${sortedIds.join(",")}`,
        ),
    );
}

function queueCanonicalUnmappedImport(canonical: {
    libraryId: number;
    editionId: number;
    mappings: Array<{ unmappedFileId: number; trackId: number }>;
}): Promise<number> {
    const sortedIds = canonical.mappings
        .map((mapping) => mapping.unmappedFileId)
        .sort((left, right) => left - right);
    return runWithAsyncBusyRetry(() =>
        CommandQueueManager.push(
            CommandNames.ImportUnmappedFiles,
            {
                canonical,
                title: "Importing canonical files",
                description: `Importing ${canonical.mappings.length} mapped file${canonical.mappings.length === 1 ? "" : "s"}`,
            },
            `canonical-unmapped-import:${canonical.libraryId}:${canonical.editionId}:${sortedIds.join(",")}`,
        ),
    );
}

/**
 * GET /api/unmapped
 * Returns all unmapped local files.
 */
router.get("/", async (req, res) => {
    try {
        const limit = parseBoundedQueryInteger(req.query.limit, 100, { min: 1, max: 500 });
        const offset = parseBoundedQueryInteger(req.query.offset, 0);
        const result = unmappedFilesService.listFiles(limit, offset);
        const candidates = await unmappedFilesService.getCandidateGuesses(result.items);

        res.json({
            ...result,
            candidates,
            limit,
            offset,
            hasMore: offset + result.items.length < result.total,
        });
    } catch (e: any) {
        console.error("[Unmapped API] Error fetching unmapped files:", e);
        res.status(500).json({ error: e.message || "Failed to fetch unmapped files" });
    }
});

router.get("/canonical/libraries", (_req, res) => {
    const libraries = unmappedFilesService.listManualImportLibraries();
    res.json(libraries);
});

router.get("/canonical/releases/:releaseIdentity", (req, res) => {
    try {
        const release = unmappedFilesService.getCanonicalImportRelease(req.params.releaseIdentity);
        if (!release) return res.status(404).json({ error: "Canonical release not found" });
        res.json(release);
    } catch (error: any) {
        res.status(500).json({ error: error.message || "Failed to load canonical release" });
    }
});

router.post("/canonical-import", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        const rawMappings = body.mappings;
        if (!Array.isArray(rawMappings) || rawMappings.length === 0) {
            return res.status(400).json({ error: "mappings must be a non-empty array" });
        }
        const mappings = rawMappings.map((entry, index) => {
            const mapping = getObjectBody(entry, `mappings[${index}] must be a JSON object`);
            rejectUnknownKeys(mapping, ["unmappedFileId", "trackId"], `mappings[${index}]`);
            return {
                unmappedFileId: getRequiredInteger(mapping, "unmappedFileId"),
                trackId: getRequiredInteger(mapping, "trackId"),
            };
        });
        const canonical = {
            libraryId: getRequiredInteger(body, "libraryId"),
            editionId: getRequiredInteger(body, "editionId"),
            mappings,
        };
        const commandId = await queueCanonicalUnmappedImport(canonical);
        res.status(202).json({
            success: true,
            queued: commandId !== -1,
            commandId,
            message: `Queued canonical import for ${mappings.length} mapped file${mappings.length === 1 ? "" : "s"}.`,
        });
    } catch (error: any) {
        if (isRequestValidationError(error)) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: error.message || "Failed to queue canonical import" });
    }
});

router.post("/canonical/acoustid", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        rejectUnknownKeys(body, ["unmappedFileId"]);
        const result = await unmappedFilesService.identifyFileByAcoustId(
            getRequiredInteger(body, "unmappedFileId"),
        );
        res.json(result);
    } catch (error: any) {
        if (isRequestValidationError(error)) {
            return res.status(400).json({ error: error.message });
        }
        const message = error?.message || "AcoustID identification failed";
        const status = /not found|missing from disk/i.test(message) ? 404 : 422;
        res.status(status).json({ error: message });
    }
});

router.post("/canonical-video-import", async (req, res) => {
    try {
        const body = getObjectBody(req.body);
        rejectUnknownKeys(body, ["libraryId", "mappings"]);
        if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
            return res.status(400).json({ error: "mappings must be a non-empty array" });
        }
        const mappings = body.mappings.map((entry, index) => {
            const mapping = getObjectBody(entry, `mappings[${index}] must be a JSON object`);
            rejectUnknownKeys(mapping, ["unmappedFileId", "recordingId"], `mappings[${index}]`);
            return {
                unmappedFileId: getRequiredInteger(mapping, "unmappedFileId"),
                recordingId: getRequiredInteger(mapping, "recordingId"),
            };
        });
        const canonicalVideo = {
            libraryId: getRequiredInteger(body, "libraryId"),
            mappings,
        };
        const commandId = await queueCanonicalVideoImport(canonicalVideo);
        res.status(202).json({
            success: true,
            queued: commandId !== -1,
            commandId,
            message: `Queued canonical video import for ${mappings.length} file${mappings.length === 1 ? "" : "s"}.`,
        });
    } catch (error: any) {
        if (isRequestValidationError(error)) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: error.message || "Failed to queue canonical video import" });
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
                res.status(410).json({
                    error: "Provider-keyed manual import was removed; use canonical MusicBrainz import",
                });
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
            return res.status(410).json({
                error: "Provider-keyed video identification was removed; select a canonical MusicBrainz Recording",
            });
        }

        const fileIds = getRequiredIntegerArray(body, "fileIds");
        // The identity of a release group is a MusicBrainz release-group MBID.
        // `tidalAlbumId` is retained only as a backwards-compatible alias for
        // older clients; identification is catalog-only and never provider-keyed.
        const releaseGroupMbid = getRequiredIdentifier(
            { value: body.releaseGroupMbid ?? body.albumId ?? body.tidalAlbumId },
            "value",
        );

        const result = await unmappedFilesService.identifyAgainstAlbum(fileIds, releaseGroupMbid);
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
 * Provider-keyed bulk mapping was retired in favor of typed canonical imports.
 */
router.post("/bulk-map", (_req, res) => {
    res.status(410).json({
        error: "Provider-keyed manual import was removed; use canonical MusicBrainz import",
    });
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
