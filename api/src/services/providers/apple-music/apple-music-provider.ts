import fs from "fs";
import path from "path";
import {
  StreamingProvider,
  ProviderArtworkRequest,
  ProviderAlbum,
  ProviderArtist,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
  ProviderAuthStatus,
  ProviderDownloadOptions,
  ProviderCapabilities,
  ProviderDiagnosticResult,
  ProviderManifest,
  ProviderImportSelection,
  ProviderImportSource,
} from "../streaming-provider.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";
import {
  AppleMusicAuthToken,
  clearStoredAppleMusicToken,
  loadStoredAppleMusicToken,
  resolveAppleStorefront,
  saveStoredAppleMusicToken,
  syncTokenToDownloader,
} from "./apple-music-auth.js";
import {
  getAppleAlbum,
  getAppleAlbumTracks,
  getAppleArtist,
  getAppleArtistAlbums,
  getAppleArtistVideos,
  getAppleTrack,
  getAppleVideo,
  renderAppleArtwork,
  searchApple,
} from "./apple-music-catalog.js";
import { AppleMusicApiOptions, validateAppleMusicCredentials } from "./apple-music-api.js";
import { downloadBackendRegistry } from "../../download/download-backend.js";
import {
  AppleMusicBackend,
  describeAppleDownloaderMissingPrerequisites,
  getAppleMusicDownloaderCapabilitySnapshot,
  resolveAppleMusicProviderStorefront,
} from "./apple-music-backend.js";

export class AppleMusicProvider implements StreamingProvider {
  readonly id = "apple-music";
  readonly name = "Apple Music";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/apple-music",
    auth: {
      kind: "developer-token",
      managedByApp: false,
      credentialFields: [
        {
          key: "developerToken",
          label: "Bearer/developer token",
          secret: true,
          required: false,
          helpText: "Optional Authorization bearer override. If omitted, Discogenius resolves the Apple Music web token like the downloader.",
        },
        {
          key: "mediaUserToken",
          label: "Media user token",
          secret: true,
          required: true,
          helpText: "Apple Music web cookie named media-user-token.",
        },
        {
          key: "storefront",
          label: "Storefront",
          required: false,
          helpText: "Two-letter storefront such as us, gb, nl, or jp.",
        },
      ],
    },
    integration: {
      catalogSource: "official-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "video", "playlist"],
    },
    downloadBackends: [
      {
        id: "apple-music-downloader",
        capabilities: ["stereo", "spatial", "video"],
        enabled: true,
        setupNote: "Requires zhaarey/apple-music-downloader plus its decryption wrapper and Apple Music user tokens.",
      },
    ],
    catalog: {
      search: true,
      artistCatalog: true,
      releaseOffers: true,
      videos: true,
    },
    imports: {
      supported: ["library-artists", "playlist"],
    },
    qualityMapping: {
      neutral: true,
      stereo: true,
      spatial: true,
      video: true,
    },
    diagnostics: ["auth", "catalog", "download-backend"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    // Apple's public catalog API has no followed-artists endpoint for our token.
    followedArtists: false,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: true,
    hiResStereo: true,
    spatialAudio: true,
    // Apple Music API does not expose time-synced lyrics to third-party tokens.
    lyrics: false,
    musicVideos: true,
    videoPreviews: true,
    videoDownloads: true,
    artwork: true,
    editorialMetadata: true,
    providerIds: true,
    spatialFormats: ["DOLBY_ATMOS"],
  };
  readonly qualityMapping = appleMusicQualityMapping;

  private apiOptions(): AppleMusicApiOptions {
    return {};
  }

  isAuthenticated(): boolean {
    return Boolean(loadStoredAppleMusicToken());
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = options.limit ?? 10;
    const types = options.types?.length ? options.types : ["artists", "albums", "tracks", "videos"];
    return searchApple(query, types, limit, this.apiOptions());
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return getAppleArtist(String(id), this.apiOptions());
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    return getAppleArtistAlbums(String(id), this.apiOptions());
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return getAppleArtistVideos(String(id), this.apiOptions());
  }

  async listImportSources(): Promise<ProviderImportSource[]> {
    const { getAppleImportSources } = await import("./apple-music-library.js");
    return getAppleImportSources(this.apiOptions());
  }

  async getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    const { getAppleArtistsForImportSource } = await import("./apple-music-library.js");
    return getAppleArtistsForImportSource(selection, this.apiOptions());
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return getAppleArtistAlbums(String(id), this.apiOptions());
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    const searchText = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const results = await searchApple(searchText, ["albums"], 25, this.apiOptions());
    const albums = results.albums;
    if (query.slot === "spatial") {
      return albums.filter((album) => this.isSpatial(album.qualityTags));
    }
    if (query.slot === "stereo") {
      return albums.filter((album) => !this.isSpatial(album.qualityTags));
    }
    return albums;
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return getAppleAlbum(String(id), this.apiOptions());
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    return getAppleAlbumTracks(String(id), this.apiOptions());
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    return getAppleTrack(String(id), this.apiOptions());
  }

  async getVideo(id: string | number): Promise<ProviderVideo> {
    return getAppleVideo(String(id), this.apiOptions());
  }

  async apiRequest<T = any>(endpoint: string, options?: AppleMusicApiOptions): Promise<T> {
    const { appleMusicApiRequest } = await import("./apple-music-api.js");
    return appleMusicApiRequest<T>(endpoint, options ?? this.apiOptions());
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    const size = typeof request.size === "number" ? request.size : Number(request.size) || 640;
    if (request.entityType === "album" && request.providerId != null) {
      const album = await getAppleAlbum(String(request.providerId), this.apiOptions());
      return album.cover ? this.resizeArtwork(album.cover, size) : null;
    }
    if (request.entityType === "artist" && request.providerId != null) {
      const artist = await getAppleArtist(String(request.providerId), this.apiOptions());
      return artist.picture ? this.resizeArtwork(artist.picture, size) : null;
    }
    if (request.entityType === "video" && request.providerId != null) {
      const video = await getAppleVideo(String(request.providerId), this.apiOptions());
      return video.cover ? this.resizeArtwork(video.cover, size) : null;
    }
    return null;
  }

  logout(): void {
    clearStoredAppleMusicToken();
  }

  loadToken(): AppleMusicAuthToken | null {
    return loadStoredAppleMusicToken();
  }

  async saveCredentials(credentials: Record<string, unknown>): Promise<void> {
    const developerToken = String(credentials.developerToken || credentials.developer_token || "").trim();
    const mediaUserToken = String(credentials.mediaUserToken || credentials.media_user_token || "").trim();
    const storefront = String(credentials.storefront || "").trim().toLowerCase();
    if (!mediaUserToken) {
      throw new Error("Apple Music media user token is required.");
    }
    if (storefront && !/^[a-z]{2}$/.test(storefront)) {
      throw new Error("Apple Music storefront must be a two-letter country code.");
    }
    const token: AppleMusicAuthToken = {
      developer_token: developerToken || undefined,
      media_user_token: mediaUserToken,
      storefront: storefront || resolveAppleStorefront(),
    };
    const validation = await validateAppleMusicCredentials(token);
    saveStoredAppleMusicToken({
      ...token,
      storefront: storefront || validation.storefront || token.storefront,
    });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const token = loadStoredAppleMusicToken();
    if (!token) {
      return {
        connected: false,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 0,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: false,
        canAuthenticate: true,
        user: null,
        message: "Connect your Apple Music account to access remote catalog features.",
      };
    }
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const hoursUntilExpiry = token.expires_at ? (token.expires_at - nowInSeconds) / 3600 : 0;
    const tokenExpired = token.expires_at ? hoursUntilExpiry < 0 : false;
    return {
      connected: !tokenExpired,
      tokenExpired,
      refreshTokenExpired: false,
      hoursUntilExpiry,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: !tokenExpired,
      canAuthenticate: true,
      user: token.user?.username ? { username: token.user.username } : null,
      message: tokenExpired
        ? "Your configured Apple Music bearer token has expired. Remove it or reconnect to use the auto-resolved web token."
        : undefined,
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const authStatus = await this.getAuthStatus();
    const snapshot = await getAppleMusicDownloaderCapabilitySnapshot();
    const missingPrerequisites = describeAppleDownloaderMissingPrerequisites(snapshot);
    const requiredReady = missingPrerequisites.length === 0;
    const videoReady = Boolean(snapshot.mp4DecryptAvailable);
    const downloadStatus: ProviderDiagnosticResult["status"] = requiredReady && videoReady
      ? "ok"
      : requiredReady
        ? "warning"
        : "error";

    return [
      {
        kind: "auth",
        status: authStatus.tokenExpired || authStatus.refreshTokenExpired
          ? "error"
          : authStatus.connected
            ? "ok"
            : "warning",
        message: authStatus.message || (authStatus.connected
          ? "Apple Music media-user-token is configured."
          : "Apple Music is not connected."),
        checkedAt,
        details: {
          authKind: this.manifest.auth.kind,
          managedByApp: this.manifest.auth.managedByApp,
          connected: authStatus.connected,
          tokenExpired: authStatus.tokenExpired,
          remoteCatalogAvailable: authStatus.remoteCatalogAvailable,
        },
      },
      {
        kind: "catalog",
        status: authStatus.remoteCatalogAvailable ? "ok" : "warning",
        message: authStatus.remoteCatalogAvailable
          ? "Apple Music catalog access is available."
          : "Apple Music catalog access needs a media-user-token.",
        checkedAt,
        details: {
          search: this.manifest.catalog.search,
          artistCatalog: this.manifest.catalog.artistCatalog,
          releaseOffers: this.manifest.catalog.releaseOffers,
          videos: this.manifest.catalog.videos,
          remoteCatalogAvailable: authStatus.remoteCatalogAvailable,
        },
      },
      {
        kind: "download-backend",
        status: downloadStatus,
        message: requiredReady && videoReady
          ? "Apple Music downloader, MP4Box, mp4decrypt, and wrapper ports are ready."
          : requiredReady
            ? "Apple Music audio downloads are ready, but mp4decrypt is missing for music videos."
            : `Apple Music downloader provisioning is incomplete: missing ${missingPrerequisites.join(", ")}.`,
        checkedAt,
        details: { ...snapshot, missingPrerequisites },
      },
    ];
  }

  getMediaUrl(type: string, providerId: string): string {
    const segment = type === "track" ? "song" : type === "video" ? "music-video" : type;
    return `https://music.apple.com/${resolveAppleMusicProviderStorefront()}/${segment}/${providerId}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    // Canonical Apple URLs carry a slug segment (".../song/<slug>/<id>"); our own
    // getMediaUrl() emits the slug-less form (".../<storefront>/song/<id>").
    // Accept both so a URL built here round-trips back through the parser.
    const match = url.match(
      /^https?:\/\/music\.apple\.com\/(?:[a-z]{2}\/)?(album|song|music-video|artist)\/(?:[^/]+\/)?(\d+)/i,
    );
    if (!match) return null;
    const rawType = match[1].toLowerCase();
    const type = rawType === "song" ? "track" : rawType === "music-video" ? "video" : rawType;
    return { type, providerId: match[2] };
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    const slot = options?.qualityProfile === "spatial" || options?.quality?.toLowerCase().includes("atmos")
      ? "spatial"
      : entityType === "video"
        ? "video"
        : "stereo";
    const backend = downloadBackendRegistry.resolve(this.id, slot);
    if (!backend) {
      throw new Error(`No download backend resolved for ${this.id} and slot ${slot}`);
    }

    try {
      await fs.promises.rm(downloadPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });

    return backend.download(
      { provider: this.id, entityType, providerId, downloadPath, quality: options?.quality },
      {
        signal: options?.signal,
        onProgress: (progress) => options?.onProgress?.(progress),
      },
    );
  }

  async syncCredentials(): Promise<void> {
    syncTokenToDownloader(loadStoredAppleMusicToken());
  }

  async syncSettings(_downloadPath?: string): Promise<void> {
    // Apple downloader settings are derived from credentials (config.yaml);
    // per-job paths are passed as CLI args, so there is no global settings sync.
    syncTokenToDownloader(loadStoredAppleMusicToken());
  }

  private isSpatial(tags: string[] = []): boolean {
    return this.qualityMapping.toNeutral(tags).spatial!.length > 0;
  }

  private resizeArtwork(coverUrl: string, size: number): string {
    // Catalog mappers already render the template; if a raw template slips
    // through, render it. Otherwise return as-is.
    if (coverUrl.includes("{w}")) {
      return renderAppleArtwork({ url: coverUrl }, size) ?? coverUrl;
    }
    return coverUrl;
  }
}

export const appleMusicStreamingProvider = new AppleMusicProvider();
downloadBackendRegistry.register(new AppleMusicBackend());
