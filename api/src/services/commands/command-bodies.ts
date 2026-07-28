export type ArtistWorkflowValue =
  | "metadata-refresh"
  | "refresh-scan"
  | "library-scan"
  | "curation"
  | "monitoring-intake"
  | "full-monitoring";

export type MonitoringPassWorkflowValue = "full-cycle" | "curation-cycle" | "root-scan-cycle";

export type DownloadMediaType = "track" | "video" | "album";

export type DownloadTrackStatus = "queued" | "downloading" | "completed" | "error" | "skipped";

export type DownloadQueueStateValue =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "paused"
  | "importPending"
  | "importing"
  | "importFailed";

/** Terminal download outcome when the command still completed successfully. */
export type DownloadOutcomeValue = "ok" | "completedWithWarning";

export interface DownloadTrackStateEntry {
  title: string;
  trackNum?: number;
  volumeNum?: number;
  status: DownloadTrackStatus;
  /** Provider track id (staged file name); the hard link for per-track state. */
  providerTrackId?: string;
  /** Provider plugin id for this track offer (hybrid albums may mix albums within one provider). */
  provider?: string;
  quality?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
}

/** Per-track provider tip used when an album job fetches missing tracks individually. */
export interface DownloadTrackOffer {
  provider: string;
  providerTrackId: string;
  /** Source provider album for this tip (hybrid composites span multiple albums). */
  providerAlbumId?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  title?: string;
  quality?: string | null;
  trackNum?: number | null;
  volumeNum?: number | null;
}

export type DownloadAlbumAcquisitionMode = "album" | "trackOffers";

export interface DownloadStatePayload {
  progress?: number;
  currentFileNum?: number;
  totalFiles?: number;
  currentTrack?: string;
  currentProviderTrackId?: string;
  currentTrackNum?: number;
  currentVolumeNum?: number;
  trackProgress?: number;
  trackStatus?: DownloadTrackStatus;
  statusMessage?: string;
  state?: DownloadQueueStateValue;
  speed?: string;
  eta?: string;
  size?: number;
  sizeleft?: number;
  tracks?: DownloadTrackStateEntry[];
  /**
   * When a download succeeds via provider fallback (or other soft warning),
   * status stays completed but UI shows a warning — never a failure.
   */
  outcome?: DownloadOutcomeValue;
  warningMessage?: string;
  primaryProvider?: string;
  fallbackProvider?: string;
}

export interface ResolvedDownloadMetadata {
  title?: string;
  artist?: string;
  cover?: string | null;
}

export interface CommandBodyCommon {
  id?: string;
  ids?: number[];
  providerId?: string;
  provider?: string;
  releaseGroupMbid?: string;
  releaseMbid?: string | null;
  canonicalTrackId?: string | null;
  canonicalRecordingId?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  type?: string;
  title?: string;
  description?: string;
  /** Internal cooperative-cancellation marker while an active import drains to a safe boundary. */
  importCancellationRequested?: boolean;
  artist?: string;
  artists?: string[];
  artistIds?: string[];
  artistId?: string;
  artistName?: string;
  albumId?: string;
  albumTitle?: string;
  album_title?: string;
  albumVersion?: string | null;
  album?: string;
  album_id?: string;
  artist_id?: string;
  workflow?: ArtistWorkflowValue;
  monitoringCycle?: MonitoringPassWorkflowValue;
  monitorArtist?: boolean;
  monitorAlbums?: boolean;
  hydrateCatalog?: boolean;
  hydrateAlbumTracks?: boolean;
  scanLibrary?: boolean;
  forceUpdate?: boolean;
  forceDownloadQueue?: boolean;
  skipDownloadQueue?: boolean;
  skipCuration?: boolean;
  skipMetadataBackfill?: boolean;
  trackUnmappedFiles?: boolean;
  fullProcessing?: boolean;
  addNewArtists?: boolean;
  applyAll?: boolean;
  expectedArtists?: number;
  target?: string;
  reason?: string;
  source?: string;
  quality?: string | null;
  qualityProfile?: string;
  cover?: string | null;
  url?: string | null;
  path?: string | null;
  libraryRoot?: string;
  libraryId?: number;
  acquisitionPlanId?: number;
  slot?: "stereo" | "spatial" | string;
  trackNumber?: number | null;
  volumeNumber?: number | null;
  fileTypes?: string[];
  files?: unknown[];
  originalJobId?: number;
  resolved?: ResolvedDownloadMetadata;
  downloadState?: DownloadStatePayload;
}

export interface RefreshArtistCommand extends CommandBodyCommon {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflowValue;
  monitorArtist: boolean;
  monitorAlbums?: boolean;
  hydrateCatalog: boolean;
  hydrateAlbumTracks: boolean;
  scanLibrary: boolean;
  forceDownloadQueue: boolean;
  forceUpdate: boolean;
}

/**
 * Provider availability matching for one artist, run as its own queued unit
 * AFTER the metadata refresh (RefreshArtist → MatchArtistProviders → RescanFolders
 * → CurateArtist). Carries the context the inline matching had so the deferred
 * step is faithful to the inline path.
 */
export interface MatchArtistProvidersCommand extends CommandBodyCommon {
  artistId: string;
  artistName: string;
  /** Resolved MusicBrainz artist id, carried from the refresh so the match step
   *  does not recompute it. */
  artistMbid: string | null;
  /** Computed PRE-intake by RefreshArtist: true = fetch + match provider offers;
   *  false = just rebuild slot selections from stored offers. Passed through so
   *  the deferred match keeps the same decision the inline path would have made
   *  (the scan level changes once intake has run). */
  shouldHydrateCatalog: boolean;
  metadataChanged?: boolean;
  isNewArtist?: boolean;
  workflow: ArtistWorkflowValue;
  scanLibrary: boolean;
  forceDownloadQueue: boolean;
  forceUpdate: boolean;
}

export interface RefreshAlbumCommand extends CommandBodyCommon {
  albumId: string;
  forceUpdate?: boolean;
}

export interface RefreshMetadataCommand extends CommandBodyCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface ApplyCurationCommand extends CommandBodyCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface DownloadMissingCommand extends CommandBodyCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
  artistIds?: string[];
}

export type CheckUpgradesCommand = CommandBodyCommon;

export type HousekeepingCommand = CommandBodyCommon;

export interface DownloadTrackCommand extends CommandBodyCommon {
  type?: "track";
}

export interface DownloadVideoCommand extends CommandBodyCommon {
  type?: "video";
}

export interface DownloadAlbumCommand extends CommandBodyCommon {
  type?: "album";
  /**
   * How the processor fetches media for this catalog-anchored album job.
   * - `album`: single provider album download (normal full-missing match).
   * - `trackOffers`: download only the listed missing tracks (hybrid / partial).
   */
  acquisitionMode?: DownloadAlbumAcquisitionMode;
  /** Missing-track provider offers when `acquisitionMode` is `trackOffers`. */
  trackOffers?: DownloadTrackOffer[];
}

export interface CurateArtistCommand extends CommandBodyCommon {
  artistId: string;
  artistName: string;
  workflow?: Extract<ArtistWorkflowValue, "curation" | "monitoring-intake" | "full-monitoring">;
  skipDownloadQueue?: boolean;
  forceDownloadQueue?: boolean;
}

export interface RescanFoldersCommand extends CommandBodyCommon {
  artistId?: string;
  artistName?: string;
  workflow?: Extract<ArtistWorkflowValue, "refresh-scan" | "library-scan" | "monitoring-intake" | "full-monitoring">;
  skipDownloadQueue?: boolean;
  skipCuration?: boolean;
  skipMetadataBackfill?: boolean;
  trackUnmappedFiles?: boolean;
  forceDownloadQueue?: boolean;
  // Library-wide scan options
  addNewArtists?: boolean;
  monitorArtist?: boolean;
  fullProcessing?: boolean;
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface ImportDownloadCommand extends CommandBodyCommon {
  type: DownloadMediaType;
  providerId: string;
  resolved?: ResolvedDownloadMetadata;
  originalJobId?: number;
  acquisitionMode?: DownloadAlbumAcquisitionMode;
  trackOffers?: DownloadTrackOffer[];
  libraryId?: number;
  acquisitionPlanId?: number;
}

export interface ConfigPruneCommand extends CommandBodyCommon {
  /**
   * Preference changes first refresh every canonical MediaCover cache entry,
   * then run the same sidecar/embed reconciliation as an ordinary config prune.
   */
  refreshArtworkPreference?: boolean;
}

export interface MoveArtistCommand extends CommandBodyCommon {
  artistId: string;
  sourcePath?: string | null;
  destinationPath: string;
  moveFiles: boolean;
}

export interface RenameFilesCommand extends CommandBodyCommon {
  ids?: number[];
  artistId?: string;
  albumId?: string;
  libraryRoot?: string;
  fileTypes?: string[];
  applyAll?: boolean;
}

export interface RenameArtistCommand extends CommandBodyCommon {
  artistId?: string;
  artistIds?: string[];
}

export type BulkRefreshArtistCommand = CommandBodyCommon;

export type DownloadMissingForceCommand = CommandBodyCommon;

export interface RescanAllRootsCommand extends CommandBodyCommon {
  addNewArtists?: boolean;
}

export type CheckHealthCommand = CommandBodyCommon;

export type CompactDatabaseCommand = CommandBodyCommon;

export type BackupDatabaseCommand = CommandBodyCommon;

export type CleanupTempFilesCommand = CommandBodyCommon;

export type UpdateLibraryMetadataCommand = CommandBodyCommon;

export interface ImportProviderArtistsCommand extends CommandBodyCommon {
  providerId?: string;
  /** Which provider import source to pull artists from. */
  importCategory: "library-artists" | "followed-artists" | "playlist" | "favorite-tracks" | "mix";
  /** Specific list id for playlist/mix sources. */
  importListId?: string;
  /** Human-readable label for progress/history (e.g. the playlist name). */
  importLabel?: string;
  /** Provider artist ids selected in the import preview. Omitted means all source artists. */
  importArtistIds?: string[];
}

export interface ImportUnmappedFilesCommand extends CommandBodyCommon {
  items?: Array<{ id: number; providerId: string }>;
  canonical?: {
    libraryId: number;
    releaseId: number;
    mappings: Array<{
      unmappedFileId: number;
      trackId: number;
      providerItemId?: number | null;
    }>;
  };
}

export interface LibraryBulkActionCommand extends CommandBodyCommon {
  entity: "artist" | "album" | "track" | "video";
  action: "monitor" | "unmonitor" | "lock" | "unlock" | "download";
  entityIds: string[];
}

export interface SeedVideoCommand extends CommandBodyCommon {
  providerId: string;
  monitorArtist?: boolean;
  monitorVideo?: boolean;
}

export interface RetagFilesCommand extends CommandBodyCommon {
  ids?: number[];
  mediaIds?: Array<string | number>;
  artistId?: string;
  albumId?: string;
  applyAll?: boolean;
  /** When true, remove embedded tags without rewriting catalog metadata. */
  stripOnly?: boolean;
}

export interface RetagArtistCommand extends CommandBodyCommon {
  artistId?: string;
  artistIds?: string[];
}
