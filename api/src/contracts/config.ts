import {
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectOneOf,
  expectOptionalBoolean,
  expectOptionalNumber,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";

export const AUDIO_QUALITY_VALUES = ["low", "normal", "high", "max"] as const;
export type AudioQualityValue = (typeof AUDIO_QUALITY_VALUES)[number];

export const VIDEO_QUALITY_VALUES = ["sd", "hd", "fhd"] as const;
export type VideoQualityValue = (typeof VIDEO_QUALITY_VALUES)[number];

export const UPC_TARGET_VALUES = ["UPC", "EAN", "BARCODE"] as const;
export type UpcTargetValue = (typeof UPC_TARGET_VALUES)[number];

export const VIDEO_THUMBNAIL_RESOLUTION_VALUES = [
  "origin",
  "640x360",
  "1280x720",
  "160x107",
  "480x320",
  "750x500",
  "1080x720",
] as const;
export type VideoThumbnailResolutionValue = (typeof VIDEO_THUMBNAIL_RESOLUTION_VALUES)[number];

export interface PublicAppConfigContract {
  acoustid_api_key?: string;
}

export interface AccountConfigContract {
  userId?: number;
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string;
  countryCode?: string;
  picture?: string | null;
}

export interface QualityConfigContract {
  audio_quality: AudioQualityValue;
  video_quality: VideoQualityValue;
  embed_cover: boolean;
  embed_lyrics: boolean;
  embed_synced_lyrics?: boolean;
  upgrade_existing_files: boolean;
  convert_video_mp4?: boolean;
  download_dolby_atmos?: boolean;
  extract_flac?: boolean;
}

export interface MetadataConfigContract {
  save_album_cover: boolean;
  album_cover_name: string;
  album_cover_resolution: "origin" | number;
  save_artist_picture: boolean;
  artist_picture_name: string;
  artist_picture_resolution: number | string;
  save_video_thumbnail: boolean;
  embed_video_thumbnail?: boolean;
  video_thumbnail_resolution: VideoThumbnailResolutionValue;
  save_lyrics: boolean;
  save_album_review: boolean;
  embed_album_review?: boolean;
  save_artist_bio: boolean;
  enable_fingerprinting: boolean;
  write_tidal_url: boolean;
  mark_explicit: boolean;
  upc_target: UpcTargetValue;
  write_audio_metadata?: boolean;
  embed_replaygain?: boolean;
}

export interface PathConfigContract {
  music_path: string;
  atmos_path: string;
  video_path: string;
}

export interface NamingConfigContract {
  artist_folder: string;
  album_track_path_single: string;
  album_track_path_multi: string;
  video_file: string;
}

export interface FilteringConfigContract {
  include_album: boolean;
  include_single: boolean;
  include_ep: boolean;
  include_compilation: boolean;
  include_soundtrack: boolean;
  include_live: boolean;
  include_remix: boolean;
  include_appears_on: boolean;
  include_atmos: boolean;
  include_videos: boolean;
  prefer_explicit: boolean;
  enable_redundancy_filter: boolean;
}

export interface MonitoringConfigContract {
  enabled: boolean;
  scanIntervalHours: number;
  startHour: number;
  durationHours: number;
  monitorNewArtists: boolean;
  removeUnmonitoredFiles: boolean;
  artistRefreshDays: number;
  albumRefreshDays: number;
  trackRefreshDays: number;
  videoRefreshDays: number;
  lastCheckTimestamp?: string;
  checkInProgress?: boolean;
  progressArtistIndex?: number;
}

export interface MonitoringStatusResponseContract {
  running: boolean;
  checking: boolean;
  config: MonitoringConfigContract;
}

export interface MonitoringConfigUpdateResponseContract {
  success: boolean;
  config: MonitoringConfigContract;
}

function expectResolutionOrOrigin(value: unknown, label: string): "origin" | number {
  if (value === "origin") {
    return "origin";
  }

  return expectNumber(value, label);
}

function expectNumberOrString(value: unknown, label: string): number | string {
  if (typeof value === "string") {
    return value;
  }

  return expectNumber(value, label);
}

export function parsePublicAppConfigContract(value: unknown): PublicAppConfigContract {
  const record = expectRecord(value, "App config");
  return {
    acoustid_api_key: expectOptionalString(record.acoustid_api_key, "app.acoustid_api_key"),
  };
}

export function parseAccountConfigContract(value: unknown): AccountConfigContract {
  const record = expectRecord(value, "Account config");
  return {
    userId: expectOptionalNumber(record.userId, "account.userId"),
    username: expectOptionalString(record.username, "account.username"),
    firstName: expectNullableString(record.firstName, "account.firstName"),
    lastName: expectNullableString(record.lastName, "account.lastName"),
    fullName: expectNullableString(record.fullName, "account.fullName"),
    email: expectOptionalString(record.email, "account.email"),
    countryCode: expectOptionalString(record.countryCode, "account.countryCode"),
    picture: expectNullableString(record.picture, "account.picture"),
  };
}

export function parseQualityConfigContract(value: unknown): QualityConfigContract {
  const record = expectRecord(value, "Quality config");
  return {
    audio_quality: expectOneOf(record.audio_quality, AUDIO_QUALITY_VALUES, "quality.audio_quality"),
    video_quality: expectOneOf(record.video_quality, VIDEO_QUALITY_VALUES, "quality.video_quality"),
    embed_cover: expectBoolean(record.embed_cover, "quality.embed_cover"),
    embed_lyrics: expectBoolean(record.embed_lyrics, "quality.embed_lyrics"),
    embed_synced_lyrics: expectOptionalBoolean(record.embed_synced_lyrics, "quality.embed_synced_lyrics"),
    upgrade_existing_files: expectBoolean(record.upgrade_existing_files, "quality.upgrade_existing_files"),
    convert_video_mp4: expectOptionalBoolean(record.convert_video_mp4, "quality.convert_video_mp4"),
    download_dolby_atmos: expectOptionalBoolean(record.download_dolby_atmos, "quality.download_dolby_atmos"),
    extract_flac: expectOptionalBoolean(record.extract_flac, "quality.extract_flac"),
  };
}

export function parseMetadataConfigContract(value: unknown): MetadataConfigContract {
  const record = expectRecord(value, "Metadata config");
  return {
    save_album_cover: expectBoolean(record.save_album_cover, "metadata.save_album_cover"),
    album_cover_name: expectString(record.album_cover_name, "metadata.album_cover_name"),
    album_cover_resolution: expectResolutionOrOrigin(record.album_cover_resolution, "metadata.album_cover_resolution"),
    save_artist_picture: expectBoolean(record.save_artist_picture, "metadata.save_artist_picture"),
    artist_picture_name: expectString(record.artist_picture_name, "metadata.artist_picture_name"),
    artist_picture_resolution: expectNumberOrString(record.artist_picture_resolution, "metadata.artist_picture_resolution"),
    save_video_thumbnail: expectBoolean(record.save_video_thumbnail, "metadata.save_video_thumbnail"),
    embed_video_thumbnail: expectOptionalBoolean(record.embed_video_thumbnail, "metadata.embed_video_thumbnail"),
    video_thumbnail_resolution: expectOneOf(
      record.video_thumbnail_resolution,
      VIDEO_THUMBNAIL_RESOLUTION_VALUES,
      "metadata.video_thumbnail_resolution",
    ),
    save_lyrics: expectBoolean(record.save_lyrics, "metadata.save_lyrics"),
    save_album_review: expectBoolean(record.save_album_review, "metadata.save_album_review"),
    embed_album_review: expectOptionalBoolean(record.embed_album_review, "metadata.embed_album_review"),
    save_artist_bio: expectBoolean(record.save_artist_bio, "metadata.save_artist_bio"),
    enable_fingerprinting: expectBoolean(record.enable_fingerprinting, "metadata.enable_fingerprinting"),
    write_tidal_url: expectBoolean(record.write_tidal_url, "metadata.write_tidal_url"),
    mark_explicit: expectBoolean(record.mark_explicit, "metadata.mark_explicit"),
    upc_target: expectOneOf(record.upc_target, UPC_TARGET_VALUES, "metadata.upc_target"),
    write_audio_metadata: expectOptionalBoolean(record.write_audio_metadata, "metadata.write_audio_metadata"),
    embed_replaygain: expectOptionalBoolean(record.embed_replaygain, "metadata.embed_replaygain"),
  };
}

export function parsePathConfigContract(value: unknown): PathConfigContract {
  const record = expectRecord(value, "Path config");
  return {
    music_path: expectString(record.music_path, "path.music_path"),
    atmos_path: expectString(record.atmos_path, "path.atmos_path"),
    video_path: expectString(record.video_path, "path.video_path"),
  };
}

export function parseNamingConfigContract(value: unknown): NamingConfigContract {
  const record = expectRecord(value, "Naming config");
  return {
    artist_folder: expectString(record.artist_folder, "naming.artist_folder"),
    album_track_path_single: expectString(record.album_track_path_single, "naming.album_track_path_single"),
    album_track_path_multi: expectString(record.album_track_path_multi, "naming.album_track_path_multi"),
    video_file: expectString(record.video_file, "naming.video_file"),
  };
}

export function parseFilteringConfigContract(value: unknown): FilteringConfigContract {
  const record = expectRecord(value, "Curation config");
  return {
    include_album: expectBoolean(record.include_album, "curation.include_album"),
    include_single: expectBoolean(record.include_single, "curation.include_single"),
    include_ep: expectBoolean(record.include_ep, "curation.include_ep"),
    include_compilation: expectBoolean(record.include_compilation, "curation.include_compilation"),
    include_soundtrack: expectBoolean(record.include_soundtrack, "curation.include_soundtrack"),
    include_live: expectBoolean(record.include_live, "curation.include_live"),
    include_remix: expectBoolean(record.include_remix, "curation.include_remix"),
    include_appears_on: expectBoolean(record.include_appears_on, "curation.include_appears_on"),
    include_atmos: expectBoolean(record.include_atmos, "curation.include_atmos"),
    include_videos: expectBoolean(record.include_videos, "curation.include_videos"),
    prefer_explicit: expectBoolean(record.prefer_explicit, "curation.prefer_explicit"),
    enable_redundancy_filter: expectBoolean(record.enable_redundancy_filter, "curation.enable_redundancy_filter"),
  };
}

export function parseMonitoringConfigContract(value: unknown): MonitoringConfigContract {
  const record = expectRecord(value, "Monitoring config");
  return {
    enabled: expectBoolean(record.enabled, "monitoring.enabled"),
    scanIntervalHours: expectNumber(record.scanIntervalHours, "monitoring.scanIntervalHours"),
    startHour: expectNumber(record.startHour, "monitoring.startHour"),
    durationHours: expectNumber(record.durationHours, "monitoring.durationHours"),
    monitorNewArtists: expectBoolean(record.monitorNewArtists, "monitoring.monitorNewArtists"),
    removeUnmonitoredFiles: expectBoolean(record.removeUnmonitoredFiles, "monitoring.removeUnmonitoredFiles"),
    artistRefreshDays: expectNumber(record.artistRefreshDays, "monitoring.artistRefreshDays"),
    albumRefreshDays: expectNumber(record.albumRefreshDays, "monitoring.albumRefreshDays"),
    trackRefreshDays: expectNumber(record.trackRefreshDays, "monitoring.trackRefreshDays"),
    videoRefreshDays: expectNumber(record.videoRefreshDays, "monitoring.videoRefreshDays"),
    lastCheckTimestamp: expectOptionalString(record.lastCheckTimestamp, "monitoring.lastCheckTimestamp"),
    checkInProgress: expectOptionalBoolean(record.checkInProgress, "monitoring.checkInProgress"),
    progressArtistIndex: expectOptionalNumber(record.progressArtistIndex, "monitoring.progressArtistIndex"),
  };
}

export function parseMonitoringStatusResponseContract(value: unknown): MonitoringStatusResponseContract {
  const record = expectRecord(value, "Monitoring status");
  return {
    running: expectBoolean(record.running, "monitoringStatus.running"),
    checking: expectBoolean(record.checking, "monitoringStatus.checking"),
    config: parseMonitoringConfigContract(record.config),
  };
}

export function parseMonitoringConfigUpdateResponseContract(value: unknown): MonitoringConfigUpdateResponseContract {
  const record = expectRecord(value, "Monitoring update response");
  return {
    success: expectBoolean(record.success, "monitoringUpdate.success"),
    config: parseMonitoringConfigContract(record.config),
  };
}


