import type { ProviderQualityMapping, NeutralQuality } from "./provider-quality.js";

export type { ProviderQualityMapping, NeutralQuality } from "./provider-quality.js";

export interface ProviderCapabilities {
  catalogSearch: boolean;
  artistCatalog: boolean;
  followedArtists: boolean;
  audioPreviews: boolean;
  audioDownloads: boolean;
  lossyStereo: boolean;
  losslessStereo: boolean;
  hiResStereo: boolean;
  spatialAudio: boolean;
  lyrics: boolean;
  musicVideos: boolean;
  videoPreviews: boolean;
  videoDownloads: boolean;
  artwork: boolean;
  editorialMetadata: boolean;
  providerIds: boolean;
  spatialFormats?: string[];
}

/**
 * High-level, provider-agnostic capability descriptor (DATA_MODEL_TARGET §4).
 *
 * The detailed `ProviderCapabilities` above drives the settings UI; this compact
 * 7-axis descriptor is what feature-gating callers use to degrade gracefully when
 * a provider does not support an axis (e.g. a metadata-only provider with
 * `download: false`). Every provider must supply it — it is derived from, and
 * must stay consistent with, the detailed capabilities.
 */
export interface ProviderCoreCapabilities {
  /** Can stream/return stereo audio metadata + previews/playback. */
  audio: boolean;
  /** Supports any spatial format (Atmos / 360). */
  spatialAudio: boolean;
  /** Supports music videos (metadata and/or playback). */
  video: boolean;
  /** Can return lyrics. */
  lyrics: boolean;
  /** Has a working download backend wired in. */
  download: boolean;
  /** Supports catalog search. */
  search: boolean;
  /** Can enumerate the user's followed artists. */
  followedArtists: boolean;
}

export interface StreamingProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Compact universal capability descriptor — see ProviderCoreCapabilities. */
  readonly coreCapabilities: ProviderCoreCapabilities;
  /** Neutral <-> provider quality translation (omit only if the provider has no audio). */
  readonly qualityMapping?: ProviderQualityMapping;

  /** Translate this provider's raw quality tags into the neutral model. */
  toNeutralQuality?(rawTags: Iterable<string | null | undefined>): NeutralQuality;

  isAuthenticated?(): boolean;
  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults>;
  getArtist(id: string | number): Promise<ProviderArtist>;
  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]>;
  getArtistVideos?(id: string | number): Promise<ProviderVideo[]>;
  getArtistCatalogPage?(id: string | number): Promise<any>;
  getFollowedArtists?(): Promise<ProviderArtist[]>;
  listArtistReleaseOffers?(id: string | number): Promise<ProviderAlbum[]>;
  searchReleaseGroup?(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]>;
  getAlbum(id: string | number): Promise<ProviderAlbum>;
  getAlbumTracks(id: string | number): Promise<ProviderTrack[]>;
  getTrack(id: string | number): Promise<ProviderTrack>;
  getVideo?(id: string | number): Promise<ProviderVideo>;
  getPlaybackInfo?(id: string | number, preferredQuality?: string): Promise<ProviderPlaybackInfo | null>;
  getVideoPlaybackInfo?(id: string | number): Promise<ProviderVideoPlaybackInfo | null>;

  getArtistBio?(id: string | number): Promise<string | null>;
  getSimilarArtists?(id: string | number): Promise<ProviderArtist[]>;
  getAlbumReview?(id: string | number): Promise<string | null>;
  getSimilarAlbums?(id: string | number): Promise<ProviderAlbum[]>;
  getAlbumCredits?(id: string | number): Promise<any[]>;
  getAlbumTrackCredits?(id: string | number): Promise<Map<string, any[]>>;
  getArtworkUrl?(request: ProviderArtworkRequest): Promise<string | null> | string | null;
  getLyrics?(trackId: string | number): Promise<ProviderLyrics | null>;
  
  logout?(): void | Promise<void>;
  loadToken?(): any;
  refreshProviderToken?(): Promise<void>;
  shouldRefreshToken?(): boolean;

  getRateLimitMetrics?(): any;
  getCountryCode?(): string;
  apiRequest?<T = any>(endpoint: string, options?: any): Promise<T>;

  getAuthStatus(): Promise<ProviderAuthStatus>;
  startDeviceLogin?(): Promise<ProviderDeviceLoginResult>;
  pollDeviceLogin?(): Promise<ProviderDeviceLoginPollResult>;
  getMediaUrl?(type: string, providerId: string): string;
  parseMediaUrl?(url: string): { type: string; providerId: string } | null;
  downloadItem?(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions
  ): Promise<void>;
  syncCredentials?(): Promise<void> | void;
  syncSettings?(downloadPath?: string): Promise<void> | void;
}

/**
 * Derive the compact universal capability descriptor from the detailed
 * capability flags, keeping the two in sync. `hasDownloadBackend` lets a
 * provider report `download: false` when its backend is not yet wired (e.g. a
 * metadata-only adapter), independent of the catalog-level audio/video flags.
 */
export function deriveCoreCapabilities(
  capabilities: ProviderCapabilities,
  options: { hasDownloadBackend?: boolean } = {},
): ProviderCoreCapabilities {
  const downloadable = capabilities.audioDownloads || capabilities.videoDownloads;
  return {
    audio: capabilities.lossyStereo || capabilities.losslessStereo || capabilities.hiResStereo || capabilities.audioPreviews,
    spatialAudio: capabilities.spatialAudio,
    video: capabilities.musicVideos || capabilities.videoPreviews || capabilities.videoDownloads,
    lyrics: capabilities.lyrics,
    download: downloadable && (options.hasDownloadBackend ?? true),
    search: capabilities.catalogSearch,
    followedArtists: capabilities.followedArtists,
  };
}

export interface ProviderAuthStatus {
  connected: boolean;
  tokenExpired: boolean;
  refreshTokenExpired: boolean;
  hoursUntilExpiry: number;
  canAccessShell: boolean;
  canAccessLocalLibrary: boolean;
  remoteCatalogAvailable: boolean;
  canAuthenticate: boolean;
  refreshing?: boolean;
  user?: { username?: string } | null;
  message?: string;
}

export interface ProviderDeviceLoginResult {
  alreadyLoggedIn?: boolean;
  userCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  interval?: number;
}

export interface ProviderDeviceLoginPollResult {
  logged_in: boolean;
  expired?: boolean;
  remainingSeconds?: number;
  user?: { username?: string } | null;
}

export interface ProviderDownloadProgress {
  progress: number;
  currentFileNum?: number;
  totalFiles?: number;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
  statusMessage?: string;
  state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
  speed?: string;
  eta?: string;
  size?: number;
  sizeleft?: number;
  tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];
}

export interface ProviderDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProviderDownloadProgress) => void;
  quality?: string | null;
  qualityProfile?: string;
}

export type ProviderPlaybackInfo =
  | { type: "bts"; url: string }
  | { type: "dash"; segments: string[]; durations?: number[]; contentType: string };

export type ProviderVideoPlaybackInfo = {
  url: string;
  contentType?: string | null;
};

export interface ProviderSearchResults {
  artists: ProviderArtist[];
  albums: ProviderAlbum[];
  tracks: ProviderTrack[];
  videos: ProviderVideo[];
}

export type ProviderSearchType = "artists" | "albums" | "tracks" | "videos";

export interface ProviderSearchOptions {
  limit?: number;
  types?: ProviderSearchType[];
}

export interface ProviderArtist {
  providerId: string;
  name: string;
  picture?: string | null;
  url?: string;
  popularity?: number | null;
  types?: string[];
  roles?: string[];
  raw?: unknown;
}

export interface ProviderAlbum {
  providerId: string;
  title: string;
  artist: ProviderArtist;
  artists?: ProviderArtist[];
  cover?: string | null;
  releaseDate?: string | null;
  trackCount?: number | null;
  volumeCount?: number | null;
  duration?: number | null;
  type?: "ALBUM" | "EP" | "SINGLE" | string;
  explicit?: boolean | null;
  upc?: string | null;
  quality?: string | null;
  qualityTags?: string[];
  url?: string;
  version?: string | null;
  raw?: unknown;
}

export interface ProviderTrack {
  providerId: string;
  title: string;
  version?: string | null;
  artist: ProviderArtist;
  artists?: ProviderArtist[];
  album: ProviderAlbum;
  duration: number;
  trackNumber: number;
  volumeNumber?: number;
  url?: string;
  isrc?: string | null;
  quality?: string | null;
  qualityTags?: string[];
  raw?: unknown;
}

export interface ProviderVideo {
  providerId: string;
  title: string;
  artist: ProviderArtist;
  artists?: ProviderArtist[];
  duration?: number | null;
  releaseDate?: string | null;
  cover?: string | null;
  quality?: string | null;
  explicit?: boolean | null;
  url?: string;
  isrc?: string | null;
  recordingMbid?: string | null;
  raw?: unknown;
}

export type ProviderArtworkEntityType = "artist" | "album" | "video" | "albumVideoCover";

export interface ProviderArtworkRequest {
  entityType: ProviderArtworkEntityType;
  providerId?: string | number | null;
  imageId?: string | null;
  size?: string | number | null;
}

export interface ProviderLyrics {
  text: string;
  subtitles: string;
  provider: string;
  raw?: unknown;
}

export interface ProviderReleaseGroupSearch {
  artistName: string;
  releaseGroupMbid?: string | null;
  releaseGroupTitle: string;
  releaseDate?: string | null;
  slot: "stereo" | "spatial" | "video";
  preferredTrackCount?: number | null;
  preferredVolumeCount?: number | null;
}
