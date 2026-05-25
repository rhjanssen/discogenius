import { getConfigSection } from "../config.js";
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
  return url && /^https?:\/\//i.test(url) ? url : null;
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

  return imageUrl(images.sort((left, right) => imageArea(right) - imageArea(left))[0]);
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
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
}): string | null {
  return getSkyHookAlbumImageUrl(options.skyHookData)
    || chooseCachedProviderArtwork(options.providerCandidates || [], "album");
}

export function chooseCachedArtistArtwork(options: {
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
}): string | null {
  return getSkyHookArtistImageUrl(options.skyHookData, options.preferredCoverTypes)
    || chooseCachedProviderArtwork(options.providerCandidates || [], "artist");
}

function configuredArtistPictureResolution(): number {
  try {
    const resolution = Number(getConfigSection("metadata")?.artist_picture_resolution || 750);
    return Number.isFinite(resolution) ? resolution : 750;
  } catch {
    return 750;
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
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  size?: string | number | null;
}): Promise<string | null> {
  const skyHookUrl = getSkyHookAlbumImageUrl(options.skyHookData);
  if (skyHookUrl) {
    return skyHookUrl;
  }

  const providerUrl = await resolveProviderArtworkUrl(
    options.providerCandidates || [],
    "album",
    options.size ?? configuredAlbumCoverResolution(),
  );
  if (providerUrl) {
    return providerUrl;
  }

  return null;
}

export async function resolveArtistArtwork(options: {
  skyHookData?: SkyHookImageContainer | null;
  providerCandidates?: ProviderArtworkCandidate[];
  preferredCoverTypes?: string | string[];
  size?: string | number | null;
}): Promise<string | null> {
  const skyHookUrl = getSkyHookArtistImageUrl(options.skyHookData, options.preferredCoverTypes);
  if (skyHookUrl) {
    return skyHookUrl;
  }

  return resolveProviderArtworkUrl(
    options.providerCandidates || [],
    "artist",
    options.size ?? configuredArtistPictureResolution(),
  );
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
}
