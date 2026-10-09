import * as jpeg from "jpeg-js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
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

/** Decode a bounded first frame for library JPEG materialization. Native
 * conversion is asynchronous and uses a private temporary directory, never
 * MediaCover or a library path. The selected source's dimensions are retained. */
export async function decodeArtworkImage(buffer: Buffer, extension: string): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  if (buffer.length > 32 * 1024 * 1024) throw new Error("Artwork exceeds the 32 MiB conversion limit");
  const isJpeg = extension === ".jpg" || extension === ".jpeg";
  if (extension !== ".webp" && extension !== ".gif") {
    try { return decodeImage(buffer, extension); }
    catch (error) {
      // JPEG coefficients can exceed the JS decoder's budget even for a valid
      // 16 MP image. Keep that budget; native decoding needs only bounded RGBA.
      if (!isJpeg || !(error instanceof Error) || !/^maxMemoryUsageInMB limit exceeded/.test(error.message)) throw error;
    }
  }
  const isGif = ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  const isWebp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const signatureMatches = isJpeg ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : extension === ".gif" ? isGif : isWebp;
  if (!signatureMatches) throw new Error("Artwork bytes do not match their selected image container");
  const { resolveFfmpegBinary, resolveFfprobeBinary } = await import("../mediafiles/audioUtils.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discogenius-artwork-convert-"));
  const input = path.join(directory, `source${extension}`);
  const run = (binary: string, args: string[], maxBuffer: number, timeout: number) => new Promise<Buffer>((resolve, reject) => {
    execFile(binary, args, { encoding: "buffer", windowsHide: true, maxBuffer, timeout }, (error, stdout) => {
      if (error) reject(new Error(`Artwork conversion tool failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    });
  });
  try {
    await fs.writeFile(input, buffer);
    const probe = JSON.parse((await run(resolveFfprobeBinary(), ["-v", "error", "-max_alloc", "268435456", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height", "-of", "json", input], 1024 * 1024, 10_000)).toString("utf8"));
    const stream = probe.streams?.[0];
    if (!stream || stream.codec_name !== (isJpeg ? "mjpeg" : extension.slice(1)) || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)
      || stream.width < 1 || stream.height < 1 || stream.width * stream.height > 48_000_000) {
      throw new Error("Artwork has invalid dimensions or exceeds the 48 megapixel decoding limit");
    }
    if (isJpeg) {
      const expectedBytes = stream.width * stream.height * 4;
      const rgba = await run(resolveFfmpegBinary(), ["-v", "error", "-max_alloc", "268435456", "-threads", "1", "-i", input,
        "-map", "0:v:0", "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], expectedBytes, 30_000);
      if (rgba.length !== expectedBytes) throw new Error("Artwork dimensions changed during conversion");
      return {width:stream.width,height:stream.height,data:rgba};
    }
    const png = await run(resolveFfmpegBinary(), ["-v", "error", "-max_alloc", "268435456", "-threads", "1", "-i", input,
      "-map", "0:v:0", "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], 32 * 1024 * 1024, 30_000);
    const decoded = decodeImage(png, ".png");
    if (!decoded || decoded.width !== stream.width || decoded.height !== stream.height) throw new Error("Artwork dimensions changed during conversion");
    return decoded;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

