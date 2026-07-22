/**
 * Public streaming-provider contract types for core code.
 *
 * Phase 1 of 2.6 modularity: core should import types from `api/src/providers`
 * rather than reaching into `services/providers/<id>/`. Concrete definitions
 * still live next to the adapters until per-provider moves land.
 */
export type {
  NeutralQuality,
  ProviderAlbum,
  ProviderArtist,
  ProviderArtworkRequest,
  ProviderAuthKind,
  ProviderAuthStatus,
  ProviderCapabilities,
  ProviderDeviceLoginPollResult,
  ProviderDeviceLoginResult,
  ProviderDiagnosticKind,
  ProviderDiagnosticResult,
  ProviderDiagnosticStatus,
  ProviderDownloadOptions,
  ProviderDownloadProgress,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderImportSourceCategory,
  ProviderImportSourceList,
  ProviderLyrics,
  ProviderManifest,
  ProviderPlaybackInfo,
  ProviderQualityMapping,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderSearchType,
  ProviderTrack,
  ProviderVideo,
  ProviderVideoPlaybackInfo,
  StreamingProvider,
} from "../services/providers/streaming-provider.js";
