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
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  library_slot?: string | null;
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
  preview_provider?: string | null;
  preview_provider_track_id?: string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  qualityTags?: string[];
  artist_name?: string;
  artist_credits?: Array<{ id: string; name: string; join_phrase: string }>;
  album_title?: string;
  musicbrainz_track_id?: string | null;
  musicbrainz_recording_id?: string | null;
  musicbrainz_release_id?: string | null;
  downloaded: boolean;
  is_downloaded: boolean;
  is_monitored: boolean;
  monitored_lock: boolean;
  explicit?: boolean;
  album_id?: string | null;
  files: LibraryFileContract[];
}

export interface SimilarAlbumContract {
  id: string;
  title: string;
  cover_id?: string | null;
  provider_cover_id?: string | null;
  artist_name?: string;
  release_date?: string | null;
  popularity?: number;
  quality?: string | null;
  explicit?: boolean;
  is_monitored?: boolean;
}

export interface AlbumVersionContract extends SimilarAlbumContract {
  version?: string | null;
  stereo_provider_id?: string | null;
  stereo_quality?: string | null;
  spatial_provider_id?: string | null;
  spatial_quality?: string | null;
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
  monitored_lock: boolean;
  downloaded: boolean;
  is_downloaded: boolean;
}

export interface VideoUpdateContract {
  monitored?: boolean;
  monitored_lock?: boolean;
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
    canonical_artist_mbid: expectNullableString(record.canonical_artist_mbid, `${indexLabel}.canonical_artist_mbid`),
    canonical_release_group_mbid: expectNullableString(record.canonical_release_group_mbid, `${indexLabel}.canonical_release_group_mbid`),
    canonical_release_mbid: expectNullableString(record.canonical_release_mbid, `${indexLabel}.canonical_release_mbid`),
    canonical_track_mbid: expectNullableString(record.canonical_track_mbid, `${indexLabel}.canonical_track_mbid`),
    canonical_recording_mbid: expectNullableString(record.canonical_recording_mbid, `${indexLabel}.canonical_recording_mbid`),
    provider: expectNullableString(record.provider, `${indexLabel}.provider`),
    provider_entity_type: expectNullableString(record.provider_entity_type, `${indexLabel}.provider_entity_type`),
    provider_id: expectNullableString(record.provider_id, `${indexLabel}.provider_id`),
    library_slot: expectNullableString(record.library_slot, `${indexLabel}.library_slot`),
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
    preview_provider: expectOptionalString(record.preview_provider, `${label}.preview_provider`) ?? null,
    preview_provider_track_id: expectOptionalString(record.preview_provider_track_id, `${label}.preview_provider_track_id`) ?? null,
    title: expectString(record.title, `${label}.title`),
    version: expectNullableString(record.version, `${label}.version`),
    duration: expectNumber(record.duration, `${label}.duration`),
    track_number: expectNumber(record.track_number, `${label}.track_number`),
    volume_number: expectNumber(record.volume_number, `${label}.volume_number`),
    quality: expectString(record.quality, `${label}.quality`),
    qualityTags: record.qualityTags === undefined
      ? undefined
      : expectArray(record.qualityTags, `${label}.qualityTags`, (quality, qualityIndex) =>
          expectString(quality, `${label}.qualityTags[${qualityIndex}]`)),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    artist_credits: record.artist_credits === undefined
      ? undefined
      : expectArray(record.artist_credits, `${label}.artist_credits`, (credit, creditIndex) => {
          const creditRecord = expectRecord(credit, `${label}.artist_credits[${creditIndex}]`);
          return {
            id: expectString(creditRecord.id, `${label}.artist_credits[${creditIndex}].id`),
            name: expectString(creditRecord.name, `${label}.artist_credits[${creditIndex}].name`),
            join_phrase: expectString(creditRecord.join_phrase, `${label}.artist_credits[${creditIndex}].join_phrase`),
          };
        }),
    album_title: expectOptionalString(record.album_title, `${label}.album_title`),
    musicbrainz_track_id: expectOptionalString(record.musicbrainz_track_id, `${label}.musicbrainz_track_id`) ?? null,
    musicbrainz_recording_id: expectOptionalString(record.musicbrainz_recording_id, `${label}.musicbrainz_recording_id`) ?? null,
    musicbrainz_release_id: expectOptionalString(record.musicbrainz_release_id, `${label}.musicbrainz_release_id`) ?? null,
    downloaded: expectBoolean(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    monitored_lock: expectOptionalBoolean(record.monitored_lock, `${label}.monitored_lock`) ?? false,
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
    provider_cover_id: expectNullableString(record.provider_cover_id, `${label}.provider_cover_id`),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    popularity: expectOptionalNumber(record.popularity, `${label}.popularity`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    is_monitored: expectOptionalBoolean(record.is_monitored, `${label}.is_monitored`),
    version: expectNullableString(record.version, `${label}.version`),
    stereo_provider_id: expectOptionalString(record.stereo_provider_id, `${label}.stereo_provider_id`) ?? null,
    stereo_quality: expectOptionalString(record.stereo_quality, `${label}.stereo_quality`) ?? null,
    spatial_provider_id: expectOptionalString(record.spatial_provider_id, `${label}.spatial_provider_id`) ?? null,
    spatial_quality: expectOptionalString(record.spatial_quality, `${label}.spatial_quality`) ?? null,
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
    monitored_lock: expectOptionalBoolean(record.monitored_lock, "video.monitored_lock") ?? false,
    downloaded: expectBoolean(record.downloaded, "video.downloaded"),
    is_downloaded: expectBoolean(record.is_downloaded, "video.is_downloaded"),
  };
}
