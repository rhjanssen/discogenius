import type {
  AccountConfigContract,
  FilteringConfigContract,
  MetadataConfigContract,
  MonitoringConfigContract,
  NamingConfigContract,
  PathConfigContract,
  PublicAppConfigContract,
  QualityConfigContract,
} from "./config.js";
import {
  parseAccountConfigContract,
  parseFilteringConfigContract,
  parseMetadataConfigContract,
  parseMonitoringConfigContract,
  parseNamingConfigContract,
  parsePathConfigContract,
  parsePublicAppConfigContract,
  parseQualityConfigContract,
} from "./config.js";
import { expectRecord } from "./runtime.js";
import { RequestValidationError } from "../utils/request-validation.js";

const ACCOUNT_UPDATE_KEYS = [
  "userId",
  "username",
  "firstName",
  "lastName",
  "fullName",
  "email",
  "countryCode",
  "picture",
] as const satisfies readonly (keyof AccountConfigContract)[];

const APP_UPDATE_KEYS = [
  "acoustid_api_key",
] as const satisfies readonly (keyof PublicAppConfigContract)[];

const QUALITY_UPDATE_KEYS = [
  "audio_quality",
  "video_quality",
  "embed_cover",
  "embed_lyrics",
  "embed_synced_lyrics",
  "upgrade_existing_files",
  "convert_video_mp4",
  "download_dolby_atmos",
  "extract_flac",
] as const satisfies readonly (keyof QualityConfigContract)[];

const METADATA_UPDATE_KEYS = [
  "save_album_cover",
  "album_cover_name",
  "album_cover_resolution",
  "save_artist_picture",
  "artist_picture_name",
  "artist_picture_resolution",
  "save_video_thumbnail",
  "embed_video_thumbnail",
  "video_thumbnail_resolution",
  "save_lyrics",
  "save_nfo",
  "embed_album_review",
  "enable_fingerprinting",
  "write_tidal_url",
  "mark_explicit",
  "upc_target",
  "write_audio_metadata",
  "embed_replaygain",
] as const satisfies readonly (keyof MetadataConfigContract)[];

const PATH_UPDATE_KEYS = [
  "music_path",
  "atmos_path",
  "video_path",
] as const satisfies readonly (keyof PathConfigContract)[];

const NAMING_UPDATE_KEYS = [
  "artist_folder",
  "album_track_path_single",
  "album_track_path_multi",
  "video_file",
] as const satisfies readonly (keyof NamingConfigContract)[];

const FILTERING_UPDATE_KEYS = [
  "include_album",
  "include_single",
  "include_ep",
  "include_compilation",
  "include_soundtrack",
  "include_live",
  "include_remix",
  "include_appears_on",
  "include_atmos",
  "include_videos",
  "prefer_explicit",
  "enable_redundancy_filter",
] as const satisfies readonly (keyof FilteringConfigContract)[];

const MONITORING_UPDATE_KEYS = [
  "enabled",
  "scanIntervalHours",
  "startHour",
  "durationHours",
  "monitorNewArtists",
  "removeUnmonitoredFiles",
  "artistRefreshDays",
  "albumRefreshDays",
  "trackRefreshDays",
  "videoRefreshDays",
] as const satisfies readonly (keyof MonitoringConfigContract)[];

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function ensureAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const unsupported = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unsupported.length > 0) {
    throw new RequestValidationError(
      `${label} contains unsupported field${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
    );
  }
}

function parsePartialUpdate<T extends object, K extends keyof T>(
  value: unknown,
  current: T,
  allowedKeys: readonly K[],
  parser: (value: unknown) => T,
  label: string,
): Partial<T> {
  let record: Record<string, unknown>;

  try {
    record = expectRecord(value, label);
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : `${label} must be a JSON object`);
  }

  ensureAllowedKeys(record, allowedKeys as readonly string[], label);

  const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const key of allowedKeys) {
    if (hasOwn(record, key as string)) {
      merged[key as string] = record[key as string];
    }
  }

  let parsed: T;
  try {
    parsed = parser(merged);
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : `${label} is invalid`);
  }

  const updates: Partial<T> = {};
  for (const key of allowedKeys) {
    if (hasOwn(record, key as string)) {
      updates[key] = parsed[key];
    }
  }

  return updates;
}

export function parseAccountConfigUpdate(
  value: unknown,
  current: AccountConfigContract,
): Partial<AccountConfigContract> {
  return parsePartialUpdate(value, current, ACCOUNT_UPDATE_KEYS, parseAccountConfigContract, "Account config update");
}

export function parsePublicAppConfigUpdate(
  value: unknown,
  current: PublicAppConfigContract,
): Partial<PublicAppConfigContract> {
  const record = expectRecord(value, "App config update");
  ensureAllowedKeys(record, APP_UPDATE_KEYS, "App config update");

  const normalizedValue = {
    ...record,
    acoustid_api_key: hasOwn(record, "acoustid_api_key")
      ? record.acoustid_api_key === null || record.acoustid_api_key === undefined
        ? undefined
        : typeof record.acoustid_api_key === "string"
          ? record.acoustid_api_key.trim() || undefined
          : record.acoustid_api_key
      : undefined,
  };

  return parsePartialUpdate(normalizedValue, current, APP_UPDATE_KEYS, parsePublicAppConfigContract, "App config update");
}

export function parseQualityConfigUpdate(
  value: unknown,
  current: QualityConfigContract,
): Partial<QualityConfigContract> {
  return parsePartialUpdate(value, current, QUALITY_UPDATE_KEYS, parseQualityConfigContract, "Quality config update");
}

export function parseMetadataConfigUpdate(
  value: unknown,
  current: MetadataConfigContract,
): Partial<MetadataConfigContract> {
  return parsePartialUpdate(value, current, METADATA_UPDATE_KEYS, parseMetadataConfigContract, "Metadata config update");
}

export function parsePathConfigUpdate(
  value: unknown,
  current: PathConfigContract,
): Partial<PathConfigContract> {
  return parsePartialUpdate(value, current, PATH_UPDATE_KEYS, parsePathConfigContract, "Path config update");
}

export function parseNamingConfigUpdate(
  value: unknown,
  current: NamingConfigContract,
): Partial<NamingConfigContract> {
  return parsePartialUpdate(value, current, NAMING_UPDATE_KEYS, parseNamingConfigContract, "Naming config update");
}

export function parseFilteringConfigUpdate(
  value: unknown,
  current: FilteringConfigContract,
): Partial<FilteringConfigContract> {
  return parsePartialUpdate(value, current, FILTERING_UPDATE_KEYS, parseFilteringConfigContract, "Curation config update");
}

export function parseMonitoringConfigUpdate(
  value: unknown,
  current: MonitoringConfigContract,
): Partial<MonitoringConfigContract> {
  return parsePartialUpdate(value, current, MONITORING_UPDATE_KEYS, parseMonitoringConfigContract, "Monitoring config update");
}
