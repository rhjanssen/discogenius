import {
  ProviderAlbum,
  ProviderArtist,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
} from "../streaming-provider.js";
import { appleMusicApiRequest, AppleMusicApiOptions, storefrontFor } from "./apple-music-api.js";

/**
 * Apple Music catalog resources are JSON:API-style objects:
 *   { id, type, attributes: {...}, relationships?: {...} }
 * This module fetches them and maps them into the provider-neutral DTOs.
 */

interface AppleResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  href?: string;
  attributes?: A;
  relationships?: Record<string, { data?: AppleResource[] }>;
}

interface AppleArtwork {
  url?: string;
  width?: number;
  height?: number;
}

/** Apple artwork URLs are templates with {w}/{h} placeholders. */
export function renderAppleArtwork(artwork: AppleArtwork | undefined | null, size = 640): string | null {
  if (!artwork?.url) return null;
  return artwork.url
    .replace(/\{w\}/g, String(size))
    .replace(/\{h\}/g, String(size))
    .replace(/\{f\}/g, "jpg");
}

function audioTraits(attributes: Record<string, unknown> | undefined): string[] {
  const traits = (attributes as { audioTraits?: unknown })?.audioTraits;
  return Array.isArray(traits) ? traits.map((t) => String(t)) : [];
}

export function mapAppleArtist(resource: AppleResource): ProviderArtist {
  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    url?: string;
    artwork?: AppleArtwork;
    genreNames?: string[];
  };
  return {
    providerId: resource.id,
    name: attrs.name || "Unknown Artist",
    picture: renderAppleArtwork(attrs.artwork, 750),
    url: attrs.url,
    raw: resource,
  };
}

export function mapAppleAlbum(resource: AppleResource): ProviderAlbum {
  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    artistName?: string;
    artwork?: AppleArtwork;
    releaseDate?: string;
    trackCount?: number;
    upc?: string;
    isSingle?: boolean;
    isCompilation?: boolean;
    contentRating?: string;
    url?: string;
    recordLabel?: string;
  };
  const traits = audioTraits(resource.attributes);
  const artistResource = resource.relationships?.artists?.data?.[0];
  const artist: ProviderArtist = artistResource
    ? mapAppleArtist(artistResource)
    : { providerId: "", name: attrs.artistName || "Unknown Artist" };

  let type: ProviderAlbum["type"] = "ALBUM";
  if (attrs.isSingle) type = "SINGLE";

  return {
    providerId: resource.id,
    title: attrs.name || "Unknown Album",
    artist,
    cover: renderAppleArtwork(attrs.artwork, 1200),
    releaseDate: attrs.releaseDate || null,
    trackCount: attrs.trackCount ?? null,
    duration: null,
    type,
    explicit: attrs.contentRating ? attrs.contentRating === "explicit" : null,
    upc: attrs.upc || null,
    quality: traits[0] || null,
    qualityTags: traits,
    url: attrs.url,
    raw: resource,
  };
}

export function mapAppleTrack(resource: AppleResource): ProviderTrack {
  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    trackNumber?: number;
    discNumber?: number;
    isrc?: string;
    contentRating?: string;
    url?: string;
    artwork?: AppleArtwork;
  };
  const traits = audioTraits(resource.attributes);
  const albumResource = resource.relationships?.albums?.data?.[0];
  const artistResource = resource.relationships?.artists?.data?.[0];
  const artist: ProviderArtist = artistResource
    ? mapAppleArtist(artistResource)
    : { providerId: "", name: attrs.artistName || "Unknown Artist" };

  const album: ProviderAlbum = albumResource
    ? mapAppleAlbum(albumResource)
    : {
      providerId: "",
      title: attrs.albumName || "Unknown Album",
      artist,
    };

  return {
    providerId: resource.id,
    title: attrs.name || "Unknown Track",
    artist,
    album,
    duration: attrs.durationInMillis != null ? Math.round(attrs.durationInMillis / 1000) : 0,
    trackNumber: attrs.trackNumber ?? 0,
    volumeNumber: attrs.discNumber ?? 1,
    url: attrs.url,
    isrc: attrs.isrc || null,
    quality: traits[0] || null,
    qualityTags: traits,
    raw: resource,
  };
}

export function mapAppleVideo(resource: AppleResource): ProviderVideo {
  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    artistName?: string;
    artwork?: AppleArtwork;
    releaseDate?: string;
    durationInMillis?: number;
    contentRating?: string;
    url?: string;
    isrc?: string;
  };
  const artistResource = resource.relationships?.artists?.data?.[0];
  const artist: ProviderArtist = artistResource
    ? mapAppleArtist(artistResource)
    : { providerId: "", name: attrs.artistName || "Unknown Artist" };
  return {
    providerId: resource.id,
    title: attrs.name || "Unknown Video",
    artist,
    duration: attrs.durationInMillis != null ? Math.round(attrs.durationInMillis / 1000) : null,
    releaseDate: attrs.releaseDate || null,
    cover: renderAppleArtwork(attrs.artwork, 1080),
    explicit: attrs.contentRating ? attrs.contentRating === "explicit" : null,
    url: attrs.url,
    isrc: attrs.isrc || null,
    raw: resource,
  };
}

interface AppleDataResponse<A = Record<string, unknown>> {
  data?: AppleResource<A>[];
  next?: string;
}

function first<A>(response: AppleDataResponse<A>): AppleResource<A> | null {
  return response.data?.[0] ?? null;
}

export async function getAppleArtist(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderArtist> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(`/v1/catalog/${sf}/artists/${id}`, options);
  const resource = first(res);
  if (!resource) throw new Error(`Apple Music artist not found: ${id}`);
  return mapAppleArtist(resource);
}

export async function getAppleArtistAlbums(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderAlbum[]> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(
    `/v1/catalog/${sf}/artists/${id}/albums?limit=100`,
    options,
  );
  return (res.data ?? []).map(mapAppleAlbum);
}

export async function getAppleArtistVideos(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderVideo[]> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(
    `/v1/catalog/${sf}/artists/${id}/music-videos?limit=100`,
    options,
  );
  return (res.data ?? []).map(mapAppleVideo);
}

export async function getAppleAlbum(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderAlbum> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(`/v1/catalog/${sf}/albums/${id}`, options);
  const resource = first(res);
  if (!resource) throw new Error(`Apple Music album not found: ${id}`);
  return mapAppleAlbum(resource);
}

export async function getAppleAlbumTracks(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderTrack[]> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(
    `/v1/catalog/${sf}/albums/${id}/tracks`,
    options,
  );
  return (res.data ?? []).map(mapAppleTrack);
}

export async function getAppleTrack(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderTrack> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(`/v1/catalog/${sf}/songs/${id}`, options);
  const resource = first(res);
  if (!resource) throw new Error(`Apple Music track not found: ${id}`);
  return mapAppleTrack(resource);
}

export async function getAppleVideo(id: string, options: AppleMusicApiOptions = {}): Promise<ProviderVideo> {
  const sf = storefrontFor(options.token);
  const res = await appleMusicApiRequest<AppleDataResponse>(`/v1/catalog/${sf}/music-videos/${id}`, options);
  const resource = first(res);
  if (!resource) throw new Error(`Apple Music video not found: ${id}`);
  return mapAppleVideo(resource);
}

interface AppleSearchResponse {
  results?: {
    artists?: AppleDataResponse;
    albums?: AppleDataResponse;
    songs?: AppleDataResponse;
    "music-videos"?: AppleDataResponse;
  };
}

const SEARCH_TYPE_MAP: Record<string, string> = {
  artists: "artists",
  albums: "albums",
  tracks: "songs",
  videos: "music-videos",
};

export async function searchApple(
  query: string,
  types: string[],
  limit: number,
  options: AppleMusicApiOptions = {},
): Promise<ProviderSearchResults> {
  const sf = storefrontFor(options.token);
  const appleTypes = types.map((t) => SEARCH_TYPE_MAP[t]).filter(Boolean);
  const term = encodeURIComponent(query);
  const typesParam = appleTypes.length ? appleTypes.join(",") : "artists,albums,songs,music-videos";
  const res = await appleMusicApiRequest<AppleSearchResponse>(
    `/v1/catalog/${sf}/search?term=${term}&types=${typesParam}&limit=${limit}`,
    options,
  );
  const results = res.results ?? {};
  return {
    artists: (results.artists?.data ?? []).map(mapAppleArtist),
    albums: (results.albums?.data ?? []).map(mapAppleAlbum),
    tracks: (results.songs?.data ?? []).map(mapAppleTrack),
    videos: (results["music-videos"]?.data ?? []).map(mapAppleVideo),
  };
}
