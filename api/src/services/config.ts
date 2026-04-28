import fs from "fs";
import path from "path";
import * as TOML from "@iarna/toml";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const hasApiWorkspace = fs.existsSync(path.join(current, "api", "package.json"));
    const hasAppWorkspace = fs.existsSync(path.join(current, "app", "package.json"));

    if (hasApiWorkspace && hasAppWorkspace) {
      return current;
    }

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { workspaces?: unknown };
        if (Array.isArray(packageJson.workspaces) && packageJson.workspaces.includes("api") && packageJson.workspaces.includes("app")) {
          return current;
        }
      } catch {
        // Ignore parse errors and keep walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(startDir, "..", "..", "..");
}

export const REPO_ROOT = findRepoRoot(__dirname);

function resolveOverridePath(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.join(REPO_ROOT, rawPath);
}

const DEFAULT_CONFIG_DIR = process.env.DOCKER === 'true' ? "/config" : path.join(REPO_ROOT, "config");
const CONFIG_DIR_OVERRIDE = process.env.DISCOGENIUS_CONFIG_DIR?.trim();
const CONFIG_FILE_OVERRIDE = process.env.DISCOGENIUS_CONFIG_FILE?.trim();
const DB_PATH_OVERRIDE = process.env.DB_PATH?.trim();

export const CONFIG_FILE = CONFIG_FILE_OVERRIDE
  ? resolveOverridePath(CONFIG_FILE_OVERRIDE)
  : path.join(
    CONFIG_DIR_OVERRIDE ? resolveOverridePath(CONFIG_DIR_OVERRIDE) : DEFAULT_CONFIG_DIR,
    "config.toml",
  );
export const CONFIG_DIR = path.dirname(CONFIG_FILE);
export const DB_PATH = DB_PATH_OVERRIDE
  ? resolveOverridePath(DB_PATH_OVERRIDE)
  : path.join(CONFIG_DIR, "discogenius.db");

export interface AppConfig {
  admin_password: string;
  acoustid_api_key?: string; // Optional AcoustID Client API Key
}

export interface MonitoringConfig {
  enable_active_monitoring: boolean;   // Enable scheduled re-scans
  scan_interval_hours: number;         // How often to re-scan monitored artists (daily, weekly, monthly)
  start_hour: number;                  // When to start monitoring window
  duration_hours: number;              // How long monitoring window lasts
  monitor_new_artists: boolean;        // Auto-monitor artists discovered during root scans
  remove_unmonitored_files: boolean;   // Remove files for items no longer monitored
  last_check?: string;                 // Timestamp of last successful check
  artist_refresh_days: number;         // Minimum days between artist scans
  album_refresh_days: number;          // Minimum days between album metadata refreshes
  track_refresh_days: number;          // Minimum days between track list refreshes
  video_refresh_days: number;          // Minimum days between video list refreshes
}

export interface FilteringConfig {
  // MusicBrainz-style release type filters
  include_album: boolean;              // Primary type: album (no secondary)
  include_single: boolean;             // Primary type: single
  include_ep: boolean;                 // Primary type: ep
  include_compilation: boolean;        // album + compilation secondary
  include_soundtrack: boolean;         // album + soundtrack secondary
  include_live: boolean;               // album + live secondary
  include_remix: boolean;              // album + remix secondary
  include_appears_on: boolean;         // Appears on other artists' releases
  include_atmos: boolean;              // Include Dolby Atmos/Sony 360RA
  include_videos: boolean;             // Monitor music videos
  prefer_explicit: boolean;            // Prefer explicit versions over clean
  enable_redundancy_filter: boolean;   // Deduplicate album versions/editions
}

export interface PathConfig {
  music_path: string;
  atmos_path: string;
  video_path: string;
}

export interface NamingConfig {
  artist_folder: string;        // Folder name for artists
  album_track_path_single: string; // Relative path (incl. filename stem) for tracks in single-volume albums
  album_track_path_multi: string;  // Relative path (incl. filename stem) for tracks in multi-volume albums
  video_file: string;              // Video filename stem (without extension)
}

/**
 * Controls when audio file tags are written (aligned with Lidarr's WriteAudioTagsType).
 * - "no"        — Never write tags
 * - "new_files" — Only write tags on newly downloaded/imported files
 * - "all_files" — Write tags on all files (existing + new)
 */
export type WriteAudioTagsPolicy = "no" | "new_files" | "all_files";

export interface MetadataConfig {
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
  /** @deprecated Use write_audio_tags_policy instead */
  write_audio_metadata?: boolean;
  embed_replaygain?: boolean;
  /** Lidarr-aligned tag write policy. Overrides legacy write_audio_metadata boolean. */
  write_audio_tags_policy?: WriteAudioTagsPolicy;
  /** Remove all existing tags before writing desired ones (Lidarr's ScrubAudioTags). */
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
  video_quality: "sd" | "hd" | "fhd";
  embed_cover: boolean;
  embed_lyrics: boolean;
  embed_synced_lyrics?: boolean;
  upgrade_existing_files: boolean;
  convert_video_mp4?: boolean;
  download_dolby_atmos?: boolean;
  extract_flac?: boolean;
}

export interface DiscoGeniusConfig {
  app: AppConfig;
  monitoring: MonitoringConfig;
  filtering: FilteringConfig;
  path: PathConfig;
  naming: NamingConfig;
  metadata: MetadataConfig;
  quality: QualityConfig;
  account?: AccountConfig;
}

const DEFAULT_CONFIG: DiscoGeniusConfig = {
  app: {
    admin_password: "",
  },
  monitoring: {
    enable_active_monitoring: true,
    scan_interval_hours: 24,
    start_hour: 2,
    duration_hours: 6,
    monitor_new_artists: false,
    remove_unmonitored_files: false,
    artist_refresh_days: 30,
    album_refresh_days: 120,
    track_refresh_days: 240,
    video_refresh_days: 365,
  },
  quality: {
    audio_quality: "max",
    video_quality: "fhd",
    embed_cover: true,
    embed_lyrics: true,
    embed_synced_lyrics: true,
    upgrade_existing_files: false,
    convert_video_mp4: true,
    download_dolby_atmos: false,
    extract_flac: true,
  },
  filtering: {
    enable_redundancy_filter: true,
    prefer_explicit: true,
    include_album: true,
    include_ep: true,
    include_single: true,
    include_compilation: true,        // Enable by default (was false)
    include_soundtrack: true,
    include_live: true,               // Enable by default (was false)
    include_remix: true,              // Enable by default (was false)
    include_appears_on: false,        // Only this is disabled by default
    include_atmos: false,
    include_videos: false,
  },
  path: {
    music_path: "./library/music",
    atmos_path: "./library/atmos",
    video_path: "./library/videos",
  },
  naming: {
    artist_folder: "{artistName} {mbid-{artistMbId}}",
    album_track_path_single: "{Album CleanTitle} ({Release Year})/{track:00} - {Track CleanTitle}",
    album_track_path_multi: "{Album CleanTitle} ({Release Year})/{medium:00}-{track:00} - {Track CleanTitle}",
    video_file: "{Artist CleanName} - {Video CleanTitle} {tidal-{videoId}}",
  },
  metadata: {
    save_album_cover: true,
    album_cover_name: "cover.jpg",
    album_cover_resolution: 1280,
    save_artist_picture: true,
    artist_picture_name: "folder.jpg",
    artist_picture_resolution: 750,
    save_video_thumbnail: true,
    embed_video_thumbnail: true,
    video_thumbnail_resolution: "1080x720",
    save_lyrics: true,
    save_nfo: true,
    embed_album_review: true,
    enable_fingerprinting: true,
    write_tidal_url: false,
    mark_explicit: true,
    upc_target: "BARCODE",
    write_audio_metadata: true,
    embed_replaygain: true,
    write_audio_tags_policy: "all_files",
    scrub_audio_tags: false,
  },
  account: {}
};

function normalizeFilteringConfig(raw?: Partial<FilteringConfig>): FilteringConfig {
  return {
    ...DEFAULT_CONFIG.filtering,
    ...(raw || {}),
  };
}

/**
 * Ensure config directory and default config file exist
 */
export function ensureConfigExists(): void {
  // Create config directory if it doesn't exist
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(`📁 Created config directory: ${CONFIG_DIR}`);
  }

  // Create default config file if it doesn't exist
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultToml = TOML.stringify(DEFAULT_CONFIG as any);
    fs.writeFileSync(CONFIG_FILE, defaultToml, "utf-8");
    console.log(`📄 Created default config file: ${CONFIG_FILE}`);
  }
}

/**
 * Read and parse config.toml
 */
export function readConfig(): DiscoGeniusConfig {
  ensureConfigExists();

  try {
    const content = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = TOML.parse(content) as unknown as DiscoGeniusConfig;

    // Deep merge with defaults to ensure all nested fields exist
    const metadataFromFile: Partial<MetadataConfig> = { ...(parsed.metadata || {}) };
    delete (metadataFromFile as Record<string, unknown>).save_album_review;
    delete (metadataFromFile as Record<string, unknown>).save_artist_bio;
    if (metadataFromFile.enable_fingerprinting === undefined) {
      metadataFromFile.enable_fingerprinting = DEFAULT_CONFIG.metadata.enable_fingerprinting;
    }

    const config: DiscoGeniusConfig = {
      app: { ...DEFAULT_CONFIG.app, ...parsed.app },
      monitoring: { ...DEFAULT_CONFIG.monitoring, ...parsed.monitoring },
      filtering: normalizeFilteringConfig((parsed as any).filtering),
      path: { ...DEFAULT_CONFIG.path, ...parsed.path },
      naming: { ...DEFAULT_CONFIG.naming, ...(parsed as any).naming },
      metadata: { ...DEFAULT_CONFIG.metadata, ...metadataFromFile },
      quality: { ...DEFAULT_CONFIG.quality, ...(parsed as any).quality },
      account: { ...DEFAULT_CONFIG.account, ...parsed.account },
    };

    return config;
  } catch (error) {
    console.error("❌ Error reading config.toml:", error);
    console.log("⚠️  Using default configuration");
    return DEFAULT_CONFIG;
  }
}

/**
 * Write config to config.toml
 */
export function writeConfig(config: DiscoGeniusConfig): void {
  ensureConfigExists();

  try {
    const tomlString = TOML.stringify(config as any);
    fs.writeFileSync(CONFIG_FILE, tomlString, "utf-8");
    console.log("✅ Config saved to config.toml");
  } catch (error) {
    console.error("❌ Error writing config.toml:", error);
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

// Initialize config on module load
ensureConfigExists();

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
  static getMusicPath(): string {
    const pathConfig = getConfigSection("path");
    const configuredPath = pathConfig.music_path || './library/music';
    return Config.resolvePath(configuredPath, 'library/music');
  }

  /**
   * Get resolved atmos library path
   */
  static getAtmosPath(): string {
    const pathConfig = getConfigSection("path");
    const configuredPath = pathConfig.atmos_path || './library/atmos';
    return Config.resolvePath(configuredPath, 'library/atmos');
  }

  /**
   * Get resolved video library path
   */
  static getVideoPath(): string {
    const pathConfig = getConfigSection("path");
    const configuredPath = pathConfig.video_path || './library/videos';
    return Config.resolvePath(configuredPath, 'library/videos');
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

  static getAccountConfig(): AccountConfig {
    return getConfigSection("account") || {};
  }

}
