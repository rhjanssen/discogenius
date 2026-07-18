import type {
  ProviderAlbum,
  ProviderArtist,
  ProviderArtworkRequest,
  ProviderAuthStatus,
  ProviderCapabilities,
  ProviderDiagnosticResult,
  ProviderDownloadOptions,
  ProviderManifest,
  ProviderPlaybackInfo,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  StreamingProvider,
} from "../streaming-provider.js";
import { downloadBackendRegistry } from "../../download/download-backend.js";
import type { SpotifyAuthStore, SpotifyCredentialInput } from "./spotify-auth.js";
import { spotifyAuthStore } from "./spotify-auth.js";
import { SpotifyApi } from "./spotify-api.js";
import { SpotifyCatalog } from "./spotify-catalog.js";
import { spotifyQualityMapping } from "./spotify-quality.js";
import { VotifyBackend, VOTIFY_PIP_REQUIREMENT } from "./votify-backend.js";

export class SpotifyProvider implements StreamingProvider {
  readonly id = "spotify";
  readonly name = "Spotify";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/spotify",
    auth: {
      kind: "external",
      managedByApp: false,
      credentialFields: [
        {
          key: "clientId",
          label: "Spotify client ID",
          required: true,
          helpText: "Client ID from a Spotify for Developers application; used only for official catalog metadata.",
        },
        {
          key: "clientSecret",
          label: "Spotify client secret",
          secret: true,
          required: true,
          helpText: "Client secret for the server-side client-credentials token flow.",
        },
        {
          key: "cookiesText",
          label: "Spotify cookies.txt",
          secret: true,
          multiline: true,
          required: false,
          helpText: "Optional Netscape-format Spotify web cookies used only by Votify downloads.",
        },
        {
          key: "cookiesPath",
          label: "Spotify cookies path",
          required: false,
          helpText: "Alternative path to a Netscape cookies.txt file visible inside the Discogenius runtime.",
        },
      ],
    },
    integration: {
      catalogSource: "official-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track"],
    },
    downloadBackends: [{
      id: "votify",
      capabilities: ["stereo"],
      enabled: true,
      setupNote: `Install ${VOTIFY_PIP_REQUIREMENT} and provide Netscape-format Spotify cookies. The baseline path is Vorbis only.`,
    }],
    catalog: {
      search: true,
      artistCatalog: true,
      releaseOffers: true,
      videos: false,
    },
    imports: { supported: [] },
    qualityMapping: {
      neutral: true,
      stereo: true,
      spatial: false,
      video: false,
    },
    diagnostics: ["auth", "catalog", "download-backend"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: false,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: false,
    hiResStereo: false,
    spatialAudio: false,
    lyrics: false,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: true,
    editorialMetadata: false,
    providerIds: true,
    stereoQuality: "Vorbis 160 kbps default (320 kbps requires Premium)",
  };
  readonly qualityMapping = spotifyQualityMapping;

  private readonly authStore: SpotifyAuthStore;
  private readonly api: SpotifyApi;
  private readonly catalog: SpotifyCatalog;
  private readonly backend: VotifyBackend;

  constructor(dependencies: {
    authStore?: SpotifyAuthStore;
    api?: SpotifyApi;
    catalog?: SpotifyCatalog;
    backend?: VotifyBackend;
  } = {}) {
    this.authStore = dependencies.authStore ?? spotifyAuthStore;
    this.api = dependencies.api ?? new SpotifyApi({ authStore: this.authStore });
    this.catalog = dependencies.catalog ?? new SpotifyCatalog(this.api);
    this.backend = dependencies.backend ?? new VotifyBackend({ authStore: this.authStore });
  }

  isAuthenticated(): boolean {
    return Boolean(this.authStore.load());
  }

  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults> {
    return this.catalog.search(query, options);
  }

  getArtist(id: string | number): Promise<ProviderArtist> {
    return this.catalog.getArtist(String(id));
  }

  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    return this.catalog.getArtistAlbums(String(id));
  }

  listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.getArtistAlbums(id);
  }

  searchReleaseGroup(request: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    return this.catalog.searchReleaseGroup(request);
  }

  getAlbum(id: string | number): Promise<ProviderAlbum> {
    return this.catalog.getAlbum(String(id));
  }

  getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    return this.catalog.getAlbumTracks(String(id));
  }

  getTrack(id: string | number): Promise<ProviderTrack> {
    return this.catalog.getTrack(String(id));
  }

  async getPlaybackInfo(id: string | number): Promise<ProviderPlaybackInfo | null> {
    const url = await this.catalog.getTrackPreviewUrl(String(id));
    return url ? { type: "bts", url } : null;
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.imageId && /^https?:\/\//i.test(request.imageId)) return request.imageId;
    if (!request.providerId) return null;
    try {
      if (request.entityType === "artist") return (await this.getArtist(request.providerId)).picture ?? null;
      if (request.entityType === "album") return (await this.getAlbum(request.providerId)).cover ?? null;
    } catch {
      return null;
    }
    return null;
  }

  async saveCredentials(credentials: Record<string, unknown>): Promise<void> {
    this.authStore.save(credentials as SpotifyCredentialInput);
    this.api.clearAccessToken();
  }

  async logout(): Promise<void> {
    this.authStore.clear();
    this.api.clearAccessToken();
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const credentials = this.authStore.load();
    const disconnected: ProviderAuthStatus = {
      connected: false,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 0,
      canAccessShell: false,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: false,
      canAuthenticate: true,
      message: "Save a Spotify client ID and client secret to enable catalog access.",
    };
    if (!credentials) return disconnected;
    try {
      await this.api.getAccessToken();
      const expiresAt = this.api.tokenSnapshot().expiresAt;
      return {
        ...disconnected,
        connected: true,
        remoteCatalogAvailable: true,
        hoursUntilExpiry: expiresAt ? Math.max(0, (expiresAt - Date.now()) / 3_600_000) : 0,
        message: "Spotify official catalog credentials are valid.",
      };
    } catch (error) {
      return {
        ...disconnected,
        tokenExpired: true,
        message: error instanceof Error ? error.message : "Spotify authentication failed.",
      };
    }
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const auth = await this.getAuthStatus();
    const download = this.backend.getCapabilitySnapshot();
    return [
      {
        kind: "auth",
        status: auth.connected ? "ok" : "error",
        message: auth.message || (auth.connected ? "Spotify catalog authentication is ready." : "Spotify catalog authentication failed."),
        checkedAt,
      },
      {
        kind: "catalog",
        status: auth.remoteCatalogAvailable ? "ok" : "disabled",
        message: auth.remoteCatalogAvailable
          ? "Spotify Web API catalog access is available."
          : "Spotify Web API catalog access needs client credentials.",
        checkedAt,
        details: { source: "official-api", clientCredentials: true },
      },
      {
        kind: "download-backend",
        status: download.binaryAvailable && download.cookiesAvailable ? "ok" : "error",
        message: download.binaryAvailable && download.cookiesAvailable
          ? "Votify and Spotify cookies are ready for Vorbis stereo downloads."
          : `Spotify downloads need ${download.installRequirement} and a readable Netscape cookies.txt file.`,
        checkedAt,
        details: { ...download },
      },
    ];
  }

  getMediaUrl(type: string, providerId: string): string {
    const normalized = type === "song" ? "track" : type;
    return `https://open.spotify.com/${normalized}/${providerId}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    const uri = url.match(/^spotify:(artist|album|track):([A-Za-z0-9]+)$/i);
    if (uri) return { type: uri[1].toLowerCase(), providerId: uri[2] };
    const web = url.match(/^https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(artist|album|track)\/([A-Za-z0-9]+)/i);
    return web ? { type: web[1].toLowerCase(), providerId: web[2] } : null;
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    await this.backend.download({
      provider: this.id,
      providerId,
      entityType,
      downloadPath,
      quality: options?.quality,
      slot: entityType === "video"
        ? "video"
        : options?.qualityProfile === "spatial"
          ? "spatial"
          : "stereo",
    }, {
      signal: options?.signal,
      onProgress: (progress) => options?.onProgress?.(progress),
    });
  }

  async syncCredentials(): Promise<void> {
    // Votify receives the provider-owned cookies path per job; no global home
    // directory or mutable downloader config is needed.
  }

  async syncSettings(): Promise<void> {
    // All output and quality flags are deterministic per invocation.
  }
}

export const spotifyVotifyBackend = new VotifyBackend();
downloadBackendRegistry.register(spotifyVotifyBackend);
export const spotifyStreamingProvider = new SpotifyProvider({ backend: spotifyVotifyBackend });
