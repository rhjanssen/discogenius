import {
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectOptionalBoolean,
  expectOptionalNumber,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";

export interface LibraryFileContract {
  id: number;
  artist_id?: string | null;
  album_id?: string | null;
  media_id?: string | null;
  file_type: string;
  file_path: string;
  relative_path?: string;
  filename?: string;
  extension?: string;
  quality?: string | null;
  library_root?: string;
  file_size?: number;
  bitrate?: number;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  codec?: string;
  duration?: number;
  qualityTarget?: string | null;
  qualityChangeWanted?: boolean;
  qualityChangeDirection?: string;
  qualityCutoffNotMet?: boolean;
  qualityChangeReason?: string | null;
}

export interface LibraryFilesListResponseContract {
  items: LibraryFileContract[];
  limit: number;
  offset: number;
}

export interface AlbumTrackContract {
  id: string;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  artist_name?: string;
  album_title?: string;
  downloaded: boolean;
  is_downloaded: boolean;
  is_monitored: boolean;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  monitor_locked?: boolean;
  explicit?: boolean;
  album_id?: string | null;
  files: LibraryFileContract[];
}

export interface SimilarAlbumContract {
  id: string;
  title: string;
  cover_id?: string | null;
  artist_name?: string;
  release_date?: string | null;
  popularity?: number;
  quality?: string | null;
  explicit?: boolean;
  is_monitored?: boolean;
}

export interface AlbumVersionContract extends SimilarAlbumContract {
  version?: string | null;
}

export interface VideoDetailContract {
  id: string;
  title: string;
  duration: number;
  artist_id: string;
  artist_name?: string;
  release_date?: string | null;
  version?: string | null;
  explicit?: boolean;
  quality?: string | null;
  cover?: string | null;
  cover_id?: string | null;
  is_monitored: boolean;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  monitor_locked?: boolean;
  downloaded: boolean;
  is_downloaded: boolean;
}

export interface VideoUpdateContract {
  monitored?: boolean;
  monitor_lock?: boolean;
}

function parseLibraryFileContract(value: unknown, indexLabel: string): LibraryFileContract {
  const record = expectRecord(value, indexLabel);
  const artistId = record.artist_id;
  const albumId = record.album_id;
  const mediaId = record.media_id;

  return {
    id: expectNumber(record.id, `${indexLabel}.id`),
    artist_id: artistId === undefined ? undefined : artistId === null ? null : String(artistId),
    album_id: albumId === undefined ? undefined : albumId === null ? null : String(albumId),
    media_id: mediaId === undefined ? undefined : mediaId === null ? null : String(mediaId),
    file_type: expectString(record.file_type, `${indexLabel}.file_type`),
    file_path: expectString(record.file_path, `${indexLabel}.file_path`),
    relative_path: expectOptionalString(record.relative_path, `${indexLabel}.relative_path`),
    filename: expectOptionalString(record.filename, `${indexLabel}.filename`),
    extension: expectOptionalString(record.extension, `${indexLabel}.extension`),
    quality: expectNullableString(record.quality, `${indexLabel}.quality`),
    library_root: expectOptionalString(record.library_root, `${indexLabel}.library_root`),
    file_size: expectOptionalNumber(record.file_size, `${indexLabel}.file_size`),
    bitrate: expectOptionalNumber(record.bitrate, `${indexLabel}.bitrate`),
    sample_rate: expectOptionalNumber(record.sample_rate, `${indexLabel}.sample_rate`),
    bit_depth: expectOptionalNumber(record.bit_depth, `${indexLabel}.bit_depth`),
    channels: expectOptionalNumber(record.channels, `${indexLabel}.channels`),
    codec: expectOptionalString(record.codec, `${indexLabel}.codec`),
    duration: expectOptionalNumber(record.duration, `${indexLabel}.duration`),
    qualityTarget: expectNullableString(record.qualityTarget, `${indexLabel}.qualityTarget`),
    qualityChangeWanted: expectOptionalBoolean(record.qualityChangeWanted, `${indexLabel}.qualityChangeWanted`),
    qualityChangeDirection: expectOptionalString(record.qualityChangeDirection, `${indexLabel}.qualityChangeDirection`),
    qualityCutoffNotMet: expectOptionalBoolean(record.qualityCutoffNotMet, `${indexLabel}.qualityCutoffNotMet`),
    qualityChangeReason: expectNullableString(record.qualityChangeReason, `${indexLabel}.qualityChangeReason`),
  };
}

export function parseLibraryFilesListResponseContract(value: unknown): LibraryFilesListResponseContract {
  const record = expectRecord(value, "Library files response");
  return {
    items: expectArray(record.items, "libraryFiles.items", (item, index) =>
      parseLibraryFileContract(item, `libraryFiles.items[${index}]`)),
    limit: expectNumber(record.limit, "libraryFiles.limit"),
    offset: expectNumber(record.offset, "libraryFiles.offset"),
  };
}

function parseAlbumTrackContract(value: unknown, index: number): AlbumTrackContract {
  const label = `albumTracks[${index}]`;
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    version: expectNullableString(record.version, `${label}.version`),
    duration: expectNumber(record.duration, `${label}.duration`),
    track_number: expectNumber(record.track_number, `${label}.track_number`),
    volume_number: expectNumber(record.volume_number, `${label}.volume_number`),
    quality: expectString(record.quality, `${label}.quality`),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    album_title: expectOptionalString(record.album_title, `${label}.album_title`),
    downloaded: expectBoolean(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    monitor: record.monitor as boolean | number | undefined,
    monitor_lock: record.monitor_lock as boolean | number | undefined,
    monitor_locked: expectOptionalBoolean(record.monitor_locked, `${label}.monitor_locked`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    album_id: expectNullableString(record.album_id, `${label}.album_id`),
    files: expectArray(record.files, `${label}.files`, (item, fileIndex) =>
      parseLibraryFileContract(item, `${label}.files[${fileIndex}]`)),
  };
}

export function parseAlbumTracksContract(value: unknown): AlbumTrackContract[] {
  return expectArray(value, "Album tracks", parseAlbumTrackContract);
}

function parseAlbumListItemContract<T extends SimilarAlbumContract | AlbumVersionContract>(
  value: unknown,
  index: number,
): T {
  const label = `albumList[${index}]`;
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    cover_id: expectNullableString(record.cover_id, `${label}.cover_id`),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    popularity: expectOptionalNumber(record.popularity, `${label}.popularity`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    is_monitored: expectOptionalBoolean(record.is_monitored, `${label}.is_monitored`),
    version: expectNullableString(record.version, `${label}.version`),
  } as T;
}

export function parseSimilarAlbumsContract(value: unknown): SimilarAlbumContract[] {
  return expectArray(value, "Similar albums", (item, index) => parseAlbumListItemContract<SimilarAlbumContract>(item, index));
}

export function parseAlbumVersionsContract(value: unknown): AlbumVersionContract[] {
  return expectArray(value, "Album versions", (item, index) => parseAlbumListItemContract<AlbumVersionContract>(item, index));
}

export function parseVideoDetailContract(value: unknown): VideoDetailContract {
  const record = expectRecord(value, "Video detail");
  return {
    id: expectString(record.id, "video.id"),
    title: expectString(record.title, "video.title"),
    duration: expectNumber(record.duration, "video.duration"),
    artist_id: expectString(record.artist_id, "video.artist_id"),
    artist_name: expectOptionalString(record.artist_name, "video.artist_name"),
    release_date: expectNullableString(record.release_date, "video.release_date"),
    version: expectNullableString(record.version, "video.version"),
    explicit: expectOptionalBoolean(record.explicit, "video.explicit"),
    quality: expectNullableString(record.quality, "video.quality"),
    cover: expectNullableString(record.cover, "video.cover"),
    cover_id: expectNullableString(record.cover_id, "video.cover_id"),
    is_monitored: expectBoolean(record.is_monitored, "video.is_monitored"),
    monitor: record.monitor as boolean | number | undefined,
    monitor_lock: record.monitor_lock as boolean | number | undefined,
    monitor_locked: expectOptionalBoolean(record.monitor_locked, "video.monitor_locked"),
    downloaded: expectBoolean(record.downloaded, "video.downloaded"),
    is_downloaded: expectBoolean(record.is_downloaded, "video.is_downloaded"),
  };
}
