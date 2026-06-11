import { getApiBaseUrl } from '@/utils/apiBaseUrl';
import type { AuthStatusContract } from '@contracts/auth';
import { parseAuthStatusContract } from '@contracts/auth';
import type { AppReleaseInfoContract } from '@contracts/release';
import { parseAppReleaseInfoContract } from '@contracts/release';
import type {
  AccountConfigContract,
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
  AlbumTrackContract,
  AlbumVersionContract,
  LibraryFilesListResponseContract,
  SimilarAlbumContract,
  VideoDetailContract,
  VideoUpdateContract,
} from '@contracts/media';
import {
  parseAlbumTracksContract,
  parseAlbumVersionsContract,
  parseLibraryFilesListResponseContract,
  parseSimilarAlbumsContract,
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
import {
  parseActivityListResponseContract,
  parseQueueDetailsResponseContract,
  parseQueueListResponseContract,
  parseQueueStatusContract,
  parseStatusOverviewContract,
} from '@contracts/status';
import type {
  HistoryEventItemContract,
  ListHistoryEventsResponseContract,
} from '@contracts/history';
import {
  parseHistoryEventsResponseContract,
} from '@contracts/history';
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
  };
  management: {
    canAuthenticate: boolean;
    canDisconnect: boolean;
    canImportFollowedArtists: boolean;
    canPreviewTracks: boolean;
    canPreviewVideos: boolean;
    canDownloadMusic: boolean;
    canDownloadVideos: boolean;
  };
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

  getAuthToken(): string | null {
    return this.authToken;
  }

  public async request<T>(
    endpoint: string,
    options: ApiRequestOptions = {},
    parser?: (value: unknown) => T,
  ): Promise<T> {
    // All backend routes are namespaced under /api to avoid collisions with SPA routes.
    // Keep /api/* and /proxy/* as-is, prefix everything else.
    const normalizedEndpoint =
      endpoint.startsWith(`${API_PREFIX}/`) || endpoint === API_PREFIX
        ? endpoint
        : endpoint.startsWith('/proxy')
          ? endpoint
          : `${API_PREFIX}${endpoint}`;

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
  async startDeviceLogin() {
    return this.request('/auth/device-login', { method: 'POST' });
  }

  // App authentication (optional ADMIN_PASSWORD protection)
  async isAppAuthActive(): Promise<AppAuthStatusContract> {
    return this.request('/app-auth/is-auth-active', { timeoutMs: 10000 }, parseAppAuthStatusContract);
  }

  async verifyAppAuth() {
    return this.request('/app-auth/verify');
  }

  async loginAppAuth(password: string) {
    return this.request('/app-auth', { method: 'POST', body: JSON.stringify({ password }) });
  }

  async checkDeviceLogin() {
    return this.request('/auth/check-login');
  }

  async getAuthStatus(): Promise<AuthStatusContract> {
    return this.request('/auth/status', {}, parseAuthStatusContract);
  }

  async getStreamingProviders(): Promise<{ providers: StreamingProviderStatus[]; defaultProviderId: string }> {
    return this.request('/providers');
  }

  async logoutProvider(providerId: string) {
    return this.request(`/providers/${providerId}/logout`, { method: 'POST' });
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

  async getMonitoringConfig(): Promise<MonitoringConfigContract> {
    const status = await this.request('/monitoring/status', {}, parseMonitoringStatusResponseContract);
    return status.config;
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

  async validateNamingConfig(config: Partial<NamingConfigContract>) {
    return this.request('/v1/config/naming/validate', {
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

  // Config TOML raw content endpoints
  async getConfigToml() {
    return this.request('/v1/config/toml');
  }

  async updateConfigToml(toml: string) {
    return this.request('/v1/config/toml', {
      method: 'POST',
      body: JSON.stringify({ toml }),
    });
  }

  // Identification endpoints
  async identifyUnmappedFiles(fileIds: number[], tidalAlbumId: string) {
    return this.request('/unmapped/identify', {
      method: 'POST',
      body: JSON.stringify({ fileIds, tidalAlbumId }),
    });
  }

  // Search endpoints
  async search(
    query: string,
    types: string[] = ['artists', 'albums', 'tracks', 'videos'],
    limit: number = 10,
    signal?: AbortSignal,
  ): Promise<SearchResponseContract> {
    const params = new URLSearchParams({
      query,
      type: types.join(','),
      limit: limit.toString(),
    });
    return this.request(`/search?${params}`, { signal }, parseSearchResponseContract);
  }

  async lookupArtists(
    query: string,
    limit: number = 10,
    signal?: AbortSignal,
  ): Promise<SearchResponseContract> {
    const params = new URLSearchParams({
      term: query,
      limit: limit.toString(),
    });
    return this.request(`/v1/artist/lookup?${params}`, { signal }, parseSearchResponseContract);
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

  async getArtistPage(artistId: string) {
    return this.request(`/v1/artist/${artistId}/page`);
  }

  async getArtistPageDB(artistId: string, options: RequestControlOptions = {}) {
    return this.request(`/v1/artist/${artistId}/page-db`, options);
  }

  async getArtistDetail(artistId: string) {
    return this.request(`/v1/artist/${artistId}/detail`);
  }


  async addArtist(providerId: string) {
    return this.request(`/v1/artist`, {
      method: 'POST',
      body: JSON.stringify({ id: providerId }),
    });
  }

  // Monitor endpoints - for explicit "Monitor" button action
  async monitorArtist(artistId: string, name?: string) {
    return this.request(`/v1/artist/${artistId}/monitor`, {
      method: 'POST',
      body: name ? JSON.stringify({ name }) : undefined,
    });
  }

  async monitorAlbum(albumId: string) {
    return this.request(`/v1/album/${albumId}/monitor`, { method: 'POST' });
  }

  async getArtistAlbums(artistId: string, qualityFilter: 'all' | 'stereo' | 'spatial' = 'all') {
    return this.request(`/v1/artist/${artistId}/albums?quality_filter=${qualityFilter}`);
  }

  async getProviderAlbumTracks(providerId: string, albumId: string) {
    const tracks = await this.request(`/providers/${providerId}/albums/${albumId}/tracks`) as any[];
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

  async updateAlbum(albumId: string, updates: any) {
    return this.request(`/v1/album/${albumId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteAlbum(albumId: string) {
    return this.request(`/v1/album/${albumId}`, { method: 'DELETE' });
  }

  async getAlbumTracks(albumId: string, options: RequestControlOptions = {}): Promise<AlbumTrackContract[]> {
    return this.request(`/v1/album/${albumId}/tracks`, options, parseAlbumTracksContract);
  }

  async getAlbumSimilar(albumId: string, options: RequestControlOptions = {}): Promise<SimilarAlbumContract[]> {
    return this.request(`/v1/album/${albumId}/similar`, options, parseSimilarAlbumsContract);
  }

  async getAlbumVersions(albumId: string, options: RequestControlOptions = {}): Promise<AlbumVersionContract[]> {
    return this.request(`/v1/album/${albumId}/versions`, options, parseAlbumVersionsContract);
  }

  async getTracks(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
    library_filter?: string;
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

  async deleteTrack(trackId: string) {
    return this.request(`/v1/track/${trackId}`, { method: 'DELETE' });
  }

  async getVideos(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
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

  async deleteVideo(videoId: string) {
    return this.request(`/v1/video/${videoId}`, { method: 'DELETE' });
  }

  // Library files endpoints
  async getLibraryFiles(params?: { mediaId?: string; albumId?: string; artistId?: string; fileType?: string }): Promise<LibraryFilesListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.mediaId) queryParams.set('mediaId', params.mediaId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.fileType) queryParams.set('fileType', params.fileType);
    const query = queryParams.toString();
    return this.request(`/library-files${query ? `?${query}` : ''}`, {}, parseLibraryFilesListResponseContract);
  }

  async getLibraryRenameStatus(params?: {
    artistId?: string;
    albumId?: string;
    libraryRoot?: string;
    fileTypes?: string[];
    sampleLimit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.libraryRoot) queryParams.set('libraryRoot', params.libraryRoot);
    if (params?.fileTypes?.length) queryParams.set('fileTypes', params.fileTypes.join(','));
    if (params?.sampleLimit) queryParams.set('sampleLimit', params.sampleLimit.toString());
    const query = queryParams.toString();
    return this.request(`/library-files/rename/status${query ? `?${query}` : ''}`);
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
    return this.request(`/library-files/rename/preview${query ? `?${query}` : ''}`);
  }

  async applyLibraryRenames(params: {
    ids?: number[];
    artistId?: string;
    albumId?: string;
    libraryRoot?: string;
    fileTypes?: string[];
    applyAll?: boolean;
  }) {
    return this.request('/library-files/rename/apply', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getRetagStatus(params?: {
    artistId?: string;
    albumId?: string;
    sampleLimit?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumId) queryParams.set('albumId', params.albumId);
    if (params?.sampleLimit) queryParams.set('sampleLimit', params.sampleLimit.toString());
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

  async libraryScan(artistId: string, options?: {
    skipDownloadQueue?: boolean;
    skipCuration?: boolean;
    skipMetadataBackfill?: boolean;
  }) {
    return this.request(`/library-files/scan/${artistId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
  }

  async scanRootFolders(options?: { monitorArtist?: boolean }) {
    return this.request('/library-files/scan-roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
  }

  createScanRootFoldersStream(): EventSource {
    // SSE via POST requires fetch, but we use EventSource pattern with a workaround
    // Use fetch-based SSE reader instead
    throw new Error("createScanRootFoldersStream is not supported; use scanRootFolders for queued root scans.");
  }

  getScanRootFoldersUrl(): string {
    return `${this.baseUrl}${API_PREFIX}/library-files/scan-roots-now`;
  }

  getStreamUrl(fileId: number): string {
    const base = `${this.baseUrl}${API_PREFIX}/library-files/stream/${fileId}`;
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
    const url = `${this.baseUrl}${API_PREFIX}/library-files/content?path=${encodeURIComponent(filePath)}`;
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

  async actionUnmappedFile(fileId: number, action: 'map' | 'ignore' | 'unignore' | 'delete', providerId?: string) {
    return this.request(`/unmapped/${fileId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, providerId }),
    });
  }

  async bulkMapUnmappedFiles(items: Array<{ id: number, providerId: string }>) {
    return this.request(`/unmapped/bulk-map`, {
      method: 'POST',
      body: JSON.stringify({ items }),
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

  async updateArtistPath(artistId: string, updates: {
    path?: string;
    moveFiles?: boolean;
    applyNamingTemplate?: boolean;
  }) {
    return this.request(`/v1/artist/${artistId}/path`, {
      method: 'POST',
      body: JSON.stringify(updates),
    });
  }

  async curateArtist(artistId: string) {
    return this.request(`/v1/artist/${artistId}/curate`, { method: 'POST' });
  }

  async toggleArtistMonitored(artistId: string, monitored: boolean) {
    return this.updateArtist(artistId, { monitored });
  }

  async deleteArtist(artistId: string) {
    return this.request(`/v1/artist/${artistId}`, { method: 'DELETE' });
  }

  async importFollowedArtists(providerId?: string | null) {
    return this.request('/v1/artist/import-followed', {
      method: 'POST',
      body: JSON.stringify(providerId ? { providerId } : {}),
    });
  }

  // Download queue endpoints
  async getQueue(params?: { limit?: number; offset?: number }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(`/v1/queue${query ? `?${query}` : ''}`, {}, parseQueueListResponseContract);
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

  async getQueueHistory(params?: { limit?: number; offset?: number; timeoutMs?: number | null }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
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

  async getTasks(params?: {
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
    return this.request(`/v1/queue/tasks${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseActivityListResponseContract);
  }

  async getSystemTasks(): Promise<SystemTaskContract[]> {
    return this.request('/system-task', {}, parseSystemTaskListContract);
  }

  async updateSystemTask(id: string, updates: UpdateSystemTaskRequestContract): Promise<SystemTaskContract> {
    return this.request(`/system-task/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }, parseSystemTaskContract);
  }

  async runSystemTask(id: string): Promise<RunSystemTaskResponseContract> {
    return this.request(`/system-task/${id}/run`, {
      method: 'POST',
    }, parseRunSystemTaskResponseContract);
  }

  async getHistoryEvents(params?: {
    limit?: number;
    offset?: number;
    artistId?: number;
    albumId?: number;
    mediaId?: number;
    eventType?: HistoryEventItemContract['eventType'];
  }): Promise<ListHistoryEventsResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    if (params?.artistId !== undefined) queryParams.set('artistId', params.artistId.toString());
    if (params?.albumId !== undefined) queryParams.set('albumId', params.albumId.toString());
    if (params?.mediaId !== undefined) queryParams.set('mediaId', params.mediaId.toString());
    if (params?.eventType) queryParams.set('eventType', params.eventType);
    const query = queryParams.toString();
    return this.request(`/v1/history${query ? `?${query}` : ''}`, {}, parseHistoryEventsResponseContract);
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



  async startMonitoring() {
    return this.request('/monitoring/start', { method: 'POST' });
  }

  async stopMonitoring() {
    return this.request('/monitoring/stop', { method: 'POST' });
  }

  async triggerAllMonitoring() {
    return this.request('/monitoring/trigger-all', { method: 'POST' });
  }

  async checkMonitoringNow() {
    return this.request('/monitoring/check', { method: 'POST' });
  }

  async downloadMissing() {
    return this.request('/monitoring/download-missing', { method: 'POST' });
  }

  async queueCuration() {
    return this.request('/monitoring/curate', { method: 'POST' });
  }

  // Streaming endpoints using Server-Sent Events (SSE)
  createImportFollowedStream(
    onEvent: (event: string, data: any) => void,
    onError?: (error: Error) => void,
    providerId?: string | null,
  ): EventSource {
    // Add auth token to URL query params since EventSource can't send custom headers
    let url = `${this.baseUrl}${API_PREFIX}/artists/import-followed-stream`;
    const queryParams = new URLSearchParams();
    if (providerId) queryParams.set('providerId', providerId);
    if (this.authToken) {
      queryParams.set('token', this.authToken);
    }
    const query = queryParams.toString();
    if (query) {
      url += `?${query}`;
    }
    const eventSource = createManagedEventSource(url);

    // Set up event listeners for all event types
    const eventTypes = ['status', 'total', 'artist-progress', 'artist-added', 'artist-updated', 'artist-skipped', 'complete', 'error'];

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
      if (isExpectedEventSourceClose(eventSource)) {
        return;
      }

      console.error('SSE error:', error);
      if (onError) {
        onError(new Error('Stream connection failed'));
      }
      eventSource.close();
    };

    return eventSource;
  }

  createMonitoringCheckStream(onEvent: (event: string, data: any) => void, onError?: (error: Error) => void): EventSource {
    // Add auth token to URL query params since EventSource can't send custom headers
    let url = `${this.baseUrl}${API_PREFIX}/monitoring/check-stream`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    const eventSource = createManagedEventSource(url);

    // Set up event listeners for all event types
    const eventTypes = ['status', 'total', 'artist-progress', 'artist-checked', 'artist-complete', 'album-found', 'album-queued', 'complete', 'error'];

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
      if (isExpectedEventSourceClose(eventSource)) {
        return;
      }

      console.error('SSE error:', error);
      if (onError) {
        onError(new Error('Stream connection failed'));
      }
      eventSource.close();
    };

    return eventSource;
  }

  createArtistScanStream(artistId: string, onEvent: (event: string, data: any) => void, onError?: (error: Error) => void): EventSource {
    // Add auth token to URL query params since EventSource can't send custom headers
    let url = `${this.baseUrl}${API_PREFIX}/artists/${artistId}/scan`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    const eventSource = createManagedEventSource(url);

    // Set up event listeners for all event types
    const eventTypes = ['status', 'total', 'album-progress', 'album-added', 'album-skipped', 'complete', 'error'];

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
      if (isExpectedEventSourceClose(eventSource)) {
        return;
      }

      console.error('SSE error:', error);
      if (onError) {
        onError(new Error('Stream connection failed'));
      }
      eventSource.close();
    };

    return eventSource;
  }

  /**
   * Create SSE stream for real-time download progress updates
   */
  createDownloadProgressStream(
    onEvent: (event: string, data: any) => void,
    onError?: (error: Error) => void
  ): EventSource {
    let url = `${this.baseUrl}/api/queue/progress-stream`;
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
    let url = `${this.baseUrl}${API_PREFIX}/events`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    const eventSource = createManagedEventSource(url);

    // The backend emits events with names like "job.updated", "file.deleted", etc.
    // EventSource doesn't have a wildcard listener, so we rely on the specific message events.
    // However, the standard `onmessage` doesn't fire if the server specifies an `event: customName` header.
    // Therefore we bind to the known AppEvent enum values from the backend.

    const knownEvents = [
      'job.added', 'job.updated', 'job.deleted', 'queue.cleared',
      'history.added',
      'artist.scanned', 'album.scanned', 'rescan.completed', 'config.updated',
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


  /**
   * Execute a system command (Phase 1 scheduler commands)
   * POST /api/command
   * Examples: BulkRefreshArtist, DownloadMissingForce, RescanAllRoots, CheckHealth,
   * CompactDatabase, CleanupTempFiles, UpdateLibraryMetadata, ConfigPrune
   */
  async executeCommand(commandName: string): Promise<{ id: number }> {
    return this.request('/v1/command', {
      method: 'POST',
      body: JSON.stringify({ name: commandName }),
    });
  }

  // Import endpoints handled earlier in this class
}

export const api = new ApiClient(API_BASE_URL);
