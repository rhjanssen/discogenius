import { Router } from "express";
import { AudioTagService } from "../services/audio-tag-service.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 200;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const items = await AudioTagService.preview({ artistId, albumId, limit, offset });
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

    const summary = await AudioTagService.getStatus({ artistId, albumId }, sampleLimit);
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
    const isArtistWideRetag = applyAll
      && Boolean(artistId)
      && !albumId
      && (!normalizedIds || normalizedIds.length === 0);
    const refId = applyAll
      ? (isArtistWideRetag
        ? artistId
        : `retag-files:${JSON.stringify({ artistId: artistId || null, albumId: albumId || null })}`)
      : undefined;

    const jobId = isArtistWideRetag
      ? TaskQueueService.addJob(JobTypes.RetagArtist, {
        artistId,
        artistIds: artistId ? [artistId] : undefined,
      }, refId, 1, 1)
      : TaskQueueService.addJob(JobTypes.RetagFiles, {
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
    const status = /enable fingerprinting|enable imported audio tag correction|replaygain/i.test(message) ? 400 : 500;
    res.status(status).json({ detail: message });
  }
});

export default router;
