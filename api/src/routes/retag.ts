import { Router } from "express";
import { runWithAsyncBusyRetry } from "../database.js";
import { AudioTagService } from "../services/mediafiles/audio-tag-service.js";
import { CommandNames } from "../services/commands/command-names.js";
import { CommandQueueManager } from "../services/commands/command-queue-manager.js";
import { parseBoundedQueryInteger } from "../utils/request-validation.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const limit = parseBoundedQueryInteger(req.query.limit, 200, { min: 1, max: 500 });
    const offset = parseBoundedQueryInteger(req.query.offset, 0);

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
    const sampleLimit = parseBoundedQueryInteger(req.query.sampleLimit, 10, { min: 1, max: 100 });
    const scanLimit = parseBoundedQueryInteger(req.query.scanLimit, 25, { min: 1, max: 500 });

    const summary = await AudioTagService.getStatus({ artistId, albumId, limit: scanLimit }, sampleLimit);
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
    const refId = isArtistWideRetag
      ? artistId
      : `retag-files:${JSON.stringify(applyAll
        ? { artistId: artistId || null, albumId: albumId || null }
        : { ids: normalizedIds || [] })}`;

    const commandId = await runWithAsyncBusyRetry(
      () => isArtistWideRetag
        ? CommandQueueManager.push(CommandNames.RetagArtist, {
          artistId,
          artistIds: artistId ? [artistId] : undefined,
        }, refId, 1, 1)
        : CommandQueueManager.push(CommandNames.RetagFiles, {
          ids: normalizedIds,
          applyAll,
          artistId,
          albumId,
        }, refId, 1, 1),
      30,
      200,
    );

    res.json({
      success: true,
      queued: commandId !== -1,
      commandId,
      message: "Retag task queued",
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Retag failed";
    const status = /enable fingerprinting|enable imported audio tag correction|replaygain/i.test(message) ? 400 : 500;
    res.status(status).json({ detail: message });
  }
});

/**
 * Queue a Lidarr-style strip-tags job (remove embedded tags; no rewrite).
 * Scope by ids, or applyAll with artistId / albumId.
 */
router.post("/strip", async (req, res) => {
  try {
    const ids = (req.body as any)?.ids as number[] | undefined;
    const applyAll = (req.body as any)?.applyAll === true;
    const artistId = (req.body as any)?.artistId as string | undefined;
    const albumId = (req.body as any)?.albumId as string | undefined;
    const normalizedIds = ids && Array.isArray(ids)
      ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : undefined;

    if ((!normalizedIds || normalizedIds.length === 0) && !applyAll) {
      return res.status(400).json({ detail: "ids array is required unless applyAll is true" });
    }
    if (applyAll && !artistId && !albumId) {
      return res.status(400).json({ detail: "artistId or albumId is required when applyAll is true" });
    }

    const refId = `strip-tags:${JSON.stringify(applyAll
      ? { artistId: artistId || null, albumId: albumId || null }
      : { ids: normalizedIds || [] })}`;

    const commandId = await runWithAsyncBusyRetry(
      () => CommandQueueManager.push(CommandNames.RetagFiles, {
        ids: normalizedIds,
        applyAll,
        artistId,
        albumId,
        stripOnly: true,
      }, refId, 1, 1),
      30,
      200,
    );

    res.json({
      success: true,
      queued: commandId !== -1,
      commandId,
      message: "Strip tags task queued",
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Strip tags failed";
    res.status(500).json({ detail: message });
  }
});

export default router;
