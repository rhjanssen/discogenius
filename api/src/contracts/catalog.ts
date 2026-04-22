import {
  expectArray,
  expectBoolean,
  expectIdentifierString,
  expectNullableString,
  expectNumber,
  expectOptionalBoolean,
  expectOptionalNumber,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";
import type { LibraryFileContract } from "./media.js";

export interface ArtistContract {
  id: string;
  name: string;
  picture?: string | null;
  cover_image_url?: string | null;
  is_monitored: boolean;
  last_scanned: string | null;
  album_count?: number;
  bio?: string | null;
  biography?: string | null;
  downloaded?: number;
  is_downloaded?: boolean;
}

export interface AlbumContract {
  id: string;
  title: string;
  cover_id?: string | null;
  cover?: string | null;
  cover_art_url?: string | null;
  vibrant_color?: string | null;
  release_date?: string | null;
  type?: string;
  album_type?: string;
  quality?: string | null;
  is_monitored: boolean;
  is_downloaded: boolean;
  downloaded?: number;
  artist_id: string;
  artist_name: string;
  include_in_monitoring?: number;
  excluded_reason?: string | null;
  filtered_out?: number;
  filtered_reason?: string | null;
  redundant_of?: string | null;
  redundant?: string | null;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  monitor_locked?: boolean;
  filter_locked?: number;
  module?: string;
  group_type?: string;
  files?: LibraryFileContract[];
}

export interface VideoContract {
  id: string;
  title: string;
  duration: number;
  release_date?: string | null;
  version?: string | null;
  explicit?: boolean;
  quality?: string | null;
  cover?: string | null;
  cover_id?: string | null;
  cover_art_url?: string | null;
  url?: string | null;
  path?: string | null;
  artist_id: string;
  artist_name?: string;
  is_monitored: boolean;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  monitor_locked?: boolean;
  downloaded?: boolean;
  is_downloaded: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface LibraryStatsBucketContract {
  total: number;
  monitored: number;
  downloaded: number;
}

export interface LibraryStatsFilesContract {
  total: number;
  totalSizeBytes: number;
}

export interface LibraryStatsContract {
  artists: LibraryStatsBucketContract;
  albums: LibraryStatsBucketContract;
  tracks: LibraryStatsBucketContract;
  videos: LibraryStatsBucketContract;
  files?: LibraryStatsFilesContract;
}

export interface PaginatedListResponseContract<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SearchResultContract {
  id: string;
  name: string;
  type: "artist" | "album" | "track" | "video";
  subtitle?: string | null;
  imageId?: string | null;
  monitored: boolean;
  in_library: boolean;
  quality?: string | null;
  explicit?: boolean;
  duration?: number;
  release_date?: string | null;
}

export interface SearchResultsContract {
  artists: SearchResultContract[];
  albums: SearchResultContract[];
  tracks: SearchResultContract[];
  videos: SearchResultContract[];
}

export interface SearchResponseContract {
  success: boolean;
  results: SearchResultsContract;
  mode: "live" | "mock" | "disconnected";
  remoteCatalogAvailable: boolean;
}

export type ArtistsListResponseContract = PaginatedListResponseContract<ArtistContract>;
export type AlbumsListResponseContract = PaginatedListResponseContract<AlbumContract>;
export type VideosListResponseContract = PaginatedListResponseContract<VideoContract>;

function parseArtistContract(value: unknown, index: number): ArtistContract {
  const label = `artists[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectIdentifierString(record.id, `${label}.id`),
    name: expectString(record.name, `${label}.name`),
    picture: expectNullableString(record.picture, `${label}.picture`),
    cover_image_url: expectNullableString(record.cover_image_url, `${label}.cover_image_url`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    last_scanned: expectNullableString(record.last_scanned, `${label}.last_scanned`) ?? null,
    album_count: expectOptionalNumber(record.album_count, `${label}.album_count`),
    bio: expectNullableString(record.bio, `${label}.bio`),
    biography: expectNullableString(record.biography, `${label}.biography`),
    downloaded: expectOptionalNumber(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectOptionalBoolean(record.is_downloaded, `${label}.is_downloaded`),
  };
}

export function parseAlbumContract(value: unknown, index: number): AlbumContract {
  const label = `albums[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectIdentifierString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    cover_id: expectNullableString(record.cover_id, `${label}.cover_id`),
    cover: expectNullableString(record.cover, `${label}.cover`),
    cover_art_url: expectNullableString(record.cover_art_url, `${label}.cover_art_url`),
    vibrant_color: expectNullableString(record.vibrant_color, `${label}.vibrant_color`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    type: expectOptionalString(record.type, `${label}.type`),
    album_type: expectOptionalString(record.album_type, `${label}.album_type`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    downloaded: expectOptionalNumber(record.downloaded, `${label}.downloaded`),
    artist_id: expectIdentifierString(record.artist_id, `${label}.artist_id`),
    artist_name: expectString(record.artist_name, `${label}.artist_name`),
    include_in_monitoring: expectOptionalNumber(record.include_in_monitoring, `${label}.include_in_monitoring`),
    excluded_reason: expectNullableString(record.excluded_reason, `${label}.excluded_reason`),
    filtered_out: expectOptionalNumber(record.filtered_out, `${label}.filtered_out`),
    filtered_reason: expectNullableString(record.filtered_reason, `${label}.filtered_reason`),
    redundant_of: expectNullableString(record.redundant_of, `${label}.redundant_of`),
    redundant: expectNullableString(record.redundant, `${label}.redundant`),
    monitor: record.monitor as boolean | number | undefined,
    monitor_lock: record.monitor_lock as boolean | number | undefined,
    monitor_locked: expectOptionalBoolean(record.monitor_locked, `${label}.monitor_locked`),
    filter_locked: expectOptionalNumber(record.filter_locked, `${label}.filter_locked`),
    module: expectOptionalString(record.module, `${label}.module`),
    group_type: expectOptionalString(record.group_type, `${label}.group_type`),
  };
}

function parseVideoContract(value: unknown, index: number): VideoContract {
  const label = `videos[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectIdentifierString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    duration: expectNumber(record.duration, `${label}.duration`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    version: expectNullableString(record.version, `${label}.version`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    cover: expectNullableString(record.cover, `${label}.cover`),
    cover_id: expectNullableString(record.cover_id, `${label}.cover_id`),
    cover_art_url: expectNullableString(record.cover_art_url, `${label}.cover_art_url`),
    url: expectNullableString(record.url, `${label}.url`),
    path: expectNullableString(record.path, `${label}.path`),
    artist_id: expectIdentifierString(record.artist_id, `${label}.artist_id`),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    monitor: record.monitor as boolean | number | undefined,
    monitor_lock: record.monitor_lock as boolean | number | undefined,
    monitor_locked: expectOptionalBoolean(record.monitor_locked, `${label}.monitor_locked`),
    downloaded: expectOptionalBoolean(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    created_at: expectOptionalString(record.created_at, `${label}.created_at`),
    updated_at: expectOptionalString(record.updated_at, `${label}.updated_at`),
  };
}

function parsePaginatedListResponseContract<T>(
  value: unknown,
  label: string,
  parseItem: (item: unknown, index: number) => T,
): PaginatedListResponseContract<T> {
  const record = expectRecord(value, label);
  return {
    items: expectArray(record.items, `${label}.items`, parseItem),
    total: expectNumber(record.total, `${label}.total`),
    limit: expectNumber(record.limit, `${label}.limit`),
    offset: expectNumber(record.offset, `${label}.offset`),
    hasMore: expectBoolean(record.hasMore, `${label}.hasMore`),
  };
}

function parseLibraryStatsBucketContract(value: unknown, label: string): LibraryStatsBucketContract {
  const record = expectRecord(value, label);
  return {
    total: expectNumber(record.total, `${label}.total`),
    monitored: expectNumber(record.monitored, `${label}.monitored`),
    downloaded: expectNumber(record.downloaded, `${label}.downloaded`),
  };
}

function parseLibraryStatsFilesContract(value: unknown, label: string): LibraryStatsFilesContract {
  const record = expectRecord(value, label);
  return {
    total: expectNumber(record.total, `${label}.total`),
    totalSizeBytes: expectNumber(record.totalSizeBytes, `${label}.totalSizeBytes`),
  };
}

function parseSearchResultContract(value: unknown, index: number, bucket: keyof SearchResultsContract): SearchResultContract {
  const label = `search.results.${bucket}[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectIdentifierString(record.id, `${label}.id`),
    name: expectString(record.name, `${label}.name`),
    type: record.type === "artist" || record.type === "album" || record.type === "track" || record.type === "video"
      ? record.type
      : (() => {
        throw new Error(`${label}.type must be one of: artist, album, track, video`);
      })(),
    subtitle: expectNullableString(record.subtitle, `${label}.subtitle`),
    imageId: expectNullableString(record.imageId, `${label}.imageId`),
    monitored: expectBoolean(record.monitored, `${label}.monitored`),
    in_library: expectBoolean(record.in_library, `${label}.in_library`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    duration: expectOptionalNumber(record.duration, `${label}.duration`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
  };
}

export function parseArtistsListResponseContract(value: unknown): ArtistsListResponseContract {
  return parsePaginatedListResponseContract(value, "artists", parseArtistContract);
}

export function parseAlbumsListResponseContract(value: unknown): AlbumsListResponseContract {
  return parsePaginatedListResponseContract(value, "albums", parseAlbumContract);
}

export function parseVideosListResponseContract(value: unknown): VideosListResponseContract {
  return parsePaginatedListResponseContract(value, "videos", parseVideoContract);
}

export function parseLibraryStatsContract(value: unknown): LibraryStatsContract {
  const record = expectRecord(value, "libraryStats");
  return {
    artists: parseLibraryStatsBucketContract(record.artists, "libraryStats.artists"),
    albums: parseLibraryStatsBucketContract(record.albums, "libraryStats.albums"),
    tracks: parseLibraryStatsBucketContract(record.tracks, "libraryStats.tracks"),
    videos: parseLibraryStatsBucketContract(record.videos, "libraryStats.videos"),
    files: record.files === undefined ? undefined : parseLibraryStatsFilesContract(record.files, "libraryStats.files"),
  };
}

export function parseSearchResponseContract(value: unknown): SearchResponseContract {
  const record = expectRecord(value, "search");
  const results = expectRecord(record.results, "search.results");
  const mode = expectString(record.mode, "search.mode");

  if (mode !== "live" && mode !== "mock" && mode !== "disconnected") {
    throw new Error("search.mode must be one of: live, mock, disconnected");
  }

  return {
    success: expectBoolean(record.success, "search.success"),
    results: {
      artists: expectArray(results.artists, "search.results.artists", (item, index) =>
        parseSearchResultContract(item, index, "artists")),
      albums: expectArray(results.albums, "search.results.albums", (item, index) =>
        parseSearchResultContract(item, index, "albums")),
      tracks: expectArray(results.tracks, "search.results.tracks", (item, index) =>
        parseSearchResultContract(item, index, "tracks")),
      videos: expectArray(results.videos, "search.results.videos", (item, index) =>
        parseSearchResultContract(item, index, "videos")),
    },
    mode,
    remoteCatalogAvailable: expectBoolean(record.remoteCatalogAvailable, "search.remoteCatalogAvailable"),
  };
}

export {
  parseArtistContract,
  parseSearchResultContract,
  parseVideoContract,
};
