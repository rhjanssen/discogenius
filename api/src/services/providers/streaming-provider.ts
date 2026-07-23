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
  /**
   * Maximum music-video height this provider can supply (e.g. 1080, 2160).
   * Settings greys out resolution options no connected provider can satisfy.
   */
  maxVideoResolution?: number;
}

export type ProviderAuthKind = "oauth-device" | "developer-token" | "external" | "none";
export type ProviderDiagnosticKind = "auth" | "catalog" | "download-backend" | "rate-limit";
export type ProviderDiagnosticStatus = "ok" | "warning" | "error" | "disabled" | "unknown";

export interface ProviderManifest {
  /** Stable plugin/provider id used in config, provider evidence, and download routing. */
  id: string;
  displayName: string;
  /** Directory under config/providers/ where provider-owned auth/config artifacts live. */
  configRoot: string;
  auth: {
    kind: ProviderAuthKind;
    /** True when the provider can start/complete auth from Discogenius UI routes. */
    managedByApp: boolean;
    /**
     * Whether persisted offers require a currently connected account for
     * preview/download actions. Defaults to true for authenticated providers.
     * Set false for adapters whose public media path works without credentials.
     */
    mediaAccessRequiresConnection?: boolean;
    /**
     * When true, the provider remains listed in Auth/Settings as a roadmap
     * entry but cannot be connected (Auth shows "Soon").
     */
    comingSoon?: boolean;
    /** Optional Auth-page intro shown above the step list / credential fields. */
    setupIntro?: string;
    /** Optional step-by-step Auth page guidance for external credential paste flows. */
    setupInstructions?: string[];
    credentialFields?: Array<{
      key: string;
      label: string;
      secret?: boolean;
      required?: boolean;
      /** Render long structured credentials (headers/cookies) as a resizable field. */
      multiline?: boolean;
      helpText?: string;
    }>;
  };
  integration: {
    /** Official, web-emulated, or external source used by the provider adapter for catalog/resource metadata. */
    catalogSource: "official-api" | "web-api" | "unofficial-api" | "none";
    /** How downloads are acquired. Kept descriptive so core code never branches on tool-specific setup. */
    downloadSource: "native-cli" | "external-service" | "none";
    /** Provider resource kinds whose providerId values are stable enough to persist in ProviderItems. */
    stableResourceIds: Array<"artist" | "album" | "track" | "video" | "playlist">;
  };
  downloadBackends: Array<{
    id: string;
    capabilities: Array<"stereo" | "spatial" | "video">;
    enabled: boolean;
    /** Human-facing setup note for diagnostics/settings; never consumed by core workflow logic. */
    setupNote?: string;
  }>;
  catalog: {
    search: boolean;
    artistCatalog: boolean;
    releaseOffers: boolean;
    videos: boolean;
  };
  imports: {
    supported: ProviderImportSourceCategory[];
  };
  qualityMapping: {
    neutral: boolean;
    stereo: boolean;
    spatial: boolean;
    video: boolean;
  };
  diagnostics?: ProviderDiagnosticKind[];
}

export interface StreamingProvider {
  readonly id: string;
  readonly name: string;
  readonly manifest?: ProviderManifest;
  readonly capabilities: ProviderCapabilities;
  /** Neutral <-> provider quality translation (omit only if the provider has no audio). */
  readonly qualityMapping?: ProviderQualityMapping;

  isAuthenticated?(): boolean;
  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults>;
  getArtist(id: string | number): Promise<ProviderArtist>;
  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]>;
  getArtistVideos?(id: string | number): Promise<ProviderVideo[]>;
  /** Categories of artist-import lists this provider supports (followed, playlists, mixes, …). */
  listImportSources?(): Promise<ProviderImportSource[]>;
  /** Distinct artists for a chosen import source/selection (e.g. a playlist's artists). */
  getArtistsForImportSource?(selection: ProviderImportSelection): Promise<ProviderArtist[]>;
  listArtistReleaseOffers?(id: string | number): Promise<ProviderAlbum[]>;
  searchReleaseGroup?(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]>;
  getAlbum(id: string | number): Promise<ProviderAlbum>;
  getAlbumTracks(id: string | number): Promise<ProviderTrack[]>;
  /**
   * Optional bulk tracklist fetch: given many album ids, return a map of
   * albumId → tracks, fetched in as few provider calls as possible (batched).
   * Providers that can't batch omit this and callers fall back to per-album
   * getAlbumTracks.
   */
  getAlbumTracksBulk?(ids: Array<string | number>): Promise<Map<string, ProviderTrack[]>>;
  getTrack(id: string | number): Promise<ProviderTrack>;
  getVideo?(id: string | number): Promise<ProviderVideo>;
  getPlaybackInfo?(id: string | number, preferredQuality?: string): Promise<ProviderPlaybackInfo | null>;
  getVideoPlaybackInfo?(id: string | number): Promise<ProviderVideoPlaybackInfo | null>;

  getArtistBio?(id: string | number): Promise<string | null>;
  getAlbumReview?(id: string | number): Promise<string | null>;
  getAlbumCredits?(id: string | number): Promise<any[]>;
  getAlbumTrackCredits?(id: string | number): Promise<Map<string, any[]>>;
  getArtworkUrl?(request: ProviderArtworkRequest): Promise<string | null> | string | null;
  getLyrics?(trackId: string | number): Promise<ProviderLyrics | null>;
  
  logout?(): void | Promise<void>;
  saveCredentials?(credentials: Record<string, unknown>): Promise<void> | void;

  /**
   * Optional external-downloader login handshake (e.g. Apple Music's
   * decryption wrapper). Credentials are transient — the provider must never
   * persist them. Status uses the shared vocabulary
   * idle | logging_in | waiting_for_code | success | failed (providers may
   * refine the message text).
   */
  startDownloaderLogin?(credentials: Record<string, string>): void | Promise<void>;
  getDownloaderLoginStatus?(): { status: string; message: string };
  submitDownloaderLoginCode?(code: string): void | Promise<void>;
  loadToken?(): any;
  refreshProviderToken?(): Promise<void>;
  shouldRefreshToken?(): boolean;

  getRateLimitMetrics?(): any;
  getCountryCode?(): string;
  apiRequest?<T = any>(endpoint: string, options?: any): Promise<T>;

  getAuthStatus(): Promise<ProviderAuthStatus>;
  getDiagnostics?(): Promise<ProviderDiagnosticResult[]>;
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
  /** 0-100 when known. Null/omit when the downloader has no file-level progress. */
  progress?: number | null;
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
  tracks?: {
    title: string;
    trackNum?: number;
    providerTrackId?: string;
    status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
  }[];
}

export interface ProviderDiagnosticResult {
  kind: ProviderDiagnosticKind;
  status: ProviderDiagnosticStatus;
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
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
 * Artist-import list categories. `library-artists`, `followed-artists`, and
 * `favorite-tracks` are single fixed lists (the category itself is the
 * selection). `playlist` and `mix` enumerate concrete lists the user picks from
 * (their playlists, the home-screen mixes/featured playlists). Defined on the
 * provider abstraction so each provider declares what it supports.
 */
export type ProviderImportSourceCategory =
  | "library-artists"
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
  /** Provider animated-cover id or URL (TIDAL UUID, Apple editorial motion URL, …). */
  videoCover?: string | null;
  releaseDate?: string | null;
  trackCount?: number | null;
  volumeCount?: number | null;
  duration?: number | null;
  type?: "ALBUM" | "EP" | "SINGLE" | string;
  explicit?: boolean | null;
  upc?: string | null;
  copyright?: string | null;
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
  releaseDate?: string | null;
  copyright?: string | null;
  replayGain?: number | null;
  peak?: number | null;
  popularity?: number | null;
  quality?: string | null;
  qualityTags?: string[];
  /**
   * Artwork for album-tracklist entries that are music videos (Apple bundles
   * videos into deluxe editions). Optional for normal audio tracks — album
   * cover usually comes from `album.cover`.
   */
  cover?: string | null;
  /**
   * True when this album-tracklist entry is a music video (providers like
   * Apple Music bundle videos at the end of deluxe/festival editions). The
   * import pipeline routes such tracks through the video path — video file
   * type, video library placement — while keeping their album/track identity.
   */
  isVideo?: boolean;
  /**
   * Provider video id for the UI audio/video switcher counterpart (YouTube
   * Music ATV song → OMV music video). Core persists this as an album-scoped
   * video offer linked to the audio recording for download + inline layout.
   */
  counterpartVideoId?: string | null;
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
  /**
   * Provider album id when the catalog links this video to an album
   * (TIDAL `album.id`, Apple `relationships.albums`, YouTube album browse id
   * after counterpart upsert). Never a MusicBrainz id.
   */
  albumId?: string | null;
  /**
   * Provider song/track id when the catalog links this video to a related
   * audio track (Apple `relationships.songs`). Used to attach
   * `provider_video_for` without fuzzy title matching.
   */
  relatedTrackId?: string | null;
  /**
   * Provider-native classification of the entry (e.g. YouTube Music's
   * MUSIC_VIDEO_TYPE_OMV / _ATV / _UGC). Providers whose catalogs mix real music
   * videos with audio-only uploads and user-generated content expose it so the
   * provider adapter can filter; the core video pipeline stays provider-agnostic.
   */
  videoType?: string | null;
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
  /** MusicBrainz primary type (album/ep/single/other/…). */
  primaryType?: string | null;
  /** MusicBrainz secondary types (mixtape/street, live, …). */
  secondaryTypes?: string[] | null;
  /**
   * Optional canonical tracklist for coverage ranking. Used by providers that
   * may match user playlists/sets as supersets of a release (SoundCloud mixtapes).
   */
  preferredTracks?: Array<{
    title: string;
    durationSec?: number | null;
    trackNumber?: number | null;
  }> | null;
}
