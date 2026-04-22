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

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...requestOptions.headers,
    };

    // Add auth token if available
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
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

  async logoutTidal() {
    return this.request('/auth/logout', { method: 'POST' });
  }

  // Config endpoints
  async getQualityConfig(): Promise<QualityConfigContract> {
    return this.request('/config/quality', {}, parseQualityConfigContract);
  }

  async updateQualityConfig(config: Partial<QualityConfigContract>) {
    return this.request('/config/quality', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getAccountConfig(): Promise<AccountConfigContract> {
    return this.request('/config/account', {}, parseAccountConfigContract);
  }

  async updateAccountConfig(config: Partial<AccountConfigContract>) {
    return this.request('/config/account', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getAppConfig(): Promise<PublicAppConfigContract> {
    return this.request('/config/app', {}, parsePublicAppConfigContract);
  }

  async updateAppConfig(config: Partial<PublicAppConfigContract>) {
    return this.request('/config/app', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getAppReleaseInfo(): Promise<AppReleaseInfoContract> {
    return this.request('/config/about', {}, parseAppReleaseInfoContract);
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
    return this.request('/config/curation', {}, parseFilteringConfigContract);
  }

  async updateCurationConfig(config: Partial<FilteringConfigContract>) {
    return this.request('/config/curation', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getMetadataConfig(): Promise<MetadataConfigContract> {
    return this.request('/config/metadata', {}, parseMetadataConfigContract);
  }

  async updateMetadataConfig(config: Partial<MetadataConfigContract>) {
    return this.request('/config/metadata', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getPathConfig(): Promise<PathConfigContract> {
    return this.request('/config/path', {}, parsePathConfigContract);
  }

  async updatePathConfig(config: Partial<PathConfigContract>) {
    return this.request('/config/path', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getNamingConfig(): Promise<NamingConfigContract> {
    return this.request('/config/naming', {}, parseNamingConfigContract);
  }

  async updateNamingConfig(config: Partial<NamingConfigContract>) {
    return this.request('/config/naming', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  // Config TOML raw content endpoints
  async getConfigToml() {
    return this.request('/config/toml');
  }

  async updateConfigToml(toml: string) {
    return this.request('/config/toml', {
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
      `/artists${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseArtistsListResponseContract,
    );
  }

  async getStats(options: RequestControlOptions = {}): Promise<LibraryStatsContract> {
    return this.request('/stats', options, parseLibraryStatsContract);
  }

  async getArtist<T = unknown>(artistId: string) {
    return this.request<T>(`/artists/${artistId}`);
  }

  async getArtistPage(artistId: string) {
    return this.request(`/artists/${artistId}/page`);
  }

  async getArtistPageDB(artistId: string, options: RequestControlOptions = {}) {
    return this.request(`/artists/${artistId}/page-db`, options);
  }

  async getArtistDetail(artistId: string) {
    return this.request(`/artists/${artistId}/detail`);
  }


  async addArtist(tidalId: string) {
    return this.request(`/artists`, {
      method: 'POST',
      body: JSON.stringify({ id: tidalId }),
    });
  }

  // Monitor endpoints - for explicit "Monitor" button action
  async monitorArtist(artistId: string) {
    return this.request(`/artists/${artistId}/monitor`, { method: 'POST' });
  }

  async monitorAlbum(albumId: string) {
    return this.request(`/albums/${albumId}/monitor`, { method: 'POST' });
  }

  async getArtistAlbums(artistId: string, qualityFilter: 'all' | 'stereo' | 'atmos' = 'all') {
    return this.request(`/artists/${artistId}/albums?quality_filter=${qualityFilter}`);
  }

  async getArtistAlbumsFromTidal(artistId: string) {
    return this.request(`/tidal/artists/${artistId}/albums`);
  }

  async getTidalAlbumTracks(albumId: string) {
    const tracks = await this.request(`/tidal/albums/${albumId}/tracks`) as any[];
    return Array.isArray(tracks)
      ? tracks.map((track) => ({
        ...track,
        id: String(track.id ?? track.tidal_id),
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
      `/albums${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseAlbumsListResponseContract,
    );
  }

  async getAlbum<T = unknown>(albumId: string, options: RequestControlOptions = {}) {
    return this.request<T>(`/albums/${albumId}`, options);
  }

  async getAlbumPage(albumId: string, options: RequestControlOptions = {}): Promise<AlbumPageContract> {
    return this.request(`/albums/${albumId}/page`, options, parseAlbumPageContract);
  }

  async addAlbum(tidalId: string) {
    return this.request(`/albums`, {
      method: 'POST',
      body: JSON.stringify({ id: tidalId }),
    });
  }

  async updateAlbum(albumId: string, updates: any) {
    return this.request(`/albums/${albumId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteAlbum(albumId: string) {
    return this.request(`/albums/${albumId}`, { method: 'DELETE' });
  }

  async getAlbumTracks(albumId: string, options: RequestControlOptions = {}): Promise<AlbumTrackContract[]> {
    return this.request(`/albums/${albumId}/tracks`, options, parseAlbumTracksContract);
  }

  async getAlbumSimilar(albumId: string, options: RequestControlOptions = {}): Promise<SimilarAlbumContract[]> {
    return this.request(`/albums/${albumId}/similar`, options, parseSimilarAlbumsContract);
  }

  async getAlbumVersions(albumId: string, options: RequestControlOptions = {}): Promise<AlbumVersionContract[]> {
    return this.request(`/albums/${albumId}/versions`, options, parseAlbumVersionsContract);
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
    return this.request(`/tracks${query ? `?${query}` : ''}`, {
      timeoutMs: params?.timeoutMs ?? null,
      signal: params?.signal,
    });
  }

  async getTrackFiles(trackId: string) {
    return this.request(`/tracks/${trackId}/files`);
  }

  async getTrack(trackId: string) {
    return this.request(`/tracks/${trackId}`);
  }

  async addTrack(tidalId: string) {
    return this.request(`/tracks`, {
      method: 'POST',
      body: JSON.stringify({ id: tidalId }),
    });
  }

  async updateTrack(trackId: string, updates: any) {
    return this.request(`/tracks/${trackId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteTrack(trackId: string) {
    return this.request(`/tracks/${trackId}`, { method: 'DELETE' });
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
      `/videos${query ? `?${query}` : ''}`,
      { timeoutMs: params?.timeoutMs ?? null, signal: params?.signal },
      parseVideosListResponseContract,
    );
  }

  async getVideo(videoId: string): Promise<VideoDetailContract> {
    return this.request(`/videos/${videoId}`, {}, parseVideoDetailContract);
  }

  async addVideo(tidalId: string) {
    return this.request(`/videos`, {
      method: 'POST',
      body: JSON.stringify({ id: tidalId }),
    });
  }

  async updateVideo(videoId: string, updates: VideoUpdateContract) {
    return this.request(`/videos/${videoId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteVideo(videoId: string) {
    return this.request(`/videos/${videoId}`, { method: 'DELETE' });
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
    const url = `${this.baseUrl}${API_PREFIX}/library-files/scan-roots-now`;
    // SSE via POST requires fetch, but we use EventSource pattern with a workaround
    // Use fetch-based SSE reader instead
    return null as any; // Handled by dedicated hook
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
   * Get a signed TIDAL stream URL for preview playback.
   * The backend proxies the actual CDN bytes so no TIDAL token leaks to the client.
   */
  async signTidalStream(trackId: string, preferredQuality?: string | null): Promise<string> {
    const query = preferredQuality ? `?quality=${encodeURIComponent(preferredQuality)}` : '';
    const data = await this.request(`/playback/stream/sign/${trackId}${query}`);
    // The returned url is relative (/api/playback/stream/play/...), make it absolute
    return `${this.baseUrl}${(data as any).url}`;
  }

  async signTidalVideoStream(videoId: string): Promise<string> {
    const data = await this.request(`/playback/video/sign/${videoId}`);
    return `${this.baseUrl}${(data as any).url}`;
  }

  async getFileContent(filePath: string): Promise<string> {
    const url = `${this.baseUrl}${API_PREFIX}/library-files/content?path=${encodeURIComponent(filePath)}`;
    const headers: HeadersInit = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Failed to fetch content: ${resp.status}`);
    return resp.text();
  }

  // Playlist endpoints
  async getPlaylists(params?: { limit?: number; offset?: number; search?: string; monitored?: boolean }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());
    if (params?.search) queryParams.set('search', params.search);
    if (params?.monitored !== undefined) queryParams.set('monitored', params.monitored.toString());
    const query = queryParams.toString();
    return this.request(`/playlists${query ? `?${query}` : ''}`);
  }

  async getPlaylist(playlistId: string) {
    return this.request(`/playlists/${playlistId}`);
  }

  async addPlaylist(tidalIdOrUrl: string) {
    const body = tidalIdOrUrl.includes('/')
      ? { url: tidalIdOrUrl }
      : { id: tidalIdOrUrl };
    return this.request(`/playlists`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updatePlaylist(playlistId: string, updates: any) {
    return this.request(`/playlists/${playlistId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deletePlaylist(playlistId: string) {
    return this.request(`/playlists/${playlistId}`, { method: 'DELETE' });
  }

  // Manual import / unmapped file endpoints
  async getUnmappedFiles(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(`/unmapped${query ? `?${query}` : ''}`);
  }

  async actionUnmappedFile(fileId: number, action: 'map' | 'ignore' | 'unignore' | 'delete', tidalId?: string) {
    return this.request(`/unmapped/${fileId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, tidalId }),
    });
  }

  async bulkMapUnmappedFiles(items: Array<{ id: number, tidalId: string }>) {
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

  async syncPlaylist(playlistId: string) {
    return this.request(`/playlists/${playlistId}/sync`, { method: 'POST' });
  }

  async downloadPlaylist(playlistId: string) {
    return this.request(`/playlists/${playlistId}/download`, { method: 'POST' });
  }

  async importUserPlaylists() {
    return this.request(`/playlists/import-user`, { method: 'POST' });
  }

  async scanArtist(artistId: string, options?: { forceUpdate?: boolean }) {
    return this.request(`/artists/${artistId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ forceUpdate: Boolean(options?.forceUpdate) }),
    });
  }

  async getArtistActivity(artistId: string, options: RequestControlOptions = {}) {
    return this.request(`/artists/${artistId}/activity`, options);
  }

  async updateArtist(artistId: string, updates: any) {
    return this.request(`/artists/${artistId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async updateArtistPath(artistId: string, updates: {
    path?: string;
    moveFiles?: boolean;
    applyNamingTemplate?: boolean;
  }) {
    return this.request(`/artists/${artistId}/path`, {
      method: 'POST',
      body: JSON.stringify(updates),
    });
  }

  async processRedundancy(artistId: string) {
    return this.request(`/artists/${artistId}/redundancy`, { method: 'POST' });
  }

  async toggleArtistMonitored(artistId: string, monitored: boolean) {
    return this.updateArtist(artistId, { monitored });
  }

  async deleteArtist(artistId: string) {
    return this.request(`/artists/${artistId}`, { method: 'DELETE' });
  }

  async importFollowedArtists() {
    return this.request('/artists/import-followed', { method: 'POST' });
  }

  // Download queue endpoints
  async getQueue(params?: { limit?: number; offset?: number }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(`/queue${query ? `?${query}` : ''}`, {}, parseQueueListResponseContract);
  }

  async getQueueDetails(params?: {
    artistId?: string;
    albumIds?: string[];
    tidalIds?: string[];
  }): Promise<QueueDetailsResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.artistId) queryParams.set('artistId', params.artistId);
    if (params?.albumIds && params.albumIds.length > 0) queryParams.set('albumIds', params.albumIds.join(','));
    if (params?.tidalIds && params.tidalIds.length > 0) queryParams.set('tidalIds', params.tidalIds.join(','));
    const query = queryParams.toString();
    return this.request(`/queue/details${query ? `?${query}` : ''}`, {}, parseQueueDetailsResponseContract);
  }

  async getQueueStatus(): Promise<QueueStatusContract> {
    return this.request('/queue/status', {}, parseQueueStatusContract);
  }

  async getQueueHistory(params?: { limit?: number; offset?: number; timeoutMs?: number | null }): Promise<QueueListResponseContract> {
    const queryParams = new URLSearchParams();
    if (params?.limit !== undefined) queryParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) queryParams.set('offset', params.offset.toString());
    const query = queryParams.toString();
    return this.request(`/queue/history${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseQueueListResponseContract);
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
    return this.request(`/activity${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseActivityListResponseContract);
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
    return this.request(`/tasks${query ? `?${query}` : ''}`, { timeoutMs: params?.timeoutMs ?? null }, parseActivityListResponseContract);
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
    return this.request(`/history${query ? `?${query}` : ''}`, {}, parseHistoryEventsResponseContract);
  }

  async addToQueue(url: string, type: string, tidalId?: string) {
    return this.request('/queue', {
      method: 'POST',
      body: JSON.stringify({ url, type, tidalId }),
    });
  }

  async retryQueueItem(id: number) {
    return this.request<{
      action?: 'retry-download' | 'retry-import' | 'queue-redownload';
      message: string;
      jobId?: number;
      sourceJobId?: number;
    }>(`/queue/${id}/retry`, { method: 'POST' });
  }

  async deleteQueueItem(id: number) {
    return this.request(`/queue/${id}`, { method: 'DELETE' });
  }

  async reorderQueueItems(params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number }) {
    return this.request('/queue/reorder', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async clearCompleted() {
    return this.request('/queue/clear-completed', { method: 'POST' });
  }

  async pauseQueue() {
    return this.request('/queue/pause', { method: 'POST' });
  }

  async resumeQueue() {
    return this.request('/queue/resume', { method: 'POST' });
  }

  async processMonitoredItems(artistId?: string) {
    return this.request('/tasks/process-monitored', {
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
  createImportFollowedStream(onEvent: (event: string, data: any) => void, onError?: (error: Error) => void): EventSource {
    // Add auth token to URL query params since EventSource can't send custom headers
    let url = `${this.baseUrl}${API_PREFIX}/artists/import-followed-stream`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    const eventSource = new EventSource(url, { withCredentials: false });

    // Set up event listeners for all event types
    const eventTypes = ['status', 'total', 'artist-progress', 'artist-added', 'artist-skipped', 'albums-added', 'complete', 'error'];

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
    const eventSource = new EventSource(url, { withCredentials: false });

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
    const eventSource = new EventSource(url, { withCredentials: false });

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

    const eventSource = new EventSource(url, { withCredentials: false });

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
      if (eventSource.readyState === EventSource.CLOSED) {
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
    const eventSource = new EventSource(url, { withCredentials: false });

    // The backend emits events with names like "job.updated", "file.deleted", etc.
    // EventSource doesn't have a wildcard listener, so we rely on the specific message events.
    // However, the standard `onmessage` doesn't fire if the server specifies an `event: customName` header.
    // Therefore we bind to the known AppEvent enum values from the backend.

    const knownEvents = [
      'job.added', 'job.updated', 'job.deleted', 'queue.cleared',
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
      if (eventSource.readyState === EventSource.CLOSED) {
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
    return this.request('/command', {
      method: 'POST',
      body: JSON.stringify({ name: commandName }),
    });
  }

  // Import endpoints handled earlier in this class
}

export const api = new ApiClient(API_BASE_URL);
