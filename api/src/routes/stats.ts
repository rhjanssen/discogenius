import { Router } from "express";
import { LibraryStatsQueryService } from "../services/music/library-stats-query-service.js";

const router = Router();

/**
 * GET /stats
 * Returns counts and library summary.
 */
router.get("/", async (_, res) => {
  try {
    res.json(await LibraryStatsQueryService.getSnapshot());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
