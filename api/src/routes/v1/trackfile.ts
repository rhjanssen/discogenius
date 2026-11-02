import { Router } from "express";
import { deleteLibraryFilesByIds } from "../../services/mediafiles/library-file-delete-service.js";
import {
  deletionScopeFromRequest,
  scopeToOptions,
} from "../../services/mediafiles/library-deletion-scope.js";

const router = Router();

/**
 * Delete one TrackFiles row and the bytes it names. Catalog rows stay.
 * A track-level delete removes every file of that recording; this route does not.
 * Query: libraryId=N or allLibraries=true when several libraries are configured.
 */
router.delete("/:fileId", (req, res) => {
  try {
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return res.status(400).json({ detail: "fileId must be a positive integer" });
    }

    const scope = deletionScopeFromRequest({
      libraryId: req.query.libraryId,
      allLibraries: req.query.allLibraries,
    });
    const result = deleteLibraryFilesByIds([fileId], scopeToOptions(scope));
    const accounted = result.deleted + result.missing + result.errors + result.skippedOutsideRoot;
    if (accounted === 0) {
      return res.status(404).json({ detail: "Track file not found" });
    }

    res.json({
      success: result.errors === 0 && result.skippedOutsideRoot === 0,
      fileId,
      ...result,
    });
  } catch (error: any) {
    if (error?.status === 400) {
      return res.status(400).json({ detail: error.message });
    }
    console.error("[TrackFile] Failed to delete file:", error);
    res.status(500).json({ detail: error.message });
  }
});

export default router;
