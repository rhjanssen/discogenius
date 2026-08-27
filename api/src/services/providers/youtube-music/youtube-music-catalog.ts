import type {
  ProviderAlbum,
  ProviderArtist,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderLyrics,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
} from "../streaming-provider.js";
import { getYouTubeMusicCredentialState } from "./youtube-music-auth.js";
import {
  PythonYtMusicBridge,
  YOUTUBE_MUSIC_AUTH_REQUIRED_MESSAGE,
  type YtMusicBridge,
} from "./ytmusicapi-bridge.js";
import { youtubeVideoQualityTagFromHeight } from "./youtube-music-quality.js";

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

function youtubeStillUrl(videoId: string | null | undefined): string | null {
  const id = String(videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/u.test(id)) return null;
  return `https://i.ytimg.com/vi/${id}/hq720.jpg`;
}

function imageFrom(raw: UnknownRecord, watchId?: string | null): string | null {
  const ownedStill = youtubeStillUrl(watchId);
  if (ownedStill) return ownedStill;
  const direct = nullableText(raw.picture, raw.cover, raw.image, raw.thumbnailUrl);
  if (direct) return normalizeYouTubeThumb(direct);
  const thumbnailContainer = record(raw.thumbnail);
  const thumbnails = records(raw.thumbnails).length > 0
    ? records(raw.thumbnails)
    : records(thumbnailContainer.thumbnails);
  if (thumbnails.length === 0) return null;
  // Prefer landscape (16:9 / 3:2) over square crops even when the square is larger.
  const sorted = [...thumbnails].sort((left, right) => {
    const leftW = numeric(left.width) ?? 0;
    const leftH = numeric(left.height) ?? 0;
    const rightW = numeric(right.width) ?? 0;
    const rightH = numeric(right.height) ?? 0;
    const leftLandscape = leftW > leftH ? 1 : 0;
    const rightLandscape = rightW > rightH ? 1 : 0;
    if (leftLandscape !== rightLandscape) return rightLandscape - leftLandscape;
    return (rightW * rightH) - (leftW * leftH);
  });
  return normalizeYouTubeThumb(nullableText(sorted[0]?.url));
}

/** Strip YouTube UI `sqp=` center-crops; keep a full-frame hq720 still. */
function normalizeYouTubeThumb(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/^https?:\/\/i\.ytimg\.com\/vi\/([^/?#]+)\//i);
  if (!match) return url;
  if (/[?&]sqp=/i.test(url) || !/\/(maxresdefault|hq720|sddefault|hqdefault)\.jpg/i.test(url)) {
    return `https://i.ytimg.com/vi/${match[1]}/hq720.jpg`;
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return `https://i.ytimg.com/vi/${match[1]}/hq720.jpg`;
  }
}

function releaseDate(raw: UnknownRecord): string | null {
  const fullDate = nullableText(raw.releaseDate, raw.publishDate, raw.uploadDate);
  if (fullDate) {
    // ytmusicapi/yt-dlp return ISO timestamps; persist calendar day for matching.
    const day = fullDate.match(/^(\d{4}-\d{2}-\d{2})/);
    return day ? day[1] : fullDate;
  }
  const year = numeric(raw.year);
  return year && year >= 1000 && year <= 9999 ? `${Math.trunc(year)}-01-01` : null;
}

/**
 * ytmusicapi `get_song` returns Music's `microformatDataRenderer`; yt-dlp's WEB
 * player path uses `playerMicroformatRenderer`. Both carry publish/upload dates.
 */
function microformatRecord(raw: UnknownRecord): UnknownRecord {
  const microformat = record(raw.microformat);
  const music = record(microformat.microformatDataRenderer);
  if (Object.keys(music).length > 0) return music;
  return record(microformat.playerMicroformatRenderer);
}

/** Max progressive/adaptive height from Innertube `streamingData` (same source yt-dlp uses). */
function maxHeightFromStreamingData(raw: UnknownRecord): number | null {
  const streaming = record(raw.streamingData);
  const formats = [
    ...records(streaming.adaptiveFormats),
    ...records(streaming.formats),
  ];
  let maxHeight: number | null = null;
  for (const format of formats) {
    const height = numeric(format.height);
    if (height != null && height > (maxHeight ?? 0)) {
      maxHeight = height;
    }
  }
  return maxHeight;
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
  const counterpart = record(merged.counterpart);
  const counterpartVideoId = text(counterpart.videoId);
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
    // Prefer a distinct ATV→OMV id; same-id self-OMV is filled by enrichAlbumTrackCounterparts.
    counterpartVideoId: counterpartVideoId || null,
    raw: rawValue,
  };
}

/**
 * YouTube Music tags every entry with a `videoType`:
 *   OMV                   – Original Music Video (includes official lyric videos;
 *                           there is no separate OLV type)
 *   OFFICIAL_SOURCE_MUSIC – official video content (live sets, medleys)
 *   ATV                   – audio-only "song" with a cover image, NOT a video
 *   UGC                   – user-generated upload (fan videos, lyric rips)
 * Only OMV / OFFICIAL_SOURCE_MUSIC are kept as music videos. Without this filter
 * an unauthenticated YouTube refresh injects fan uploads and audio-only tracks
 * into the video library. Entries with no videoType are kept (older payloads omit
 * it) so we never silently drop a legitimate video.
 * Official lyric cuts still arrive as OMV with bare YTM titles — the Python bridge
 * upgrades titles from youtube.com oEmbed when cut labels are present there.
 */
export function isYouTubeMusicVideoType(videoType: string | null | undefined): boolean {
  const normalized = String(videoType ?? "").trim().toUpperCase();
  if (!normalized) return true;
  if (normalized.includes("UGC")) return false;
  if (normalized.includes("ATV")) return false;
  return true;
}

export function mapYouTubeMusicVideo(rawValue: unknown, fallbackArtist?: ProviderArtist): ProviderVideo {
  const raw = record(rawValue);
  const videoDetails = record(raw.videoDetails);
  const microformat = microformatRecord(raw);
  const merged = Object.keys(videoDetails).length > 0 || Object.keys(microformat).length > 0
    ? { ...raw, ...microformat, ...videoDetails }
    : raw;
  const artists = artistList(merged, fallbackArtist);
  const providerId = text(merged.videoId, merged.id, videoDetails.videoId);
  const probedHeight = maxHeightFromStreamingData(raw);
  return {
    providerId,
    title: text(merged.title, merged.name, videoDetails.title) || "Untitled YouTube video",
    artist: artists[0],
    artists,
    duration: durationSeconds(merged) || durationSeconds(videoDetails) || null,
    releaseDate: releaseDate(merged) || releaseDate(microformat),
    cover: youtubeStillUrl(providerId) || imageFrom(merged, providerId) || imageFrom(videoDetails, providerId),
    // Prefer Innertube streamingData height (catalog); never invent TIDAL MP4_*.
    quality: youtubeVideoQualityTagFromHeight(probedHeight),
    explicit: typeof merged.isExplicit === "boolean" ? merged.isExplicit : null,
    url: providerId ? `https://www.youtube.com/watch?v=${encodeURIComponent(providerId)}` : undefined,
    videoType: text(merged.videoType, merged.musicVideoType, videoDetails.musicVideoType) || null,
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
  discoveryPlaylists?: unknown[];
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
        .filter((video) => Boolean(video.providerId) && isYouTubeMusicVideoType(video.videoType)),
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
      .filter((video) => Boolean(video.providerId) && isYouTubeMusicVideoType(video.videoType));
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
    const tracks = records(rawAlbum.tracks)
      .map((track, index) => mapYouTubeMusicTrack(track, {
        album,
        fallbackArtist: album.artist,
        index: index + 1,
      }))
      .filter((track) => Boolean(track.providerId));
    return this.enrichAlbumTrackCounterparts(tracks);
  }

  /**
   * Resolve YouTube Music ATV→OMV counterparts (UI audio/video switcher) via
   * get_watch_playlist. Also keeps album tracks that are already OMV (no
   * separate counterpart id) so refresh can persist a video offer. Capped so
   * album refresh cannot issue unbounded calls.
   */
  async enrichAlbumTrackCounterparts(tracks: ProviderTrack[]): Promise<ProviderTrack[]> {
    const missingIds = [...new Set(
      tracks
        .filter((track) => Boolean(track.providerId) && !track.counterpartVideoId)
        .map((track) => String(track.providerId)),
    )];
    if (missingIds.length === 0) {
      return tracks;
    }

    let counterparts: Record<string, unknown> = {};
    try {
      const response = await this.bridge.request<{ counterparts?: Record<string, unknown> }>(
        "get_track_counterparts",
        { ids: missingIds },
      );
      counterparts = record(response?.counterparts);
    } catch (error) {
      console.warn("[YouTubeMusicCatalog] counterpart enrich failed:", error);
      return tracks;
    }

    return tracks.map((track) => {
      if (track.counterpartVideoId || !track.providerId) {
        return track;
      }
      const counterpart = record(counterparts[track.providerId]);
      const counterpartVideoId = text(counterpart.videoId);
      if (!counterpartVideoId) {
        return track;
      }
      // Separate ATV→OMV id, or self-OMV (album track is already the music video).
      return { ...track, counterpartVideoId };
    });
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

  async getLyrics(id: string | number): Promise<ProviderLyrics | null> {
    const raw = await this.bridge.request<unknown>("get_lyrics", { id: String(id) });
    const lyrics = record(raw);
    const textValue = text(lyrics.text);
    const subtitles = text(lyrics.subtitles);
    if (!textValue && !subtitles) return null;
    return {
      text: textValue,
      subtitles,
      provider: text(lyrics.provider) || "YouTube Music",
      raw,
    };
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
    const discovery = (payload.discoveryPlaylists || []).map((rawValue) => {
      const raw = record(rawValue);
      return {
        id: text(raw.playlistId, raw.id, raw.browseId),
        title: text(raw.title, raw.name) || "Discovery playlist",
        subtitle: nullableText(raw.author, raw.description),
        image: imageFrom(raw),
        itemCount: numeric(raw.count ?? raw.trackCount),
      };
    }).filter((playlist) => playlist.id);
    if (discovery.length > 0) {
      result.push({
        category: "mix",
        label: "Mixed for you",
        description: "Artists from a personalized YouTube Music home-screen playlist",
        requiresListSelection: true,
        lists: discovery,
      });
    }
    return result;
  }

  async getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    if ((selection.category === "playlist" || selection.category === "mix") && !selection.listId) {
      throw new Error("A YouTube Music playlist must be selected.");
    }
    if (!["library-artists", "favorite-tracks", "playlist", "mix"].includes(selection.category)) {
      throw new Error(`Unsupported YouTube Music import source: ${selection.category}`);
    }
    // Library/liked imports need browser cookies. Fail before the Python bridge
    // so missing auth never surfaces as a ytmusicapi KeyError dump.
    if (selection.category === "library-artists" || selection.category === "favorite-tracks") {
      const state = getYouTubeMusicCredentialState();
      if (!state.browserHeadersConfigured) {
        throw new Error(YOUTUBE_MUSIC_AUTH_REQUIRED_MESSAGE);
      }
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
