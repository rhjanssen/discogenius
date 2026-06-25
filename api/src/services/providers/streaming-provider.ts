import type { ProviderQualityMapping } from "./provider-quality.js";

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
  /**
   * Human display strings for the connection card's quality summary. These are
   * provider facts (e.g. "192 kHz", "1080p") that cannot be derived from the
   * booleans above, so each provider declares them directly. The card shows
   * three axes — stereo, spatial, and video quality — and falls back to deriving
   * a coarse label from the booleans when a string is absent.
   */
  stereoQuality?: string;
  spatialQuality?: string;
  videoQuality?: string;
}

export interface StreamingProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Neutral <-> provider quality translation (omit only if the provider has no audio). */
  readonly qualityMapping?: ProviderQualityMapping;

  isAuthenticated?(): boolean;
  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults>;
  getArtist(id: string | number): Promise<ProviderArtist>;
  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]>;
  getArtistVideos?(id: string | number): Promise<ProviderVideo[]>;
  getArtistCatalogPage?(id: string | number): Promise<any>;
  /** Categories of artist-import lists this provider supports (followed, playlists, mixes, …). */
  listImportSources?(): Promise<ProviderImportSource[]>;
  /** Distinct artists for a chosen import source/selection (e.g. a playlist's artists). */
  getArtistsForImportSource?(selection: ProviderImportSelection): Promise<ProviderArtist[]>;
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

/**
 * Artist-import list categories. `followed-artists` and `favorite-tracks` are
 * single fixed lists (the category itself is the selection). `playlist` and `mix`
 * enumerate concrete lists the user picks from (their playlists, the home-screen
 * mixes/featured playlists). Defined on the provider abstraction so each provider
 * declares what it supports; TIDAL implements all four today.
 */
export type ProviderImportSourceCategory =
  | "followed-artists"
  | "playlist"
  | "favorite-tracks"
  | "mix";

export interface ProviderImportSourceList {
  id: string;
  title: string;
  subtitle?: string | null;
  image?: string | null;
  itemCount?: number | null;
}

export interface ProviderImportSource {
  category: ProviderImportSourceCategory;
  label: string;
  description?: string;
  /** When true the UI must have the user pick one of `lists`; otherwise the category is the selection. */
  requiresListSelection: boolean;
  lists?: ProviderImportSourceList[];
}

export interface ProviderImportSelection {
  category: ProviderImportSourceCategory;
  /** Required when the source `requiresListSelection` (a specific playlist or mix id). */
  listId?: string;
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
  popularity?: number | null;
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
