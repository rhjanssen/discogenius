import type {
  ProviderAlbum,
  ProviderArtist,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
} from "../streaming-provider.js";
import { PythonYtMusicBridge, type YtMusicBridge } from "./ytmusicapi-bridge.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function text(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function nullableText(...values: unknown[]): string | null {
  return text(...values) || null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDuration(value: unknown): number {
  const direct = numeric(value);
  if (direct != null && direct >= 0) return Math.round(direct);
  const raw = text(value);
  if (!/^\d+(?::\d{1,2}){1,2}$/u.test(raw)) return 0;
  return raw.split(":").reduce((seconds, component) => seconds * 60 + Number(component), 0);
}

function durationSeconds(raw: UnknownRecord): number {
  const milliseconds = numeric(raw.durationMs ?? raw.lengthMs);
  if (milliseconds != null) return Math.round(milliseconds / 1000);
  return parseDuration(raw.duration_seconds ?? raw.lengthSeconds ?? raw.duration);
}

function imageFrom(raw: UnknownRecord): string | null {
  const direct = nullableText(raw.picture, raw.cover, raw.image, raw.thumbnailUrl);
  if (direct) return direct;
  const thumbnailContainer = record(raw.thumbnail);
  const thumbnails = records(raw.thumbnails).length > 0
    ? records(raw.thumbnails)
    : records(thumbnailContainer.thumbnails);
  if (thumbnails.length === 0) return null;
  const sorted = [...thumbnails].sort((left, right) => {
    const leftSize = (numeric(left.width) ?? 0) * (numeric(left.height) ?? 0);
    const rightSize = (numeric(right.width) ?? 0) * (numeric(right.height) ?? 0);
    return rightSize - leftSize;
  });
  return nullableText(sorted[0]?.url);
}

function releaseDate(raw: UnknownRecord): string | null {
  const fullDate = nullableText(raw.releaseDate, raw.publishDate, raw.uploadDate);
  if (fullDate) return fullDate;
  const year = numeric(raw.year);
  return year && year >= 1000 && year <= 9999 ? `${Math.trunc(year)}-01-01` : null;
}

function artistId(raw: UnknownRecord): string {
  return text(raw.channelId, raw.browseId, raw.id);
}

export function mapYouTubeMusicArtist(rawValue: unknown, fallback?: Partial<ProviderArtist>): ProviderArtist {
  const raw = record(rawValue);
  const videoDetails = record(raw.videoDetails);
  const providerId = artistId(raw) || text(videoDetails.channelId) || fallback?.providerId || "unknown";
  const name = text(raw.name, raw.artist, raw.title, videoDetails.author, fallback?.name) || "Unknown Artist";
  const picture = imageFrom(raw) || imageFrom(videoDetails) || fallback?.picture || null;
  return {
    providerId,
    name,
    picture,
    url: `https://music.youtube.com/channel/${encodeURIComponent(providerId)}`,
    raw: rawValue,
  };
}

function artistList(raw: UnknownRecord, fallback?: ProviderArtist): ProviderArtist[] {
  const mapped = records(raw.artists).map((artist) => mapYouTubeMusicArtist(artist, fallback));
  if (mapped.length > 0) return mapped;
  const videoDetails = record(raw.videoDetails);
  if (Object.keys(videoDetails).length > 0) {
    return [mapYouTubeMusicArtist(videoDetails, fallback)];
  }
  return [fallback || mapYouTubeMusicArtist(raw)];
}

function albumType(raw: UnknownRecord): string {
  const normalized = text(raw.type, raw.albumType, raw.category, raw.resultType).toLowerCase();
  if (normalized.includes("single")) return "SINGLE";
  if (normalized === "ep" || normalized.includes("extended play")) return "EP";
  return "ALBUM";
}

export function mapYouTubeMusicAlbum(
  rawValue: unknown,
  fallbackArtist?: ProviderArtist,
  fallbackProviderId?: string,
): ProviderAlbum {
  const raw = record(rawValue);
  const artists = artistList(raw, fallbackArtist);
  const providerId = text(raw.browseId, raw.id, raw.playlistId, fallbackProviderId);
  const title = text(raw.title, raw.name) || "Untitled YouTube Music album";
  return {
    providerId: providerId || `unknown-${Buffer.from(`${artists[0].name}:${title}`).toString("base64url")}`,
    title,
    artist: artists[0],
    artists,
    cover: imageFrom(raw),
    releaseDate: releaseDate(raw),
    trackCount: numeric(raw.trackCount) ?? (Array.isArray(raw.tracks) ? raw.tracks.length : null),
    volumeCount: numeric(raw.volumeCount) ?? 1,
    duration: durationSeconds(raw) || null,
    type: albumType(raw),
    explicit: typeof raw.isExplicit === "boolean" ? raw.isExplicit : null,
    quality: "YOUTUBE_LOSSY",
    qualityTags: ["opus", "aac", "lossy"],
    url: providerId ? `https://music.youtube.com/browse/${encodeURIComponent(providerId)}` : undefined,
    raw: rawValue,
  };
}

function albumForTrack(raw: UnknownRecord, artist: ProviderArtist, providerTrackId: string): ProviderAlbum {
  const album = record(raw.album);
  if (Object.keys(album).length > 0) {
    return mapYouTubeMusicAlbum({
      ...album,
      title: text(album.title, album.name),
      browseId: text(album.browseId, album.id),
      artists: album.artists || raw.artists,
    }, artist);
  }
  return mapYouTubeMusicAlbum({
    browseId: providerTrackId,
    title: text(raw.albumName) || "YouTube Music",
    artists: raw.artists,
    thumbnails: raw.thumbnails,
    type: "SINGLE",
    trackCount: 1,
  }, artist);
}

export function mapYouTubeMusicTrack(
  rawValue: unknown,
  options: { album?: ProviderAlbum; fallbackArtist?: ProviderArtist; index?: number } = {},
): ProviderTrack {
  const raw = record(rawValue);
  const videoDetails = record(raw.videoDetails);
  const merged = Object.keys(videoDetails).length > 0 ? { ...raw, ...videoDetails } : raw;
  const artists = artistList(merged, options.fallbackArtist || options.album?.artist);
  const providerId = text(merged.videoId, merged.id);
  const album = options.album || albumForTrack(merged, artists[0], providerId || "unknown");
  const trackNumber = numeric(merged.trackNumber ?? merged.index ?? merged.playlistIndex) ?? options.index ?? 1;
  return {
    providerId,
    title: text(merged.title, merged.name) || "Untitled YouTube Music track",
    artist: artists[0],
    artists,
    album,
    duration: durationSeconds(merged),
    trackNumber: Math.max(1, Math.round(trackNumber)),
    volumeNumber: Math.max(1, Math.round(numeric(merged.volumeNumber ?? merged.discNumber) ?? 1)),
    url: providerId ? `https://music.youtube.com/watch?v=${encodeURIComponent(providerId)}` : undefined,
    releaseDate: releaseDate(merged) || album.releaseDate,
    quality: "YOUTUBE_LOSSY",
    qualityTags: ["opus", "aac", "lossy"],
    raw: rawValue,
  };
}

export function mapYouTubeMusicVideo(rawValue: unknown, fallbackArtist?: ProviderArtist): ProviderVideo {
  const raw = record(rawValue);
  const videoDetails = record(raw.videoDetails);
  const microformat = record(record(raw.microformat).playerMicroformatRenderer);
  const merged = Object.keys(videoDetails).length > 0
    ? { ...raw, ...microformat, ...videoDetails }
    : raw;
  const artists = artistList(merged, fallbackArtist);
  const providerId = text(merged.videoId, merged.id);
  return {
    providerId,
    title: text(merged.title, merged.name) || "Untitled YouTube video",
    artist: artists[0],
    artists,
    duration: durationSeconds(merged) || null,
    releaseDate: releaseDate(merged),
    cover: imageFrom(merged),
    quality: "SOURCE",
    explicit: typeof merged.isExplicit === "boolean" ? merged.isExplicit : null,
    url: providerId ? `https://www.youtube.com/watch?v=${encodeURIComponent(providerId)}` : undefined,
    raw: rawValue,
  };
}

interface SearchBuckets {
  artists?: unknown[];
  albums?: unknown[];
  tracks?: unknown[];
  videos?: unknown[];
}

interface ImportSourcePayload {
  libraryArtists?: unknown[];
  playlists?: unknown[];
  favoriteTracksAvailable?: boolean;
}

export class YouTubeMusicCatalog {
  constructor(private readonly bridge: YtMusicBridge = new PythonYtMusicBridge()) {}

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const types = options.types?.length ? options.types : ["artists", "albums", "tracks", "videos"];
    const buckets = await this.bridge.request<SearchBuckets>("search", {
      query,
      types,
      limit: Math.max(1, Math.min(options.limit ?? 10, 100)),
    });
    return {
      artists: (buckets.artists || [])
        .map((item) => mapYouTubeMusicArtist(item))
        .filter((artist) => artist.providerId !== "unknown"),
      albums: (buckets.albums || [])
        .map((item) => mapYouTubeMusicAlbum(item))
        .filter((album) => !album.providerId.startsWith("unknown-")),
      tracks: (buckets.tracks || [])
        .map((item, index) => mapYouTubeMusicTrack(item, { index: index + 1 }))
        .filter((track) => Boolean(track.providerId)),
      videos: (buckets.videos || [])
        .map((item) => mapYouTubeMusicVideo(item))
        .filter((video) => Boolean(video.providerId)),
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return mapYouTubeMusicArtist(await this.bridge.request("get_artist", { id: String(id) }), { providerId: String(id) });
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const [artist, rawAlbums] = await Promise.all([
      this.getArtist(id),
      this.bridge.request<unknown[]>("get_artist_albums", { id: String(id) }),
    ]);
    return rawAlbums
      .map((album) => mapYouTubeMusicAlbum(album, artist))
      .filter((album) => !album.providerId.startsWith("unknown-"));
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    const [artist, rawVideos] = await Promise.all([
      this.getArtist(id),
      this.bridge.request<unknown[]>("get_artist_videos", { id: String(id) }),
    ]);
    return rawVideos
      .map((video) => mapYouTubeMusicVideo(video, artist))
      .filter((video) => Boolean(video.providerId));
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return mapYouTubeMusicAlbum(
      await this.bridge.request("get_album", { id: String(id) }),
      undefined,
      String(id),
    );
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    const rawAlbum = await this.bridge.request<UnknownRecord>("get_album", { id: String(id) });
    const album = mapYouTubeMusicAlbum(rawAlbum, undefined, String(id));
    return records(rawAlbum.tracks)
      .map((track, index) => mapYouTubeMusicTrack(track, {
        album,
        fallbackArtist: album.artist,
        index: index + 1,
      }))
      .filter((track) => Boolean(track.providerId));
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    const track = mapYouTubeMusicTrack(await this.bridge.request("get_track", { id: String(id) }));
    if (!track.providerId) throw new Error(`ytmusicapi returned no stable video ID for track ${id}.`);
    return track;
  }

  async getVideo(id: string | number): Promise<ProviderVideo> {
    const video = mapYouTubeMusicVideo(await this.bridge.request("get_video", { id: String(id) }));
    if (!video.providerId) throw new Error(`ytmusicapi returned no stable video ID for video ${id}.`);
    return video;
  }

  async listImportSources(): Promise<ProviderImportSource[]> {
    const payload = await this.bridge.request<ImportSourcePayload>("list_import_sources");
    const result: ProviderImportSource[] = [
      {
        category: "library-artists",
        label: "Library artists",
        description: "Artists saved in your YouTube Music library",
        requiresListSelection: false,
      },
      {
        category: "favorite-tracks",
        label: "Liked music",
        description: "Distinct artists from your liked YouTube Music tracks",
        requiresListSelection: false,
      },
    ];
    const playlists = (payload.playlists || []).map((rawValue) => {
      const raw = record(rawValue);
      return {
        id: text(raw.playlistId, raw.id, raw.browseId),
        title: text(raw.title, raw.name) || "Untitled playlist",
        subtitle: nullableText(raw.author, raw.description),
        image: imageFrom(raw),
        itemCount: numeric(raw.count ?? raw.trackCount),
      };
    }).filter((playlist) => playlist.id);
    if (playlists.length > 0) {
      result.push({
        category: "playlist",
        label: "Playlists",
        description: "Artists from one of your YouTube Music playlists",
        requiresListSelection: true,
        lists: playlists,
      });
    }
    return result;
  }

  async getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    if (selection.category === "playlist" && !selection.listId) {
      throw new Error("A YouTube Music playlist must be selected.");
    }
    if (!["library-artists", "favorite-tracks", "playlist"].includes(selection.category)) {
      throw new Error(`Unsupported YouTube Music import source: ${selection.category}`);
    }
    const raw = await this.bridge.request<unknown[]>("get_import_artists", {
      category: selection.category,
      listId: selection.listId,
    });
    return raw
      .map((artist) => mapYouTubeMusicArtist(artist))
      .filter((artist) => artist.providerId !== "unknown");
  }
}
