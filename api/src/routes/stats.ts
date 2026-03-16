import { Router } from "express";
import { LibraryStatsQueryService } from "../services/library-stats-query-service.js";

const router = Router();

/**
 * GET /stats
 * Returns counts and library summary.
 */
router.get("/", (_, res) => {
  try {
    res.json(LibraryStatsQueryService.getSnapshot());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
