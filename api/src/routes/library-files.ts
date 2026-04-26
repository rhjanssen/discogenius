import { Router } from "express";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { db } from "../database.js";
import { listLibraryFiles, parseLibraryFilesQueryLimit, parseLibraryFilesQueryOffset } from "../services/library-files-query-service.js";
import { resolveStoredLibraryPath } from "../services/library-paths.js";
import { queueArtistWorkflow } from "../services/artist-workflow.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";
import { RenameTrackFileService } from "../services/rename-track-file-service.js";
import { requiresBrowserCompatibleAudioStream, spawnBrowserCompatibleAudioTranscode } from "../services/audioUtils.js";
import { rootScanRouteService, type RootScanSsePayload } from "../services/root-scan-route-service.js";
import { parseSingleByteRange } from "../utils/http-range.js";

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
    const libraryRoot = req.query.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes(req.query.fileTypes);
    const limit = parseInt(req.query.limit as string) || 200;
    const offset = parseInt(req.query.offset as string) || 0;

    const items = RenameTrackFileService.getRenamePreviews({ artistId, albumId, libraryRoot, fileTypes, limit, offset });
    res.json({ items, limit, offset });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/rename/status", (req, res) => {
  try {
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const libraryRoot = req.query.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes(req.query.fileTypes);
    const sampleLimit = parseInt(req.query.sampleLimit as string) || 10;

    const summary = RenameTrackFileService.getRenameStatus({ artistId, albumId, libraryRoot, fileTypes }, sampleLimit);
    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/rename/apply", (req, res) => {
  try {
    const ids = (req.body as any)?.ids as number[] | undefined;
    const applyAll = (req.body as any)?.applyAll === true;
    if ((!ids || !Array.isArray(ids) || ids.length === 0) && !applyAll) {
      return res.status(400).json({ detail: "ids array is required unless applyAll is true" });
    }

    const artistId = (req.body as any)?.artistId as string | undefined;
    const albumId = (req.body as any)?.albumId as string | undefined;
    const libraryRoot = (req.body as any)?.libraryRoot as string | undefined;
    const fileTypes = parseFileTypes((req.body as any)?.fileTypes);
    const normalizedIds = ids && Array.isArray(ids)
      ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : undefined;
    const isArtistWideRename = applyAll
      && Boolean(artistId)
      && !albumId
      && !libraryRoot
      && (!fileTypes || fileTypes.length === 0)
      && (!normalizedIds || normalizedIds.length === 0);
    const refId = applyAll
      ? (isArtistWideRename
        ? artistId
        : `rename-files:${JSON.stringify({ artistId: artistId || null, albumId: albumId || null, libraryRoot: libraryRoot || null, fileTypes: fileTypes || [] })}`)
      : undefined;

    const jobId = isArtistWideRename
      ? TaskQueueService.addJob(JobTypes.RenameArtist, {
        artistId,
        artistIds: artistId ? [artistId] : undefined,
      }, refId, 1, 1)
      : TaskQueueService.addJob(JobTypes.RenameFiles, {
        ids: normalizedIds,
        applyAll,
        artistId,
        albumId,
        libraryRoot,
        fileTypes,
      }, refId, 1, 1);

    res.json({
      success: true,
      queued: jobId !== -1,
      jobId,
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
    const file = db.prepare(`
      SELECT id, file_type, file_path, relative_path, library_root
      FROM library_files
      WHERE file_path = ?
    `).get(filePath) as any;
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
    const file = db.prepare("SELECT * FROM library_files WHERE id = ?").get(id) as any;
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
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Type": "audio/mp4",
          "Cache-Control": "no-store",
          "Accept-Ranges": "none",
        });
        return res.end();
      }

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

    const rangeResult = parseSingleByteRange(req.headers.range, fileSize);
    if (!rangeResult.satisfiable) {
      res.writeHead(416, {
        "Content-Range": rangeResult.contentRange,
        "Accept-Ranges": "bytes",
        "Content-Type": contentType,
      });
      return res.end();
    }

    if (rangeResult.range) {
      const { start, end, chunkSize } = rangeResult.range;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });

      if (req.method === "HEAD") {
        return res.end();
      }

      await streamPipeline(fs.createReadStream(filePath, { start, end }), res);
      return;
    }

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });

    if (req.method === "HEAD") {
      return res.end();
    }

    await streamPipeline(fs.createReadStream(filePath), res);
  } catch (error: any) {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      return;
    }
    console.error("[library-files] Stream error:", error);
    res.status(500).json({ detail: error.message });
  }
});

/**
 * POST /library-files/scan/:artistId
 * Trigger a library scan for a specific artist.
 * Queues the local scan/import phase only.
 */
router.post("/scan/:artistId", (req, res) => {
  try {
    const { artistId } = req.params;
    const artist = db.prepare("SELECT id, name FROM artists WHERE id = ?").get(artistId) as any;
    if (!artist) {
      return res.status(404).json({ detail: `Artist ${artistId} not found` });
    }

    const jobId = queueArtistWorkflow({
      artistId,
      artistName: artist.name,
      workflow: "library-scan",
      trigger: 1,
    });

    res.json({ success: true, jobId, message: `Library scan queued for ${artist.name}` });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

/**
 * POST /library-files/scan-roots
 * Queue a root folder scan that discovers unknown folders in all library roots,
 * runs the shared import decision pipeline, and imports anything it can identify.
 */
router.post("/scan-roots", (req, res) => {
  try {
    const jobId = rootScanRouteService.queueRootScan({
      trigger: 1,
      fullProcessing: req.body?.fullProcessing,
      monitorArtist: req.body?.monitorArtist,
    });
    res.json({ success: true, jobId, message: "Root folder scan queued" });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

/**
 * POST /library-files/scan-roots-now
 * Run an immediate root folder scan with SSE progress streaming.
 * Discovers unknown folders, runs the shared import decision pipeline, and streams progress.
 */
router.post("/scan-roots-now", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (data: RootScanSsePayload) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await rootScanRouteService.runImmediateRootScan({
      monitorArtist: req.body?.monitorArtist,
      sendEvent,
    });
  } finally {
    res.end();
  }
});

export default router;


