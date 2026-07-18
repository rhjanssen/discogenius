import type {
  ProviderAlbum,
  ProviderArtist,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
} from "../streaming-provider.js";
import type { SpotifyApiClient } from "./spotify-api.js";

export interface SpotifyImageObject {
  url?: string;
  width?: number | null;
  height?: number | null;
}

export interface SpotifyArtistObject {
  id?: string;
  name?: string;
  type?: string;
  popularity?: number;
  images?: SpotifyImageObject[];
  external_urls?: { spotify?: string };
}

export interface SpotifyPaging<T> {
  items?: T[];
  next?: string | null;
  total?: number;
  limit?: number;
  offset?: number;
}

export interface SpotifyAlbumObject {
  id?: string;
  name?: string;
  album_type?: string;
  album_group?: string;
  total_tracks?: number;
  release_date?: string;
  release_date_precision?: string;
  artists?: SpotifyArtistObject[];
  images?: SpotifyImageObject[];
  external_ids?: { upc?: string };
  external_urls?: { spotify?: string };
  copyrights?: Array<{ text?: string; type?: string }>;
  label?: string;
  popularity?: number;
  tracks?: SpotifyPaging<SpotifyTrackObject>;
}

export interface SpotifyTrackObject {
  id?: string;
  name?: string;
  type?: string;
  duration_ms?: number;
  track_number?: number;
  disc_number?: number;
  explicit?: boolean;
  is_local?: boolean;
  preview_url?: string | null;
  popularity?: number;
  artists?: SpotifyArtistObject[];
  album?: SpotifyAlbumObject;
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
}

export type SpotifyProviderTrack = ProviderTrack & {
  /** Provider evidence retained even though the legacy shared DTO omits it. */
  explicit: boolean | null;
  previewUrl: string | null;
};

interface SpotifySearchResponse {
  artists?: SpotifyPaging<SpotifyArtistObject>;
  albums?: SpotifyPaging<SpotifyAlbumObject>;
  tracks?: SpotifyPaging<SpotifyTrackObject>;
}

function bestImage(images: SpotifyImageObject[] | undefined): string | null {
  const valid = (images ?? []).filter((image): image is SpotifyImageObject & { url: string } => Boolean(image.url));
  valid.sort((left, right) => {
    const leftArea = Number(left.width ?? 0) * Number(left.height ?? 0);
    const rightArea = Number(right.width ?? 0) * Number(right.height ?? 0);
    return rightArea - leftArea;
  });
  return valid[0]?.url ?? null;
}

function albumType(album: SpotifyAlbumObject): ProviderAlbum["type"] {
  const raw = String(album.album_type ?? album.album_group ?? "album").toLowerCase();
  if (raw === "compilation") return "COMPILATION";
  if (raw === "single") return Number(album.total_tracks ?? 0) <= 1 ? "SINGLE" : "EP";
  return "ALBUM";
}

function placeholderArtist(name = "Unknown Artist"): ProviderArtist {
  return { providerId: "", name, picture: null };
}

export function mapSpotifyArtist(artist: SpotifyArtistObject): ProviderArtist {
  return {
    providerId: String(artist.id ?? ""),
    name: artist.name || "Unknown Artist",
    picture: bestImage(artist.images),
    url: artist.external_urls?.spotify,
    popularity: Number.isFinite(artist.popularity) ? Number(artist.popularity) : null,
    raw: artist,
  };
}

export function mapSpotifyAlbum(album: SpotifyAlbumObject): ProviderAlbum {
  const artists = (album.artists ?? []).map(mapSpotifyArtist);
  const tracks = album.tracks?.items ?? [];
  const durations = tracks.map((track) => Number(track.duration_ms)).filter(Number.isFinite);
  const maxDisc = tracks.reduce((max, track) => Math.max(max, Number(track.disc_number ?? 0)), 0);
  const hasExplicitEvidence = tracks.some((track) => typeof track.explicit === "boolean");
  const trackPageComplete = album.tracks?.total == null || Number(album.tracks.total) <= tracks.length;
  const explicit = tracks.some((track) => track.explicit === true)
    ? true
    : (hasExplicitEvidence && trackPageComplete ? false : null);
  return {
    providerId: String(album.id ?? ""),
    title: album.name || "Unknown Album",
    artist: artists[0] ?? placeholderArtist(),
    artists,
    cover: bestImage(album.images),
    releaseDate: album.release_date || null,
    trackCount: Number.isFinite(album.total_tracks) ? Number(album.total_tracks) : null,
    volumeCount: maxDisc || null,
    duration: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / 1000) : null,
    type: albumType(album),
    explicit,
    upc: album.external_ids?.upc || null,
    copyright: album.copyrights?.map((entry) => entry.text).find(Boolean) || null,
    popularity: Number.isFinite(album.popularity) ? Number(album.popularity) : null,
    quality: "VORBIS_MEDIUM",
    qualityTags: ["VORBIS_MEDIUM"],
    url: album.external_urls?.spotify,
    raw: album,
  };
}

export function mapSpotifyTrack(
  track: SpotifyTrackObject,
  albumOverride?: SpotifyAlbumObject,
): SpotifyProviderTrack {
  const artists = (track.artists ?? []).map(mapSpotifyArtist);
  const albumRaw = track.album ?? albumOverride ?? {
    id: "",
    name: "Unknown Album",
    artists: track.artists,
  };
  const album = mapSpotifyAlbum(albumRaw);
  const artist = artists[0] ?? album.artist ?? placeholderArtist();
  return {
    providerId: String(track.id ?? ""),
    title: track.name || "Unknown Track",
    artist,
    artists,
    album,
    duration: Number.isFinite(track.duration_ms) ? Math.round(Number(track.duration_ms) / 1000) : 0,
    trackNumber: Number.isFinite(track.track_number) ? Number(track.track_number) : 0,
    volumeNumber: Number.isFinite(track.disc_number) ? Number(track.disc_number) : 1,
    url: track.external_urls?.spotify,
    isrc: track.external_ids?.isrc || null,
    releaseDate: album.releaseDate,
    copyright: album.copyright,
    popularity: Number.isFinite(track.popularity) ? Number(track.popularity) : null,
    quality: "VORBIS_MEDIUM",
    qualityTags: ["VORBIS_MEDIUM"],
    explicit: typeof track.explicit === "boolean" ? track.explicit : null,
    previewUrl: track.preview_url || null,
    raw: track,
  };
}

async function collectPages<T>(
  api: SpotifyApiClient,
  initial: SpotifyPaging<T>,
): Promise<T[]> {
  const result = [...(initial.items ?? [])];
  const visited = new Set<string>();
  let next = initial.next || null;
  let pages = 0;
  while (next && !visited.has(next) && pages < 100) {
    visited.add(next);
    pages += 1;
    const page = await api.request<SpotifyPaging<T>>(next);
    result.push(...(page.items ?? []));
    next = page.next || null;
  }
  return result;
}

function uniqueById<T extends { id?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = String(item.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export class SpotifyCatalog {
  constructor(private readonly api: SpotifyApiClient) {}

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const requested = options.types?.length ? options.types : ["artists", "albums", "tracks"];
    const spotifyTypes = requested
      .map((type) => type === "artists" ? "artist" : type === "albums" ? "album" : type === "tracks" ? "track" : null)
      .filter((type): type is "artist" | "album" | "track" => Boolean(type));
    const empty: ProviderSearchResults = { artists: [], albums: [], tracks: [], videos: [] };
    if (!spotifyTypes.length) return empty;
    const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
    const params = new URLSearchParams({ q: query, type: spotifyTypes.join(","), limit: String(limit) });
    const response = await this.api.request<SpotifySearchResponse>(`/search?${params.toString()}`);
    return {
      artists: requested.includes("artists") ? (response.artists?.items ?? []).map(mapSpotifyArtist) : [],
      albums: requested.includes("albums") ? (response.albums?.items ?? []).map(mapSpotifyAlbum) : [],
      tracks: requested.includes("tracks") ? (response.tracks?.items ?? []).map((track) => mapSpotifyTrack(track)) : [],
      videos: [],
    };
  }

  async getArtist(id: string): Promise<ProviderArtist> {
    const artist = await this.api.request<SpotifyArtistObject>(`/artists/${encodeURIComponent(id)}`);
    if (!artist.id) throw new Error(`Spotify artist not found: ${id}`);
    return mapSpotifyArtist(artist);
  }

  async getArtistAlbums(id: string): Promise<ProviderAlbum[]> {
    const params = new URLSearchParams({ include_groups: "album,single,compilation", limit: "50" });
    const first = await this.api.request<SpotifyPaging<SpotifyAlbumObject>>(
      `/artists/${encodeURIComponent(id)}/albums?${params.toString()}`,
    );
    return uniqueById(await collectPages(this.api, first)).map(mapSpotifyAlbum);
  }

  async getAlbum(id: string): Promise<ProviderAlbum> {
    const album = await this.api.request<SpotifyAlbumObject>(`/albums/${encodeURIComponent(id)}`);
    if (!album.id) throw new Error(`Spotify album not found: ${id}`);
    return mapSpotifyAlbum(album);
  }

  async getAlbumTracks(id: string): Promise<ProviderTrack[]> {
    const album = await this.api.request<SpotifyAlbumObject>(`/albums/${encodeURIComponent(id)}`);
    if (!album.id) throw new Error(`Spotify album not found: ${id}`);
    const first = album.tracks ?? await this.api.request<SpotifyPaging<SpotifyTrackObject>>(
      `/albums/${encodeURIComponent(id)}/tracks?limit=50`,
    );
    return (await collectPages(this.api, first)).map((track) => mapSpotifyTrack(track, album));
  }

  async getTrack(id: string): Promise<SpotifyProviderTrack> {
    const track = await this.api.request<SpotifyTrackObject>(`/tracks/${encodeURIComponent(id)}`);
    if (!track.id) throw new Error(`Spotify track not found: ${id}`);
    return mapSpotifyTrack(track);
  }

  async getTrackPreviewUrl(id: string): Promise<string | null> {
    return (await this.getTrack(id)).previewUrl;
  }

  async searchReleaseGroup(request: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    if (request.slot !== "stereo") return [];
    const query = `album:${JSON.stringify(request.releaseGroupTitle)} artist:${JSON.stringify(request.artistName)}`;
    return (await this.search(query, { types: ["albums"], limit: 20 })).albums;
  }
}
