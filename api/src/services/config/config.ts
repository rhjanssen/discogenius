import { db, runWithSqliteBusyRetry } from "../../database.js";
import path from "path";
import { REPO_ROOT, CONFIG_DIR, APP_DATA_DIR } from "./bootstrap.js";
export { REPO_ROOT, CONFIG_DIR, APP_DATA_DIR };
import { normalizeMbHost } from "../catalog/mb-connection.js";

export interface AppConfig {
  admin_password: string;
  acoustid_api_key?: string; // Optional AcoustID Client API Key
}

export interface MonitoringConfig {
  enable_active_monitoring: boolean;   // Enable scheduled monitoring checks
  monitor_new_artists: boolean;        // Auto-monitor artists discovered during root scans
  remove_unmonitored_files: boolean;   // Remove files for items no longer monitored
}

export interface FilteringConfig {
  // MusicBrainz release-group primary types
  include_album: boolean;              // Primary type: Album
  include_single: boolean;             // Primary type: Single
  include_ep: boolean;                 // Primary type: EP
  include_broadcast: boolean;          // Primary type: Broadcast
  include_other: boolean;              // Primary type: Other (MusicBrainz's own)

  // MusicBrainz release-group secondary types. A Release Group with none at all
  // passes on its primary type alone, so there is no synthetic "Studio" key.
  include_compilation: boolean;        // Secondary type: Compilation
  include_soundtrack: boolean;         // Secondary type: Soundtrack
  include_live: boolean;               // Secondary type: Live
  include_remix: boolean;              // Secondary type: Remix
  include_dj_mix: boolean;             // Secondary type: DJ-mix
  include_mixtape_street: boolean;     // Secondary type: Mixtape/Street
  include_demo: boolean;               // Secondary type: Demo
  // The rest of MusicBrainz's secondary taxonomy.
  include_spokenword: boolean;         // Secondary type: Spokenword
  include_interview: boolean;          // Secondary type: Interview
  include_audiobook: boolean;          // Secondary type: Audiobook
  include_audio_drama: boolean;        // Secondary type: Audio drama
  include_field_recording: boolean;    // Secondary type: Field recording

  /**
   * MusicBrainz release statuses. Edition eligibility for *automatic* curation
   * only — an excluded Edition stays stored, visible, usable as matching
   * evidence, and monitorable by hand.
   */
  include_status_official: boolean;
  include_status_promotion: boolean;
  include_status_bootleg: boolean;
  include_status_pseudo_release: boolean;
  include_status_withdrawn: boolean;
  include_status_cancelled: boolean;
  include_status_expunged: boolean;

  include_spatial: boolean;            // Include spatial/surround release-group slots
  include_videos: boolean;             // Monitor music videos
  /** Official Music Video / OMV (`video` + `official`). Factory default ON. */
  include_video_official: boolean;
  /** Official lyric videos (`lyric`). Factory default OFF. */
  include_video_lyric: boolean;
  /** Live performance videos (`live`). Factory default ON. */
  include_video_live: boolean;
  /**
   * Visualiser cuts + Official Audio / audio-only (`visualizer` + `audio`).
   * Factory default OFF. One Settings toggle covers both catalog classes.
   */
  include_video_visualizer: boolean;
  /**
   * Legacy alias for Official Audio only. Kept for config API compatibility;
   * the UI no longer exposes it. Filter logic prefers `include_video_visualizer`.
   */
  include_video_official_audio: boolean;
  prefer_explicit: boolean;            // Prefer explicit versions over clean
  enable_redundancy_filter: boolean;   // Deduplicate album versions/editions
  require_provider_availability: boolean; // Only mark release groups wanted when a provider offer exists
}

export interface PathConfig {
  music_path: string;
  spatial_path: string;
  video_path: string;
  create_empty_artist_folders?: boolean;
  /** separated | inline (linked when possible) | inline_only (skip orphan/separated downloads) */
  video_folder_layout?: "separated" | "inline" | "inline_only";
}

export interface NamingConfig {
  artist_folder: string;        // Folder name for artists
  album_track_path_single: string; // Relative path (incl. filename stem) for tracks in single-volume albums
  album_track_path_multi: string;  // Relative path (incl. filename stem) for tracks in multi-volume albums
  video_file: string;              // Video filename stem (without extension)
}

/**
 * Controls when audio file tags are written.
 * - "no"        — Never write tags
 * - "new_files" — Only write tags on newly downloaded/imported files
 * - "all_files" — Write tags on all files (existing + new)
 * - "sync"      — New files, and re-tag after a metadata refresh changes catalog columns
 */
export type WriteAudioTagsPolicy = "no" | "new_files" | "all_files" | "sync";

export interface MetadataConfig {
  /** Prefer canonical catalog/CAA artwork or streaming-provider artwork. */
  artwork_preference: "canonical" | "provider";
  save_album_cover: boolean;
  album_cover_name: string;
  album_cover_resolution: "origin" | number;
  save_artist_picture: boolean;
  artist_picture_name: string;
  artist_picture_resolution: number | string;
  save_video_thumbnail: boolean;
  embed_video_thumbnail?: boolean;
  video_thumbnail_resolution: "origin" | "640x360" | "1280x720" | "160x107" | "480x320" | "750x500" | "1080x720";
  save_lyrics: boolean;
  save_nfo: boolean;
  embed_album_review?: boolean;
  enable_fingerprinting: boolean;
  write_tidal_url: boolean;
  mark_explicit: boolean;
  upc_target: "UPC" | "EAN" | "BARCODE";
  embed_replaygain?: boolean;
  /** tag write policy. */
  write_audio_tags_policy?: WriteAudioTagsPolicy;
  /** Remove all existing tags before writing desired ones (scrub existing tags first). */
  scrub_audio_tags?: boolean;
}

export interface AccountConfig {
  userId?: number;
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string;
  countryCode?: string;
  picture?: string | null;
}

export interface QualityConfig {
  audio_quality: "low" | "normal" | "high" | "max";
  video_quality: "sd" | "hd" | "fhd" | "uhd";
  embed_cover: boolean;
  embed_lyrics: boolean;
  upgrade_existing_files: boolean;
  /** When true, lowering preferred quality transcodes existing stereo files down to that class. */
  downconvert_existing_files: boolean;
  convert_video_mp4?: boolean;
  extract_flac?: boolean;
}

export interface StreamingConfig {
  /**
   * Active/default streaming provider id (e.g. "tidal", "apple-music"). Drives
   * `getDefaultStreamingProvider()` instead of a hardcoded value. When unset or
   * pointing at an unregistered provider the manager falls back to the first
   * registered provider.
   */
  default_provider?: string;
  /**
   * User-ordered provider preference (first = most preferred). Used as the
   * tie-break when two providers offer equal-quality/equal-coverage matches.
   * Unknown ids are ignored; providers missing from the list rank after the
   * listed ones in registration order. When unset, the default provider leads.
   */
  provider_priority?: string[];
}

/**
 * Canonical catalog source selection (see docs/MB_LOCAL_MODE.md). `servarr` =
 * Servarr Metadata Server / Skyhook (default, replicate-and-refresh); `musicbrainz`
 * = a local MusicBrainz-docker read directly from Postgres. `musicbrainz_host` is
 * just the host/IP (optionally `host:postgresPort` for advanced setups); the
 * Postgres DSN and co-located `/ws/2`+Solr URL are derived centrally.
 * The env vars `DISCOGENIUS_CATALOG_SOURCE` (`servarr-metadata`|`musicbrainz-local`)
 * and `DISCOGENIUS_MUSICBRAINZ_HOST` / `MB_LOCAL_HOST` override the stored values.
 */
export interface CatalogConfig {
  source: "servarr" | "musicbrainz";
  musicbrainz_host: string;
}

export interface DiscoGeniusConfig {
  app: AppConfig;
  monitoring: MonitoringConfig;
  filtering: FilteringConfig;
  path: PathConfig;
  naming: NamingConfig;
  metadata: MetadataConfig;
  quality: QualityConfig;
  streaming: StreamingConfig;
  catalog: CatalogConfig;
  account?: AccountConfig;
}

/**
 * Factory configuration.
 *
 * Exported so the taxonomy contract can assert the shipped defaults rather
 * than restate them — a default that drifts from its stated intent is the
 * kind of change nobody notices until a library curates differently.
 */
export const DEFAULT_CONFIG: DiscoGeniusConfig = {
  app: {
    admin_password: "",
  },
  monitoring: {
    enable_active_monitoring: true,
    monitor_new_artists: false,
    remove_unmonitored_files: false,
  },
  quality: {
    audio_quality: "max",
    video_quality: "uhd",
    embed_cover: true,
    embed_lyrics: true,
    upgrade_existing_files: false,
    downconvert_existing_files: false,
    convert_video_mp4: true,
    extract_flac: true,
  },
  filtering: {
    enable_redundancy_filter: true,
    prefer_explicit: true,
    include_album: true,
    include_ep: true,
    include_single: true,
    // A broadcast is a radio session, and `Other` also carries the untyped and
    // the unrecognised. Both are off: a discography is albums, EPs and singles
    // until the user says otherwise.
    include_broadcast: false,
    include_other: false,
    include_compilation: true,
    include_soundtrack: true,
    include_live: true,
    include_remix: true,
    include_dj_mix: true,
    include_mixtape_street: true,
    include_demo: true,
    // Field recording is environmental sound released as music; MusicBrainz
    // added it after Lidarr's list and Lidarr still does not model it.
    include_field_recording: true,
    // Speech rather than music.
    include_spokenword: false,
    include_interview: false,
    include_audiobook: false,
    include_audio_drama: false,
    // Only Official. A bootleg or pseudo-release is a worse copy of a record
    // the user already gets, not additional coverage; a Release with no status
    // at all is not a statement that it is official.
    include_status_official: true,
    include_status_promotion: false,
    include_status_bootleg: false,
    include_status_pseudo_release: false,
    include_status_withdrawn: false,
    include_status_cancelled: false,
    include_status_expunged: false,
    include_spatial: false,
    include_videos: false,
    include_video_official: true,
    include_video_lyric: false,
    include_video_live: true,
    include_video_visualizer: false,
    include_video_official_audio: false,
    require_provider_availability: true,
  },
  path: {
    music_path: "/library/stereo-music",
    spatial_path: "/library/spatial-music",
    video_path: "/library/music-videos",
    create_empty_artist_folders: false,
    video_folder_layout: "separated",
  },
  naming: {
    artist_folder: "{Artist Name} {mbid-{Artist MbId}}",
    // Prefer edition (release) title so deluxe / Track-by-Track / region products
    // get distinct folders; falls back to the album title when no edition is set.
    album_track_path_single: "{Edition Title} ({Release Year})/{track:00} - {Track Title}",
    album_track_path_multi: "{Edition Title} ({Release Year})/{medium:0}{track:00} - {Track Title}",
    // The default "separated" layout already puts video files in per-artist
    // folders, so the artist prefix in the filename is redundant. Include
    // {Video Type} so Plex/Jellyfin extras classification is template-owned
    // (no hardcoded suffix append after render). Prefer full video title so
    // shared venue/live parentheticals survive rename.
    video_file: "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}",
  },
  metadata: {
    artwork_preference: "canonical",
    save_album_cover: true,
    album_cover_name: "cover.jpg",
    album_cover_resolution: 1200,
    save_artist_picture: true,
    artist_picture_name: "folder.jpg",
    artist_picture_resolution: "origin",
    save_video_thumbnail: true,
    embed_video_thumbnail: true,
    video_thumbnail_resolution: "origin",
    save_lyrics: true,
    save_nfo: true,
    embed_album_review: true,
    enable_fingerprinting: true,
    write_tidal_url: false,
    mark_explicit: true,
    upc_target: "BARCODE",
    embed_replaygain: true,
    write_audio_tags_policy: "new_files",
    scrub_audio_tags: false,
  },
  streaming: {
    default_provider: "tidal",
  },
  catalog: {
    source: "servarr",
    musicbrainz_host: "localhost",
  },
  account: {}
};

let configCache: DiscoGeniusConfig | null = null;

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeMonitoringConfig(raw?: Partial<MonitoringConfig>): MonitoringConfig {
  return {
    enable_active_monitoring: typeof raw?.enable_active_monitoring === "boolean"
      ? raw.enable_active_monitoring
      : DEFAULT_CONFIG.monitoring.enable_active_monitoring,
    monitor_new_artists: typeof raw?.monitor_new_artists === "boolean"
      ? raw.monitor_new_artists
      : DEFAULT_CONFIG.monitoring.monitor_new_artists,
    remove_unmonitored_files: typeof raw?.remove_unmonitored_files === "boolean"
      ? raw.remove_unmonitored_files
      : DEFAULT_CONFIG.monitoring.remove_unmonitored_files,
  };
}

function normalizeFilteringConfig(raw?: Partial<FilteringConfig>): FilteringConfig {
  return {
    enable_redundancy_filter: raw?.enable_redundancy_filter ?? DEFAULT_CONFIG.filtering.enable_redundancy_filter,
    prefer_explicit: raw?.prefer_explicit ?? DEFAULT_CONFIG.filtering.prefer_explicit,
    include_album: raw?.include_album ?? DEFAULT_CONFIG.filtering.include_album,
    include_ep: raw?.include_ep ?? DEFAULT_CONFIG.filtering.include_ep,
    include_single: raw?.include_single ?? DEFAULT_CONFIG.filtering.include_single,
    include_broadcast: raw?.include_broadcast ?? DEFAULT_CONFIG.filtering.include_broadcast,
    include_other: raw?.include_other ?? DEFAULT_CONFIG.filtering.include_other,
    include_spokenword: raw?.include_spokenword ?? DEFAULT_CONFIG.filtering.include_spokenword,
    include_interview: raw?.include_interview ?? DEFAULT_CONFIG.filtering.include_interview,
    include_audiobook: raw?.include_audiobook ?? DEFAULT_CONFIG.filtering.include_audiobook,
    include_audio_drama: raw?.include_audio_drama ?? DEFAULT_CONFIG.filtering.include_audio_drama,
    include_field_recording: raw?.include_field_recording ?? DEFAULT_CONFIG.filtering.include_field_recording,
    include_status_official: raw?.include_status_official ?? DEFAULT_CONFIG.filtering.include_status_official,
    include_status_promotion: raw?.include_status_promotion ?? DEFAULT_CONFIG.filtering.include_status_promotion,
    include_status_bootleg: raw?.include_status_bootleg ?? DEFAULT_CONFIG.filtering.include_status_bootleg,
    include_status_pseudo_release: raw?.include_status_pseudo_release ?? DEFAULT_CONFIG.filtering.include_status_pseudo_release,
    include_status_withdrawn: raw?.include_status_withdrawn ?? DEFAULT_CONFIG.filtering.include_status_withdrawn,
    include_status_cancelled: raw?.include_status_cancelled ?? DEFAULT_CONFIG.filtering.include_status_cancelled,
    include_status_expunged: raw?.include_status_expunged ?? DEFAULT_CONFIG.filtering.include_status_expunged,
    include_compilation: raw?.include_compilation ?? DEFAULT_CONFIG.filtering.include_compilation,
    include_soundtrack: raw?.include_soundtrack ?? DEFAULT_CONFIG.filtering.include_soundtrack,
    include_live: raw?.include_live ?? DEFAULT_CONFIG.filtering.include_live,
    include_remix: raw?.include_remix ?? DEFAULT_CONFIG.filtering.include_remix,
    include_dj_mix: raw?.include_dj_mix ?? DEFAULT_CONFIG.filtering.include_dj_mix,
    include_mixtape_street: raw?.include_mixtape_street ?? DEFAULT_CONFIG.filtering.include_mixtape_street,
    include_demo: raw?.include_demo ?? DEFAULT_CONFIG.filtering.include_demo,
    include_spatial: raw?.include_spatial ?? DEFAULT_CONFIG.filtering.include_spatial,
    include_videos: raw?.include_videos ?? DEFAULT_CONFIG.filtering.include_videos,
    include_video_official: raw?.include_video_official ?? DEFAULT_CONFIG.filtering.include_video_official,
    include_video_lyric: raw?.include_video_lyric ?? DEFAULT_CONFIG.filtering.include_video_lyric,
    include_video_live: raw?.include_video_live ?? DEFAULT_CONFIG.filtering.include_video_live,
    include_video_visualizer: raw?.include_video_visualizer ?? DEFAULT_CONFIG.filtering.include_video_visualizer,
    include_video_official_audio:
      raw?.include_video_official_audio ?? DEFAULT_CONFIG.filtering.include_video_official_audio,
    require_provider_availability: raw?.require_provider_availability ?? DEFAULT_CONFIG.filtering.require_provider_availability,
  };
}

function normalizeMetadataConfig(raw?: Partial<MetadataConfig>): MetadataConfig {
  const writeAudioTagsPolicy = raw?.write_audio_tags_policy;

  return {
    artwork_preference: raw?.artwork_preference === "provider" ? "provider" : "canonical",
    save_album_cover: raw?.save_album_cover ?? DEFAULT_CONFIG.metadata.save_album_cover,
    album_cover_name: raw?.album_cover_name ?? DEFAULT_CONFIG.metadata.album_cover_name,
    album_cover_resolution: raw?.album_cover_resolution ?? DEFAULT_CONFIG.metadata.album_cover_resolution,
    save_artist_picture: raw?.save_artist_picture ?? DEFAULT_CONFIG.metadata.save_artist_picture,
    artist_picture_name: raw?.artist_picture_name ?? DEFAULT_CONFIG.metadata.artist_picture_name,
    artist_picture_resolution: raw?.artist_picture_resolution ?? DEFAULT_CONFIG.metadata.artist_picture_resolution,
    save_video_thumbnail: raw?.save_video_thumbnail ?? DEFAULT_CONFIG.metadata.save_video_thumbnail,
    embed_video_thumbnail: raw?.embed_video_thumbnail ?? DEFAULT_CONFIG.metadata.embed_video_thumbnail,
    video_thumbnail_resolution: raw?.video_thumbnail_resolution ?? DEFAULT_CONFIG.metadata.video_thumbnail_resolution,
    save_lyrics: raw?.save_lyrics ?? DEFAULT_CONFIG.metadata.save_lyrics,
    save_nfo: raw?.save_nfo ?? DEFAULT_CONFIG.metadata.save_nfo,
    embed_album_review: raw?.embed_album_review ?? DEFAULT_CONFIG.metadata.embed_album_review,
    enable_fingerprinting: raw?.enable_fingerprinting ?? DEFAULT_CONFIG.metadata.enable_fingerprinting,
    write_tidal_url: raw?.write_tidal_url ?? DEFAULT_CONFIG.metadata.write_tidal_url,
    mark_explicit: raw?.mark_explicit ?? DEFAULT_CONFIG.metadata.mark_explicit,
    upc_target: raw?.upc_target ?? DEFAULT_CONFIG.metadata.upc_target,
    embed_replaygain: raw?.embed_replaygain ?? DEFAULT_CONFIG.metadata.embed_replaygain,
    write_audio_tags_policy: writeAudioTagsPolicy === "no"
      || writeAudioTagsPolicy === "new_files"
      || writeAudioTagsPolicy === "all_files"
      || writeAudioTagsPolicy === "sync"
      ? writeAudioTagsPolicy
      : DEFAULT_CONFIG.metadata.write_audio_tags_policy,
    scrub_audio_tags: raw?.scrub_audio_tags ?? DEFAULT_CONFIG.metadata.scrub_audio_tags,
  };
}

function normalizeCatalogConfig(raw?: Partial<CatalogConfig>): CatalogConfig {
  // Env wins over stored config so a compose/TrueNAS deployment can force the
  // source without the UI (mirrors DISCOGENIUS_CATALOG_SOURCE / MB_LOCAL_HOST).
  // Env uses catalog-provider ids; config uses short UI values. Unset env keeps
  // the factory default (`servarr` / online Servarr Metadata) — wiping config
  // alone does not clear a set env override.
  const envSourceRaw = (process.env.DISCOGENIUS_CATALOG_SOURCE || "").trim();
  const envSource = envSourceRaw === "musicbrainz-local" || envSourceRaw === "musicbrainz"
    ? "musicbrainz"
    : envSourceRaw === "servarr-metadata" || envSourceRaw === "servarr"
      ? "servarr"
      : undefined;
  const rawSource = raw?.source === "musicbrainz" || raw?.source === "servarr" ? raw.source : undefined;

  const envHost = (
    process.env.DISCOGENIUS_MUSICBRAINZ_HOST ||
    process.env.MB_LOCAL_HOST ||
    ""
  ).trim();
  const rawHost = typeof raw?.musicbrainz_host === "string"
    ? raw.musicbrainz_host.trim()
    : "";
  const normalizedHost = normalizeMbHost(envHost || rawHost || DEFAULT_CONFIG.catalog.musicbrainz_host)
    || DEFAULT_CONFIG.catalog.musicbrainz_host;

  return {
    source: envSource ?? rawSource ?? DEFAULT_CONFIG.catalog.source,
    musicbrainz_host: normalizedHost,
  };
}

function normalizeQualityConfig(raw?: Partial<QualityConfig>): QualityConfig {
  const audioQuality = raw?.audio_quality;
  const videoQuality = raw?.video_quality;

  return {
    audio_quality: audioQuality === "low" || audioQuality === "normal" || audioQuality === "high" || audioQuality === "max"
      ? audioQuality
      : DEFAULT_CONFIG.quality.audio_quality,
    video_quality: videoQuality === "sd" || videoQuality === "hd" || videoQuality === "fhd" || videoQuality === "uhd"
      ? videoQuality
      : DEFAULT_CONFIG.quality.video_quality,
    embed_cover: raw?.embed_cover ?? DEFAULT_CONFIG.quality.embed_cover,
    embed_lyrics: raw?.embed_lyrics ?? DEFAULT_CONFIG.quality.embed_lyrics,
    upgrade_existing_files: raw?.upgrade_existing_files ?? DEFAULT_CONFIG.quality.upgrade_existing_files,
    downconvert_existing_files: raw?.downconvert_existing_files ?? DEFAULT_CONFIG.quality.downconvert_existing_files,
    convert_video_mp4: raw?.convert_video_mp4 ?? DEFAULT_CONFIG.quality.convert_video_mp4,
    extract_flac: raw?.extract_flac ?? DEFAULT_CONFIG.quality.extract_flac,
  };
}

function normalizeNamingConfig(raw?: Partial<NamingConfig> | null): NamingConfig {
  return { ...DEFAULT_CONFIG.naming, ...(raw || {}) };
}

function normalizeConfig(config: Partial<DiscoGeniusConfig>): DiscoGeniusConfig {
  return {
    app: { ...DEFAULT_CONFIG.app, ...(config.app || {}) },
    monitoring: normalizeMonitoringConfig(config.monitoring),
    filtering: normalizeFilteringConfig(config.filtering),
    path: { ...DEFAULT_CONFIG.path, ...(config.path || {}) },
    naming: normalizeNamingConfig(config.naming),
    metadata: normalizeMetadataConfig(config.metadata),
    quality: normalizeQualityConfig(config.quality),
    streaming: { ...DEFAULT_CONFIG.streaming, ...(config.streaming || {}) },
    catalog: normalizeCatalogConfig(config.catalog),
    account: { ...DEFAULT_CONFIG.account, ...(config.account || {}) },
  };
}

function readConfigFromDb(): DiscoGeniusConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  try {
    const rows = runWithSqliteBusyRetry(() => db.prepare("SELECT key, value FROM config WHERE key LIKE 'settings.%'").all()) as Array<{key: string, value: string}>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value);
        if (row.key === "settings.app") Object.assign(config.app, parsed);
        else if (row.key === "settings.monitoring") Object.assign(config.monitoring, parsed);
        else if (row.key === "settings.filtering") Object.assign(config.filtering, parsed);
        else if (row.key === "settings.path") Object.assign(config.path, parsed);
        else if (row.key === "settings.naming") Object.assign(config.naming, parsed);
        else if (row.key === "settings.metadata") Object.assign(config.metadata, parsed);
        else if (row.key === "settings.quality") Object.assign(config.quality, parsed);
        else if (row.key === "settings.streaming") Object.assign(config.streaming, parsed);
        else if (row.key === "settings.catalog") Object.assign(config.catalog, parsed);
        else if (row.key === "settings.account") {
          config.account = config.account || {};
          Object.assign(config.account, parsed);
        }
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    // If DB isn't ready or table doesn't exist yet, return defaults
  }
  return normalizeConfig(config);
}

export function clearConfigCache(): void {
  configCache = null;
}

/**
 * Read and parse config
 */
export function readConfig(): DiscoGeniusConfig {
  // Always re-read from SQLite. Command workers are separate threads with their
  // own module cache; a long-lived in-memory snapshot would keep boot-time
  // defaults (include_videos=false, naming templates, etc.) after Settings
  // changes on the main thread.
  configCache = readConfigFromDb();
  return cloneConfig(configCache);
}

/**
 * Write config to database
 */
export function writeConfig(config: DiscoGeniusConfig): void {
  const normalized = normalizeConfig(config);
  try {
    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
    const run = db.transaction(() => {
      stmt.run("settings.app", JSON.stringify(normalized.app));
      stmt.run("settings.monitoring", JSON.stringify(normalized.monitoring));
      stmt.run("settings.filtering", JSON.stringify(normalized.filtering));
      stmt.run("settings.path", JSON.stringify(normalized.path));
      stmt.run("settings.naming", JSON.stringify(normalized.naming));
      stmt.run("settings.metadata", JSON.stringify(normalized.metadata));
      stmt.run("settings.quality", JSON.stringify(normalized.quality));
      stmt.run("settings.streaming", JSON.stringify(normalized.streaming));
      stmt.run("settings.catalog", JSON.stringify(normalized.catalog));
      stmt.run("settings.account", JSON.stringify(normalized.account));
    });
    runWithSqliteBusyRetry(() => run());
    configCache = normalized;
    console.log("✅ Config saved to database");
  } catch (error) {
    console.error("❌ Error writing config to database:", error);
    throw error;
  }
}

/**
 * Get specific config section
 */
export function getConfigSection<K extends keyof DiscoGeniusConfig>(
  section: K
): DiscoGeniusConfig[K] {
  const config = readConfig();
  return config[section];
}

/**
 * Update specific config section
 */
export function updateConfig<K extends keyof DiscoGeniusConfig>(
  section: K,
  updates: Partial<DiscoGeniusConfig[K]>
): void {
  const config = readConfig();

  if (section === "filtering") {
    config.filtering = normalizeFilteringConfig({
      ...config.filtering,
      ...(updates as Partial<FilteringConfig>),
    });
  } else if (section === "monitoring") {
    config.monitoring = normalizeMonitoringConfig({
      ...config.monitoring,
      ...(updates as Partial<MonitoringConfig>),
    });
  } else if (section === "metadata") {
    config.metadata = normalizeMetadataConfig({
      ...config.metadata,
      ...(updates as Partial<MetadataConfig>),
    });
  } else if (section === "quality") {
    config.quality = normalizeQualityConfig({
      ...config.quality,
      ...(updates as Partial<QualityConfig>),
    });
  } else {
    config[section] = {
      ...config[section],
      ...updates
    };
  }

  writeConfig(config);
}

export class Config {
  /**
   * Resolve a path - handles relative paths by resolving to REPO_ROOT,
   * and Docker absolute paths (/downloads, /library)
   */
  static resolvePath(configuredPath: string, defaultName: string = 'downloads'): string {
    // If Docker, use absolute container paths
    if (process.env.DOCKER === 'true') {
      if (configuredPath.startsWith('/')) {
        return configuredPath;
      }
      return `/${defaultName}`;
    }

    // If already absolute, use as-is
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    // Resolve relative paths to REPO_ROOT
    return path.join(REPO_ROOT, configuredPath.replace(/^\.\//, ''));
  }

  /**
   * Get resolved download path
   */
  static getDownloadPath(): string {
    const configuredPath = process.env.DOWNLOAD_PATH || (process.env.DOCKER === 'true' ? '/downloads' : './downloads');
    return Config.resolvePath(configuredPath, 'downloads');
  }

  /**
   * Get resolved music library path
   */
  static getMusicPath(pathConfig?: PathConfig): string {
    const envOverride = process.env.MUSIC_PATH?.trim();
    if (envOverride) return Config.resolvePath(envOverride, 'library/stereo-music');
    const configuredPath = (pathConfig ?? getConfigSection("path")).music_path || '/library/stereo-music';
    return Config.resolvePath(configuredPath, 'library/stereo-music');
  }

  /**
   * Get resolved spatial library path
   */
  static getSpatialPath(pathConfig?: PathConfig): string {
    const envOverride = process.env.SPATIAL_PATH?.trim();
    if (envOverride) return Config.resolvePath(envOverride, 'library/spatial-music');
    const configuredPath = (pathConfig ?? getConfigSection("path")).spatial_path || '/library/spatial-music';
    return Config.resolvePath(configuredPath, 'library/spatial-music');
  }

  /**
   * Get resolved video library path
   */
  static getVideoPath(pathConfig?: PathConfig): string {
    const envOverride = process.env.VIDEO_PATH?.trim();
    if (envOverride) return Config.resolvePath(envOverride, 'library/music-videos');
    const configuredPath = (pathConfig ?? getConfigSection("path")).video_path || '/library/music-videos';
    return Config.resolvePath(configuredPath, 'library/music-videos');
  }

  static getAppConfig(): AppConfig {
    return getConfigSection("app");
  }

  static getMonitoringConfig(): MonitoringConfig {
    return getConfigSection("monitoring");
  }

  static getFilteringConfig(): FilteringConfig {
    return getConfigSection("filtering");
  }

  static getPathConfig(): PathConfig {
    return getConfigSection("path");
  }

  static getMetadataConfig(): MetadataConfig {
    return getConfigSection("metadata");
  }

  static getQualityConfig(): QualityConfig {
    return getConfigSection("quality");
  }

  static getStreamingConfig(): StreamingConfig {
    return getConfigSection("streaming") || {};
  }

  static getAccountConfig(): AccountConfig {
    return getConfigSection("account") || {};
  }

}

/**
 * Settings stereo ceiling. Download backends cap native requests to this;
 * missing config (unit tests, early bootstrap) behaves as max.
 */
export function configuredAudioQuality(): QualityConfig["audio_quality"] {
  try {
    const value = getConfigSection("quality").audio_quality;
    if (value === "low" || value === "normal" || value === "high" || value === "max") {
      return value;
    }
  } catch {
    // Config database is not always available in backend unit tests.
  }
  return "max";
}
