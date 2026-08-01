import { getApiBaseUrl } from '@/utils/apiBaseUrl';
import type { AuthStatusContract } from '@contracts/auth';
import { parseAuthStatusContract } from '@contracts/auth';
import type { AppReleaseInfoContract } from '@contracts/release';
import { parseAppReleaseInfoContract } from '@contracts/release';
import type {
  AccountConfigContract,
  CatalogConfigContract,
  FilteringConfigContract,
  MetadataConfigContract,
  MonitoringConfigContract,
  MonitoringConfigUpdateResponseContract,
  MonitoringStatusResponseContract,
  NamingConfigContract,
  PathConfigContract,
  PublicAppConfigContract,
  QualityConfigContract,
} from '@contracts/config';
import {
  parseAccountConfigContract,
  parseCatalogConfigContract,
  parseFilteringConfigContract,
  parseMetadataConfigContract,
  parseMonitoringConfigUpdateResponseContract,
  parseMonitoringStatusResponseContract,
  parseNamingConfigContract,
  parsePathConfigContract,
  parsePublicAppConfigContract,
  parseQualityConfigContract,
} from '@contracts/config';
import type {
  AlbumsListResponseContract,
  ArtistsListResponseContract,
  LibraryStatsContract,
  SearchResponseContract,
  VideosListResponseContract,
} from '@contracts/catalog';
import {
  parseAlbumsListResponseContract,
  parseArtistsListResponseContract,
  parseLibraryStatsContract,
  parseSearchResponseContract,
  parseVideosListResponseContract,
} from '@contracts/catalog';
import type {
  LibraryFilesListResponseContract,
  LibraryReleaseGroupAvailabilityContract,
  VideoDetailContract,
  VideoUpdateContract,
} from '@contracts/media';
import {
  parseLibraryFilesListResponseContract,
  parseLibraryReleaseGroupAvailabilityContract,
  parseVideoDetailContract,
} from '@contracts/media';
import type { AlbumPageContract } from '@contracts/pages';
import { parseAlbumPageContract } from '@contracts/pages';
import type {
  ActivityListResponseContract,
  QueueDetailsResponseContract,
  QueueListResponseContract,
  QueueStatusContract,
  StatusOverviewContract,
} from '@contracts/status';
import type {
  ManualMatchCandidatesContract,
  ManualMatchResultContract,
  SystemStatusContract,
} from '@contracts/system-status';
import {
  parseActivityListResponseContract,
  parseQueueDetailsResponseContract,
  parseQueueListResponseContract,
  parseQueueStatusContract,
  parseStatusOverviewContract,
} from '@contracts/status';
import type {
  RunSystemTaskResponseContract,
  SystemTaskContract,
  UpdateSystemTaskRequestContract,
} from '@contracts/system-task';
import {
  parseRunSystemTaskResponseContract,
  parseSystemTaskContract,
  parseSystemTaskListContract,
} from '@contracts/system-task';

type AppAuthStatusContract = {
  isAuthActive: boolean;
  authType: 'password' | null;
};

function parseAppAuthStatusContract(value: unknown): AppAuthStatusContract {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid app auth status response');
  }

  const record = value as Record<string, unknown>;
  const authType = record.authType;

  return {
    isAuthActive: Boolean(record.isAuthActive),
    authType: authType === 'password' ? 'password' : null,
  };
}

const API_BASE_URL = getApiBaseUrl();
const API_PREFIX = '/api';
const API_V1_PREFIX = '/api/v1';

export type ImportSourceCategory = 'library-artists' | 'followed-artists' | 'playlist' | 'favorite-tracks' | 'mix';

export interface ImportSourceList {
  id: string;
  title: string;
  subtitle?: string | null;
  image?: string | null;
  itemCount?: number | null;
}

export interface ImportSource {
  category: ImportSourceCategory;
  label: string;
  description?: string;
  requiresListSelection: boolean;
  lists?: ImportSourceList[];
}

export interface ImportSourcesResponse {
  providerId: string;
  providerName: string;
  sources: ImportSource[];
}

export interface ImportPreviewArtist {
  providerId: string;
  name: string;
  picture?: string | null;
}

export interface ImportPreviewResponse {
  providerId: string;
  providerName: string;
  artists: ImportPreviewArtist[];
}

export interface ImportStreamHandle {
  close: () => void;
}

// Business/resource endpoints are served under a single /api/v1 namespace.
// A small set of infra/streaming endpoints stay un-versioned
// under /api and must match the backend mounts in server.ts.
const UNVERSIONED_API_PREFIXES = ['/auth', '/app-auth', '/playback', '/health'];

function toApiUrl(endpoint: string): string {
  // Already-absolute (/api/...) or proxy URLs are passed through unchanged.
  if (endpoint.startsWith(`${API_PREFIX}/`) || endpoint === API_PREFIX || endpoint.startsWith('/proxy')) {
    return endpoint;
  }

  // Infra endpoints stay un-versioned under /api.
  if (
    UNVERSIONED_API_PREFIXES.some(
      (prefix) => endpoint === prefix || endpoint.startsWith(`${prefix}/`) || endpoint.startsWith(`${prefix}?`),
    )
  ) {
    return `${API_PREFIX}${endpoint}`;
  }

  const path = endpoint.startsWith('/v1/') ? endpoint.slice(3) : endpoint;
  return `${API_V1_PREFIX}${path}`;
}

/**
 * Which libraries an Album command applies to.
 *
 * There is no default. Monitoring an Album in Stereo says nothing about
 * Spatial, so a caller either names one library or states that it means every
 * audio library.
 */
export type AlbumLibraryScope = { libraryId: number } | { allLibraries: true };

type ApiRequestOptions = RequestInit & {
  timeoutMs?: number | null;
};

type RequestControlOptions = {
  timeoutMs?: number | null;
  signal?: AbortSignal;
};

type ManagedEventSource = EventSource & {
  __discogeniusClosed?: boolean;
};

const managedEventSources = new Set<ManagedEventSource>();
let eventSourceUnloadListenerRegistered = false;

function registerEventSourceUnloadHandler(): void {
  if (eventSourceUnloadListenerRegistered || typeof window === "undefined") {
    return;
  }

  eventSourceUnloadListenerRegistered = true;
  window.addEventListener("beforeunload", () => {
    for (const eventSource of managedEventSources) {
      eventSource.__discogeniusClosed = true;
      eventSource.close();
    }
    managedEventSources.clear();
  });
}

function createManagedEventSource(url: string): ManagedEventSource {
  registerEventSourceUnloadHandler();
  const eventSource = new EventSource(url, { withCredentials: false }) as ManagedEventSource;
  const close = eventSource.close.bind(eventSource);

  managedEventSources.add(eventSource);

  eventSource.close = () => {
    eventSource.__discogeniusClosed = true;
    managedEventSources.delete(eventSource);
    close();
  };

  return eventSource;
}

function isExpectedEventSourceClose(eventSource: ManagedEventSource): boolean {
  return eventSource.__discogeniusClosed === true
    || eventSource.readyState === EventSource.CLOSED
    || (typeof document !== "undefined" && document.visibilityState === "hidden");
}

export type StreamingProviderStatus = {
  id: string;
  name: string;
  isDefault: boolean;
  authenticated: boolean;
  remoteCatalogAvailable: boolean;
  manifest?: {
    id: string;
    displayName: string;
    configRoot: string;
    auth: {
      kind: 'oauth-device' | 'developer-token' | 'external' | 'none';
      managedByApp: boolean;
      setupInstructions?: string[];
      setupIntro?: string;
      credentialFields?: Array<{
        key: string;
        label: string;
        secret?: boolean;
        required?: boolean;
        multiline?: boolean;
        helpText?: string;
      }>;
    };
    integration: {
      catalogSource: 'official-api' | 'web-api' | 'unofficial-api' | 'none';
      downloadSource: 'native-cli' | 'external-service' | 'none';
      stableResourceIds: Array<'artist' | 'album' | 'track' | 'video' | 'playlist'>;
    };
    downloadBackends: Array<{
      id: string;
      capabilities: Array<'stereo' | 'spatial' | 'video'>;
      enabled: boolean;
      setupNote?: string;
    }>;
    catalog: {
      search: boolean;
      artistCatalog: boolean;
      releaseOffers: boolean;
      videos: boolean;
    };
    imports: {
      supported: ImportSourceCategory[];
    };
    qualityMapping: {
      neutral: boolean;
      stereo: boolean;
      spatial: boolean;
      video: boolean;
    };
    diagnostics?: Array<'auth' | 'catalog' | 'download-backend' | 'rate-limit'>;
  };
  capabilities: {
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
    stereoQuality?: string;
    spatialQuality?: string;
    videoQuality?: string;
    maxVideoResolution?: number;
  };
  management: {
    canAuthenticate: boolean;
    canDisconnect: boolean;
    canImportArtists: boolean;
    canPreviewTracks: boolean;
    canPreviewVideos: boolean;
    canDownloadMusic: boolean;
    canDownloadVideos: boolean;
  };
};

export type ProviderDiagnosticResult = {
  kind: 'auth' | 'catalog' | 'download-backend' | 'rate-limit';
  status: 'ok' | 'warning' | 'error' | 'disabled' | 'unknown';
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
};

export type ProviderDiagnosticsResponse = {
  providerId: string;
  providerName: string;
  diagnostics: ProviderDiagnosticResult[];
};

export type QueueDownloadRequest = {
  url?: string | null;
  type: string;
  providerId?: string | null;
  provider?: string | null;
  releaseGroupMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  slot?: string | null;
  title?: string | null;
  artist?: string | null;
  artists?: string[];
  albumId?: string | null;
  albumTitle?: string | null;
  artistId?: string | null;
  cover?: string | null;
  quality?: string | null;
  description?: string | null;
};

class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  public async request<T>(
    endpoint: string,
    options: ApiRequestOptions = {},
    parser?: (value: unknown) => T,
  ): Promise<T> {
    // All backend routes are namespaced under /api to avoid collisions with SPA
    // routes; business endpoints live under /api/v1 (see toApiUrl).
    const normalizedEndpoint = toApiUrl(endpoint);

    const url = `${this.baseUrl}${normalizedEndpoint}`;

    const { timeoutMs = null, ...requestOptions } = options;

    const headers = new Headers(requestOptions.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Add auth token if available
    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`);
    }

    const callerSignal = requestOptions.signal;
    const controller = new AbortController();
    let didTimeout = false;
    const hasRequestTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timeoutId = hasRequestTimeout
      ? setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs)
      : null;

    const abortFromCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...requestOptions,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (didTimeout) {
          throw new Error(`Request timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`);
        }
        throw error;
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (callerSignal) {
        callerSignal.removeEventListener('abort', abortFromCaller);
      }
    }

    if (!response.ok) {
      let errorMessage = 'Request failed';
      try {
        const error = await response.json();
        errorMessage = error?.detail || error?.message || errorMessage;
      } catch (e) {
        // Response body is not JSON
        errorMessage = `Request failed with status ${response.status}`;
      }
      throw new Error(errorMessage);
    }

    if (response.status === 204) {
      return null as T;
    }

    const text = await response.text();
    if (!text) {
      return null as T;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text as unknown as T;
    }
    return parser ? parser(parsed) : parsed as T;
  }

  // Auth endpoints
  async startDeviceLogin(provider?: string) {
    const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return this.request(`/auth/device-login${suffix}`, { method: 'POST' });
  }

  async saveProviderCredentials(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<{ success: boolean; provider: string; status: AuthStatusContract }> {
    return this.request('/auth/credentials', {
      method: 'POST',
      body: JSON.stringify({ provider, credentials }),
    });
  }

  /** Hand Apple ID credentials to the decryption wrapper (transient — never stored). */
  async runAppleWrapperLogin(appleId: string, password: string) {
    return this.request('/auth/apple-music/downloader-login', {
      method: 'POST',
      body: JSON.stringify({ appleId, password }),
    });
  }

  async getAppleWrapperStatus(): Promise<{ status: string; message: string }> {
    return this.request('/auth/apple-music/downloader-login/status');
  }

  async submitAppleWrapper2fa(code: string) {
    return this.request('/auth/apple-music/downloader-login/code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  // App authentication (optional ADMIN_PASSWORD protection)
  async isAppAuthActive(): Promise<AppAuthStatusContract> {
    // Keep the boot check short: the app loads optimistically when this fails,
    // so a stalled API should not hold the boot screen for long.
    return this.request('/app-auth/is-auth-active', { timeoutMs: 4000 }, parseAppAuthStatusContract);
  }

  async verifyAppAuth() {
    return this.request('/app-auth/verify');
  }

  async loginAppAuth(password: string) {
    return this.request('/app-auth', { method: 'POST', body: JSON.stringify({ password }) });
  }

  async checkDeviceLogin(provider?: string) {
    const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return this.request(`/auth/check-login${suffix}`);
  }

  async getAuthStatus(): Promise<AuthStatusContract> {
    return this.request('/auth/status', {}, parseAuthStatusContract);
  }

  async getStreamingProviders(): Promise<{ providers: StreamingProviderStatus[]; defaultProviderId: string; providerPriority?: string[] }> {
    return this.request('/provider');
  }

  /** Persist provider preference order; the first entry becomes the default provider. */
  async updateProviderPriority(order: string[]): Promise<{ providerPriority: string[]; defaultProviderId: string }> {
    return this.request('/provider/priority', {
      method: 'PUT',
      body: JSON.stringify({ order }),
    });
  }

  async getProviderDiagnostics(providerId: string): Promise<ProviderDiagnosticsResponse> {
    return this.request(`/provider/${encodeURIComponent(providerId)}/diagnostics`);
  }

  async logoutProvider(providerId: string) {
    return this.request(`/provider/${providerId}/logout`, { method: 'POST' });
  }

  // Config endpoints
  async getQualityConfig(): Promise<QualityConfigContract> {
    return this.request('/v1/config/quality', {}, parseQualityConfigContract);
  }

  async updateQualityConfig(config: Partial<QualityConfigContract>) {
    return this.request('/v1/config/quality', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getCatalogConfig(): Promise<CatalogConfigContract> {
    return this.request('/v1/config/catalog', {}, parseCatalogConfigContract);
  }

  async updateCatalogConfig(config: Partial<CatalogConfigContract>) {
    return this.request('/v1/config/catalog', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async testCatalogConnection(musicbrainzHost?: string): Promise<{ ok: boolean; status?: number; message: string }> {
    return this.request('/v1/config/catalog/test', {
      method: 'POST',
      body: JSON.stringify(musicbrainzHost ? { musicbrainz_host: musicbrainzHost } : {}),
    });
  }

  async getAccountConfig(): Promise<AccountConfigContract> {
    return this.request('/v1/config/account', {}, parseAccountConfigContract);
  }

  async updateAccountConfig(config: Partial<AccountConfigContract>) {
    return this.request('/v1/config/account', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getAppConfig(): Promise<PublicAppConfigContract> {
    return this.request('/v1/config/app', {}, parsePublicAppConfigContract);
  }

  async updateAppConfig(config: Partial<PublicAppConfigContract>) {
    return this.request('/v1/config/app', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getAppReleaseInfo(): Promise<AppReleaseInfoContract> {
    return this.request('/v1/config/about', {}, parseAppReleaseInfoContract);
  }

  async updateMonitoringConfig(config: Partial<MonitoringConfigContract>): Promise<MonitoringConfigUpdateResponseContract> {
    return this.request('/monitoring/config', {
      method: 'POST',
      body: JSON.stringify(config),
    }, parseMonitoringConfigUpdateResponseContract);
  }

  async getCurationConfig(): Promise<FilteringConfigContract> {
    return this.request('/v1/config/curation', {}, parseFilteringConfigContract);
  }

  async updateCurationConfig(config: Partial<FilteringConfigContract>) {
    return this.request('/v1/config/curation', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getMetadataConfig(): Promise<MetadataConfigContract> {
    return this.request('/v1/config/metadata', {}, parseMetadataConfigContract);
  }

  async updateMetadataConfig(config: Partial<MetadataConfigContract>) {
    return this.request('/v1/config/metadata', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getPathConfig(): Promise<PathConfigContract> {
    return this.request('/v1/config/path', {}, parsePathConfigContract);
  }

  async updatePathConfig(config: Partial<PathConfigContract>) {
    return this.request('/v1/config/path', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getNamingConfig(): Promise<NamingConfigContract> {
    return this.request('/v1/config/naming', {}, parseNamingConfigContract);
  }

  async updateNamingConfig(config: Partial<NamingConfigContract>) {
    return this.request('/v1/config/naming', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async previewNamingConfig(config: Partial<NamingConfigContract>): Promise<{
    valid: boolean;
    validation: Record<string, { valid: boolean; errors: string[]; unknownTokens: string[]; tokens: string[] }>;
    preview: {
      artistFolder: string;
      standardTrack: string;
      multiDiscTrack: string;
      video: string;
    } | null;
  }> {
    return this.request('/v1/config/naming/preview', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  // Identification endpoints
  async identifyUnmappedFiles(fileIds: number[], releaseGroupMbid: string) {
    return this.request('/unmapped/identify', {
      method: 'POST',
      body: JSON.stringify({ fileIds, releaseGroupMbid }),
    });
  }

  // Search endpoints
  async search(
    query: string,
    types: string[] = ['artists', 'albums', 'tracks', 'videos'],
    limit: number = 10,
    signal?: AbortSignal,
    options?: { remote?: boolean; local?: boolean; artist?: string },
  ): Promise<SearchResponseContract> {
    const params = new URLSearchParams({
      query,
      type: types.join(','),
      limit: limit.toString(),
    });
    if (options?.artist) {
      params.set('artist', options.artist);
    }
    if (options?.remote) {
      params.set('remote', '1');
    }
    if (options?.local === false) {
      params.set('local', '0');
    }
    return this.request(`/search?${params}`, { signal }, parseSearchResponseContract);
  }

  // Artist endpoints
  async getArtists(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    sort?: string;
    dir?: 'asc' | 'desc';
    includeDownloadStats?: boolean;
    includeCounts?: boolean;
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }): Promise<ArtistsListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());
    if (params?.search) queryParams.set('search', params.search);
    if (params?.monitored !== undefined) queryParams.set('monitored', params.monitored ? 'true' : 'false');
    if (params?.sort) queryParams.set('sort', params.sort);
    if (params?.dir) queryParams.set('dir', params.dir);
    if (params?.includeDownloadStats !== undefined) queryParams.set('includeDownloadStats', params.includeDownloadStats ? 'true' : 'false');
    if (params?.includeCounts !== undefined) queryParams.set('includeCounts', params.includeCounts ? 'true' : 'false');
    const query = queryParams.toString();
    return this.request(
      `/v1/artist${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseArtistsListResponseContract,
    );
  }

  async getStats(options: RequestControlOptions = {}): Promise<LibraryStatsContract> {
    return this.request('/stats', options, parseLibraryStatsContract);
  }

  async getArtist<T = unknown>(artistId: string) {
    return this.request<T>(`/v1/artist/${artistId}`);
  }

  async getArtistPage(
    artistId: string,
    options: RequestControlOptions & { section?: 'all' | 'identity' | 'summary' | 'albums' | 'tracks' | 'videos' } = {},
  ) {
    const { section = 'all', ...requestOptions } = options;
    const query = section === 'all' ? '' : `?section=${section}`;
    return this.request(`/v1/artist/${artistId}/page${query}`, requestOptions);
  }

  async addArtist(providerId: string, name?: string) {
    return this.request(`/v1/artist`, {
      method: 'POST',
      body: JSON.stringify(name ? { id: providerId, name } : { id: providerId }),
    });
  }

  // Monitor endpoints - for explicit "Monitor" button action
  async monitorArtist(artistId: string, name?: string) {
    return this.request(`/v1/artist/${artistId}/monitor`, {
      method: 'POST',
      body: name ? JSON.stringify({ name }) : undefined,
    });
  }

  /**
   * Monitor an Album. The library scope is never implicit: pass one library, or
   * say `allLibraries` and mean every audio library (the Video Library curates
   * canonical video recordings and never takes part).
   */
  async monitorAlbum(albumId: string, scope: AlbumLibraryScope, monitored = true) {
    return this.request(`/v1/album/${albumId}/monitor`, {
      method: 'POST',
      body: JSON.stringify({ monitored, ...scope }),
    });
  }

  async getProviderAlbumTracks(providerId: string, albumId: string, releaseMbid?: string) {
    const query = releaseMbid ? `?releaseMbid=${encodeURIComponent(releaseMbid)}` : '';
    const tracks = await this.request(`/provider/${providerId}/albums/${albumId}/tracks${query}`) as any[];
    return Array.isArray(tracks)
      ? tracks.map((track) => ({
        ...track,
        id: String(track.id ?? track.providerId),
      }))
      : tracks;
  }



  async getAlbums(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
    library_filter?: string;
    provider?: string;
    quality_tier?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }): Promise<AlbumsListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());
    if (params?.search) queryParams.set('search', params.search);
    if (params?.monitored !== undefined) queryParams.set('monitored', params.monitored ? 'true' : 'false');
    if (params?.downloaded !== undefined) queryParams.set('downloaded', params.downloaded ? 'true' : 'false');
    if (params?.locked !== undefined) queryParams.set('locked', params.locked ? 'true' : 'false');
    if (params?.library_filter) queryParams.set('library_filter', params.library_filter);
    if (params?.provider) queryParams.set('provider', params.provider);
    if (params?.quality_tier) queryParams.set('quality_tier', params.quality_tier);
    if (params?.sort) queryParams.set('sort', params.sort);
    if (params?.dir) queryParams.set('dir', params.dir);
    const query = queryParams.toString();
    return this.request(
      `/v1/album${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseAlbumsListResponseContract,
    );
  }

  async getAlbum<T = unknown>(albumId: string, options: RequestControlOptions = {}) {
    return this.request<T>(`/v1/album/${albumId}`, options);
  }

  async getAlbumPage(albumId: string, options: RequestControlOptions = {}): Promise<AlbumPageContract> {
    return this.request(`/v1/album/${albumId}/page`, options, parseAlbumPageContract);
  }

  async addAlbum(albumId: string, options?: { slot?: 'stereo' | 'spatial' }) {
    return this.request(`/v1/album`, {
      method: 'POST',
      body: JSON.stringify({ id: albumId, slot: options?.slot }),
    });
  }

  /** `scope` is required for monitored/monitored_lock changes — see monitorAlbum. */
  async updateAlbum(albumId: string, updates: any, scope: AlbumLibraryScope) {
    return this.request(`/v1/album/${albumId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...updates, ...scope }),
    });
  }

  async deleteAlbumFiles(albumId: string, options?: { slot?: 'stereo' | 'spatial'; unmonitor?: boolean }) {
    const params = new URLSearchParams();
    if (options?.slot) params.set('slot', options.slot);
    if (options?.unmonitor) params.set('unmonitor', 'true');
    const query = params.toString();
    return this.request(`/v1/album/${albumId}/files${query ? `?${query}` : ''}`, { method: 'DELETE' });
  }

  async deleteArtistFiles(artistId: string, options?: { unmonitor?: boolean }) {
    return this.request(`/v1/artist/${artistId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ unmonitor: options?.unmonitor === true }),
    });
  }

  async deleteTrackFiles(trackId: string) {
    return this.request(`/v1/track/${trackId}/files`, { method: 'DELETE' });
  }

  async deleteVideoFiles(videoId: string) {
    return this.request(`/v1/video/${videoId}/files`, { method: 'DELETE' });
  }

  async getTracks(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
    library_filter?: string;
    provider?: string;
    quality_tier?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());
    if (params?.search) queryParams.set('search', params.search);
    if (params?.monitored !== undefined) queryParams.set('monitored', params.monitored ? 'true' : 'false');
    if (params?.downloaded !== undefined) queryParams.set('downloaded', params.downloaded ? 'true' : 'false');
    if (params?.locked !== undefined) queryParams.set('locked', params.locked ? 'true' : 'false');
    if (params?.library_filter) queryParams.set('library_filter', params.library_filter);
    if (params?.provider) queryParams.set('provider', params.provider);
    if (params?.quality_tier) queryParams.set('quality_tier', params.quality_tier);
    if (params?.sort) queryParams.set('sort', params.sort);
    if (params?.dir) queryParams.set('dir', params.dir);
    const query = queryParams.toString();
    return this.request(`/v1/track${query ? `?${query}` : ''}`, {
      timeoutMs: params?.timeoutMs ?? null,
      signal: params?.signal,
    });
  }

  async getTrackFiles(trackId: string) {
    return this.request(`/v1/track/${trackId}/files`);
  }

  async getTrack(trackId: string) {
    return this.request(`/v1/track/${trackId}`);
  }

  async addTrack(providerId: string) {
    return this.request(`/v1/track`, {
      method: 'POST',
      body: JSON.stringify({ id: providerId }),
    });
  }

  async updateTrack(trackId: string, updates: any) {
    return this.request(`/v1/track/${trackId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async getVideos(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
    provider?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }): Promise<VideosListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());
    if (params?.search) queryParams.set('search', params.search);
    if (params?.monitored !== undefined) queryParams.set('monitored', params.monitored ? 'true' : 'false');
    if (params?.downloaded !== undefined) queryParams.set('downloaded', params.downloaded ? 'true' : 'false');
    if (params?.locked !== undefined) queryParams.set('locked', params.locked ? 'true' : 'false');
    if (params?.provider) queryParams.set('provider', params.provider);
    if (params?.sort) queryParams.set('sort', params.sort);
    if (params?.dir) queryParams.set('dir', params.dir);
    const query = queryParams.toString();
    return this.request(
      `/v1/video${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseVideosListResponseContract,
    );
  }

  async getVideo(videoId: string): Promise<VideoDetailContract> {
    return this.request(`/v1/video/${videoId}`, {}, parseVideoDetailContract);
  }

  async addVideo(providerId: string) {
    return this.request(`/v1/video`, {
      method: 'POST',
      body: JSON.stringify({ id: providerId }),
    });
  }

  async updateVideo(videoId: string, updates: VideoUpdateContract) {
    return this.request(`/v1/video/${videoId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  // Managed media-file endpoints
  async getLibraryFiles(params?: { mediaId?: string; albumId?: string; artistId?: string; fileType?: string }): Promise<LibraryFilesListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.mediaId) queryParams.set('mediaId', params.mediaId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.fileType) queryParams.set('fileType', params.fileType);
    const query = queryParams.toString();
    return this.request(`/mediaFile${query ? `?${query}` : ''}`, {}, parseLibraryFilesListResponseContract);
  }

  async getLibraryRenameStatus(params?: {
    artistId?: string;
    albumId?: string;
    libraryRoot?: string;
    fileTypes?: string[];
    sampleLimit?: number;
    scanLimit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.libraryRoot) queryParams.set('libraryRoot', params.libraryRoot);
    if (params?.fileTypes?.length) queryParams.set('fileTypes', params.fileTypes.join(','));
    if (params?.sampleLimit) queryParams.set('sampleLimit', params.sampleLimit.toString());
    if (params?.scanLimit) queryParams.set('scanLimit', params.scanLimit.toString());
    const query = queryParams.toString();
    return this.request(`/mediaFile/rename/status${query ? `?${query}` : ''}`);
  }

  async getLibraryRenamePreview(params?: {
    artistId?: string;
    albumId?: string;
    libraryRoot?: string;
    fileTypes?: string[];
    limit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.libraryRoot) queryParams.set('libraryRoot', params.libraryRoot);
    if (params?.fileTypes?.length) queryParams.set('fileTypes', params.fileTypes.join(','));
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    const query = queryParams.toString();
    return this.request(`/mediaFile/rename/preview${query ? `?${query}` : ''}`);
  }

  async applyLibraryRenames(params: {
    ids?: number[];
    artistId?: string;
    albumId?: string;
    libraryRoot?: string;
    fileTypes?: string[];
    applyAll?: boolean;
  }) {
    return this.request('/mediaFile/rename/apply', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getRetagStatus(params?: {
    artistId?: string;
    albumId?: string;
    sampleLimit?: number;
    scanLimit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.sampleLimit) queryParams.set('sampleLimit', params.sampleLimit.toString());
    if (params?.scanLimit) queryParams.set('scanLimit', params.scanLimit.toString());
    const query = queryParams.toString();
    return this.request(`/retag/status${query ? `?${query}` : ''}`);
  }

  async getRetagPreview(params?: {
    artistId?: string;
    albumId?: string;
    limit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    const query = queryParams.toString();
    return this.request(`/retag${query ? `?${query}` : ''}`);
  }

  async applyRetags(params: {
    ids?: number[];
    artistId?: string;
    albumId?: string;
    applyAll?: boolean;
  }) {
    return this.request('/retag/apply', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async stripTags(params: {
    ids?: number[];
    artistId?: string;
    albumId?: string;
    applyAll?: boolean;
  }) {
    return this.request('/retag/strip', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async scanRootFolders(options?: { monitorArtist?: boolean }) {
    return this.request('/mediaFile/scan-roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
  }

  getStreamUrl(fileId: number): string {
    const base = `${this.baseUrl}${API_V1_PREFIX}/mediaFile/stream/${fileId}`;
    // Append auth token as query param since <audio>/<video> elements can't send headers
    if (this.authToken) {
      return `${base}?token=${encodeURIComponent(this.authToken)}`;
    }
    return base;
  }

  /**
   * Get a signed provider stream URL for preview playback.
   * The backend proxies the actual CDN bytes so no provider token leaks to the client.
   */
  async signTrackPreviewStream(
    trackId: string,
    options?: {
      provider?: string | null;
      quality?: string | null;
      releaseGroupMbid?: string | null;
      canonicalTrackMbid?: string | null;
      canonicalRecordingMbid?: string | null;
      slot?: string | null;
    },
  ): Promise<{ url: string; hlsUrl?: string }> {
    const queryParams = new URLSearchParams();
    if (options?.provider) queryParams.set('provider', options.provider);
    if (options?.quality) queryParams.set('quality', options.quality);
    if (options?.releaseGroupMbid) queryParams.set('releaseGroupMbid', options.releaseGroupMbid);
    if (options?.canonicalTrackMbid) queryParams.set('canonicalTrackMbid', options.canonicalTrackMbid);
    if (options?.canonicalRecordingMbid) queryParams.set('canonicalRecordingMbid', options.canonicalRecordingMbid);
    if (options?.slot) queryParams.set('slot', options.slot);
    const query = queryParams.toString();
    const data = await this.request(`/playback/stream/sign/${trackId}${query ? `?${query}` : ''}`) as { url: string; hlsUrl?: string };
    // Returned urls are relative (/api/playback/stream/...), make them absolute
    const absolute = (value?: string) => (value ? (value.startsWith("http") ? value : `${this.baseUrl}${value}`) : undefined);
    return { url: absolute(data.url)!, hlsUrl: absolute(data.hlsUrl) };
  }

  async signVideoPreviewStream(videoId: string, options?: { provider?: string | null }): Promise<string> {
    const queryParams = new URLSearchParams();
    if (options?.provider) queryParams.set('provider', options.provider);
    const query = queryParams.toString();
    const data = await this.request(`/playback/video/sign/${videoId}${query ? `?${query}` : ''}`);
    const url = (data as any).url;
    return url.startsWith("http") ? url : `${this.baseUrl}${url}`;
  }

  async getFileContent(filePath: string): Promise<string> {
    const url = `${this.baseUrl}${API_V1_PREFIX}/mediaFile/content?path=${encodeURIComponent(filePath)}`;
    const headers = new Headers();
    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`);
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Failed to fetch content: ${resp.status}`);
    return resp.text();
  }

  // Manual import / unmapped file endpoints
  async getUnmappedFiles(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(`/unmapped${query ? `?${query}` : ''}`);
  }

  async actionUnmappedFile(fileId: number, action: 'ignore' | 'unignore' | 'delete') {
    return this.request(`/unmapped/${fileId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  }

  async getAlbumLibraryAvailability(
    albumId: string,
    options: RequestControlOptions = {},
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(
      `/v1/album/${albumId}/library-availability`,
      options,
      parseLibraryReleaseGroupAvailabilityContract,
    );
  }

  async setAlbumLibraryRelease(
    albumId: string,
    libraryId: number,
    editionId: number,
    providerEditionMatchId?: number,
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(`/v1/album/${albumId}/libraries/${libraryId}/selection`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editionId, providerEditionMatchId }),
    }, parseLibraryReleaseGroupAvailabilityContract);
  }

  /**
   * Monitor an edition and execute exactly this plan.
   *
   * `mode` defaults to "exclusive" — the same "use only this" a normal click
   * means. "additive" keeps the album's other monitored editions.
   */
  async setAlbumLibraryPlan(
    albumId: string,
    libraryId: number,
    editionId: number,
    planKey: string,
    mode: "exclusive" | "additive" = "exclusive",
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(`/v1/album/${albumId}/libraries/${libraryId}/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editionId, planKey, mode }),
    }, parseLibraryReleaseGroupAvailabilityContract);
  }

  /** Stop monitoring one edition. Never deletes files. */
  async removeAlbumLibraryEdition(
    albumId: string,
    libraryId: number,
    editionId: number,
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(
      `/v1/album/${albumId}/libraries/${libraryId}/selection/${editionId}`,
      { method: "DELETE" },
      parseLibraryReleaseGroupAvailabilityContract,
    );
  }

  /** Make an already-monitored edition the Primary one for its album. */
  async setAlbumLibraryRepresentative(
    albumId: string,
    libraryId: number,
    editionId: number,
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(`/v1/album/${albumId}/libraries/${libraryId}/representative`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editionId }),
    }, parseLibraryReleaseGroupAvailabilityContract);
  }

  /** Hand the plan choice back to the planner. */
  async revertAlbumLibraryPlan(
    albumId: string,
    libraryId: number,
    editionId: number,
  ): Promise<LibraryReleaseGroupAvailabilityContract> {
    return this.request(`/v1/album/${albumId}/libraries/${libraryId}/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editionId, automatic: true }),
    }, parseLibraryReleaseGroupAvailabilityContract);
  }

  async getManualImportLibraries() {
    return this.request('/unmapped/canonical/libraries');
  }

  async getCanonicalManualImportRelease(releaseIdentity: string) {
    return this.request(`/unmapped/canonical/releases/${encodeURIComponent(releaseIdentity)}`);
  }

  async canonicalManualImport(payload: {
    libraryId: number;
    editionId: number;
    mappings: Array<{
      unmappedFileId: number;
      trackId: number;
    }>;
  }) {
    return this.request('/unmapped/canonical-import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async canonicalManualVideoImport(payload: {
    libraryId: number;
    mappings: Array<{
      unmappedFileId: number;
      recordingId: number;
    }>;
  }) {
    return this.request('/unmapped/canonical-video-import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async bulkActionUnmappedFiles(ids: number[], action: 'ignore' | 'unignore' | 'delete') {
    return this.request(`/unmapped/bulk-action`, {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    });
  }

  async scanArtist(artistId: string, options?: { forceUpdate?: boolean }) {
    return this.request(`/v1/artist/${artistId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ forceUpdate: Boolean(options?.forceUpdate) }),
    });
  }

  async getArtistActivity(artistId: string, options: RequestControlOptions = {}) {
    return this.request(`/v1/artist/${artistId}/activity`, options);
  }

  async updateArtist(artistId: string, updates: any) {
    return this.request(`/v1/artist/${artistId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async curateArtist(artistId: string) {
    return this.request(`/v1/artist/${artistId}/curate`, { method: 'POST' });
  }

  async toggleArtistMonitored(artistId: string, monitored: boolean) {
    return this.updateArtist(artistId, { monitored });
  }

  async deleteArtist(artistId: string, options?: { deleteFiles?: boolean }) {
    const query = options?.deleteFiles ? '?deleteFiles=true' : '';
    return this.request(`/v1/artist/${artistId}${query}`, { method: 'DELETE' });
  }

  // Download queue endpoints
  async getQueue(params?: { limit?: number; offset?: number; timeoutMs?: number | null }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(
      `/v1/queue${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null },
      parseQueueListResponseContract,
    );
  }

  async getQueueDetails(params?: {
    artistId?: string;
    albumIds?: string[];
    providerIds?: string[];
  }): Promise<QueueDetailsResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumIds && params.albumIds.length > 0) queryParams.set('albumIds', params.albumIds.join(','));
    if (params?.providerIds && params.providerIds.length > 0) queryParams.set('providerIds', params.providerIds.join(','));
    const query = queryParams.toString();
    return this.request(`/v1/queue/details${query ? `?${query}` : ''}`, {}, parseQueueDetailsResponseContract);
  }

  async getQueueStatus(): Promise<QueueStatusContract> {
    return this.request('/v1/queue/status', {}, parseQueueStatusContract);
  }

  async getQueueHistory(params?: {
    limit?: number;
    offset?: number;
    outcomes?: string[];
    mediaKinds?: string[];
    timeoutMs?: number | null;
  }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    if (params?.outcomes && params.outcomes.length > 0) {
      queryParams.set('outcome', params.outcomes.join(','));
    }
    if (params?.mediaKinds && params.mediaKinds.length > 0) {
      queryParams.set('slot', params.mediaKinds.join(','));
    }
    const query = queryParams.toString();
    return this.request(`/v1/queue/history${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseQueueListResponseContract);
  }

  async getStatusOverview(options: RequestControlOptions = {}): Promise<StatusOverviewContract> {
    return this.request('/status', { timeoutMs: options.timeoutMs ?? null }, parseStatusOverviewContract);
  }

  async getActivity(params?: {
    limit?: number;
    offset?: number;
    statuses?: string[];
    categories?: string[];
    types?: string[];
    timeoutMs?: number | null;
  }): Promise<ActivityListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    if (params?.statuses && params.statuses.length > 0) queryParams.set('statuses', params.statuses.join(','));
    if (params?.categories && params.categories.length > 0) queryParams.set('categories', params.categories.join(','));
    if (params?.types && params.types.length > 0) queryParams.set('types', params.types.join(','));
    const query = queryParams.toString();
    return this.request(`/v1/history/activity${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseActivityListResponseContract);
  }

  async getSystemTasks(): Promise<SystemTaskContract[]> {
    return this.request('/v1/system/task', {}, parseSystemTaskListContract);
  }

  async getSystemStatus(): Promise<SystemStatusContract> {
    return this.request('/v1/system/status');
  }

  async getUnmatchedArtistCandidates(provider: string, providerId: string): Promise<ManualMatchCandidatesContract> {
    return this.request(`/v1/system/status/unmatched-artists/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}/candidates`);
  }

  async applyUnmatchedArtistMatch(provider: string, providerId: string, mbid: string): Promise<ManualMatchResultContract> {
    return this.request(`/v1/system/status/unmatched-artists/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}/match`, {
      method: 'POST',
      body: JSON.stringify({ mbid }),
    });
  }

  async ignoreUnmatchedArtist(provider: string, providerId: string): Promise<{ ignored: boolean }> {
    return this.request(`/v1/system/status/unmatched-artists/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}/ignore`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async updateSystemTask(id: string, updates: UpdateSystemTaskRequestContract): Promise<SystemTaskContract> {
    return this.request(`/v1/system/task/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }, parseSystemTaskContract);
  }

  async runSystemTask(id: string): Promise<RunSystemTaskResponseContract> {
    return this.request(`/v1/system/task/${id}/run`, {
      method: 'POST',
    }, parseRunSystemTaskResponseContract);
  }

  async addToQueue(url: string | null | undefined, type: string, providerId?: string | null, payload?: Partial<QueueDownloadRequest> | Record<string, unknown>) {
    return this.request<{ id: number; message: string }>('/v1/queue', {
      method: 'POST',
      body: JSON.stringify({ ...payload, url, type, providerId }),
    });
  }

  async retryQueueItem(id: number) {
    return this.request<{
      action?: 'retry-download' | 'retry-import' | 'queue-redownload';
      message: string;
      jobId?: number;
      sourceJobId?: number;
    }>(`/v1/queue/${id}/retry`, { method: 'POST' });
  }

  async deleteQueueItem(id: number) {
    return this.request(`/v1/queue/${id}`, { method: 'DELETE' });
  }

  async reorderQueueItems(params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number }) {
    return this.request('/v1/queue/reorder', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async clearCompleted() {
    return this.request('/v1/queue/clear-completed', { method: 'POST' });
  }

  async pauseQueue() {
    return this.request('/v1/queue/pause', { method: 'POST' });
  }

  async resumeQueue() {
    return this.request('/v1/queue/resume', { method: 'POST' });
  }

  async processMonitoredItems(artistId?: string) {
    return this.request('/v1/queue/tasks/process-monitored', {
      method: 'POST',
      body: JSON.stringify({ artistId })
    });
  }

  // Monitoring endpoints
  async getMonitoringStatus(): Promise<MonitoringStatusResponseContract> {
    return this.request('/monitoring/status', {}, parseMonitoringStatusResponseContract);
  }



  async triggerAllMonitoring() {
    return this.request('/monitoring/trigger-all', { method: 'POST' });
  }

  async checkMonitoringNow() {
    return this.request('/monitoring/check', { method: 'POST' });
  }

  async queueCuration() {
    return this.request('/monitoring/curate', { method: 'POST' });
  }

  // Artist-import sources (followed artists, playlists, favorite tracks, mixes)
  // for the connected provider, used by the "Import artists" modal.
  async getImportSources(providerId?: string | null): Promise<ImportSourcesResponse> {
    const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : '';
    return this.request(`/v1/provider/import-sources${query}`);
  }

  async getImportPreview(selection: {
    category: string;
    listId?: string | null;
    providerId?: string | null;
  }): Promise<ImportPreviewResponse> {
    return this.request('/v1/provider/import-preview', {
      method: 'POST',
      body: JSON.stringify(selection),
    });
  }

  // Streaming endpoints using Server-Sent Events (SSE)
  // General artist-import stream: enqueues the background ImportProviderArtists
  // command and relays its progress. `category` selects the source; `listId` is
  // required for playlist/mix sources.
  createImportStream(
    selection: {
      category: string;
      listId?: string | null;
      label?: string | null;
      providerId?: string | null;
      artistIds?: string[];
    },
    onEvent: (event: string, data: any) => void,
    onError?: (error: Error) => void,
  ): ImportStreamHandle {
    const controller = new AbortController();
    const close = () => controller.abort();

    void (async () => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (this.authToken) headers.set('Authorization', `Bearer ${this.authToken}`);
      const response = await fetch(`${this.baseUrl}${API_V1_PREFIX}/artist/import-stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify(selection),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail || `Import request failed (${response.status})`);
      }
      if (!response.body) throw new Error('Import progress stream is unavailable');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary).replace(/\r/g, '');
          buffer = buffer.slice(boundary + 2);
          const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
          const dataText = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (event && dataText) {
            try {
              onEvent(event, JSON.parse(dataText));
            } catch (error) {
              console.error(`Failed to parse import event ${event}:`, error);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
    })().catch((error) => {
      if (!controller.signal.aborted) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return { close };
  }

  /**
   * Create SSE stream for real-time download progress updates
   */
  createDownloadProgressStream(
    onEvent: (event: string, data: any) => void,
    onError?: (error: Error) => void
  ): EventSource {
    let url = `${this.baseUrl}${API_V1_PREFIX}/queue/progress-stream`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }

    const eventSource = createManagedEventSource(url);

    const eventTypes = ['status', 'progress', 'progress-batch', 'started', 'completed', 'failed', 'queue-status', 'heartbeat'];

    eventTypes.forEach(eventType => {
      eventSource.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onEvent(eventType, data);
        } catch (error) {
          console.error(`Failed to parse SSE data for event ${eventType}:`, error);
        }
      });
    });

    eventSource.onerror = (error) => {
      // Ignore expected error events from intentionally closed streams.
      if (isExpectedEventSourceClose(eventSource)) {
        return;
      }
      if (eventSource.readyState === EventSource.CONNECTING) {
        return;
      }

      console.error('Download progress SSE error:', error);
      // Close to prevent native auto-reconnect storm; caller handles reconnect with backoff
      eventSource.close();
      if (onError) {
        onError(new Error('Download progress stream connection failed'));
      }
    };

    return eventSource;
  }

  createGlobalEventStream(onEvent: (event: string, data: any) => void, onError?: (error: Error) => void): EventSource {
    let url = `${this.baseUrl}${API_V1_PREFIX}/events`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    const eventSource = createManagedEventSource(url);

    // The backend emits events with names like "command.updated", "file.deleted", etc.
    // EventSource doesn't have a wildcard listener, so we rely on the specific message events.
    // However, the standard `onmessage` doesn't fire if the server specifies an `event: customName` header.
    // Therefore we bind to the known AppEvent enum values from the backend.

    const knownEvents = [
      'command.added', 'command.updated', 'command.deleted', 'queue.cleared',
      'history.added',
      'artist.scanned', 'artist.refresh.complete', 'config.updated',
      'file.added', 'file.deleted', 'file.upgraded'
    ];

    knownEvents.forEach(eventType => {
      eventSource.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onEvent(eventType, data);
        } catch (error) {
          console.error(`[API] Failed to parse SSE data for global event ${eventType}:`, error);
        }
      });
    });

    eventSource.onerror = (error) => {
      // Ignore expected abort/error notifications after the client closes the stream.
      if (isExpectedEventSourceClose(eventSource)) {
        return;
      }
      if (eventSource.readyState === EventSource.CONNECTING) {
        return;
      }

      console.error('[API] Global SSE stream error:', error);
      if (onError) onError(new Error('Global Stream connection failed'));
      // Browser usually auto-reconnects SSE, but we might want to manually close if auth fails etc.
    };

    return eventSource;
  }


  // Import endpoints handled earlier in this class
}

export const api = new ApiClient(API_BASE_URL);
