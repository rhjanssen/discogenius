import { Router } from "express";
import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { LibraryFilesService } from "../services/library-files.js";
import { DiskScanService } from "../services/library-scan.js";
import { resolveStoredLibraryPath } from "../services/library-paths.js";
import { queueArtistWorkflow } from "../services/artist-workflow.js";
import { queueRescanFoldersPass } from "../services/monitoring-scheduler.js";
import { getConfigSection } from "../services/config.js";
import { UpgradableSpecification } from "../services/upgradable-specification.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";
import type { LibraryFileContract, LibraryFilesListResponseContract } from "../contracts/media.js";

const router = Router();
let immediateRootScanInProgress = false;

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
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const artistId = req.query.artistId as string | undefined;
    const albumId = req.query.albumId as string | undefined;
    const mediaId = req.query.mediaId as string | undefined;
    const libraryRoot = req.query.libraryRoot as string | undefined;
    const fileType = req.query.fileType as string | undefined;

    const where: string[] = [];
    const params: any[] = [];

    if (artistId) {
      where.push("lf.artist_id = ?");
      params.push(artistId);
    }
    if (albumId) {
      where.push("lf.album_id = ?");
      params.push(albumId);
    }
    if (mediaId) {
      where.push("lf.media_id = ?");
      params.push(mediaId);
    }
    if (libraryRoot) {
      where.push("lf.library_root = ?");
      params.push(libraryRoot);
    }
    if (fileType) {
      where.push("lf.file_type = ?");
      params.push(fileType);
    }

    const sql = `
      SELECT
        lf.*,
        m.type AS media_type,
        m.quality AS source_quality,
        a.quality AS album_quality
      FROM library_files lf
      LEFT JOIN media m ON m.id = lf.media_id
      LEFT JOIN albums a ON a.id = lf.album_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY lf.created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const profile = UpgradableSpecification.buildEffectiveProfile();
    const rawItems = db.prepare(sql).all(...params) as any[];
    const items: LibraryFileContract[] = rawItems.map((item) => {
      const evaluation = item.file_type === "video" || item.media_type === "Music Video"
        ? UpgradableSpecification.evaluateVideoChange({
          profile,
          currentQuality: item.quality,
          extension: item.extension,
        })
        : item.file_type === "track"
          ? UpgradableSpecification.evaluateAudioChange({
            profile,
            currentQuality: item.quality,
            sourceQuality: item.source_quality || item.album_quality,
            codec: item.codec,
            extension: item.extension,
          })
          : null;

      return {
        ...item,
        artist_id: item.artist_id == null ? null : String(item.artist_id),
        album_id: item.album_id == null ? null : String(item.album_id),
        media_id: item.media_id == null ? null : String(item.media_id),
        qualityTarget: evaluation?.targetQuality ?? null,
        qualityChangeWanted: evaluation?.needsChange ?? false,
        qualityChangeDirection: evaluation?.direction ?? "none",
        qualityCutoffNotMet: evaluation?.qualityCutoffNotMet ?? false,
        qualityChangeReason: evaluation?.needsChange ? evaluation.reason : null,
      };
    });
    const response: LibraryFilesListResponseContract = { items, limit, offset };
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

    const items = LibraryFilesService.previewRenames({ artistId, albumId, libraryRoot, fileTypes, limit, offset });
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

    const summary = LibraryFilesService.getRenameStatus({ artistId, albumId, libraryRoot, fileTypes }, sampleLimit);
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
    const refId = applyAll
      ? `apply-renames:${JSON.stringify({ artistId: artistId || null, albumId: albumId || null, libraryRoot: libraryRoot || null, fileTypes: fileTypes || [] })}`
      : undefined;

    const jobId = TaskQueueService.addJob(JobTypes.ApplyRenames, {
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
    const allowedTypes = ["lyrics", "bio", "review"];
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
router.get("/stream/:id", (req, res) => {
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

    // Handle range requests for audio/video seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });

      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error: any) {
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
 * POST /library-files/scan-now/:artistId
 * Run an immediate (synchronous) disk scan for a specific artist.
 * Does NOT run curation or metadata backfill — just reconciles library_files with disk.
 */
router.post("/scan-now/:artistId", async (req, res) => {
  try {
    const { artistId } = req.params;
    const artist = db.prepare("SELECT id, name FROM artists WHERE id = ?").get(artistId) as any;
    if (!artist) {
      return res.status(404).json({ detail: `Artist ${artistId} not found` });
    }

    const result = await DiskScanService.scan({ artistIds: [artistId] });
    res.json({ success: true, ...result });
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
    const monitorArtist = typeof req.body?.monitorArtist === "boolean"
      ? req.body.monitorArtist
      : undefined;

    const jobId = queueRescanFoldersPass({
      trigger: 1,
      fullProcessing: req.body?.fullProcessing === true,
      monitorArtist,
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

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (immediateRootScanInProgress) {
    sendEvent({
      type: "error",
      message: "A root folder scan is already running. Wait for it to finish before starting another.",
    });
    res.end();
    return;
  }

  immediateRootScanInProgress = true;

  try {
    const monitorArtist = typeof req.body?.monitorArtist === "boolean"
      ? req.body.monitorArtist
      : getConfigSection("monitoring").monitor_new_artists;

    const result = await DiskScanService.scan({
      addNewArtists: true,
      monitorNewArtists: monitorArtist,
      onProgress: (event) => {
        sendEvent({ type: "progress", message: event.message });
      },
    });

    sendEvent({ type: "complete", result });
  } catch (error: any) {
    sendEvent({ type: "error", message: error.message });
  } finally {
    immediateRootScanInProgress = false;
    res.end();
  }
});

export default router;



