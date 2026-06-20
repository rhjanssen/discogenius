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
  ProviderCoreCapabilities,
  deriveCoreCapabilities,
} from "../streaming-provider.js";
import type { NeutralQuality } from "../provider-quality.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";
import {
  AppleMusicAuthToken,
  clearStoredAppleMusicToken,
  loadStoredAppleMusicToken,
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
import { AppleMusicApiOptions } from "./apple-music-api.js";
import { downloadBackendRegistry } from "../../download/download-backend.js";
import { AppleMusicBackend, APPLE_MUSIC_DOWNLOAD_ENABLED } from "./apple-music-backend.js";

export class AppleMusicProvider implements StreamingProvider {
  readonly id = "apple-music";
  readonly name = "Apple Music";
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    // Apple's public catalog API has no followed-artists endpoint for our token.
    followedArtists: false,
    audioPreviews: true,
    // Gated behind the live binary path (see apple-music-backend).
    audioDownloads: APPLE_MUSIC_DOWNLOAD_ENABLED,
    lossyStereo: true,
    losslessStereo: true,
    hiResStereo: true,
    spatialAudio: true,
    // Apple Music API does not expose time-synced lyrics to third-party tokens.
    lyrics: false,
    musicVideos: true,
    videoPreviews: true,
    videoDownloads: APPLE_MUSIC_DOWNLOAD_ENABLED,
    artwork: true,
    editorialMetadata: true,
    providerIds: true,
    spatialFormats: ["DOLBY_ATMOS"],
  };
  readonly coreCapabilities: ProviderCoreCapabilities = deriveCoreCapabilities(this.capabilities, {
    hasDownloadBackend: APPLE_MUSIC_DOWNLOAD_ENABLED,
  });
  readonly qualityMapping = appleMusicQualityMapping;

  toNeutralQuality(rawTags: Iterable<string | null | undefined>): NeutralQuality {
    return appleMusicQualityMapping.toNeutral(rawTags);
  }

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
        ? "Your Apple Music developer token has expired. Reconnect to access remote catalog features."
        : undefined,
    };
  }

  getMediaUrl(type: string, providerId: string): string {
    const segment = type === "track" ? "song" : type === "video" ? "music-video" : type;
    return `https://music.apple.com/${segment}/${providerId}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    // Canonical Apple URLs carry a slug segment (".../song/<slug>/<id>"); our own
    // getMediaUrl() emits the slug-less form (".../song/<id>"). Accept both so a
    // URL built here round-trips back through the parser.
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
    return this.toNeutralQuality(tags).spatial!.length > 0;
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
