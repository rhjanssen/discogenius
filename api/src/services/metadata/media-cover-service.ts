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
import { normalizeComparableText, stringSimilarity } from "../mediafiles/import-matching-utils.js";
import {
  MediaCoverSelectionRepository,
  type MediaCoverSourceKind,
} from "./media-cover-selection-repository.js";

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
  title?: string | null;
  url?: string | null;
  /** Companion/single source that must not displace an existing active cover. */
  supplemental?: boolean;
};

type MediaCoverProxyEntry = {
  url: string;
  expiresAt: number;
};

const MEDIA_COVER_PROXY_TTL_MS = 24 * 60 * 60 * 1000;
const MEDIA_COVER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Album/artist UI cache: both sizes. Videos only need a small card proxy + full origin. */
const MEDIA_COVER_DEFAULT_HEIGHTS = [500, 250] as const;
const MEDIA_COVER_VIDEO_HEIGHTS = [250] as const;
/** Heights cleared on rewrite (includes legacy video-500 leftovers). */
const MEDIA_COVER_ALL_HEIGHTS = [500, 250] as const;
const PNG = (pngjs as unknown as { PNG: any }).PNG as any;
const mediaCoverProxyMemoryCache = new Map<string, MediaCoverProxyEntry>();
let lastMediaCoverCleanupAt = 0;

/** Resolve at call time so test suites that override DISCOGENIUS_CONFIG_DIR work. */
function mediaCoverRoot(): string {
  const override = process.env.DISCOGENIUS_CONFIG_DIR?.trim() || process.env.DISCOGENIUS_APP_DATA?.trim();
  if (override) {
    const resolved = path.isAbsolute(override) ? override : path.resolve(override);
    return path.join(resolved, "media-cover");
  }
  return path.join(CONFIG_DIR, "media-cover");
}

type MediaCoverEntity = "Artist" | "Album" | "Video";
export type MediaCoverEntityKind = MediaCoverEntity;

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

export function normalizeMediaCoverEntityId(entityId: string | number | null | undefined): string | null {
  const raw = String(entityId ?? "").trim();
  if (!raw || raw === "." || raw === "..") {
    return null;
  }
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

function safeMediaCoverEntityId(entityId: string | number): string {
  return normalizeMediaCoverEntityId(entityId) || "unknown";
}

function resolveWithinMediaCoverRoot(...segments: string[]): string {
  const root = path.resolve(mediaCoverRoot());
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Media-cover path escaped its configured root");
  }
  return candidate;
}

function mediaCoverFolder(entityId: string | number, coverEntity: MediaCoverEntity): string {
  const safeId = safeMediaCoverEntityId(entityId);
  if (coverEntity === "Album") {
    return resolveWithinMediaCoverRoot("Albums", safeId);
  }
  if (coverEntity === "Video") {
    return resolveWithinMediaCoverRoot("Videos", safeId);
  }
  return resolveWithinMediaCoverRoot(safeId);
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

function canonicalArtworkCoverTypes(
  coverEntity: "Album" | "Artist",
  requestedCoverType: string,
): string[] {
  const requested = normalizedCoverType(requestedCoverType);
  if (coverEntity === "Album" && requested === "cover") {
    return ["cover", "poster"];
  }
  if (coverEntity === "Artist" && (requested === "poster" || requested === "headshot")) {
    return requested === "poster"
      ? ["poster", "headshot"]
      : ["headshot", "poster"];
  }
  if (
    coverEntity === "Artist"
    && (requested === "fanart" || requested === "background" || requested === "landscape")
  ) {
    return [
      requested,
      ...["fanart", "background", "landscape"].filter((type) => type !== requested),
    ];
  }
  return [requested];
}

function filenameForCover(coverType: string, extension: string, height?: number | null): string {
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = height ? `-${height}` : "";
  return `${normalizedCoverType(coverType)}${suffix}${safeExtension}`;
}

function sourceMarkerPath(entityId: string | number, coverEntity: MediaCoverEntity, coverType: string): string {
  return path.join(mediaCoverFolder(entityId, coverEntity), `.${normalizedCoverType(coverType)}.source.json`);
}

function cachedSourceMatches(
  entityId: string | number,
  coverEntity: MediaCoverEntity,
  coverType: string,
  sourceUrl: string,
): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(sourceMarkerPath(entityId, coverEntity, coverType), "utf-8"));
    return marker?.url === sourceUrl && marker?.preference === configuredArtworkPreference();
  } catch {
    return false;
  }
}

function clearStaleCachedCoverFiles(
  entityId: string | number,
  coverEntity: MediaCoverEntity,
  coverType: string,
  keep: Set<string>,
): void {
  const folder = mediaCoverFolder(entityId, coverEntity);
  for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    for (const height of [null, ...MEDIA_COVER_ALL_HEIGHTS]) {
      const candidate = path.join(folder, filenameForCover(coverType, extension, height));
      if (keep.has(path.resolve(candidate))) continue;
      try { fs.rmSync(candidate, { force: true }); } catch { /* absent */ }
    }
  }
}

function commitCachedCoverVariant(options: {
  entityId: string | number;
  coverEntity: MediaCoverEntity;
  coverType: string;
  extension: string;
  originalBuffer: Buffer;
  derivatives: PreparedMediaCoverDerivative[];
}): void {
  const writes = [
    {
      target: getMediaCoverPath(
        options.entityId,
        options.coverEntity,
        options.coverType,
        options.extension,
      ),
      buffer: options.originalBuffer,
    },
    ...options.derivatives.map((derivative) => ({
      target: getMediaCoverPath(
        options.entityId,
        options.coverEntity,
        options.coverType,
        ".jpg",
        derivative.height,
      ),
      buffer: derivative.buffer,
    })),
  ];
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const staged = writes.map((write) => ({
    ...write,
    temp: path.join(path.dirname(write.target), `.${path.basename(write.target)}.${nonce}.tmp`),
  }));

  try {
    // Stage every file first. A failed write leaves the current variant intact.
    for (const write of staged) fs.writeFileSync(write.temp, write.buffer);
    for (const write of staged) fs.renameSync(write.temp, write.target);
    clearStaleCachedCoverFiles(
      options.entityId,
      options.coverEntity,
      options.coverType,
      new Set(writes.map((write) => path.resolve(write.target))),
    );
  } finally {
    for (const write of staged) {
      try { fs.rmSync(write.temp, { force: true }); } catch { /* already committed */ }
    }
  }
}

function writeSourceMarker(
  entityId: string | number,
  coverEntity: MediaCoverEntity,
  coverType: string,
  sourceUrl: string,
  fulfilledBy: MediaCoverSourceKind,
  contentHash?: string | null,
): void {
  const markerPath = sourceMarkerPath(entityId, coverEntity, coverType);
  const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(
      tempPath,
      JSON.stringify({
        url: sourceUrl,
        preference: configuredArtworkPreference(),
        fulfilledBy,
        sourceKind: fulfilledBy,
        contentHash: contentHash ?? null,
      }),
      "utf-8",
    );
    fs.renameSync(tempPath, markerPath);
  } catch {
    // The image remains usable; the next request may refresh it once more.
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* already committed */ }
  }
}

function looksLikeProviderArtworkUrl(url: unknown): boolean {
  const lower = String(url || "").trim().toLowerCase();
  if (!lower) return false;
  if (
    lower.includes("coverartarchive.org")
    || lower.includes("images.lidarr.audio")
    || lower.includes("/media-cover/")
  ) {
    return false;
  }
  return (
    lower.includes("resources.tidal.com")
    || lower.includes("mzstatic.com")
    || lower.includes("scdn.co")
    || lower.includes("i.ytimg.com")
    || lower.includes("yt3.ggpht.com")
    || lower.includes("lh3.googleusercontent.com")
    || lower.includes("deezer.com")
    || lower.includes("images-amazon.com")
    || lower.includes("amazon.com")
    || lower.includes("provider.example")
  );
}

function hasStoredCanonicalArtwork(
  entityId: string | number,
  coverEntity: "Album" | "Artist",
  coverType: string,
): boolean {
  try {
    const row = coverEntity === "Album"
      ? db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined
      : db.prepare("SELECT images FROM ArtistMetadata WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined;
    if (!row?.images) return false;
    const images = JSON.parse(row.images);
    if (!Array.isArray(images)) return false;
    const acceptedTypes = new Set(canonicalArtworkCoverTypes(coverEntity, coverType));
    return images.some((image) => {
      if (!image || typeof image !== "object") return false;
      if (isProviderFallbackImage(image as Record<string, any>)) return false;
      return acceptedTypes.has(imageCoverType(image as ServarrMetadataImage))
        && Boolean(imageUrl(image as ServarrMetadataImage));
    });
  } catch {
    return false;
  }
}

function storedProviderArtworkSource(
  entityId: string | number,
  coverEntity: "Album" | "Artist",
  coverType: string,
): string | null {
  try {
    const row = coverEntity === "Album"
      ? db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined
      : db.prepare("SELECT images FROM ArtistMetadata WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined;
    const images = row?.images ? JSON.parse(row.images) : [];
    if (!Array.isArray(images)) return null;
    for (const acceptedType of canonicalArtworkCoverTypes(coverEntity, coverType)) {
      const match = images.find((image) => (
        image
        && typeof image === "object"
        && isProviderFallbackImage(image as Record<string, any>)
        && imageCoverType(image as ServarrMetadataImage) === acceptedType
        && imageUrl(image as ServarrMetadataImage)
      ));
      if (match) {
        return imageUrl(match as ServarrMetadataImage);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function storedCanonicalArtworkSource(
  entityId: string | number,
  coverEntity: "Album" | "Artist",
  coverType: string,
): string | null {
  try {
    const row = coverEntity === "Album"
      ? db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined
      : db.prepare("SELECT images FROM ArtistMetadata WHERE mbid = ?").get(String(entityId)) as { images?: string | null } | undefined;
    const images = row?.images ? JSON.parse(row.images) : [];
    if (!Array.isArray(images)) return null;
    for (const acceptedType of canonicalArtworkCoverTypes(coverEntity, coverType)) {
      const match = images.find((image) => (
        image
        && typeof image === "object"
        && !isProviderFallbackImage(image as Record<string, any>)
        && imageCoverType(image as ServarrMetadataImage) === acceptedType
        && imageUrl(image as ServarrMetadataImage)
      ));
      if (match) {
        return imageUrl(match as ServarrMetadataImage);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cache is "current" when the preference marker matches. Provider-fulfilled
 * files under a canonical preference are treated as stale once Servarr/CAA
 * imagery exists in the catalog, so the next refresh worker re-resolves instead
 * of locking the fallback in forever.
 */
export function isArtworkPreferenceCacheCurrent(
  entityId: string | number,
  coverEntity: "Album" | "Artist",
  coverType: string,
): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(sourceMarkerPath(entityId, coverEntity, coverType), "utf-8"));
    const preference = configuredArtworkPreference();
    if (marker?.preference !== preference) return false;

    const fulfilledByProvider = marker?.fulfilledBy === "provider"
      || (marker?.fulfilledBy == null && looksLikeProviderArtworkUrl(marker?.url));
    const canonicalSource = storedCanonicalArtworkSource(entityId, coverEntity, coverType);
    const normalizedCanonicalSource = normalizeArtworkUrl(canonicalSource);
    const normalizedProviderSource = preference === "provider" && fulfilledByProvider
      ? normalizeArtworkUrl(
        directProviderArtworkSourceFromCandidates(
          coverEntity === "Album"
            ? loadAlbumProviderArtworkCandidates(String(entityId))
            : loadArtistProviderArtworkCandidates(String(entityId)),
          coverEntity === "Album" ? "album" : "artist",
        ) || storedProviderArtworkSource(entityId, coverEntity, coverType),
      )
      : null;
    if (
      !fulfilledByProvider
      && normalizedCanonicalSource
      && normalizeArtworkUrl(marker?.url) !== normalizedCanonicalSource
    ) {
      return false;
    }
    if (
      preference === "canonical"
      && fulfilledByProvider
      && hasStoredCanonicalArtwork(entityId, coverEntity, coverType)
    ) {
      return false;
    }
    if (
      preference === "provider"
      && fulfilledByProvider
      && normalizedProviderSource
      && normalizeArtworkUrl(marker?.url) !== normalizedProviderSource
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function getMediaCoverPath(entityId: string | number, coverEntity: MediaCoverEntity, coverType: string, extension: string, height?: number | null): string {
  return path.join(mediaCoverFolder(entityId, coverEntity), filenameForCover(coverType, extension, height));
}

export function getMediaCoverUrl(entityId: string | number, coverEntity: MediaCoverEntity, coverType: string, extension: string, height?: number | null): string {
  return `${mediaCoverUrlFolder(entityId, coverEntity)}/${filenameForCover(coverType, extension, height)}`;
}

/** True when config/media-cover already has bytes for this entity/type. */
export function hasCachedMediaCover(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string,
): boolean {
  return existingMediaCover(entityId, coverEntity, coverType) != null;
}

/**
 * Return the absolute filesystem path to the cached original/derivative cover file in media-cover/ if it exists.
 */
export function getCachedMediaCoverFilePath(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string = "cover",
): string | null {
  return existingMediaCover(entityId, coverEntity, coverType)?.path ?? null;
}

/**
 * True when local bytes exist and their source marker matches the source that
 * the catalog/provider currently advertises. This is intended for refresh
 * workers; UI response mapping must remain filesystem-free.
 */
export function isMediaCoverSourceCacheCurrent(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string,
  sourceUrl: string | null | undefined,
): boolean {
  const normalizedSource = normalizeArtworkUrl(sourceUrl);
  if (
    entityId == null
    || String(entityId).trim() === ""
    || !normalizedSource
    || !existingMediaCover(entityId, coverEntity, coverType)
  ) {
    return false;
  }
  return cachedSourceMatches(entityId, coverEntity, coverType, normalizedSource);
}

function existingMediaCover(entityId: string | number | null | undefined, coverEntity: MediaCoverEntity, coverType: string): { path: string; url: string } | null {
  const normalizedEntityId = normalizeMediaCoverEntityId(entityId);
  if (!normalizedEntityId) {
    return null;
  }

  // Prefer full-res origin (height null), then resized proxies (500, 250).
  // Public URL identity is always bare `{coverType}.jpg` (Lidarr-style). Height is a
  // request-layer rewrite (`cover-250.jpg`) so list and detail share one cover id.
  const heights: Array<number | null> = coverEntity === "Video"
    ? [null, ...MEDIA_COVER_VIDEO_HEIGHTS]
    : [null, ...MEDIA_COVER_DEFAULT_HEIGHTS];
  for (const height of heights) {
    for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
      const filePath = getMediaCoverPath(normalizedEntityId, coverEntity, coverType, extension, height);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && stats.size > 0) {
          return { path: filePath, url: getMediaCoverUrl(normalizedEntityId, coverEntity, coverType, ".jpg") };
        }
      } catch {
        // try next candidate
      }
    }
  }

  return null;
}

function existingOriginalMediaCover(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string,
): { path: string; url: string } | null {
  const normalizedEntityId = normalizeMediaCoverEntityId(entityId);
  if (!normalizedEntityId) return null;

  for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    const filePath = getMediaCoverPath(normalizedEntityId, coverEntity, coverType, extension);
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile() && stats.size > 0) {
        return {
          path: filePath,
          url: getMediaCoverUrl(normalizedEntityId, coverEntity, coverType, extension),
        };
      }
    } catch {
      // Try the next supported container.
    }
  }
  return null;
}

/** Return only the cached full-resolution master, never a UI derivative. */
export function getCachedMediaCoverOriginalFilePath(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string = "cover",
): string | null {
  return existingOriginalMediaCover(entityId, coverEntity, coverType)?.path ?? null;
}

function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Exact byte comparison used by MediaCover sidecar materialization. */
export function mediaCoverFilesMatch(leftPath: string, rightPath: string): boolean {
  try {
    const left = fs.statSync(leftPath);
    const right = fs.statSync(rightPath);
    return left.isFile()
      && right.isFile()
      && left.size === right.size
      && fileSha256(leftPath) === fileSha256(rightPath);
  } catch {
    return false;
  }
}

export type MediaCoverSidecarSyncResult = "missing" | "unchanged" | "written";

/**
 * Materialize a library sidecar strictly from the cached full-resolution master.
 * This function never resolves a provider URL and never performs network I/O.
 */
export function syncCachedMediaCoverToFile(options: {
  entityId: string | number | null | undefined;
  coverEntity: MediaCoverEntity;
  coverTypes?: string | string[];
  outputPath: string;
}): MediaCoverSidecarSyncResult {
  const coverTypes = Array.isArray(options.coverTypes)
    ? options.coverTypes
    : [options.coverTypes || (options.coverEntity === "Artist" ? "poster" : "cover")];
  const sourcePath = coverTypes
    .map((coverType) => getCachedMediaCoverOriginalFilePath(
      options.entityId,
      options.coverEntity,
      coverType,
    ))
    .find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
  if (!sourcePath) return "missing";
  if (mediaCoverFilesMatch(sourcePath, options.outputPath)) return "unchanged";

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const temporaryPath = `${options.outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // Stage alongside the destination so rename is an atomic replacement on the
    // same filesystem. A failed copy/rename therefore leaves the prior sidecar
    // intact instead of exposing a partial image to library consumers.
    fs.copyFileSync(sourcePath, temporaryPath);
    fs.renameSync(temporaryPath, options.outputPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Rename consumed the temporary file, or staging never created it.
    }
  }
  return "written";
}

function appendMediaCoverQuery(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
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

type PreparedMediaCoverDerivative = {
  height: number;
  buffer: Buffer;
};

function prepareResizedMediaCovers(
  originalBuffer: Buffer,
  extension: string,
  heights: readonly number[] = MEDIA_COVER_DEFAULT_HEIGHTS,
): PreparedMediaCoverDerivative[] {
  let decoded: { width: number; height: number; data: Uint8Array } | null = null;
  try {
    decoded = decodeImage(originalBuffer, extension);
  } catch (error) {
    console.warn("[MediaCoverService] Failed to decode artwork for resizing:", (error as Error).message);
    return [];
  }

  if (!decoded) {
    return [];
  }

  const derivatives: PreparedMediaCoverDerivative[] = [];
  for (const targetHeight of heights) {
    try {
      const resized = resizeRgbaNearest(decoded, targetHeight);
      const candidates = [82, 70, 60, 50].map((quality) => jpeg.encode({
          width: resized.width,
          height: resized.height,
          data: resized.data,
        }, quality).data);
      const encoded = candidates.find((candidate) => candidate.length < originalBuffer.length)
        ?? candidates.reduce((smallest, candidate) => candidate.length < smallest.length ? candidate : smallest);
      derivatives.push({ height: targetHeight, buffer: Buffer.from(encoded) });
    } catch (error) {
      console.warn(`[MediaCoverService] Failed to prepare ${targetHeight}px artwork:`, (error as Error).message);
    }
  }
  return derivatives;
}

/**
 * Return a JPEG buffer of `sourcePath` scaled so its height is at most
 * `maxHeight`, or null when the source is already within the cap (embed it
 * as-is) or cannot be decoded. Pure-JS (no native deps); used to cap embedded
 * cover art at a sane size without a network round trip.
 */
export function renderCappedCoverBuffer(sourcePath: string, maxHeight: number): Buffer | null {
  try {
    const buffer = fs.readFileSync(sourcePath);
    const extension = path.extname(sourcePath) || ".jpg";
    const decoded = decodeImage(buffer, extension);
    if (!decoded || decoded.height <= maxHeight) {
      return null;
    }
    const [derivative] = prepareResizedMediaCovers(buffer, extension, [maxHeight]);
    return derivative ? derivative.buffer : null;
  } catch (error) {
    console.warn("[MediaCoverService] Failed to render capped cover:", (error as Error).message);
    return null;
  }
}

export function getCoverArtArchiveReleaseGroupUrl(releaseGroupMbid: string | null | undefined): string | null {
  const mbid = String(releaseGroupMbid || "").trim();
  return mbid ? `https://coverartarchive.org/release-group/${mbid}/front` : null;
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
async function fetchArtworkWithFallbacks(sourceUrl: string): Promise<{ response: Response; fetchedUrl: string } | null> {
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

export async function ensureCachedMediaCover(options: {
  entityId: string | number | null | undefined;
  coverEntity: MediaCoverEntity;
  coverType: string;
  sourceUrl: string | null | undefined;
  /** Which preference branch produced this URL (drives stale-fallback invalidation). */
  fulfilledBy?: MediaCoverSourceKind;
}): Promise<string | null> {
  const sourceUrl = normalizeArtworkUrl(options.sourceUrl);
  const entityId = normalizeMediaCoverEntityId(options.entityId);
  if (!sourceUrl || !entityId) {
    return null;
  }

  const fulfilledBy = options.fulfilledBy
    ?? (looksLikeProviderArtworkUrl(sourceUrl) ? "provider" : "canonical");

  const existing = existingMediaCover(entityId, options.coverEntity, options.coverType);
  // Albums/artists refresh when the preference/source marker changes. Videos
  // historically skipped markers and kept the first cached bytes forever —
  // that froze cropped YouTube `sqp=` thumbs. Match on source when a marker
  // exists; without one, only refresh when the new URL is a known upgrade
  // (uncropped YT / landscape Apple mv) so we do not re-download every video
  // cover on every request.
  if (existing) {
    if (cachedSourceMatches(entityId, options.coverEntity, options.coverType, sourceUrl)) {
      return existing.url;
    }
    if (options.coverEntity === "Video") {
      let hasMarker = false;
      try {
        fs.accessSync(sourceMarkerPath(entityId, options.coverEntity, options.coverType));
        hasMarker = true;
      } catch {
        hasMarker = false;
      }
      if (!hasMarker && !isUpgradedProviderThumbnailUrl(sourceUrl)) {
        return existing.url;
      }
    }
    // Album/artist (and video upgrades / mismatched markers): fall through and refresh.
  }

  try {
    const fetched = await fetchArtworkWithFallbacks(sourceUrl);

    if (!fetched) {
      // Keep the previous cache file as a last-resort display fallback, but do
      // not mark it as though it came from the source that just failed. The
      // resolver must be able to continue to its next candidate (for example
      // CAA after a dead metadata URL), and a later request should retry this
      // source rather than treating stale artwork as current.
      return null;
    }

    const { response, fetchedUrl } = fetched;
    const contentType = response.headers.get("content-type");
    const extension = extensionForImage(contentType, fetchedUrl);
    const folder = mediaCoverFolder(entityId, options.coverEntity);
    fs.mkdirSync(folder, { recursive: true });

    const originalBuffer = Buffer.from(await response.arrayBuffer());

    if (options.coverEntity === "Video") {
      // Full-aspect origin for detail/embed; a single 250px proxy for cards/lists.
      // Video thumbs are typically ~720p already, so a 500px derivative is wasteful.
      const derivatives = prepareResizedMediaCovers(originalBuffer, extension, MEDIA_COVER_VIDEO_HEIGHTS);
      commitCachedCoverVariant({
        entityId,
        coverEntity: options.coverEntity,
        coverType: options.coverType,
        extension,
        originalBuffer,
        derivatives,
      });
      const contentHash = crypto.createHash("sha256").update(originalBuffer).digest("hex");
      writeSourceMarker(entityId, options.coverEntity, options.coverType, sourceUrl, fulfilledBy, contentHash);
      return getMediaCoverUrl(entityId, options.coverEntity, options.coverType, extension);
    }

    // Full-resolution album/artist origin for detail/embed (Lidarr-style) + 500/250 proxies.
    // Unsupported-but-valid source containers (currently WebP/GIF) still keep
    // their master even when our pure-JS resizer cannot derive JPEG proxies.
    const derivatives = prepareResizedMediaCovers(originalBuffer, extension);
    const decoderSupportsContainer = [".jpg", ".jpeg", ".png"].includes(extension);
    if (decoderSupportsContainer && derivatives.length === 0) {
      return existing?.url ?? null;
    }

    commitCachedCoverVariant({
      entityId,
      coverEntity: options.coverEntity,
      coverType: options.coverType,
      extension,
      originalBuffer,
      derivatives,
    });
    const contentHash = crypto.createHash("sha256").update(originalBuffer).digest("hex");
    writeSourceMarker(entityId, options.coverEntity, options.coverType, sourceUrl, fulfilledBy, contentHash);
    return getMediaCoverUrl(entityId, options.coverEntity, options.coverType, extension);
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

  const pathname = text.split(/[?#]/, 1)[0];
  let parts: string[];
  try {
    parts = pathname.split("/").map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts.length < 4) {
    return null;
  }

  if (parts[2] === "Albums" && parts.length >= 5) {
    const albumId = normalizeMediaCoverEntityId(parts[3]);
    return albumId
      ? resolveMediaCoverFilePath(resolveWithinMediaCoverRoot("Albums", albumId), parts[4])
      : null;
  }

  if (parts[2] === "Videos" && parts.length >= 5) {
    const videoId = normalizeMediaCoverEntityId(parts[3]);
    return videoId
      ? resolveMediaCoverFilePath(resolveWithinMediaCoverRoot("Videos", videoId), parts[4])
      : null;
  }

  const artistId = normalizeMediaCoverEntityId(parts[2]);
  return artistId
    ? resolveMediaCoverFilePath(resolveWithinMediaCoverRoot(artistId), parts[3])
    : null;
}

/**
 * Remote origin URL that populated a MediaCover cache entry (from `.cover.source.json`).
 * Kept for diagnostics/source revision checks; sidecar writers copy the cached
 * full-resolution master and never fetch this URL.
 */
export function getCachedMediaCoverSourceUrlFromLocalUrl(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text.startsWith("/media-cover/")) {
    return null;
  }

  const pathname = text.split(/[?#]/, 1)[0];
  let parts: string[];
  try {
    parts = pathname.split("/").map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts.length < 4) {
    return null;
  }

  let folder: string;
  let filename: string;
  if (parts[2] === "Albums" && parts.length >= 5) {
    const albumId = normalizeMediaCoverEntityId(parts[3]);
    if (!albumId) return null;
    folder = resolveWithinMediaCoverRoot("Albums", albumId);
    filename = parts[4];
  } else if (parts[2] === "Videos" && parts.length >= 5) {
    const videoId = normalizeMediaCoverEntityId(parts[3]);
    if (!videoId) return null;
    folder = resolveWithinMediaCoverRoot("Videos", videoId);
    filename = parts[4];
  } else {
    const artistId = normalizeMediaCoverEntityId(parts[2]);
    if (!artistId) return null;
    folder = resolveWithinMediaCoverRoot(artistId);
    filename = parts[3];
  }

  const coverType = String(filename || "")
    .replace(/\.[^.]+$/, "")
    .replace(/-\d+$/, "")
    .toLowerCase();
  if (!coverType) {
    return null;
  }

  try {
    const marker = JSON.parse(fs.readFileSync(path.join(folder, `.${coverType}.source.json`), "utf-8"));
    return normalizeArtworkUrl(marker?.url) || null;
  } catch {
    return null;
  }
}

export function resolveMediaCoverFilePath(folder: string, filename: string): string | null {
  const safeFilename = path.basename(String(filename || ""));
  if (!safeFilename || safeFilename !== filename) {
    return null;
  }

  const requested = path.join(folder, safeFilename);
  const resizedMatch = safeFilename.match(/^(.+)-\d+\.[a-z0-9]+$/i);
  try {
    const stats = fs.statSync(requested);
    if (stats.isFile() && stats.size > 0) {
      if (resizedMatch) {
        for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
          const original = path.join(folder, `${resizedMatch[1]}${extension}`);
          try {
            const originalStats = fs.statSync(original);
            if (originalStats.isFile() && originalStats.size > 0 && originalStats.size <= stats.size) {
              return original;
            }
          } catch {
            // try next original extension
          }
        }
      }
      return requested;
    }
  } catch {
    // Try falling back from cover-250.jpg to cover.* as in route does.
  }

  if (!resizedMatch) {
    // Stable aliases (`poster.jpg`, `cover.jpg`) have no plain file on disk —
    // UI cache keeps only height derivatives. Resolve to the largest available.
    const coverType = safeFilename.replace(/\.[a-z0-9]+$/i, "");
    if (coverType) {
      for (const height of MEDIA_COVER_DEFAULT_HEIGHTS) {
        const resized = path.join(folder, `${coverType}-${height}.jpg`);
        try {
          const stats = fs.statSync(resized);
          if (stats.isFile() && stats.size > 0) {
            return resized;
          }
        } catch {
          // try next height
        }
      }
    }
    return null;
  }

  for (const extension of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    const fallback = path.join(folder, `${resizedMatch[1]}${extension}`);
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

/** Profile / folder.jpg art — never Fanart/Banner (those are wide backdrops). */
const ARTIST_PROFILE_COVER_TYPES = ["Poster", "Headshot"] as const;
/** Wide backdrop / branding types that must not fill profile/folder slots. */
const ARTIST_BACKDROP_COVER_TYPES = new Set([
  "fanart",
  "banner",
  "logo",
  "clearlogo",
  "landscape",
  "background",
]);

function artistArtworkCoverTypes(value: string | string[] | undefined): string[] {
  const requested = preferredTypes(value, [...ARTIST_PROFILE_COVER_TYPES]);
  const expanded: string[] = [];
  for (const coverType of requested) {
    const normalized = normalizedCoverType(coverType);
    const aliases = normalized === "poster" || normalized === "headshot"
      ? canonicalArtworkCoverTypes("Artist", normalized)
      : (
        normalized === "fanart" || normalized === "background" || normalized === "landscape"
          ? canonicalArtworkCoverTypes("Artist", normalized)
          : [normalized]
      );
    for (const alias of aliases) {
      if (!expanded.includes(alias)) {
        expanded.push(alias);
      }
    }
  }
  return expanded;
}

function existingArtistMediaCoverUrl(artistMbid: string | null | undefined, coverTypes: string | string[] | undefined): string | null {
  const types = artistArtworkCoverTypes(coverTypes);
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

  const allowBackdrop = coverTypes.some((type) => ARTIST_BACKDROP_COVER_TYPES.has(type.trim().toLowerCase()));
  if (allowBackdrop) {
    // Backdrop roles are not interchangeable with arbitrary canonical art.
    // Requested aliases were already checked above.
    return null;
  }
  const fallback = images.find((img) => {
    const imageType = String(img.coverType || img.CoverType || "").trim().toLowerCase();
    const source = String((img as any).source || (img as any).Source || "").trim().toLowerCase();
    if (!allowBackdrop && ARTIST_BACKDROP_COVER_TYPES.has(imageType)) {
      return false;
    }
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
  const normalizedEntityId = normalizeMediaCoverEntityId(entityId);
  if (!normalizedEntityId || !normalizedSource) {
    return null;
  }
  return getMediaCoverUrl(normalizedEntityId, coverEntity, coverType, extensionForImage(null, normalizedSource));
}

function firstStoredProviderFallbackUrl(
  images: ServarrMetadataImage[] | undefined | null,
  coverTypes: string[],
): string | null {
  const providerImages = images?.filter((image) => isProviderFallbackImage(image as Record<string, any>));
  return firstStoredImageUrl(providerImages, coverTypes, true);
}

function directProviderArtworkSourceFromCandidates(
  candidates: ProviderArtworkCandidate[],
  entityType: "album" | "artist",
): string | null {
  for (const candidate of candidates) {
    const direct = normalizeArtworkUrl(candidate.imageId)
      || renderableProviderArtworkUrl(
        candidate.imageId,
        candidate.provider,
        entityType === "album" ? "origin" : 750,
      );
    if (direct) {
      return normalizeArtworkUrl(direct);
    }
  }
  return null;
}

export function configuredArtworkPreference(): "canonical" | "provider" {
  try {
    return getConfigSection("metadata")?.artwork_preference === "provider" ? "provider" : "canonical";
  } catch {
    return "canonical";
  }
}

export function artworkSourceRevision(sourceUrl: string | null | undefined): string | null {
  const normalizedSource = normalizeArtworkUrl(sourceUrl);
  return normalizedSource
    ? crypto.createHash("sha256").update(normalizedSource).digest("hex").slice(0, 16)
    : null;
}

export function isMediaCoverRevisionCacheCurrent(
  entityId: string | number | null | undefined,
  coverEntity: MediaCoverEntity,
  coverType: string,
  requestedRevision: string | null | undefined,
): boolean {
  const revision = String(requestedRevision || "").trim().toLowerCase();
  const normalizedEntityId = normalizeMediaCoverEntityId(entityId);
  if (!normalizedEntityId || !/^[a-f0-9]{16}$/.test(revision)) {
    return false;
  }
  try {
    const marker = JSON.parse(
      fs.readFileSync(sourceMarkerPath(normalizedEntityId, coverEntity, coverType), "utf-8"),
    );
    return artworkSourceRevision(marker?.url) === revision;
  } catch {
    return false;
  }
}

function withArtworkPreference(
  url: string | null,
  preference: "canonical" | "provider" = configuredArtworkPreference(),
  selectedSourceUrl?: string | null,
): string | null {
  if (!url || !url.startsWith("/media-cover/")) {
    return url;
  }
  const withPreference = /[?&]source=/.test(url)
    ? url
    : appendMediaCoverQuery(url, "source", preference);
  const revision = artworkSourceRevision(selectedSourceUrl);
  return revision && !/[?&]rev=/.test(withPreference)
    ? appendMediaCoverQuery(withPreference, "rev", revision)
    : withPreference;
}

export function mapAlbumArtworkToLocalUrl(options: {
  albumMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  includeExpectedProviderFallback?: boolean;
}): string | null {
  const coverTypes = preferredTypes("Cover", ["Cover"]);
  const allImages = getServarrMetadataImages(options.servarrMetadataData);
  const canonicalImages = allImages.filter((image) => !isProviderFallbackImage(image as Record<string, any>));
  const canonicalSource = firstStoredImageUrl(
    canonicalImages,
    coverTypes,
    false,
  ) || getServarrMetadataAlbumImageUrl({ images: canonicalImages });
  const storedProviderFallback = firstStoredProviderFallbackUrl(allImages, coverTypes);
  const currentProviderSource = directProviderArtworkSourceFromCandidates(
    options.providerCandidates || [],
    "album",
  );
  const providerSource = options.includeExpectedProviderFallback === false
    ? null
    : currentProviderSource || storedProviderFallback;
  const canonicalUrl = expectedMediaCoverUrl(options.albumMbid, "Album", "Cover", canonicalSource);
  const providerUrl = expectedMediaCoverUrl(options.albumMbid, "Album", "Cover", providerSource);
  const preference = configuredArtworkPreference();
  const selected = preference === "provider"
    ? (providerUrl ? { url: providerUrl, source: providerSource } : { url: canonicalUrl, source: canonicalSource })
    : (canonicalUrl ? { url: canonicalUrl, source: canonicalSource } : { url: providerUrl, source: providerSource });
  // Always emit a local /media-cover URL when we know the album MBID so UI
  // never falls back to raw provider asset ids. Bytes fill on first request.
  return withArtworkPreference(
    selected.url
      || (
        normalizeMediaCoverEntityId(options.albumMbid)
          ? getMediaCoverUrl(options.albumMbid!, "Album", "Cover", ".jpg")
          : null
      ),
    preference,
    selected.source,
  );
}

export function mapArtistArtworkToLocalUrl(options: {
  artistMbid?: string | null;
  servarrMetadataData?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
  sourceUrls?: Array<string | null | undefined>;
}): string | null {
  const types = artistArtworkCoverTypes(options.preferredCoverTypes);
  const allImages = getServarrMetadataImages(options.servarrMetadataData);
  const canonicalImages = allImages.filter((image) => !isProviderFallbackImage(image as Record<string, any>));
  const canonicalSource = firstStoredImageUrl(canonicalImages, types, false)
    || getServarrMetadataArtistImageUrl({ images: canonicalImages }, types);
  const storedProviderSource = firstStoredProviderFallbackUrl(allImages, types);
  const explicitSource = options.sourceUrls?.map(normalizeArtworkUrl).find((url): url is string => Boolean(url));
  const providerSource = directProviderArtworkSourceFromCandidates(
    options.providerCandidates || [],
    "artist",
  );
  const selectedProviderSource = providerSource || storedProviderSource;
  const canonicalUrl = expectedMediaCoverUrl(
    options.artistMbid,
    "Artist",
    types[0] || "Poster",
    canonicalSource || explicitSource,
  );
  const providerUrl = expectedMediaCoverUrl(
    options.artistMbid,
    "Artist",
    types[0] || "Poster",
    selectedProviderSource,
  );
  const preference = configuredArtworkPreference();
  const selected = preference === "provider"
    ? (
      providerUrl
        ? { url: providerUrl, source: selectedProviderSource }
        : { url: canonicalUrl, source: canonicalSource || explicitSource }
    )
    : (
      canonicalUrl
        ? { url: canonicalUrl, source: canonicalSource || explicitSource }
        : { url: providerUrl, source: selectedProviderSource }
    );
  return withArtworkPreference(
    selected.url
      || (
        normalizeMediaCoverEntityId(options.artistMbid)
          ? getMediaCoverUrl(options.artistMbid!, "Artist", types[0] || "Poster", ".jpg")
          : null
      ),
    preference,
    selected.source,
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

/**
 * YouTube UI thumbs often arrive as `hq720.jpg?sqp=...` — those sqp params are
 * a center-crop for YouTube's own layout and cut title text off music-video
 * artwork. Prefer the full-frame `hq720` / `maxresdefault` still.
 */
function normalizeYouTubeThumbnailUrl(url: string): string {
  const match = url.match(/^https?:\/\/i\.ytimg\.com\/vi\/([^/?#]+)\//i);
  if (!match) {
    return url;
  }
  const videoId = match[1];
  // Keep explicit still names when already uncropped; otherwise upgrade to hq720.
  if (/\/(maxresdefault|hq720|sddefault|hqdefault)\.jpg(?:$|\?)/i.test(url) && !/[?&]sqp=/i.test(url)) {
    try {
      const parsed = new URL(url);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return `https://i.ytimg.com/vi/${videoId}/hq720.jpg`;
    }
  }
  return `https://i.ytimg.com/vi/${videoId}/hq720.jpg`;
}

/**
 * Apple music-video artwork templates are often materialized as square
 * `1080x1080mv.jpg`. Prefer a 16:9 request so library/UI thumbs match the frame.
 */
function normalizeAppleMusicVideoArtworkUrl(url: string): string {
  return url.replace(
    /\/(\d+)x(\d+)(mv\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i,
    (_full, width, height, suffix) => {
      const w = Number(width);
      const h = Number(height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) {
        return `/${width}x${height}${suffix}`;
      }
      return `/1920x1080${suffix}`;
    },
  );
}

/** TIDAL CDN 3:2 video still sizes — requesting these crops the native frame. */
const TIDAL_VIDEO_CROP_SIZES = new Set([
  "160x107",
  "480x320",
  "750x500",
  "1080x720",
]);

/**
 * TIDAL video stills requested at 3:2 (e.g. 1080x720) are center-cropped from
 * the native landscape upload. Prefer `/origin.jpg` so UI/library thumbs keep
 * the full frame (often 16:9).
 */
function normalizeTidalVideoArtworkUrl(url: string): string {
  return url.replace(
    /^(https?:\/\/resources\.tidal\.com\/images\/(?:[0-9a-f]{2,}\/){4}[0-9a-f]+)\/([^/?#]+)\.(jpe?g|png|webp)(?:\?.*)?$/i,
    (_full, base, size, ext) => {
      if (TIDAL_VIDEO_CROP_SIZES.has(String(size).toLowerCase())) {
        return `${base}/origin.${ext}`;
      }
      return `${base}/${size}.${ext}`;
    },
  );
}

/** True when `url` is a known upgrade over cropped provider thumbs (triggers cache refresh). */
function isUpgradedProviderThumbnailUrl(url: string): boolean {
  if (/^https?:\/\/i\.ytimg\.com\/vi\/[^/?#]+\/(hq720|maxresdefault)\.jpg$/i.test(url)) {
    return true;
  }
  const apple = url.match(/\/(\d+)x(\d+)mv\.(?:jpg|jpeg|png|webp)$/i);
  if (apple) {
    const w = Number(apple[1]);
    const h = Number(apple[2]);
    return Number.isFinite(w) && Number.isFinite(h) && w > h;
  }
  if (/^https?:\/\/resources\.tidal\.com\/images\/.+\/origin\.(?:jpe?g|png|webp)$/i.test(url)) {
    return true;
  }
  return false;
}

export function normalizeArtworkUrl(value: unknown): string | null {
  const url = textOrNull(value);
  if (!url) {
    return null;
  }
  if (/^https?:\/\//i.test(url)) {
    if (/i\.ytimg\.com\/vi\//i.test(url)) {
      return normalizeYouTubeThumbnailUrl(url);
    }
    if (/mzstatic\.com\/image\/thumb\//i.test(url) && /mv\.(?:jpg|jpeg|png|webp)/i.test(url)) {
      return normalizeAppleMusicVideoArtworkUrl(url);
    }
    if (/resources\.tidal\.com\/images\//i.test(url)) {
      return normalizeTidalVideoArtworkUrl(url);
    }
    return url;
  }
  return null;
}

const TIDAL_IMAGE_ASSET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Convert provider artwork evidence into a browser-renderable fallback URL.
 * Canonical pages and queues should prefer their local /media-cover URL; this
 * is only the final fallback when no cached canonical cover is available.
 */
export function renderableProviderArtworkUrl(
  value: unknown,
  provider?: string | null,
  size: number | "origin" = 320,
): string | null {
  const text = textOrNull(value);
  if (!text) {
    return null;
  }
  if (/^(https?:\/\/|\/|data:|blob:)/i.test(text)) {
    return text;
  }
  if (TIDAL_IMAGE_ASSET_RE.test(text) && (!provider || provider.toLowerCase() === "tidal")) {
    const variant = size === "origin"
      ? "origin"
      : `${Math.max(80, Math.round(size))}x${Math.max(80, Math.round(size))}`;
    return `https://resources.tidal.com/images/${text.replace(/-/g, "/")}/${variant}.jpg`;
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

function isManualOverrideImage(image: Record<string, any>): boolean {
  const src = String(image.source || image.Source || "").trim().toLowerCase();
  return src === "manual" || src === "manual-override";
}

function isProviderFallbackImage(image: Record<string, any>): boolean {
  return String(image.source || image.Source || "").trim().toLowerCase() === "provider-fallback";
}

function chooseImageFromStoredList(
  images: unknown,
  preferredCoverTypes: string[],
  options: { includeProviderFallbacks: boolean; proxy: boolean; manualOnly?: boolean },
): string | null {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const candidates = images
    .filter((image): image is Record<string, any> => Boolean(image && typeof image === "object"))
    .filter((image) => {
      if (options.manualOnly) {
        return isManualOverrideImage(image);
      }
      return options.includeProviderFallbacks || !isProviderFallbackImage(image);
    });
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

  // Do not fall back to the first stored image — that is often Banner/Fanart
  // (wide backdrop) when the caller asked for Poster/Headshot only.
  return null;
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

  const preferred = preferredTypes(preferredCoverTypes, []).map((type) => type.trim().toLowerCase());
  const allowBackdrop = preferred.some((type) => ARTIST_BACKDROP_COVER_TYPES.has(type));
  if (allowBackdrop) {
    // Requested backdrop aliases were checked above; a Poster/Banner/Logo must
    // not silently fill a missing Fanart slot.
    return null;
  }
  const fallbackCandidates = images.filter((image) => !ARTIST_BACKDROP_COVER_TYPES.has(imageCoverType(image)));
  if (fallbackCandidates.length === 0) {
    return null;
  }
  const fallbackUrl = imageUrl(fallbackCandidates.sort((left, right) => imageArea(right) - imageArea(left))[0]);
  return fallbackUrl || null;
}

export function getServarrMetadataArtistImageUrl(
  artist: ServarrMetadataImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = [...ARTIST_PROFILE_COVER_TYPES],
): string | null {
  return getServarrMetadataImageUrl(artist, preferredCoverTypes);
}

export function getServarrMetadataAlbumImageUrl(
  album: ServarrMetadataImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = ["Cover", "Poster"],
): string | null {
  return getServarrMetadataImageUrl(album, preferredCoverTypes);
}

function nestedRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

export function albumProviderArtworkCandidatesFromRow(row: Record<string, any>): ProviderArtworkCandidate[] {
  const selectedProvider = textOrNull(row.selected_provider);
  const candidates: ProviderArtworkCandidate[] = [
    {
      provider: textOrNull(row.stereo_provider, selectedProvider),
      entityId: textOrNull(row.stereo_provider_id, row.selected_provider_id),
      imageId: textOrNull(row.stereo_cover),
    },
    {
      provider: textOrNull(row.spatial_provider, selectedProvider),
      entityId: textOrNull(row.spatial_provider_id, row.selected_provider_id),
      imageId: textOrNull(row.spatial_cover),
    },
    {
      provider: selectedProvider,
      entityId: textOrNull(row.selected_provider_id, row.provider_id),
      imageId: textOrNull(row.provider_asset_id, row.provider_cover, row.cover),
    },
  ];

  return candidates.filter((candidate) => candidate.provider || candidate.imageId || candidate.entityId);
}

export function providerArtworkIdFromCandidates(
  candidates: ProviderArtworkCandidate[],
  entityType: ProviderArtworkEntityType,
): string | null {
  for (const candidate of candidates) {
    const imageId = textOrNull(candidate.imageId);
    if (imageId) {
      return imageId;
    }
  }
  return null;
}

export function videoProviderArtworkCandidatesFromRow(row: Record<string, any>): ProviderArtworkCandidate[] {
  const provider = textOrNull(row.provider, row.selected_provider);
  return [{
    provider,
    entityId: textOrNull(row.provider_id, row.selected_provider_id),
    imageId: textOrNull(row.provider_asset_id, row.asset_id, row.cover, row.cover_image_id),
  }].filter((candidate) => candidate.provider || candidate.imageId || candidate.entityId);
}

export function videoCoverLocalUrl(
  videoId: string | number | null | undefined,
  sourceUrl?: string | null,
): string | null {
  const normalizedVideoId = textOrNull(videoId);
  if (!normalizedVideoId || normalizeMediaCoverEntityId(normalizedVideoId) == null) {
    return null;
  }

  // Always emit the local URL for UI; refresh/match workflows populate its
  // cache. The delivery route never exposes raw provider asset UUIDs.
  // The route serves validators (ETag + Last-Modified) for this stable identity;
  // response mapping must never scan derivative files to manufacture a revision.
  const localUrl = getMediaCoverUrl(normalizedVideoId, "Video", "Cover", ".jpg");
  const revision = artworkSourceRevision(sourceUrl);
  return revision ? appendMediaCoverQuery(localUrl, "rev", revision) : localUrl;
}

/**
 * read mapper — the equivalent of its
 * IMapCoversToLocal.ConvertToLocalUrls. Maps an album's STORED images (the
 * `images` column) to its local /media-cover URL. Image selection and any
 * provider-fallback artwork are resolved and persisted into `images` at
 * refresh/match time (see resolveAlbumArtwork / persistResolvedFallbackArtwork),
 * so a page read never re-derives a cover from raw provider data. RefreshArtist
 * / MatchArtistProviders warm bytes into config/media-cover; the delivery route
 * only serves those local files.
 */
export function albumCoverLocalUrl(options: {
  albumMbid?: string | null;
  images?: ServarrMetadataImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  skipStoredImageLookup?: boolean;
}): string | null {
  let images = options.images;
  if (!images && options.albumMbid && options.skipStoredImageLookup !== true) {
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
    providerCandidates: options.providerCandidates,
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
  coverType: string,
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
    const parsed = row?.images ? JSON.parse(row.images) : [];
    const existing = Array.isArray(parsed) ? parsed : [];
    const coverEntity = table === "Albums" ? "Album" : "Artist";
    const replacedTypes = new Set(canonicalArtworkCoverTypes(coverEntity, coverType));
    const retained = existing.filter((image) => (
      !image
      || typeof image !== "object"
      || !isProviderFallbackImage(image)
      || !replacedTypes.has(imageCoverType(image))
    ));
    const normalizedUrl = normalizeArtworkUrl(url);
    const current = existing.find((image) => (
      image
      && typeof image === "object"
      && isProviderFallbackImage(image)
      && replacedTypes.has(imageCoverType(image))
      && imageUrl(image) === normalizedUrl
    ));
    if (current && retained.length === existing.length - 1) {
      return;
    }

    db.prepare(`UPDATE ${table} SET images = ?, updated_at = CURRENT_TIMESTAMP WHERE mbid = ?`)
      .run(
        JSON.stringify([
          ...retained,
          { coverType, url: normalizedUrl || url, source: "provider-fallback" },
        ]),
        canonicalMbid,
      );
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
    const imageId = textOrNull(candidate.imageId);

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

    const directUrl = normalizeArtworkUrl(imageId);
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
  let storedManualUrl: string | null = null;
  let storedCanonicalUrl: string | null = null;
  let storedProviderFallbackUrl: string | null = null;
  if (options.albumMbid) {
    try {
      const row = db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(options.albumMbid) as { images?: string | null } | undefined;
      if (row?.images) {
        const dbImages = JSON.parse(row.images);
        const preferredCoverTypes = ["Cover", "Poster"];
        storedManualUrl = chooseImageFromStoredList(dbImages, preferredCoverTypes, {
          includeProviderFallbacks: true,
          proxy: false,
          manualOnly: true,
        });
        const nonManualImages = Array.isArray(dbImages)
          ? dbImages.filter((img: any) => !isManualOverrideImage(img))
          : [];
        storedCanonicalUrl = chooseImageFromStoredList(nonManualImages, preferredCoverTypes, {
          includeProviderFallbacks: false,
          proxy: false,
        });
        const providerImages = Array.isArray(nonManualImages)
          ? nonManualImages.filter((image) => isProviderFallbackImage(image))
          : [];
        storedProviderFallbackUrl = chooseImageFromStoredList(providerImages, preferredCoverTypes, {
          includeProviderFallbacks: true,
          proxy: false,
        });
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve album artwork from database:", error);
    }
  }

  const explicitCanonicalImages = getServarrMetadataImages(options.servarrMetadataData)
    .filter((image) => !isProviderFallbackImage(image as Record<string, any>));
  const servarrMetadataUrl = getServarrMetadataAlbumImageUrl({ images: explicitCanonicalImages });

  const releaseGroupId = options.albumMbid
    ? (db.prepare("SELECT id FROM Albums WHERE mbid = ? LIMIT 1").get(options.albumMbid) as {
      id?: number;
    } | undefined)?.id ?? null
    : null;
  const selectionRepository = new MediaCoverSelectionRepository(db);
  const persistSelection = (
    sourceUrl: string,
    sourceKind: MediaCoverSourceKind,
    supplemental = false,
  ): void => {
    if (releaseGroupId == null) return;
    const cached = existingMediaCover(options.albumMbid, "Album", "Cover");
    if (!cached) return;
    let contentHash: string;
    try {
      contentHash = crypto.createHash("sha256").update(fs.readFileSync(cached.path)).digest("hex");
    } catch {
      return;
    }
    selectionRepository.select({
      releaseGroupId,
      sourceKind,
      contentHash,
      sourceIdentity: sourceUrl,
      supplemental,
    });
  };

  const cacheSource = async (
    sourceUrl: string | null,
    fulfilledBy: MediaCoverSourceKind,
    supplemental = false,
  ): Promise<string | null> => {
    if (!sourceUrl) return null;
    if (supplemental && releaseGroupId != null && selectionRepository.get(releaseGroupId)) {
      return null;
    }
    const localUrl = await ensureCachedMediaCover({
      entityId: options.albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl,
      fulfilledBy,
    });
    if (localUrl) persistSelection(sourceUrl, fulfilledBy, supplemental);
    return localUrl;
  };

  const resolveManual = async (): Promise<string | null> => {
    return cacheSource(storedManualUrl, "manual");
  };

  const resolveCanonical = async (): Promise<string | null> => {
    for (const sourceUrl of [
      storedCanonicalUrl,
      servarrMetadataUrl,
      getCoverArtArchiveReleaseGroupUrl(options.albumMbid),
    ]) {
      const cached = await cacheSource(sourceUrl, "canonical");
      if (cached) return cached;
    }
    return null;
  };

  const resolveProvider = async (): Promise<string | null> => {
    const providerCandidates = [
      ...(options.providerCandidates || []),
      ...loadAlbumProviderArtworkCandidates(options.albumMbid),
    ];
    const primaryCandidates = providerCandidates.filter((candidate) => !candidate.supplemental);
    const candidates = primaryCandidates.length > 0 ? primaryCandidates : providerCandidates;
    const supplemental = candidates.length > 0 && candidates.every((candidate) => candidate.supplemental);
    const providerUrl = await resolveProviderArtworkUrl(
      candidates,
      "album",
      // Fetch the origin image as the cached source; local derivatives serve UI.
      options.size ?? "origin",
    );
    if (providerUrl) {
      persistResolvedFallbackArtwork("Albums", options.albumMbid, "Cover", providerUrl);
      const cached = await cacheSource(providerUrl, "provider", supplemental);
      if (cached) return cached;
    }
    return cacheSource(storedProviderFallbackUrl, "provider", supplemental);
  };

  const manualResolved = await resolveManual();
  if (manualResolved) {
    return manualResolved;
  }
  const resolved = configuredArtworkPreference() === "provider"
    ? await resolveProvider() || await resolveCanonical()
    : await resolveCanonical() || await resolveProvider();
  return resolved || existingAlbumMediaCoverUrl(options.albumMbid);
}

/**
 * Reconstruct album artwork candidates from persisted provider offers.
 *
 * Current acquisition-plan sources come first, with ordinary accepted release
 * matches as fallbacks. Refresh/match uses these candidates to populate the
 * canonical cache; delivery and sidecar paths remain local-only.
 */
export function loadAlbumProviderArtworkCandidates(
  albumMbid?: string | null,
  _options?: unknown,
): ProviderArtworkCandidate[] {
  const mbid = textOrNull(albumMbid);
  if (!mbid) return [];

  type ArtworkRow = {
    provider?: string | null;
    provider_id?: string | null;
    asset_id?: string | null;
    cover?: string | null;
    title?: string | null;
    version?: string | null;
    match_confidence?: number | null;
  };

  const { canonicalTitle, canonicalPrimaryType } = (() => {
    try {
      const row = db.prepare("SELECT title, primary_type FROM Albums WHERE mbid = ? LIMIT 1")
        .get(mbid) as { title?: string | null; primary_type?: string | null } | undefined;
      return {
        canonicalTitle: textOrNull(row?.title),
        canonicalPrimaryType: textOrNull(row?.primary_type),
      };
    } catch {
      return { canonicalTitle: null, canonicalPrimaryType: null };
    }
  })();
  const normalizedCanonicalTitle = normalizeComparableText(canonicalTitle);
  const titleScore = (row: ArtworkRow): number => {
    const candidate = normalizeComparableText(textOrNull(row.title, row.version));
    if (!normalizedCanonicalTitle || !candidate) return 0;
    if (candidate === normalizedCanonicalTitle) return 1;
    if (
      candidate.startsWith(`${normalizedCanonicalTitle} `)
      || normalizedCanonicalTitle.startsWith(`${candidate} `)
    ) {
      return 0.95;
    }
    return stringSimilarity(normalizedCanonicalTitle, candidate);
  };
  const sortRows = (rows: ArtworkRow[]): ArtworkRow[] => [...rows].sort((left, right) =>
    titleScore(right) - titleScore(left)
    || Number(right.match_confidence || 0) - Number(left.match_confidence || 0)
    || String(left.provider || "").localeCompare(String(right.provider || ""))
    || String(left.provider_id || "").localeCompare(String(right.provider_id || "")),
  );

  const isSupplementalCompanion = (row: ArtworkRow): boolean => {
    const version = String(row.version || "").trim().toLowerCase();
    const title = String(row.title || "").trim().toLowerCase();
    if (!version && !title) return false;

    const primaryType = String(canonicalPrimaryType || "Album").trim().toLowerCase();
    if (primaryType !== "single" && primaryType !== "ep") {
      if (
        version === "single" || version === "ep" || version.includes("single") || version.includes("ep") ||
        title.endsWith(" (single)") || title.endsWith(" [single]") || title.endsWith(" - single")
      ) {
        return true;
      }
    }
    return false;
  };

  const seen = new Set<string>();
  const candidates: ProviderArtworkCandidate[] = [];
  const supplementalCandidates: ProviderArtworkCandidate[] = [];

  const pushRow = (row: ArtworkRow | null | undefined) => {
    if (!row) return;
    const provider = textOrNull(row.provider);
    const entityId = textOrNull(row.provider_id);
    const imageId = textOrNull(row.asset_id, row.cover);
    if (!provider && !entityId && !imageId) return;

    const key = `${provider || ""}\u0000${entityId || ""}\u0000${imageId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);

    const candidate = { provider, entityId, imageId, title: textOrNull(row.title) };
    if (isSupplementalCompanion(row)) {
      supplementalCandidates.push({ ...candidate, supplemental: true });
    } else {
      candidates.push(candidate);
    }
  };

  try {
    const selectedRows = db.prepare(`
      SELECT
        provider_item.provider,
        CAST(provider_item.provider_id AS TEXT) AS provider_id,
        provider_item.cover_id AS asset_id,
        provider_item.artwork_url AS cover,
        provider_item.title,
        provider_item.version,
        release_match.confidence AS match_confidence
      FROM AcquisitionPlans plan
      JOIN LibraryReleases library_release
        ON library_release.id = plan.library_release_id
      JOIN AlbumReleases release
        ON release.id = library_release.release_id
      JOIN Albums release_group
        ON release_group.id = release.release_group_id
      JOIN Libraries library
        ON library.id = library_release.library_id
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      JOIN AcquisitionPlanSources source
        ON source.plan_id = plan.id
      JOIN ProviderReleaseMatches release_match
        ON release_match.id = source.provider_release_match_id
      JOIN ProviderItems provider_item
        ON provider_item.id = release_match.provider_release_item_id
      WHERE release_group.mbid = ?
        AND plan.state = 'current'
        AND release_match.match_state = 'accepted'
      ORDER BY
        CASE WHEN EXISTS (
          SELECT 1
          FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        ) THEN 1 ELSE 0 END,
        source.sort_order,
        source.id
    `).all(mbid) as ArtworkRow[];
    for (const row of selectedRows) {
      pushRow(row);
    }

    const matchedRows = db.prepare(`
      SELECT
        provider_item.provider,
        CAST(provider_item.provider_id AS TEXT) AS provider_id,
        provider_item.cover_id AS asset_id,
        provider_item.artwork_url AS cover,
        provider_item.title,
        provider_item.version,
        release_match.confidence AS match_confidence
      FROM ProviderReleaseMatches release_match
      JOIN ProviderItems provider_item
        ON provider_item.id = release_match.provider_release_item_id
      JOIN AlbumReleases release
        ON release.id = release_match.release_id
      JOIN Albums release_group
        ON release_group.id = release.release_group_id
      WHERE release_group.mbid = ?
        AND release_match.match_state = 'accepted'
      ORDER BY
        CASE WHEN release_match.decision_source = 'manual' THEN 0 ELSE 1 END,
        release_match.confidence DESC,
        release_match.updated_at DESC
      LIMIT 8
    `).all(mbid) as ArtworkRow[];
    for (const row of sortRows(matchedRows)) {
      pushRow(row);
    }
  } catch (error) {
    console.warn("[MediaCoverService] Failed to load album provider artwork candidates:", error);
  }

  return candidates.length > 0 ? candidates : supplementalCandidates;
}

/**
 * Provider artwork candidates for an artist, pulled from the DB so callers don't
 * have to assemble them (mirrors how the video resolver self-serves). Sources the
 * matched provider artist offer(s) (`ProviderItems entity_type='artist'`) and the
 * `ArtistMetadata.picture` asset.
 *
 * When preferring provider art, candidates are ordered by Settings
 * `streaming.provider_priority` (then match confidence) so TIDAL-first actually
 * picks TIDAL's picture when that offer exists.
 */
export function loadArtistProviderArtworkCandidates(artistMbid?: string | null): ProviderArtworkCandidate[] {
  const mbid = textOrNull(artistMbid);
  if (!mbid) return [];
  try {
    const rows = db.prepare(`
      SELECT
        item.provider,
        item.provider_id,
        COALESCE(item.cover_id, item.artwork_url) AS asset_id,
        artist_match.confidence AS match_confidence
      FROM ProviderArtistMatches artist_match
      JOIN ProviderItems item
        ON item.id = artist_match.provider_artist_item_id
      JOIN ArtistMetadata artist ON artist.id = artist_match.artist_id
      WHERE item.entity_type = 'artist'
        AND artist.mbid = ?
        AND artist_match.match_state = 'accepted'
      ORDER BY
        CASE artist_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
        artist_match.confidence DESC,
        artist_match.updated_at DESC
      LIMIT 12
    `).all(mbid) as Array<{
      provider?: string | null;
      provider_id?: string | null;
      asset_id?: string | null;
      match_confidence?: number | null;
    }>;

    type RankedCandidate = ProviderArtworkCandidate & { matchConfidence: number };
    const candidates: RankedCandidate[] = rows
      .filter((row) => row.asset_id || row.provider_id)
      .map((row) => ({
        provider: row.provider,
        entityId: row.provider_id,
        imageId: row.asset_id,
        matchConfidence: Number(row.match_confidence || 0),
      }));

    candidates.sort((left, right) => {
      const rankDelta = streamingProviderManager.getProviderPreferenceRank(String(left.provider || ""))
        - streamingProviderManager.getProviderPreferenceRank(String(right.provider || ""));
      if (rankDelta !== 0) return rankDelta;
      return right.matchConfidence - left.matchConfidence
        || String(left.provider || "").localeCompare(String(right.provider || ""))
        || String(left.entityId || "").localeCompare(String(right.entityId || ""));
    });

    // Fallback: the provider artist picture homed on ArtistMetadata (an asset id
    // sufficient on its own to build the provider image URL).
    const meta = db.prepare("SELECT picture FROM ArtistMetadata WHERE mbid = ?").get(mbid) as { picture?: string | null } | undefined;
    const picture = textOrNull(meta?.picture);
    const ordered: ProviderArtworkCandidate[] = candidates.map(({ provider, entityId, imageId }) => ({
      provider,
      entityId,
      imageId,
    }));
    if (picture && !ordered.some((candidate) => candidate.imageId === picture)) {
      ordered.push({ provider: streamingProviderManager.getDefaultProviderId(), imageId: picture });
    }
    return ordered;
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
  const types = artistArtworkCoverTypes(options.preferredCoverTypes);
  const coverTypeForCache = types[0] || "Poster";
  let storedManualUrl: string | null = null;
  let storedCanonicalUrl: string | null = null;
  let storedProviderFallbackUrl: string | null = null;

  if (options.artistMbid) {
    try {
      const row = db.prepare("SELECT images FROM ArtistMetadata WHERE mbid = ?").get(options.artistMbid) as { images?: string | null } | undefined;
      if (row?.images) {
        const dbImages = JSON.parse(row.images);
        storedManualUrl = chooseImageFromStoredList(dbImages, types, {
          includeProviderFallbacks: true,
          proxy: false,
          manualOnly: true,
        });
        const nonManualImages = Array.isArray(dbImages)
          ? dbImages.filter((img: any) => !isManualOverrideImage(img))
          : [];
        storedCanonicalUrl = chooseImageFromStoredList(nonManualImages, types, {
          includeProviderFallbacks: false,
          proxy: false,
        });
        const providerImages = Array.isArray(nonManualImages)
          ? nonManualImages.filter((image) => isProviderFallbackImage(image))
          : [];
        storedProviderFallbackUrl = chooseImageFromStoredList(providerImages, types, {
          includeProviderFallbacks: true,
          proxy: false,
        });
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve artist artwork from database:", error);
    }
  }

  const explicitCanonicalImages = getServarrMetadataImages(options.servarrMetadataData)
    .filter((image) => !isProviderFallbackImage(image as Record<string, any>));
  const servarrMetadataUrl = getServarrMetadataArtistImageUrl({ images: explicitCanonicalImages }, types);
  const cacheSource = async (
    sourceUrl: string | null,
    fulfilledBy: "canonical" | "provider",
  ): Promise<string | null> => sourceUrl
    ? ensureCachedMediaCover({
      entityId: options.artistMbid,
      coverEntity: "Artist",
      coverType: coverTypeForCache,
      sourceUrl,
      fulfilledBy,
    })
    : null;

  const resolveManual = async (): Promise<string | null> => {
    return cacheSource(storedManualUrl, "canonical");
  };

  const resolveCanonical = async (): Promise<string | null> => {
    for (const sourceUrl of [storedCanonicalUrl, servarrMetadataUrl]) {
      const cached = await cacheSource(sourceUrl, "canonical");
      if (cached) return cached;
    }
    return null;
  };

  const resolveProvider = async (): Promise<string | null> => {
    const providerUrl = await resolveProviderArtworkUrl(
      [...(options.providerCandidates || []), ...loadArtistProviderArtworkCandidates(options.artistMbid)],
      "artist",
      options.size ?? configuredArtistPictureResolution(),
    );
    if (providerUrl) {
      persistResolvedFallbackArtwork("ArtistMetadata", options.artistMbid, coverTypeForCache, providerUrl);
      const cached = await cacheSource(providerUrl, "provider");
      if (cached) return cached;
    }
    return cacheSource(storedProviderFallbackUrl, "provider");
  };

  const manualResolved = await resolveManual();
  if (manualResolved) {
    return manualResolved;
  }
  const resolved = configuredArtworkPreference() === "provider"
    ? await resolveProvider() || await resolveCanonical()
    : await resolveCanonical() || await resolveProvider();
  return resolved || existingArtistMediaCoverUrl(options.artistMbid, types);
}

export async function resolveVideoArtwork(options: {
  videoId?: string | number | null;
  providerCandidates?: ProviderArtworkCandidate[];
  size?: string | number | null;
}): Promise<string | null> {
  const normalizedVideoId = textOrNull(options.videoId);

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
          provider_item.cover_id AS provider_asset_id,
          provider_item.artwork_url AS provider_cover
        FROM Recordings recording
        LEFT JOIN ProviderItems provider_item
          ON provider_item.id = (
            SELECT candidate.id
            FROM ProviderVideoMatches candidate_match
            JOIN ProviderItems candidate
              ON candidate.id = candidate_match.provider_video_item_id
            WHERE candidate.entity_type = 'video'
              AND candidate_match.recording_id = recording.id
              AND candidate_match.match_state = 'accepted'
            ORDER BY
              CASE candidate_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
              candidate_match.confidence DESC,
              candidate_match.updated_at DESC
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

  // Do not early-return on existing files: ensureCachedMediaCover refreshes when
  // the source marker mismatches or the URL is a known upgrade (uncropped YT /
  // Apple landscape / TIDAL origin). Origin + card proxies rewrite together.
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
    // Prefer origin so we keep the provider's native aspect (no 3:2 crop).
    // ensureCachedMediaCover still derives the 250px card proxy.
    options.size ?? "origin",
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

  return existingVideoMediaCoverUrl(normalizedVideoId);
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

/**
 * Single public door for media-cover reads/resolves. Prefer this over importing
 * individual helpers in new call sites — implementation stays on the named exports.
 */
export const mediaCover = {
  url: {
    album: albumCoverLocalUrl,
    artist: mapArtistArtworkToLocalUrl,
    video: videoCoverLocalUrl,
  },
  resolve: {
    album: resolveAlbumArtwork,
    artist: resolveArtistArtwork,
    video: resolveVideoArtwork,
  },
};
