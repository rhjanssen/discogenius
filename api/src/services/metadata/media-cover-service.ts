import { getConfigSection } from "../config.js";
import { db } from "../../database.js";
import crypto from "crypto";
import path from "path";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderArtworkEntityType } from "../providers/streaming-provider.js";

export type SkyHookImage = {
  Url?: string | null;
  url?: string | null;
  remoteUrl?: string | null;
  CoverType?: string | null;
  coverType?: string | null;
  Width?: number | null;
  width?: number | null;
  Height?: number | null;
  height?: number | null;
};

export type SkyHookImageContainer = {
  Images?: SkyHookImage[] | null;
  images?: SkyHookImage[] | null;
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

function clearExpiredMediaCoverProxyEntries(now = Date.now()): void {
  try {
    db.prepare("DELETE FROM MediaCoverProxyCache WHERE expires_at <= ?").run(now);
  } catch (error) {
    console.warn("Failed to clear expired media cover proxy entries:", error);
  }
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
  try {
    db.prepare(`
      INSERT INTO MediaCoverProxyCache (hash, url, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        expires_at = excluded.expires_at
    `).run(hash, url, now + MEDIA_COVER_PROXY_TTL_MS);
  } catch (error) {
    console.warn("Failed to register media cover proxy URL in DB:", error);
  }

  return `/MediaCoverProxy/${hash}/${getSafeMediaCoverFilename(url)}`;
}

export function getRegisteredMediaCoverProxyUrl(hash: string): string | null {
  clearExpiredMediaCoverProxyEntries();
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

  const match = text.match(/^\/MediaCoverProxy\/([a-f0-9]{64})\//i);
  if (match) {
    return getRegisteredMediaCoverProxyUrl(match[1]);
  }

  return normalizeArtworkUrl(text);
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
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url)) {
    const formattedId = url.replace(/-/g, "/");
    return `https://resources.tidal.com/images/${formattedId}/750x750.jpg`;
  }
  return null;
}

function getSkyHookImages(resource: SkyHookImageContainer | null | undefined): SkyHookImage[] {
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

function imageUrl(image: SkyHookImage): string | null {
  return normalizeArtworkUrl(image.Url || image.url || image.remoteUrl);
}

function imageCoverType(image: SkyHookImage): string {
  return String(image.CoverType || image.coverType || "").trim().toLowerCase();
}

function imageArea(image: SkyHookImage): number {
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

export function getSkyHookImageUrl(
  resource: SkyHookImageContainer | null | undefined,
  preferredCoverTypes: string | string[],
): string | null {
  const images = getSkyHookImages(resource).filter((image) => imageUrl(image));
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

export function getSkyHookArtistImageUrl(
  artist: SkyHookImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = ["Poster", "Headshot", "Fanart"],
): string | null {
  return getSkyHookImageUrl(artist, preferredCoverTypes);
}

export function getSkyHookAlbumImageUrl(
  album: SkyHookImageContainer | null | undefined,
  preferredCoverTypes: string | string[] = ["Cover", "Poster"],
): string | null {
  return getSkyHookImageUrl(album, preferredCoverTypes);
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
      imageId: extractProviderArtworkId(row.provider_data, "album"),
      data: row.provider_data,
    },
  ];

  return candidates.filter((candidate) => candidate.provider || candidate.imageId || candidate.data || candidate.entityId);
}

export function chooseCachedProviderArtwork(
  candidates: ProviderArtworkCandidate[],
  entityType: ProviderArtworkEntityType,
): string | null {
  for (const candidate of candidates) {
    const imageId = textOrNull(candidate.imageId, extractProviderArtworkId(candidate.data, entityType));
    const url = normalizeArtworkUrl(imageId);
    if (url) {
      return url;
    }
    if (imageId) {
      return imageId;
    }
  }
  return null;
}

export function chooseCachedAlbumArtwork(options: {
  albumMbid?: string | null;
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
}): string | null {
  let storedProviderFallbackUrl: string | null = null;
  if (options.albumMbid) {
    try {
      const row = db.prepare("SELECT images FROM Albums WHERE mbid = ?").get(options.albumMbid) as { images?: string | null } | undefined;
      if (row?.images) {
        const dbImages = JSON.parse(row.images);
        const preferredCoverTypes = ["Cover", "Poster"];
        const storedCanonicalUrl = chooseImageFromStoredList(dbImages, preferredCoverTypes, {
          includeProviderFallbacks: false,
          proxy: true,
        });
        if (storedCanonicalUrl) {
          return storedCanonicalUrl;
        }
        storedProviderFallbackUrl = chooseImageFromStoredList(dbImages, preferredCoverTypes, {
          includeProviderFallbacks: true,
          proxy: true,
        });
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to query or parse cached album artwork:", error);
    }
  }

  const skyHookUrl = getSkyHookAlbumImageUrl(options.skyHookData);
  if (skyHookUrl) {
    return registerMediaCoverProxyUrl(skyHookUrl) || skyHookUrl;
  }
  if (storedProviderFallbackUrl) {
    return storedProviderFallbackUrl;
  }
  const providerUrl = chooseCachedProviderArtwork(options.providerCandidates || [], "album");
  return registerMediaCoverProxyUrl(providerUrl) || providerUrl;
}

export function chooseCachedArtistArtwork(options: {
  artistMbid?: string | null;
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
}): string | null {
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
              if (url) return registerMediaCoverProxyUrl(url) || url;
            }
          }
          const fallback = dbImages[0]?.url;
          if (fallback) {
            const url = normalizeArtworkUrl(fallback);
            if (url) return registerMediaCoverProxyUrl(url) || url;
          }
        }
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to query or parse cached artist artwork:", error);
    }
  }

  const skyHookUrl = getSkyHookArtistImageUrl(options.skyHookData, options.preferredCoverTypes);
  if (skyHookUrl) {
    return registerMediaCoverProxyUrl(skyHookUrl) || skyHookUrl;
  }
  const providerUrl = chooseCachedProviderArtwork(options.providerCandidates || [], "artist");
  return registerMediaCoverProxyUrl(providerUrl) || providerUrl;
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
    const directUrl = normalizeArtworkUrl(candidate.imageId || extractProviderArtworkId(candidate.data, entityType));
    if (directUrl) {
      return directUrl;
    }

    const providerId = textOrNull(candidate.provider);
    const entityId = textOrNull(candidate.entityId);
    const imageId = textOrNull(candidate.imageId, extractProviderArtworkId(candidate.data, entityType));
    if (!providerId || (!entityId && !imageId)) {
      continue;
    }

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
      // Provider artwork is a fallback source; continue to the next candidate.
    }
  }

  return null;
}

export async function resolveAlbumArtwork(options: {
  albumMbid?: string | null;
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  size?: string | number | null;
}): Promise<string | null> {
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
          return storedCanonicalUrl;
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

  const skyHookUrl = getSkyHookAlbumImageUrl(options.skyHookData);
  if (skyHookUrl) {
    return skyHookUrl;
  }
  if (storedProviderFallbackUrl) {
    return storedProviderFallbackUrl;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    options.providerCandidates || [],
    "album",
    options.size ?? configuredAlbumCoverResolution(),
  );
  if (providerUrl) {
    persistResolvedFallbackArtwork("Albums", options.albumMbid, "Cover", providerUrl);
    return providerUrl;
  }

  return null;
}

export async function resolveArtistArtwork(options: {
  artistMbid?: string | null;
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
  size?: string | number | null;
}): Promise<string | null> {
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
              if (url) return url;
            }
          }
          const fallback = dbImages[0]?.url;
          if (fallback) {
            const url = normalizeArtworkUrl(fallback);
            if (url) return url;
          }
        }
      }
    } catch (error) {
      console.warn("[MediaCoverService] Failed to resolve artist artwork from database:", error);
    }
  }

  const skyHookUrl = getSkyHookArtistImageUrl(options.skyHookData, options.preferredCoverTypes);
  if (skyHookUrl) {
    return skyHookUrl;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    options.providerCandidates || [],
    "artist",
    options.size ?? configuredArtistPictureResolution(),
  );
  if (providerUrl) {
    persistResolvedFallbackArtwork("ArtistMetadata", options.artistMbid, "Headshot", providerUrl);
    return providerUrl;
  }

  return null;
}

// MediaCoverService class aligned 1:1 with Lidarr naming and structure
export class MediaCoverService {
  static getArtistImageUrl(artist: SkyHookImageContainer, preferredCoverType = "Poster"): string | null {
    return getSkyHookArtistImageUrl(artist, preferredCoverType);
  }

  static getAlbumImageUrl(album: SkyHookImageContainer, preferredCoverType = "Cover"): string | null {
    return getSkyHookAlbumImageUrl(album, preferredCoverType);
  }

  static getCoverPath(entityId: number, coverEntity: 'Artist' | 'Album', coverType: string, extension: string): string {
    // Discogenius doesn't use local image paths yet, but we define the method signature for 1:1 parity
    return `${coverEntity.toLowerCase()}s/${entityId}/${coverType.toLowerCase()}${extension}`;
  }

  static convertToLocalUrls(entityId: number, coverEntity: 'Artist' | 'Album', covers: SkyHookImage[]): void {
    // Discogenius uses raw RemoteUrl and resolved URLs directly, signature kept for 1:1 parity
  }

  static chooseCachedAlbumArtwork = chooseCachedAlbumArtwork;
  static chooseCachedArtistArtwork = chooseCachedArtistArtwork;
  static resolveAlbumArtwork = resolveAlbumArtwork;
  static resolveArtistArtwork = resolveArtistArtwork;
  static albumProviderArtworkCandidatesFromRow = albumProviderArtworkCandidatesFromRow;
  static parseJsonObject = parseJsonObject;
  static normalizeArtworkUrl = normalizeArtworkUrl;
  static registerUrl = registerMediaCoverProxyUrl;
  static getUrl = getRegisteredMediaCoverProxyUrl;
  static resolveProxyUrl = resolveMediaCoverProxyUrl;
}
