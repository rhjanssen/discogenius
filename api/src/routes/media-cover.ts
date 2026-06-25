import fs from "fs";
import path from "path";
import { Router } from "express";

import { CONFIG_DIR } from "../services/config/config.js";
import { getMediaCoverContentType, resolveMediaCoverFilePath } from "../services/metadata/media-cover-service.js";

const router = Router();
const MEDIA_COVER_ROOT = path.join(CONFIG_DIR, "MediaCover");

function sendMediaCover(res: any, filePath: string): void {
  res.setHeader("Content-Type", getMediaCoverContentType(filePath));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(filePath).pipe(res);
}

router.get("/Albums/:albumId/:filename", (req, res) => {
  const albumId = String(req.params.albumId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = resolveMediaCoverFilePath(path.join(MEDIA_COVER_ROOT, "Albums", albumId), String(req.params.filename || ""));
  if (!filePath) {
    return res.status(404).end();
  }
  return sendMediaCover(res, filePath);
});

router.get("/:artistId/:filename", (req, res) => {
  const artistId = String(req.params.artistId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = resolveMediaCoverFilePath(path.join(MEDIA_COVER_ROOT, artistId), String(req.params.filename || ""));
  if (!filePath) {
    return res.status(404).end();
  }
  return sendMediaCover(res, filePath);
});

export default router;
