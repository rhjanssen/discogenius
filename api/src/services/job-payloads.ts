export type ArtistWorkflowValue =
  | "metadata-refresh"
  | "refresh-scan"
  | "library-scan"
  | "curation"
  | "monitoring-intake"
  | "full-monitoring";

export type MonitoringPassWorkflowValue = "full-cycle" | "curation-cycle" | "root-scan-cycle";

export type DownloadMediaType = "track" | "video" | "album" | "playlist";

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

export interface DownloadTrackStateEntry {
  title: string;
  trackNum?: number;
  status: DownloadTrackStatus;
}

export interface DownloadStatePayload {
  progress?: number;
  currentFileNum?: number;
  totalFiles?: number;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: DownloadTrackStatus;
  statusMessage?: string;
  state?: DownloadQueueStateValue;
  speed?: string;
  eta?: string;
  size?: number;
  sizeleft?: number;
  tracks?: DownloadTrackStateEntry[];
}

export interface ResolvedDownloadMetadata {
  title?: string;
  artist?: string;
  cover?: string | null;
}

export interface QueuePayloadCommon {
  id?: string;
  ids?: number[];
  tidalId?: string;
  type?: string;
  title?: string;
  description?: string;
  artist?: string;
  artists?: string[];
  artistIds?: string[];
  artistId?: string;
  artistName?: string;
  albumId?: string;
  albumTitle?: string;
  albumVersion?: string | null;
  album?: string;
  album_id?: string;
  artist_id?: string;
  playlistId?: string;
  playlistName?: string;
  workflow?: ArtistWorkflowValue;
  monitoringCycle?: MonitoringPassWorkflowValue;
  monitor?: boolean;
  monitorArtist?: boolean;
  monitorAlbums?: boolean;
  hydrateCatalog?: boolean;
  hydrateAlbumTracks?: boolean;
  scanLibrary?: boolean;
  includeSimilarArtists?: boolean;
  seedSimilarArtists?: boolean;
  forceUpdate?: boolean;
  forceDownloadQueue?: boolean;
  skipDownloadQueue?: boolean;
  skipCuration?: boolean;
  skipMetadataBackfill?: boolean;
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
  fileTypes?: string[];
  files?: unknown[];
  originalJobId?: number;
  resolved?: ResolvedDownloadMetadata;
  downloadState?: DownloadStatePayload;
}

export interface RefreshArtistJobPayload extends QueuePayloadCommon {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflowValue;
  monitorArtist: boolean;
  monitorAlbums?: boolean;
  hydrateCatalog: boolean;
  hydrateAlbumTracks: boolean;
  scanLibrary: boolean;
  includeSimilarArtists?: boolean;
  seedSimilarArtists?: boolean;
  forceDownloadQueue: boolean;
  forceUpdate: boolean;
}

export interface ScanAlbumJobPayload extends QueuePayloadCommon {
  albumId: string;
  forceUpdate?: boolean;
}

export interface ScanPlaylistJobPayload extends QueuePayloadCommon {
  tidalId: string;
  forceUpdate?: boolean;
}

export interface RefreshMetadataJobPayload extends QueuePayloadCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface ApplyCurationJobPayload extends QueuePayloadCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface DownloadMissingJobPayload extends QueuePayloadCommon {
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export type CheckUpgradesJobPayload = QueuePayloadCommon;

export type HousekeepingJobPayload = QueuePayloadCommon;

export interface DownloadTrackJobPayload extends QueuePayloadCommon {
  type?: "track";
}

export interface DownloadVideoJobPayload extends QueuePayloadCommon {
  type?: "video";
}

export interface DownloadAlbumJobPayload extends QueuePayloadCommon {
  type?: "album";
}

export interface DownloadPlaylistJobPayload extends QueuePayloadCommon {
  type?: "playlist";
}

export interface CurateArtistJobPayload extends QueuePayloadCommon {
  artistId: string;
  artistName: string;
  workflow?: Extract<ArtistWorkflowValue, "curation" | "monitoring-intake" | "full-monitoring">;
  skipDownloadQueue?: boolean;
  forceDownloadQueue?: boolean;
}

export interface RescanFoldersJobPayload extends QueuePayloadCommon {
  artistId?: string;
  artistName?: string;
  workflow?: Extract<ArtistWorkflowValue, "refresh-scan" | "library-scan" | "monitoring-intake" | "full-monitoring">;
  skipDownloadQueue?: boolean;
  skipCuration?: boolean;
  skipMetadataBackfill?: boolean;
  forceDownloadQueue?: boolean;
  // Library-wide scan options
  addNewArtists?: boolean;
  monitorArtist?: boolean;
  fullProcessing?: boolean;
  monitoringCycle?: MonitoringPassWorkflowValue;
}

export interface ImportDownloadJobPayload extends QueuePayloadCommon {
  type: DownloadMediaType;
  tidalId: string;
  resolved?: ResolvedDownloadMetadata;
  originalJobId?: number;
}

export type ConfigPruneJobPayload = QueuePayloadCommon;

export interface ApplyRenamesJobPayload extends QueuePayloadCommon {
  ids?: number[];
  artistId?: string;
  albumId?: string;
  libraryRoot?: string;
  fileTypes?: string[];
  applyAll?: boolean;
}

export type RefreshAllMonitoredJobPayload = QueuePayloadCommon;

export interface DownloadMissingForceJobPayload extends QueuePayloadCommon {
  skipFlags?: boolean;
}

export interface RescanAllRootsJobPayload extends QueuePayloadCommon {
  addNewArtists?: boolean;
}

export type HealthCheckJobPayload = QueuePayloadCommon;

export type CompactDatabaseJobPayload = QueuePayloadCommon;

export type CleanupTempFilesJobPayload = QueuePayloadCommon;

export type UpdateLibraryMetadataJobPayload = QueuePayloadCommon;

export interface ApplyRetagsJobPayload extends QueuePayloadCommon {
  ids?: number[];
  artistId?: string;
  albumId?: string;
  applyAll?: boolean;
}

