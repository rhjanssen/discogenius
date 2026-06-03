import { Router } from "express";

import { getRegisteredMediaCoverProxyUrl } from "../services/metadata/media-cover-service.js";
import { getDiscogeniusUserAgent } from "../services/user-agent.js";

const router = Router();

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function contentTypeForFilename(filename: string, upstreamContentType: string | null): string {
  if (upstreamContentType?.toLowerCase().startsWith("image/")) {
    return upstreamContentType;
  }

  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? CONTENT_TYPES_BY_EXTENSION[match[0]] ?? "image/jpeg" : "image/jpeg";
}

router.get("/:hash/:filename", async (req, res) => {
  const hash = String(req.params.hash || "").trim();
  const filename = String(req.params.filename || "cover.jpg").trim();

  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    return res.status(404).end();
  }

  const url = getRegisteredMediaCoverProxyUrl(hash);
  if (!url) {
    return res.status(404).end();
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": getDiscogeniusUserAgent("artwork proxy"),
      },
    });

    if (!response.ok) {
      return res.status(502).end();
    }

    const contentType = contentTypeForFilename(filename, response.headers.get("content-type"));
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (error) {
    console.warn("[MediaCoverProxy] Failed to fetch artwork:", (error as Error).message);
    return res.status(502).end();
  }
});

export default router;
