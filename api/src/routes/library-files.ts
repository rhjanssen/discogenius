import { CommandPriority, CommandTrigger } from "../services/commands/command-trigger.js";
import { Router } from "express";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { db, runWithAsyncBusyRetry } from "../database.js";
import { findLibraryFileById, findTextLibraryFileByPath, listLibraryFiles, parseLibraryFilesQueryLimit, parseLibraryFilesQueryOffset } from "../services/mediafiles/library-files-query-service.js";
import { resolveStoredLibraryPath } from "../services/mediafiles/library-paths.js";
import { queueArtistWorkflow } from "../services/music/artist-workflow.js";
import {CommandNames} from "../services/commands/command-names.js";
import {CommandQueueManager} from "../services/commands/command-queue-manager.js";
import { RenameTrackFileService } from "../services/mediafiles/rename-track-file-service.js";
import { requiresBrowserCompatibleAudioStream, spawnBrowserCompatibleAudioTranscode } from "../services/mediafiles/audioUtils.js";
import { rootScanRouteService } from "../services/mediafiles/root-scan-route-service.js";
import { parseBoundedQueryInteger } from "../utils/request-validation.js";
import { parsePlaybackRange } from "../services/music/segmented-playback-cache.js";

const router = Router();
const streamPipeline = promisify(pipeline);

function parseFileTypes(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

router.get("/", (req, res) => {
  try {
    const response = listLibraryFiles({
      limit: parseLibraryFilesQueryLimit(req.query.limit),
      offset: parseLibraryFilesQueryOffset(req.query.offset),
      artistId: req.query.artistId as string | undefined,
      albumId: req.query.albumId as string | undefined,
      mediaId: req.query.mediaId as string | undefined,
      libraryRoot: req.query.libraryRoot as string | undefined,
      fileType: req.query.fileType as string | undefined,
    });
    res.json(response);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/rename/preview", (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const editionId = req.query.editionId as string | undefined;
    const releaseMbid = req.query.releaseMbid as string | undefined;
    const libraryRoot = req.query.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes(req.query.fileTypes);
    const limit = parseBoundedQueryInteger(req.query.limit, 200, { min: 1, max: 500 });
    const offset = parseBoundedQueryInteger(req.query.offset, 0);

    const items = RenameTrackFileService.getRenamePreviews({ artistId, albumId, editionId, releaseMbid, libraryRoot, fileTypes, limit, offset });
    res.json({ items, limit, offset });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/rename/status", (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const editionId = req.query.editionId as string | undefined;
    const releaseMbid = req.query.releaseMbid as string | undefined;
    const libraryRoot = req.query.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes(req.query.fileTypes);
    const sampleLimit = parseBoundedQueryInteger(req.query.sampleLimit, 10, { min: 1, max: 100 });
    const scanLimit = parseBoundedQueryInteger(req.query.scanLimit, 25, { min: 1, max: 500 });

    const summary = RenameTrackFileService.getRenameStatus({ artistId, albumId, editionId, releaseMbid, libraryRoot, fileTypes, limit: scanLimit }, sampleLimit);
    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/rename/apply", async (req, res) => {
  try {
    const ids = (req.body as any)?.ids as number[] | undefined;
    const applyAll = (req.body as any)?.applyAll === true;
    if ((!ids || !Array.isArray(ids) || ids.length === 0) && !applyAll) {
      return res.status(400).json({ detail: "ids array is required unless applyAll is true" });
    }

    const artistId = (req.body as any)?.artistId as string | undefined;
    const rawArtistIds = (req.body as any)?.artistIds;
    const artistIds = Array.isArray(rawArtistIds)
      ? rawArtistIds.map((id) => String(id ?? "").trim()).filter(Boolean)
      : (artistId ? [artistId.trim()] : undefined);
    const albumId = (req.body as any)?.albumId as string | undefined;
    const editionId = (req.body as any)?.editionId != null ? String((req.body as any).editionId).trim() : undefined;
    const releaseMbid = typeof (req.body as any)?.releaseMbid === "string" ? (req.body as any).releaseMbid.trim() : undefined;
    const libraryRoot = (req.body as any)?.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes((req.body as any)?.fileTypes);
    const normalizedIds = ids && Array.isArray(ids)
      ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : undefined;

    if (applyAll && (!artistIds || artistIds.length === 0) && !albumId && !editionId) {
      return res.status(400).json({ detail: "artistId, artistIds, albumId, or editionId is required when applyAll is true" });
    }

    const isArtistWideRename = applyAll
      && Boolean(artistIds && artistIds.length > 0)
      && !albumId
      && !editionId
      && !releaseMbid
      && !libraryRoot
      && (!fileTypes || fileTypes.length === 0)
      && (!normalizedIds || normalizedIds.length === 0);
    const refId = applyAll
      ? (isArtistWideRename
        ? (artistIds && artistIds.length === 1 ? artistIds[0] : `rename-artist-bulk:${artistIds?.length ?? 0}`)
        : `rename-files:${JSON.stringify({ artistId: artistId || null, albumId: albumId || null, editionId: editionId || null, releaseMbid: releaseMbid || null, libraryRoot: libraryRoot || null, fileTypes: fileTypes || [] })}`)
      : undefined;

    const commandId = await runWithAsyncBusyRetry(
      () => isArtistWideRename && artistIds && artistIds.length > 0
        ? CommandQueueManager.push(CommandNames.RenameArtist, {
          artistId: artistIds[0],
          artistIds,
        }, refId, CommandPriority.Interactive, CommandTrigger.Manual)
        : CommandQueueManager.push(CommandNames.RenameFiles, {
          ids: normalizedIds,
          applyAll,
          artistId: artistIds?.[0] ?? artistId,
          albumId,
          editionId,
          releaseMbid,
          libraryRoot,
          fileTypes,
        }, refId, CommandPriority.Interactive, CommandTrigger.Manual),
      30,
      200,
    );

    res.json({
      success: true,
      queued: commandId !== -1,
      commandId,
      message: "Rename task queued",
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Get text content of a file (for lyrics, etc.)
router.get("/content", (req, res) => {
  try {
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      return res.status(400).json({ detail: "path query parameter is required" });
    }

    // Security: Verify the file is in our database (prevents arbitrary file reads)
    const file = findTextLibraryFileByPath(filePath);
    if (!file) {
      return res.status(404).json({ detail: "File not found in library" });
    }

    // Only allow text file types
    const allowedTypes = ["lyrics", "bio", "review", "nfo"];
    if (!allowedTypes.includes(file.file_type)) {
      return res.status(400).json({ detail: "Content retrieval only supported for text files" });
    }

    const resolvedPath = resolveStoredLibraryPath({
      filePath,
      libraryRoot: file.library_root,
      relativePath: file.relative_path,
    });

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ detail: "File not found on disk" });
    }

    // Read and return content
    const content = fs.readFileSync(resolvedPath, "utf-8");
    res.type("text/plain").send(content);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Stream media files (audio, video, images)
router.get("/stream/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ detail: "Invalid file ID" });
    }

    // Get file from database
    const file = findLibraryFileById(id);
    if (!file) {
      return res.status(404).json({ detail: "File not found in library" });
    }

    const filePath = resolveStoredLibraryPath({
      filePath: file.file_path,
      libraryRoot: file.library_root,
      relativePath: file.relative_path,
    });

    // Check if file exists on disk
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ detail: "File not found on disk" });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const useBrowserCompatibleAudioStream = requiresBrowserCompatibleAudioStream({
      fileType: file.file_type,
      quality: file.quality,
      codec: file.codec,
      extension: ext,
    });

    // Determine content type
    const mimeTypes: Record<string, string> = {
      ".flac": "audio/flac",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".ts": "video/mp2t",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";

    if (useBrowserCompatibleAudioStream) {
      const child = spawnBrowserCompatibleAudioTranscode(filePath);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      });
      const spawnedPromise = new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const cleanupChild = () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      };

      req.once("close", cleanupChild);
      res.once("close", cleanupChild);

      try {
        await spawnedPromise;

        res.writeHead(200, {
          "Content-Type": "audio/mp4",
          "Cache-Control": "no-store",
          "Accept-Ranges": "none",
        });

        await streamPipeline(child.stdout, res);

        const { code, signal } = await exitPromise;
        if ((code ?? 0) !== 0 && signal == null) {
          console.error(`[library-files] Browser-compatible audio transcode exited with code ${code}: ${stderr.trim() || "unknown error"}`);
        }
        return;
      } finally {
        req.off("close", cleanupChild);
        res.off("close", cleanupChild);
        cleanupChild();
      }
    }

    // Handle range requests for audio/video seeking
    const rangeHeader = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
    if (rangeHeader) {
      let parsed: { start: number; end: number } | null;
      try {
        parsed = parsePlaybackRange(rangeHeader, fileSize);
      } catch {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.end();
        return;
      }

      if (!parsed) {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
        });
        await streamPipeline(fs.createReadStream(filePath), res);
        return;
      }

      const { start, end } = parsed;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });
      await streamPipeline(fs.createReadStream(filePath, { start, end }), res);
      return;
    }

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    await streamPipeline(fs.createReadStream(filePath), res);
  } catch (error: any) {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      return;
    }
    console.error("[library-files] Stream error:", error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ detail: error.message });
  }
});

/**
 * POST /api/v1/mediaFile/scan/:artistId
 * Trigger a library scan for a specific artist.
 * Queues the local scan/import phase only.
 */
router.post("/scan/:artistId", (req, res) => {
  try {
    const { artistId } = req.params;
    const artist = db.prepare("SELECT id, name FROM ArtistMetadata WHERE id = ?").get(artistId) as any;
    if (!artist) {
      return res.status(404).json({ detail: `Artist ${artistId} not found` });
    }

    const commandId = queueArtistWorkflow({
      artistId,
      artistName: artist.name,
      workflow: "library-scan",
      trigger: CommandTrigger.Manual,
    });

    res.json({ success: true, commandId, message: `Library scan queued for ${artist.name}` });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

/**
 * POST /api/v1/mediaFile/scan-roots
 * Queue a root folder scan that discovers unknown folders in all library roots,
 * runs the shared import decision pipeline, and imports anything it can identify.
 */
router.post("/scan-roots", async (req, res) => {
  try {
    const commandId = await runWithAsyncBusyRetry(() =>
      rootScanRouteService.queueRootScan({
        trigger: CommandTrigger.Manual,
        fullProcessing: req.body?.fullProcessing,
        monitorArtist: req.body?.monitorArtist,
      }),
    );
    res.json({ success: true, commandId, message: "Root folder scan queued" });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;


