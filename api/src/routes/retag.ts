import { Router } from "express";
import { AudioTagMaintenanceService } from "../services/audio-tag-maintenance.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 200;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const items = await AudioTagMaintenanceService.preview({ artistId, albumId, limit, offset });
    res.json({ items, limit, offset });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/status", async (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const sampleLimit = parseInt(req.query.sampleLimit as string, 10) || 10;

    const summary = await AudioTagMaintenanceService.getStatus({ artistId, albumId }, sampleLimit);
    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/apply", async (req, res) => {
  try {
    const ids = (req.body as any)?.ids as number[] | undefined;
    const applyAll = (req.body as any)?.applyAll === true;
    if ((!ids || !Array.isArray(ids) || ids.length === 0) && !applyAll) {
      return res.status(400).json({ detail: "ids array is required unless applyAll is true" });
    }

    const artistId = (req.body as any)?.artistId as string | undefined;
    const albumId = (req.body as any)?.albumId as string | undefined;
    const normalizedIds = ids && Array.isArray(ids)
      ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : undefined;
    const refId = applyAll
      ? `apply-retags:${JSON.stringify({ artistId: artistId || null, albumId: albumId || null })}`
      : undefined;

    const jobId = TaskQueueService.addJob(JobTypes.ApplyRetags, {
      ids: normalizedIds,
      applyAll,
      artistId,
      albumId,
    }, refId, 1, 1);

    res.json({
      success: true,
      queued: jobId !== -1,
      jobId,
      message: "Retag task queued",
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Retag failed";
    const status = /enable write audio metadata/i.test(message) ? 400 : 500;
    res.status(status).json({ detail: message });
  }
});

export default router;
