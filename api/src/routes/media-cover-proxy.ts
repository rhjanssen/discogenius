import { Router } from "express";

import { getRegisteredMediaCoverProxyUrl } from "../services/metadata/media-cover-service.js";
import { getDiscogeniusUserAgent } from "../services/config/user-agent.js";
import { fetchPublicHttpUrl } from "../security/outbound-http.js";

const router = Router();
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function contentTypeForFilename(filename: string, upstreamContentType: string | null): string {
  const normalized = upstreamContentType?.split(";", 1)[0].trim().toLowerCase() ?? null;
  if (normalized && ALLOWED_IMAGE_CONTENT_TYPES.has(normalized)) {
    return normalized;
  }

  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? CONTENT_TYPES_BY_EXTENSION[match[0]] ?? "image/jpeg" : "image/jpeg";
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Artwork response exceeds the size limit");
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Artwork response exceeds the size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maxBytes) await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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
    const { response } = await fetchPublicHttpUrl(url, {
      headers: {
        "User-Agent": getDiscogeniusUserAgent("artwork proxy"),
      },
    }, { maxRedirects: 3, timeoutMs: 15_000 });

    if (!response.ok) {
      return res.status(502).end();
    }

    const upstreamContentType = response.headers.get("content-type");
    const normalizedContentType = upstreamContentType?.split(";", 1)[0].trim().toLowerCase() ?? null;
    if (normalizedContentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(normalizedContentType)) {
      await response.body?.cancel();
      return res.status(415).end();
    }
    const contentType = contentTypeForFilename(filename, upstreamContentType);
    const buffer = await readBodyWithLimit(response, MAX_COVER_BYTES);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (error) {
    console.warn("[MediaCoverProxy] Failed to fetch artwork:", (error as Error).message);
    return res.status(502).end();
  }
});

export default router;
