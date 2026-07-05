import { CONFIG_DIR, getConfigSection } from "../config/config.js";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";
import { db } from "../../database.js";
import { isMainThread } from "node:worker_threads";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as jpeg from "jpeg-js";
import * as pngjs from "pngjs";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderArtworkEntityType } from "../providers/streaming-provider.js";

export type ServarrMetadataImage = {
  Url?: string | null;
  url?: string | null;
  remoteUrl?: string | null;
  CoverType?: string | null;
  coverType?: string | null;
  Width?: number | null;
  width?: number | null;
  Height?: number | null;
  height?: number | null;
  RemoteUrl?: string | null;
  extension?: string | null;
  Extension?: string | null;
};

export type ServarrMetadataImageContainer = {
  Images?: ServarrMetadataImage[] | null;
  images?: ServarrMetadataImage[] | null;
};

export type ProviderArtworkCandidate = {
  provider?: string | null;
  entityId?: string | number | null;
  imageId?: string | null;
  data?: unknown;
};

type MediaCoverProxyEntry = {
  url: string;
  expiresAt: number;
};

const MEDIA_COVER_PROXY_TTL_MS = 24 * 60 * 60 * 1000;
const MEDIA_COVER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MEDIA_COVER_ROOT = path.join(CONFIG_DIR, "media-cover");
const MEDIA_COVER_DEFAULT_HEIGHTS = [500, 250] as const;
const PNG = (pngjs as unknown as { PNG: any }).PNG as any;
const mediaCoverProxyMemoryCache = new Map<string, MediaCoverProxyEntry>();
let lastMediaCoverCleanupAt = 0;

type MediaCoverEntity = "Artist" | "Album" | "Video";

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
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

function safeMediaCoverEntityId(entityId: string | number): string {
  const safe = String(entityId || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown";
}

function mediaCoverFolder(entityId: string | number, coverEntity: MediaCoverEntity): string {
  const safeId = safeMediaCoverEntityId(entityId);
  if (coverEntity === "Album") {
    return path.join(MEDIA_COVER_ROOT, "Albums", safeId);
  }
  if (coverEntity === "Video") {
    return path.join(MEDIA_COVER_ROOT, "Videos", safeId);
  }
  return path.join(MEDIA_COVER_ROOT, safeId);
}

function mediaCoverUrlFolder(entityId: string | number, coverEntity: MediaCoverEntity): string {
  const safeId = encodeURIComponent(safeMediaCoverEntityId(entityId));
  if (coverEntity === "Album") {
    return `/media-cover/Albums/${safeId}`;
  }
  if (coverEntity === "Video") {
    return `/media-cover/Videos/${safeId}`;
  }
  return `/media-cover/${safeId}`;
}

function normalizedCoverType(coverType: string): string {
  const normalized = String(coverType || "cover").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || "cover";
}

function filenameForCover(coverType: string, extension: string, height?: number | null): string {
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = height ? `-${height}` : "";
  return `${normalizedCoverType(coverType)}${suffix}${safeExtension}`;
}

function getMediaCoverPath(entityId: string | number, coverEntity: MediaCoverEntity, coverType: string, extension: string, height?: number | null): string {
  return path.join(mediaCoverFolder(entityId, coverEntity), filenameForCover(coverType, extension, height));
}

function getMediaCoverUrl(entityId: string | number, coverEntity: MediaCoverEntity, coverType: string, extension: string, height?: number | null): string {
  return `${mediaCoverUrlFolder(entityId, coverEntity)}/${filenameForCover(coverType, extension, height)}`;
}

function existingMediaCover(entityId: string | number | null | undefined, coverEntity: MediaCoverEntity, coverType: string): { path: string; url: string } | null {
  if (entityId == null || String(entityId).trim() === "") {
    return null;
  }

  for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    const filePath = getMediaCoverPath(entityId, coverEntity, coverType, extension);
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile() && stats.size > 0) {
        return { path: filePath, url: getMediaCoverUrl(entityId, coverEntity, coverType, extension) };
      }
    } catch {
      // try next extension
    }
  }

  return null;
}

function contentTypeForExtension(extension: string): string {
  return CONTENT_TYPES_BY_EXTENSION[extension.toLowerCase()] ?? "image/jpeg";
}

function extensionForImage(contentType: string | null, sourceUrl: string): string {
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

function decodeImage(buffer: Buffer, extension: string): { width: number; height: number; data: Uint8Array } | null {
  if (extension === ".png") {
    const decoded = PNG.sync.read(buffer);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  return null;
}

function resizeRgbaNearest(
  source: { width: number; height: number; data: Uint8Array },
  targetHeight: number,
): { width: number; height: number; data: Buffer } {
  const targetWidth = Math.max(1, Math.round(source.width * targetHeight / source.height));
  const output = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / targetWidth));
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      output[targetIndex] = source.data[sourceIndex];
      output[targetIndex + 1] = source.data[sourceIndex + 1];
      output[targetIndex + 2] = source.data[sourceIndex + 2];
      output[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }

  return { width: targetWidth, height: targetHeight, data: output };
}

function writeResizedMediaCovers(originalPath: string, entityId: string | number, coverEntity: MediaCoverEntity, coverType: string, extension: string): void {
  let decoded: { width: number; height: number; data: Uint8Array } | null = null;
  try {
    decoded = decodeImage(fs.readFileSync(originalPath), extension);
  } catch (error) {
    console.warn("[MediaCoverService] Failed to decode artwork for resizing:", (error as Error).message);
    return;
  }

  if (!decoded) {
    return;
  }

  for (const targetHeight of MEDIA_COVER_DEFAULT_HEIGHTS) {
    if (decoded.height <= targetHeight) {
      continue;
    }

    try {
      const resized = resizeRgbaNearest(decoded, targetHeight);
      const encoded = jpeg.encode({
        width: resized.width,
        height: resized.height,
        data: resized.data,
      }, 92).data;
      fs.writeFileSync(getMediaCoverPath(entityId, coverEntity, coverType, ".jpg", targetHeight), encoded);
    } catch (error) {
      console.warn(`[MediaCoverService] Failed to write ${targetHeight}px artwork:`, (error as Error).message);
    }
  }
}

export function getCoverArtArchiveReleaseGroupUrl(releaseGroupMbid: string | null | undefined): string | null {
  const mbid = String(releaseGroupMbid || "").trim();
  return mbid ? `https://coverartarchive.org/release-group/${mbid}/front` : null;
}

export async function ensureCachedMediaCover(options: {
  entityId: string | number | null | undefined;
  coverEntity: MediaCoverEntity;
  coverType: string;
  sourceUrl: string | null | undefined;
}): Promise<string | null> {
  const sourceUrl = normalizeArtworkUrl(options.sourceUrl);
  if (!sourceUrl || options.entityId == null || String(options.entityId).trim() === "") {
    return null;
  }

  const existing = existingMediaCover(options.entityId, options.coverEntity, options.coverType);
  if (existing) {
    return existing.url;
  }

  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": getDiscogeniusUserAgent("media cover"),
      },
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type");
    const extension = extensionForImage(contentType, sourceUrl);
    const folder = mediaCoverFolder(options.entityId, options.coverEntity);
    fs.mkdirSync(folder, { recursive: true });

    const filePath = getMediaCoverPath(options.entityId, options.coverEntity, options.coverType, extension);
    fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    writeResizedMediaCovers(filePath, options.entityId, options.coverEntity, options.coverType, extension);

    return getMediaCoverUrl(options.entityId, options.coverEntity, options.coverType, extension);
  } catch (error) {
    console.warn("[MediaCoverService] Failed to cache artwork:", (error as Error).message);
    return null;
  }
}

export function getMediaCoverFilePathFromUrl(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text.startsWith("/media-cover/")) {
    return null;
  }

  const parts = text.split("/").map((part) => decodeURIComponent(part));
  if (parts.length < 4) {
    return null;
  }

  if (parts[2] === "Albums" && parts.length >= 5) {
    const albumId = safeMediaCoverEntityId(parts[3]);
    return resolveMediaCoverFilePath(path.join(MEDIA_COVER_ROOT, "Albums", albumId), parts[4]);
  }

  if (parts[2] === "Videos" && parts.length >= 5) {
    const videoId = safeMediaCoverEntityId(parts[3]);
    return resolveMediaCoverFilePath(path.join(MEDIA_COVER_ROOT, "Videos", videoId), parts[4]);
  }

  const artistId = safeMediaCoverEntityId(parts[2]);
  return resolveMediaCoverFilePath(path.join(MEDIA_COVER_ROOT, artistId), parts[3]);
}

export function resolveMediaCoverFilePath(folder: string, filename: string): string | null {
  const safeFilename = path.basename(String(filename || ""));
  if (!safeFilename || safeFilename !== filename) {
    return null;
  }

  const requested = path.join(folder, safeFilename);
  try {
    const stats = fs.statSync(requested);
    if (stats.isFile() && stats.size > 0) {
      return requested;
    }
  } catch {
    // Try falling back from cover-250.jpg to cover.* like Lidarr's route does.
  }

  const match = safeFilename.match(/^(.+)-\d+\.[a-z0-9]+$/i);
  if (!match) {
    return null;
  }

  for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    const fallback = path.join(folder, `${match[1]}${extension}`);
    try {
      const stats = fs.statSync(fallback);
      if (stats.isFile() && stats.size > 0) {
        return fallback;
      }
    } catch {
      // try next extension
    }
  }

  return null;
}

export function getMediaCoverContentType(filePath: string): string {
  return contentTypeForExtension(path.extname(filePath));
}

function runBestEffortMediaCoverWrite(action: () => void): void {
  try {
    db.pragma("busy_timeout = 0");
    action();
  } catch {
    // This cache is an optimization for proxied artwork URLs. During heavy
    // command-worker writes, never let cache maintenance block library reads.
  } finally {
    try {
      db.pragma(`busy_timeout = ${isMainThread ? 5000 : 30000}`);
    } catch {
      // Ignore restore failures; the next connection initialization will set it.
    }
  }
}

function clearExpiredMediaCoverProxyEntries(now = Date.now()): void {
  if (now - lastMediaCoverCleanupAt < MEDIA_COVER_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastMediaCoverCleanupAt = now;

  for (const [hash, entry] of mediaCoverProxyMemoryCache) {
    if (entry.expiresAt <= now) {
      mediaCoverProxyMemoryCache.delete(hash);
    }
  }

  runBestEffortMediaCoverWrite(() => {
    db.prepare("DELETE FROM MediaCoverProxyCache WHERE expires_at <= ?").run(now);
  });
}

function getSafeMediaCoverFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const basename = path.basename(parsed.pathname) || "cover.jpg";
    const safe = basename.replace(/[^a-zA-Z0-9._-]/g, "_");

    if (/\.(jpg|jpeg|png|gif|webp)$/i.test(safe)) {
      return safe;
    }

    return `${safe || "cover"}.jpg`;
  } catch {
    return "cover.jpg";
  }
}

export function registerMediaCoverProxyUrl(value: unknown): string | null {
  const url = normalizeArtworkUrl(value);
  if (!url) {
    return null;
  }

  const now = Date.now();
  clearExpiredMediaCoverProxyEntries(now);

  const hash = crypto.createHash("sha256").update(url).digest("hex");
  const expiresAt = now + MEDIA_COVER_PROXY_TTL_MS;
  mediaCoverProxyMemoryCache.set(hash, { url, expiresAt });

  runBestEffortMediaCoverWrite(() => {
    db.prepare(`
      INSERT INTO MediaCoverProxyCache (hash, url, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        expires_at = excluded.expires_at
    `).run(hash, url, expiresAt);
  });

  return `/media-cover-proxy/${hash}/${getSafeMediaCoverFilename(url)}`;
}

export function getRegisteredMediaCoverProxyUrl(hash: string): string | null {
  clearExpiredMediaCoverProxyEntries();
  const memoryEntry = mediaCoverProxyMemoryCache.get(hash);
  if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
    return memoryEntry.url;
  }

  try {
    const row = db.prepare("SELECT url FROM MediaCoverProxyCache WHERE hash = ?").get(hash) as { url: string } | undefined;
    return row?.url ?? null;
  } catch (error) {
    console.warn("Failed to get registered media cover proxy URL from DB:", error);
    return null;
  }
}

export function resolveMediaCoverProxyUrl(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const match = text.match(/^\/media-cover-proxy\/([a-f0-9]{64})\//i);
  if (match) {
    return getRegisteredMediaCoverProxyUrl(match[1]);
  }

  return normalizeArtworkUrl(text);
}

function existingAlbumMediaCoverUrl(albumMbid: string | null | undefined): string | null {
  return existingMediaCover(albumMbid, "Album", "Cover")?.url ?? null;
}

function existingArtistMediaCoverUrl(artistMbid: string | null | undefined, coverTypes: string | string[] | undefined): string | null {
  const types = preferredTypes(coverTypes, ["Poster", "Headshot", "Fanart"]);
  for (const coverType of types) {
    const existing = existingMediaCover(artistMbid, "Artist", coverType);
    if (existing) {
      return existing.url;
    }
  }
  return null;
}

function existingVideoMediaCoverUrl(videoId: string | number | null | undefined): string | null {
  return existingMediaCover(videoId, "Video", "Cover")?.url ?? null;
}

function firstStoredImageUrl(images: ServarrMetadataImage[] | undefined | null, coverTypes: string[], includeProviderFallbacks: boolean): string | null {
  if (!images || images.length === 0) {
    return null;
  }

  for (const coverType of coverTypes) {
    const match = images.find((img) => {
      const imageCoverType = String(img.coverType || img.CoverType || "").trim().toLowerCase();
      const source = String((img as any).source || (img as any).Source || "").trim().toLowerCase();
      return imageCoverType === coverType.toLowerCase()
        && (includeProviderFallbacks || source !== "provider-fallback")
        && imageUrl(img);
    });
    if (match) {
      const url = imageUrl(match);
      if (url) {
        return url;
      }
    }
  }

  const fallback = images.find((img) => {
    const source = String((img as any).source || (img as any).Source || "").trim().toLowerCase();
    return (includeProviderFallbacks || source !== "provider-fallback") && imageUrl(img);
  });
  if (fallback) {
    const url = imageUrl(fallback);
    if (url) {
      return url;
    }
  }

  return null;
}

function expectedMediaCoverUrl(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string,
  sourceUrl: string | null | undefined,
): string | null {
  const normalizedSource = normalizeArtworkUrl(sourceUrl);
  if (entityId == null || String(entityId).trim() === "" || !normalizedSource) {
    return null;
  }
  return getMediaCoverUrl(entityId, coverEntity, coverType, extensionForImage(null, normalizedSource));
}

export function mapAlbumArtworkToLocalUrl(options: {
  albumMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  includeExpectedProviderFallback?: boolean;
}): string | null {
  const existing = existingAlbumMediaCoverUrl(options.albumMbid);
  if (existing) {
    return existing;
  }

  const canonicalSource = firstStoredImageUrl(
    options.servarrMetadataData?.images,
    preferredTypes("Cover", ["Cover"]),
    false,
  ) || getServarrMetadataAlbumImageUrl(options.servarrMetadataData);
  const canonicalUrl = expectedMediaCoverUrl(options.albumMbid, "Album", "Cover", canonicalSource);
  if (canonicalUrl) {
    return canonicalUrl;
  }

  const storedProviderFallback = firstStoredImageUrl(
    options.servarrMetadataData?.images,
    preferredTypes("Cover", ["Cover"]),
    true,
  );
  const providerSource = options.includeExpectedProviderFallback === false
    ? null
    : storedProviderFallback || providerArtworkIdFromCandidates(options.providerCandidates || [], "album");
  return expectedMediaCoverUrl(options.albumMbid, "Album", "Cover", providerSource);
}

export function mapArtistArtworkToLocalUrl(options: {
  artistMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
  sourceUrls?: Array<string | null | undefined>;
}): string | null {
  const types = preferredTypes(options.preferredCoverTypes, ["Poster", "Headshot", "Fanart"]);
  const existing = existingArtistMediaCoverUrl(options.artistMbid, types);
  if (existing) {
    return existing;
  }

  const storedSource = firstStoredImageUrl(options.servarrMetadataData?.images, types, true)
    || getServarrMetadataArtistImageUrl(options.servarrMetadataData, types);
  const explicitSource = options.sourceUrls?.map(normalizeArtworkUrl).find((url): url is string => Boolean(url));
  const providerSource = providerArtworkIdFromCandidates(options.providerCandidates || [], "artist");
  return expectedMediaCoverUrl(
    options.artistMbid,
    "Artist",
    types[0] || "Poster",
    storedSource || explicitSource || providerSource,
  );
}

/**
 * Build a ServarrMetadataImageContainer from a catalog row's curated `images`
 * JSON column (an array of mapped images), replacing the old practice of passing
 * the whole raw `data` blob just so the artwork resolver could read its images.
 */
export function imageContainerFromImagesColumn(imagesJson: unknown): ServarrMetadataImageContainer | null {
  const parsed = parseJsonObject(imagesJson);
  if (Array.isArray(parsed)) {
    return { images: parsed as ServarrMetadataImage[] };
  }
  return parsed as ServarrMetadataImageContainer | null;
}

export function parseJsonObject(value: unknown): Record<string, any> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value as Record<string, any>;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

function textOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return null;
}

export function normalizeArtworkUrl(value: unknown): string | null {
  const url = textOrNull(value);
  if (!url) {
    return null;
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return null;
}

function getServarrMetadataImages(resource: ServarrMetadataImageContainer | null | undefined): ServarrMetadataImage[] {
  if (!resource) {
    return [];
  }

  if (Array.isArray(resource.Images)) {
    return resource.Images;
  }

  if (Array.isArray(resource.images)) {
    return resource.images;
  }

  return [];
}

function imageUrl(image: ServarrMetadataImage): string | null {
  return normalizeArtworkUrl(image.Url || image.url || image.remoteUrl);
}

function imageCoverType(image: ServarrMetadataImage): string {
  return String(image.CoverType || image.coverType || "").trim().toLowerCase();
}

function imageArea(image: ServarrMetadataImage): number {
  const width = Number(image.Width ?? image.width ?? 0);
  const height = Number(image.Height ?? image.height ?? 0);
  return Number.isFinite(width * height) ? width * height : 0;
}

function preferredTypes(value: string | string[] | undefined, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value) {
    return [value];
  }
  return fallback;
}

function isProviderFallbackImage(image: Record<string, any>): boolean {
  return String(image.source || image.Source || "").trim().toLowerCase() === "provider-fallback";
}

function chooseImageFromStoredList(
  images: unknown,
  preferredCoverTypes: string[],
  options: { includeProviderFallbacks: boolean; proxy: boolean },
): string | null {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const candidates = images
    .filter((image): image is Record<string, any> => Boolean(image && typeof image === "object"))
    .filter((image) => options.includeProviderFallbacks || !isProviderFallbackImage(image));
  if (candidates.length === 0) {
    return null;
  }

  for (const coverType of preferredCoverTypes) {
    const match = candidates.find((image) => String(image.coverType || image.CoverType || "").trim().toLowerCase() === coverType.toLowerCase());
    if (match?.url || match?.Url || match?.remoteUrl || match?.RemoteUrl) {
      const url = normalizeArtworkUrl(match.url || match.Url || match.remoteUrl || match.RemoteUrl);
      if (url) {
        return options.proxy ? registerMediaCoverProxyUrl(url) || url : url;
      }
    }
  }

  const fallback = candidates[0];
  const fallbackUrl = fallback?.url || fallback?.Url || fallback?.remoteUrl || fallback?.RemoteUrl;
  if (!fallbackUrl) {
    return null;
  }
  const url = normalizeArtworkUrl(fallbackUrl);
  return url ? options.proxy ? registerMediaCoverProxyUrl(url) || url : url : null;
}

export function getServarrMetadataImageUrl(
  resource: ServarrMetadataImageContainer | null | undefined,
  preferredCoverTypes: string | string[],
): string | null {
  const images = getServarrMetadataImages(resource).filter((image) => imageUrl(image));
  if (images.length === 0) {
    return null;
  }

  for (const coverType of preferredTypes(preferredCoverTypes, [])) {
    const normalizedType = coverType.trim().toLowerCase();
    const match = images
      .filter((image) => imageCoverType(image) === normalizedType)
      .sort((left, right) => imageArea(right) - imageArea(left))[0];
    const url = match ? imageUrl(match) : null;
    if (url) {
      return url;
    }
  }

  const fallbackUrl = imageUrl(images.sort((left, right) => imageArea(right) - imageArea(left))[0]);
  return fallbackUrl || null;
}

export function getServarrMetadataArtistImageUrl(
  artist: ServarrMetadataImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = ["Poster", "Headshot", "Fanart"],
): string | null {
  return getServarrMetadataImageUrl(artist, preferredCoverTypes);
}

export function getServarrMetadataAlbumImageUrl(
  album: ServarrMetadataImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = ["Cover", "Poster"],
): string | null {
  return getServarrMetadataImageUrl(album, preferredCoverTypes);
}

function configuredAlbumCoverResolution(): "origin" | number {
  try {
    const resolution = getConfigSection("metadata")?.album_cover_resolution;
    return resolution === "origin" ? "origin" : Number(resolution || 500);
  } catch {
    return 500;
  }
}

function nestedRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

export function extractProviderArtworkId(value: unknown, entityType: ProviderArtworkEntityType): string | null {
  const data = parseJsonObject(value);
  if (!data) {
    return null;
  }

  const raw = nestedRecord(data.raw);
  const keys = entityType === "artist"
    ? [data.picture, data.image, data.image_id, data.imageId, raw.picture, raw.image, raw.image_id, raw.imageId]
    : [data.cover, data.image, data.image_id, data.imageId, raw.cover, raw.image, raw.image_id, raw.imageId];

  return textOrNull(...keys);
}

export function albumProviderArtworkCandidatesFromRow(row: Record<string, any>): ProviderArtworkCandidate[] {
  const selectedProvider = textOrNull(row.selected_provider);
  const candidates: ProviderArtworkCandidate[] = [
    {
      provider: textOrNull(row.stereo_provider, selectedProvider),
      entityId: textOrNull(row.stereo_provider_id, row.selected_provider_id),
      imageId: extractProviderArtworkId(row.stereo_provider_data, "album"),
      data: row.stereo_provider_data,
    },
    {
      provider: textOrNull(row.spatial_provider, selectedProvider),
      entityId: textOrNull(row.spatial_provider_id, row.selected_provider_id),
      imageId: extractProviderArtworkId(row.spatial_provider_data, "album"),
      data: row.spatial_provider_data,
    },
    {
      provider: selectedProvider,
      entityId: textOrNull(row.selected_provider_id, row.provider_id),
      imageId: textOrNull(row.provider_asset_id, extractProviderArtworkId(row.provider_data, "album")),
      data: row.provider_data,
    },
  ];

  return candidates.filter((candidate) => candidate.provider || candidate.imageId || candidate.data || candidate.entityId);
}

export function providerArtworkIdFromCandidates(
  candidates: ProviderArtworkCandidate[],
  entityType: ProviderArtworkEntityType,
): string | null {
  for (const candidate of candidates) {
    const imageId = textOrNull(candidate.imageId, extractProviderArtworkId(candidate.data, entityType));
    if (imageId) {
      return imageId;
    }
  }
  return null;
}

export function videoProviderArtworkCandidatesFromRow(row: Record<string, any>): ProviderArtworkCandidate[] {
  const provider = textOrNull(row.provider, row.selected_provider);
  const data = row.provider_data ?? row.data;
  return [{
    provider,
    entityId: textOrNull(row.provider_id, row.selected_provider_id),
    imageId: textOrNull(row.provider_asset_id, row.asset_id, row.cover, row.cover_image_id, extractProviderArtworkId(data, "video")),
    data,
  }].filter((candidate) => candidate.provider || candidate.imageId || candidate.data || candidate.entityId);
}

export function videoCoverLocalUrl(videoId: string | number | null | undefined): string | null {
  const normalizedVideoId = textOrNull(videoId);
  if (!normalizedVideoId) {
    return null;
  }

  const existing = existingVideoMediaCoverUrl(normalizedVideoId);
  if (existing) {
    return existing;
  }

  try {
    const row = db.prepare(`
      SELECT
        recording.cover_image_url,
        recording.cover_image_id,
        provider_item.provider,
        provider_item.provider_id,
        provider_item.asset_id AS provider_asset_id,
        provider_item.data AS provider_data
      FROM Recordings recording
      LEFT JOIN ProviderItems provider_item
        ON provider_item.rowid = (
          SELECT candidate.rowid
          FROM ProviderItems candidate
          WHERE candidate.entity_type = 'video'
            AND (
              candidate.recording_id = recording.id
              OR (recording.mbid IS NOT NULL AND candidate.recording_mbid = recording.mbid)
            )
          ORDER BY COALESCE(candidate.match_confidence, 0) DESC, candidate.updated_at DESC
          LIMIT 1
        )
      WHERE CAST(recording.id AS TEXT) = CAST(? AS TEXT)
        AND recording.is_video = 1
      LIMIT 1
    `).get(normalizedVideoId) as {
      cover_image_url?: string | null;
      cover_image_id?: string | null;
      provider?: string | null;
      provider_id?: string | null;
      provider_asset_id?: string | null;
      provider_data?: string | null;
    } | undefined;
    const source = textOrNull(row?.cover_image_url, row?.cover_image_id, row?.provider_asset_id);
    if (!source) {
      return row && videoProviderArtworkCandidatesFromRow(row).length > 0
        ? getMediaCoverUrl(normalizedVideoId, "Video", "Cover", ".jpg")
        : null;
    }
    return normalizeArtworkUrl(source)
      ? expectedMediaCoverUrl(normalizedVideoId, "Video", "Cover", source)
      : getMediaCoverUrl(normalizedVideoId, "Video", "Cover", ".jpg");
  } catch (error) {
    console.warn("[MediaCoverService] Failed to query video artwork:", error);
    return null;
  }
}

/**
 * Lidarr-aligned read mapper — the equivalent of its
 * IMapCoversToLocal.ConvertToLocalUrls. Maps an album's STORED images (the
 * `images` column) to its local /media-cover URL. Image selection and any
 * provider-fallback artwork are resolved and persisted into `images` at
 * refresh/match time (see resolveAlbumArtwork / persistResolvedFallbackArtwork),
 * so a page read never re-derives a cover from raw provider data. The
 * /media-cover route fetches the bytes on first request.
 */
export function albumCoverLocalUrl(options: {
  albumMbid?: string | null;
  images?: ServarrMetadataImageContainer | null;
}): string | null {
  let images = options.images;
  if (!images && options.albumMbid) {
    try {
      const row = db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(options.albumMbid) as { images?: string | null } | undefined;
      images = imageContainerFromImagesColumn(row?.images);
    } catch (error) {
      console.warn("[MediaCoverService] Failed to query or parse cached album artwork:", error);
    }
  }

  return mapAlbumArtworkToLocalUrl({
    albumMbid: options.albumMbid,
    servarrMetadataData: images,
  });
}

function configuredArtistPictureResolution(): number {
  try {
    const resolution = Number(getConfigSection("metadata")?.artist_picture_resolution || 750);
    return Number.isFinite(resolution) ? resolution : 750;
  } catch {
    return 750;
  }
}

function persistResolvedFallbackArtwork(
  table: "Albums" | "ArtistMetadata",
  mbid: string | null | undefined,
  coverType: "Cover" | "Headshot",
  url: string,
): void {
  const canonicalMbid = String(mbid || "").trim();
  if (!canonicalMbid) {
    return;
  }

  try {
    const row = db.prepare(`SELECT images FROM ${table} WHERE mbid = ?`).get(canonicalMbid) as {
      images?: string | null;
    } | undefined;
    const existing = row?.images ? JSON.parse(row.images) : [];
    if (Array.isArray(existing) && existing.length > 0) {
      return;
    }

    db.prepare(`UPDATE ${table} SET images = ?, updated_at = CURRENT_TIMESTAMP WHERE mbid = ?`)
      .run(JSON.stringify([{ coverType, url, source: "provider-fallback" }]), canonicalMbid);
  } catch (error) {
    console.warn(`[MediaCoverService] Failed to cache fallback artwork for ${table}:${canonicalMbid}:`, error);
  }
}

export async function resolveProviderArtworkUrl(
  candidates: ProviderArtworkCandidate[],
  entityType: ProviderArtworkEntityType,
  size?: string | number | null,
): Promise<string | null> {
  for (const candidate of candidates) {
    const providerId = textOrNull(candidate.provider);
    const entityId = textOrNull(candidate.entityId);
    const imageId = textOrNull(candidate.imageId, extractProviderArtworkId(candidate.data, entityType));

    if (providerId && (entityId || imageId)) {
      try {
        const provider = streamingProviderManager.getStreamingProvider(providerId);
        const resolved = await provider.getArtworkUrl?.({
          entityType,
          providerId: entityId,
          imageId,
          size,
        });
        const url = normalizeArtworkUrl(resolved);
        if (url) {
          return url;
        }
      } catch {
        // provider artwork is a fallback source; continue to the next candidate.
      }
    }

    const directUrl = normalizeArtworkUrl(imageId || extractProviderArtworkId(candidate.data, entityType));
    if (directUrl) {
      return directUrl;
    }
  }

  return null;
}

export async function resolveAlbumArtwork(options: {
  albumMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  size?: string | number | null;
}): Promise<string | null> {
  const localCoverUrl = existingAlbumMediaCoverUrl(options.albumMbid);
  if (localCoverUrl) {
    return localCoverUrl;
  }

  let storedProviderFallbackUrl: string | null = null;
  if (options.albumMbid) {
    try {
      const row = db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(options.albumMbid) as { images?: string | null } | undefined;
      if (row?.images) {
        const dbImages = JSON.parse(row.images);
        const preferredCoverTypes = ["Cover", "Poster"];
        const storedCanonicalUrl = chooseImageFromStoredList(dbImages, preferredCoverTypes, {
          includeProviderFallbacks: false,
          proxy: false,
        });
        if (storedCanonicalUrl) {
          const cached = await ensureCachedMediaCover({
            entityId: options.albumMbid,
            coverEntity: "Album",
            coverType: "Cover",
            sourceUrl: storedCanonicalUrl,
          });
          if (cached) return cached;
        }
        storedProviderFallbackUrl = chooseImageFromStoredList(dbImages, preferredCoverTypes, {
          includeProviderFallbacks: true,
          proxy: false,
        });
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve album artwork from database:", error);
    }
  }

  const servarrMetadataUrl = getServarrMetadataAlbumImageUrl(options.servarrMetadataData);
  if (servarrMetadataUrl) {
    const cached = await ensureCachedMediaCover({
      entityId: options.albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: servarrMetadataUrl,
    });
    if (cached) return cached;
  }

  const coverArtArchiveUrl = getCoverArtArchiveReleaseGroupUrl(options.albumMbid);
  if (coverArtArchiveUrl) {
    const cached = await ensureCachedMediaCover({
      entityId: options.albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: coverArtArchiveUrl,
    });
    if (cached) return cached;
  }
  if (storedProviderFallbackUrl) {
    const cached = await ensureCachedMediaCover({
      entityId: options.albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: storedProviderFallbackUrl,
    });
    if (cached) return cached;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    options.providerCandidates || [],
    "album",
    options.size ?? configuredAlbumCoverResolution(),
  );
  if (providerUrl) {
    persistResolvedFallbackArtwork("Albums", options.albumMbid, "Cover", providerUrl);
    const cached = await ensureCachedMediaCover({
      entityId: options.albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: providerUrl,
    });
    if (cached) return cached;
  }

  return null;
}

/**
 * Provider artwork candidates for an artist, pulled from the DB so callers don't
 * have to assemble them (mirrors how the video resolver self-serves). Sources the
 * matched provider artist offer(s) (`ProviderItems entity_type='artist'`) and the
 * `ArtistMetadata.picture` asset. This is what makes provider artist images the
 * backup source once a match exists — including in MB mode, where MB serves no art.
 */
export function loadArtistProviderArtworkCandidates(artistMbid?: string | null): ProviderArtworkCandidate[] {
  const mbid = textOrNull(artistMbid);
  if (!mbid) return [];
  try {
    const rows = db.prepare(`
      SELECT provider, provider_id, asset_id
      FROM ProviderItems
      WHERE entity_type = 'artist' AND artist_mbid = ?
      ORDER BY COALESCE(match_confidence, 0) DESC, updated_at DESC
      LIMIT 4
    `).all(mbid) as Array<{ provider?: string | null; provider_id?: string | null; asset_id?: string | null }>;
    const candidates: ProviderArtworkCandidate[] = rows
      .filter((row) => row.asset_id || row.provider_id)
      .map((row) => ({ provider: row.provider, entityId: row.provider_id, imageId: row.asset_id }));

    // Fallback: the provider artist picture homed on ArtistMetadata (an asset id
    // sufficient on its own to build the provider image URL).
    const meta = db.prepare("SELECT picture FROM ArtistMetadata WHERE mbid = ?").get(mbid) as { picture?: string | null } | undefined;
    const picture = textOrNull(meta?.picture);
    if (picture && !candidates.some((candidate) => candidate.imageId === picture)) {
      candidates.push({ provider: streamingProviderManager.getDefaultProviderId(), imageId: picture });
    }
    return candidates;
  } catch {
    return [];
  }
}

export async function resolveArtistArtwork(options: {
  artistMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
  size?: string | number | null;
}): Promise<string | null> {
  const localCoverUrl = existingArtistMediaCoverUrl(options.artistMbid, options.preferredCoverTypes);
  if (localCoverUrl) {
    return localCoverUrl;
  }
  const types = preferredTypes(options.preferredCoverTypes, ["Poster", "Headshot", "Fanart"]);
  const coverTypeForCache = types[0] || "Poster";

  if (options.artistMbid) {
    try {
      const row = db.prepare("SELECT images FROM ArtistMetadata WHERE mbid = ?").get(options.artistMbid) as { images?: string | null } | undefined;
      if (row?.images) {
        const dbImages = JSON.parse(row.images);
        if (Array.isArray(dbImages) && dbImages.length > 0) {
          const types = preferredTypes(options.preferredCoverTypes, ["Poster", "Headshot", "Fanart"]);
          for (const coverType of types) {
            const match = dbImages.find(img => String(img.coverType || "").trim().toLowerCase() === coverType.toLowerCase());
            if (match?.url) {
              const url = normalizeArtworkUrl(match.url);
              if (url) {
                const cached = await ensureCachedMediaCover({
                  entityId: options.artistMbid,
                  coverEntity: "Artist",
                  coverType: coverTypeForCache,
                  sourceUrl: url,
                });
                if (cached) return cached;
              }
            }
          }
          const fallback = dbImages[0]?.url;
          if (fallback) {
            const url = normalizeArtworkUrl(fallback);
            if (url) {
              const cached = await ensureCachedMediaCover({
                entityId: options.artistMbid,
                coverEntity: "Artist",
                coverType: coverTypeForCache,
                sourceUrl: url,
              });
              if (cached) return cached;
            }
          }
        }
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve artist artwork from database:", error);
    }
  }

  const servarrMetadataUrl = getServarrMetadataArtistImageUrl(options.servarrMetadataData, options.preferredCoverTypes);
  if (servarrMetadataUrl) {
    const cached = await ensureCachedMediaCover({
      entityId: options.artistMbid,
      coverEntity: "Artist",
      coverType: coverTypeForCache,
      sourceUrl: servarrMetadataUrl,
    });
    if (cached) return cached;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    [...(options.providerCandidates || []), ...loadArtistProviderArtworkCandidates(options.artistMbid)],
    "artist",
    options.size ?? configuredArtistPictureResolution(),
  );
  if (providerUrl) {
    persistResolvedFallbackArtwork("ArtistMetadata", options.artistMbid, "Headshot", providerUrl);
    const cached = await ensureCachedMediaCover({
      entityId: options.artistMbid,
      coverEntity: "Artist",
      coverType: coverTypeForCache,
      sourceUrl: providerUrl,
    });
    if (cached) return cached;
  }

  return null;
}

export async function resolveVideoArtwork(options: {
  videoId?: string | number | null;
  providerCandidates?: ProviderArtworkCandidate[];
  size?: string | number | null;
}): Promise<string | null> {
  const normalizedVideoId = textOrNull(options.videoId);
  const localCoverUrl = existingVideoMediaCoverUrl(normalizedVideoId);
  if (localCoverUrl) {
    return localCoverUrl;
  }

  let storedSource: string | null = null;
  let providerCandidates = options.providerCandidates || [];
  if (normalizedVideoId) {
    try {
      const row = db.prepare(`
        SELECT
          recording.cover_image_url,
          recording.cover_image_id,
          provider_item.provider,
          provider_item.provider_id,
          provider_item.asset_id AS provider_asset_id,
          provider_item.data AS provider_data
        FROM Recordings recording
        LEFT JOIN ProviderItems provider_item
          ON provider_item.rowid = (
            SELECT candidate.rowid
            FROM ProviderItems candidate
            WHERE candidate.entity_type = 'video'
              AND (
                candidate.recording_id = recording.id
                OR (recording.mbid IS NOT NULL AND candidate.recording_mbid = recording.mbid)
              )
            ORDER BY COALESCE(candidate.match_confidence, 0) DESC, candidate.updated_at DESC
            LIMIT 1
          )
        WHERE CAST(recording.id AS TEXT) = CAST(? AS TEXT)
          AND recording.is_video = 1
        LIMIT 1
      `).get(normalizedVideoId) as Record<string, any> | undefined;

      storedSource = normalizeArtworkUrl(row?.cover_image_url) || null;
      if (row) {
        providerCandidates = [
          ...videoProviderArtworkCandidatesFromRow(row),
          ...providerCandidates,
        ];
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve video artwork from database:", error);
    }
  }

  if (storedSource) {
    const cached = await ensureCachedMediaCover({
      entityId: normalizedVideoId,
      coverEntity: "Video",
      coverType: "Cover",
      sourceUrl: storedSource,
    });
    if (cached) return cached;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    providerCandidates,
    "video",
    options.size ?? "1080x720",
  );
  if (providerUrl) {
    const cached = await ensureCachedMediaCover({
      entityId: normalizedVideoId,
      coverEntity: "Video",
      coverType: "Cover",
      sourceUrl: providerUrl,
    });
    if (cached) return cached;
  }

  return null;
}

// MediaCoverService class aligned 1:1 with Lidarr naming and structure
export class MediaCoverService {
  static getArtistImageUrl(artist: ServarrMetadataImageContainer, preferredCoverType = "Poster"): string | null {
    return getServarrMetadataArtistImageUrl(artist, preferredCoverType);
  }

  static getAlbumImageUrl(album: ServarrMetadataImageContainer, preferredCoverType = "Cover"): string | null {
    return getServarrMetadataAlbumImageUrl(album, preferredCoverType);
  }

  static getCoverPath(entityId: number, coverEntity: MediaCoverEntity, coverType: string, extension: string): string {
    return getMediaCoverPath(entityId, coverEntity, coverType, extension);
  }

  static convertToLocalUrls(entityId: number, coverEntity: MediaCoverEntity, covers: ServarrMetadataImage[]): void {
    for (const cover of covers) {
      const url = imageUrl(cover);
      const coverType = cover.CoverType || cover.coverType || (coverEntity === "Album" ? "Cover" : "Poster");
      if (!url || !coverType) continue;
      const extension = cover.Extension || cover.extension || extensionForImage(null, url);
      cover.RemoteUrl = url;
      cover.remoteUrl = url;
      cover.Url = getMediaCoverUrl(entityId, coverEntity, coverType, extension);
      cover.url = cover.Url;
    }
  }

  static albumCoverLocalUrl = albumCoverLocalUrl;
  static resolveAlbumArtwork = resolveAlbumArtwork;
  static resolveArtistArtwork = resolveArtistArtwork;
  static resolveVideoArtwork = resolveVideoArtwork;
  static videoCoverLocalUrl = videoCoverLocalUrl;
  static albumProviderArtworkCandidatesFromRow = albumProviderArtworkCandidatesFromRow;
  static videoProviderArtworkCandidatesFromRow = videoProviderArtworkCandidatesFromRow;
  static parseJsonObject = parseJsonObject;
  static normalizeArtworkUrl = normalizeArtworkUrl;
  static registerUrl = registerMediaCoverProxyUrl;
  static getUrl = getRegisteredMediaCoverProxyUrl;
  static resolveProxyUrl = resolveMediaCoverProxyUrl;
  static ensureCachedMediaCover = ensureCachedMediaCover;
  static getCoverArtArchiveReleaseGroupUrl = getCoverArtArchiveReleaseGroupUrl;
}
