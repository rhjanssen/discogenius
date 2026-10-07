import * as jpeg from "jpeg-js";
import path from "node:path";
import * as pngjs from "pngjs";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";
const PNG = (pngjs as unknown as { PNG: any }).PNG as any;

export const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function extensionForImage(contentType: string | null, sourceUrl: string): string {
  const type = String(contentType || "").split(";")[0]?.trim().toLowerCase();
  if (type && EXTENSIONS_BY_CONTENT_TYPE[type]) {
    return EXTENSIONS_BY_CONTENT_TYPE[type];
  }

  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if (CONTENT_TYPES_BY_EXTENSION[extension]) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }
  } catch {
    // fall through
  }

  return ".jpg";
}

export function decodeImage(buffer: Buffer, extension: string): { width: number; height: number; data: Uint8Array } | null {
  if (extension === ".png") {
    if (buffer.length >= 24 && buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 48_000_000) {
      throw new Error("Artwork exceeds the 48 megapixel decoding limit");
    }
    const decoded = PNG.sync.read(buffer);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: 48, maxMemoryUsageInMB: 256 });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  return null;
}

/**
 * YouTube renders `hq720.jpg` / `maxresdefault.jpg` only for some uploads; many
 * videos 404 on those and only expose the 4:3 stills. `sddefault` is present for
 * most, and `hqdefault` is generated for every video, so this ladder guarantees
 * a cover for the whole youtube-only-video class instead of a blank poster when
 * the normalized hq720 URL 404s.
 */
function youTubeThumbnailFallbacks(url: string): string[] {
  const match = url.match(/^https?:\/\/i\.ytimg\.com\/vi\/([^/?#]+)\/(hq720|maxresdefault)\.jpg(?:$|\?)/i);
  if (!match) {
    return [];
  }
  const videoId = match[1];
  return [
    ...(String(match[2]).toLowerCase() === "maxresdefault"
      ? [`https://i.ytimg.com/vi/${videoId}/hq720.jpg`]
      : []),
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ];
}

/**
 * Fetch artwork, trying provider-specific lower-res fallbacks when the primary
 * URL 404s (see youTubeThumbnailFallbacks). Returns the first OK response and
 * the URL it actually came from (so the extension is derived correctly), or null
 * when every candidate fails.
 */
export async function fetchArtworkWithFallbacks(sourceUrl: string): Promise<{ response: Response; fetchedUrl: string } | null> {
  const candidates = [sourceUrl, ...youTubeThumbnailFallbacks(sourceUrl)];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        headers: {
          "User-Agent": getDiscogeniusUserAgent("media cover"),
        },
        // Without a timeout a dead/slow image host hangs this fetch forever,
        // freezing the RefreshArtist worker (0 CPU, never resolves) — and with
        // maxConcurrent=1 that one hang deadlocks the whole refresh queue.
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        return { response, fetchedUrl: candidate };
      }
    } catch {
      // Try the next candidate; a transient failure on one still should not
      // abandon a video that has a working lower-res still.
    }
  }
  return null;
}

/** Bound downloaded bytes before image decoding; an image host must not be
 * able to exhaust a refresh/import worker's memory with an unbounded body. */
export async function readArtworkBuffer(response: Response): Promise<Buffer> {
  const limit = 32 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Artwork exceeds the 32 MiB download limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("Artwork exceeds the 32 MiB download limit");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}

