import {
  StreamingProvider,
  ProviderAlbum,
  ProviderArtist,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
  ProviderAuthStatus,
  ProviderDownloadOptions,
} from "../streaming-provider.js";
import { ensureOrpheusRuntime, spawnOrpheusDownload, parseOrpheusProgress } from "../../orpheus.js";

export class AppleMusicProvider implements StreamingProvider {
  readonly id = "apple-music";
  readonly name = "Apple Music";
  readonly capabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: false,
    playlists: false,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: true,
    hiResStereo: true,
    spatialAudio: true,
    lyrics: false,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: true,
    editorialMetadata: true,
    providerIds: true,
    spatialFormats: ["DOLBY_ATMOS"],
  };

  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;

  private async getDevToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiry) {
      return this.cachedToken;
    }

    try {
      const indexResponse = await fetch("https://music.apple.com");
      const html = await indexResponse.text();

      const scriptMatch = html.match(/\/assets\/index[~-][A-Za-z0-9_]+\.js/);
      if (!scriptMatch) {
        throw new Error("Could not find index script asset in HTML");
      }

      const scriptUrl = `https://music.apple.com${scriptMatch[0]}`;
      const scriptResponse = await fetch(scriptUrl);
      const scriptText = await scriptResponse.text();

      const tokenMatch = scriptText.match(/(eyJh[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+)/);
      if (!tokenMatch) {
        throw new Error("Could not find developer JWT token in script");
      }

      this.cachedToken = tokenMatch[1];
      this.tokenExpiry = now + 12 * 60 * 60 * 1000; // Cache for 12 hours
      return this.cachedToken;
    } catch (e: any) {
      throw new Error(`Failed to extract Apple Music developer token: ${e.message}`);
    }
  }

  async apiRequest<T = any>(endpoint: string, options?: any): Promise<T> {
    const token = await this.getDevToken();
    const url = `https://amp-api.music.apple.com/v1/catalog/us${endpoint}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://music.apple.com",
        ...(options?.headers || {}),
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`Apple Music API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  isAuthenticated(): boolean {
    return true;
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    try {
      await this.getDevToken();
      return {
        connected: true,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 12,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: true,
        canAuthenticate: false,
        user: { username: "Apple Music Web" },
        message: "Connected via public Web API token",
      };
    } catch (e: any) {
      return {
        connected: false,
        tokenExpired: true,
        refreshTokenExpired: true,
        hoursUntilExpiry: 0,
        canAccessShell: false,
        canAccessLocalLibrary: false,
        remoteCatalogAvailable: false,
        canAuthenticate: false,
        message: e.message,
      };
    }
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = options.limit ?? 10;
    const types = options.types?.length ? options.types : ["artists", "albums", "tracks"];
    const typeMapping: Record<string, string> = {
      artists: "artists",
      albums: "albums",
      tracks: "songs",
    };

    const requestedTypes = types
      .map((t) => typeMapping[t])
      .filter(Boolean)
      .join(",");

    if (!requestedTypes) {
      return { artists: [], albums: [], tracks: [], videos: [] };
    }

    const term = encodeURIComponent(query);
    const searchData: any = await this.apiRequest(`/search?term=${term}&types=${requestedTypes}&limit=${limit}`);

    const results = searchData.results || {};
    return {
      artists: (results.artists?.data || []).map(this.mapArtist),
      albums: (results.albums?.data || []).map(this.mapAlbum),
      tracks: (results.songs?.data || []).map(this.mapTrack),
      videos: [],
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    const data: any = await this.apiRequest(`/artists/${id}`);
    const artist = data.data?.[0];
    if (!artist) {
      throw new Error(`Artist not found: ${id}`);
    }
    return this.mapArtist(artist);
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const data: any = await this.apiRequest(`/artists/${id}/albums`);
    return (data.data || []).map(this.mapAlbum);
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return [];
  }

  async getArtistCatalogPage(id: string | number): Promise<any> {
    return this.apiRequest(`/artists/${id}`);
  }

  async getFollowedArtists(): Promise<ProviderArtist[]> {
    return [];
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.getArtistAlbums(id);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    const term = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const searchResults = await this.search(term, { limit: 10, types: ["albums"] });
    return searchResults.albums;
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    const data: any = await this.apiRequest(`/albums/${id}`);
    const album = data.data?.[0];
    if (!album) {
      throw new Error(`Album not found: ${id}`);
    }
    return this.mapAlbum(album);
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    const data: any = await this.apiRequest(`/albums/${id}/tracks`);
    return (data.data || []).map((t: any) => this.mapTrack(t, id));
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    const data: any = await this.apiRequest(`/songs/${id}`);
    const track = data.data?.[0];
    if (!track) {
      throw new Error(`Track not found: ${id}`);
    }
    return this.mapTrack(track);
  }

  async getVideo(id: string | number): Promise<ProviderVideo> {
    throw new Error("Videos not supported on Apple Music");
  }

  async getPlaybackInfo(id: string | number, preferredQuality?: string) {
    return null;
  }

  async getVideoPlaybackInfo(id: string | number) {
    return null;
  }

  private mapArtist(item: any): ProviderArtist {
    const attrs = item.attributes || {};
    return {
      providerId: item.id,
      name: attrs.name || "Unknown Artist",
      picture: attrs.artwork?.url ? attrs.artwork.url.replace("{w}x{h}", "500x500") : null,
      url: attrs.url || "",
      popularity: attrs.popularity || 0,
      raw: item,
    };
  }

  private mapAlbum(item: any): ProviderAlbum {
    const attrs = item.attributes || {};
    const traits = attrs.audioTraits || [];
    let quality = "LOSSLESS";
    if (traits.includes("spatial") || traits.includes("atmos")) {
      quality = "DOLBY_ATMOS";
    } else if (traits.includes("hi-res-lossless")) {
      quality = "HIRES_LOSSLESS";
    }

    return {
      providerId: item.id,
      title: attrs.name || "Unknown Album",
      artist: { providerId: "", name: attrs.artistName || "Unknown Artist" },
      cover: attrs.artwork?.url ? attrs.artwork.url.replace("{w}x{h}", "600x600") : null,
      releaseDate: attrs.releaseDate || null,
      trackCount: attrs.trackCount || 0,
      volumeCount: 1,
      duration: 0,
      type: attrs.isSingle ? "SINGLE" : (attrs.trackCount < 5 ? "EP" : "ALBUM"),
      explicit: attrs.contentRating === "explicit",
      upc: attrs.upc || null,
      quality,
      qualityTags: traits,
      url: attrs.url || "",
      raw: item,
    };
  }

  private mapTrack(item: any, albumId?: string | number): ProviderTrack {
    const attrs = item.attributes || {};
    const traits = attrs.audioTraits || [];
    let quality = "LOSSLESS";
    if (traits.includes("spatial") || traits.includes("atmos")) {
      quality = "DOLBY_ATMOS";
    } else if (traits.includes("hi-res-lossless")) {
      quality = "HIRES_LOSSLESS";
    }

    return {
      providerId: item.id,
      title: attrs.name || "Unknown Track",
      artist: { providerId: "", name: attrs.artistName || "Unknown Artist" },
      album: {
        providerId: String(albumId || ""),
        title: attrs.albumName || "Unknown Album",
        artist: { providerId: "", name: attrs.artistName || "Unknown Artist" },
      },
      duration: Math.round((attrs.durationInMillis || 0) / 1000),
      trackNumber: attrs.trackNumber || 1,
      volumeNumber: attrs.discNumber || 1,
      url: attrs.url || "",
      isrc: attrs.isrc || null,
      quality,
      raw: item,
    };
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video" | "playlist",
    downloadPath: string,
    options?: ProviderDownloadOptions
  ): Promise<void> {
    let url = "";
    if (entityType === "album") {
      const album = await this.getAlbum(providerId);
      url = album.url || `https://music.apple.com/us/album/${providerId}`;
    } else if (entityType === "track") {
      const track = await this.getTrack(providerId);
      url = track.url || `https://music.apple.com/us/song/${providerId}`;
    } else {
      throw new Error(`Unsupported Apple Music entity type: ${entityType}`);
    }

    await ensureOrpheusRuntime();
    const typeArg = entityType === "track" ? "track" : "album";
    const cp = await spawnOrpheusDownload(typeArg, providerId, downloadPath, "applemusic");

    if (options?.onProgress) {
      cp.stdout?.on("data", (data: any) => {
        const str = data.toString();
        const op = parseOrpheusProgress(str);
        if (op) {
          options.onProgress!({
            progress: op.trackProgress ?? 0,
            currentFileNum: op.currentTrack,
            totalFiles: op.totalTracks,
            currentTrack: op.currentTrackName,
            trackProgress: op.trackProgress,
            statusMessage: op.statusMessage,
            state: op.isEntityComplete ? 'completed' : 'downloading',
            speed: op.speed,
            eta: op.eta,
            size: op.size,
            sizeleft: op.sizeleft,
          });
        }
      });
    }

    return new Promise<void>((resolve, reject) => {
      cp.on("close", (code: any) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Orpheus exited with code ${code}`));
        }
      });
      cp.on("error", (err: any) => {
        reject(err);
      });
    });
  }
}

export const appleMusicStreamingProvider = new AppleMusicProvider();
