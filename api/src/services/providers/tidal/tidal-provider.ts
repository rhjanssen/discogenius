import {
  StreamingProvider,
  ProviderArtworkRequest,
  ProviderAlbum,
  ProviderArtist,
  ProviderLyrics,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
  ProviderAuthStatus,
  ProviderDeviceLoginResult,
  ProviderDeviceLoginPollResult,
  ProviderDownloadOptions,
  ProviderImportSource,
  ProviderImportSelection,
  ProviderManifest,
} from "../streaming-provider.js";
import { tidalQualityMapping } from "./tidal-quality.js";
import * as tidal from "./tidal.js";
import { getBrowserPlaybackInfo, getVideoPlaybackInfo } from "./tidal-playback.js";
import { hasSpatialAudioQuality } from "../../../utils/spatial-audio.js";
import fs from "fs";
import path from "path";
import { db } from "../../../database.js";
import { syncTiddlSettings } from "./tiddl.js";
import { downloadBackendRegistry } from "../../download/download-backend.js";
import { TiddlBackend } from "./tiddl-backend.js";
import { syncStoredTidalTokenToDownloaders } from "./tidal-auth.js";

export type TidalAlbumDownloadTrackInfo = {
  title: string;
  version?: string | null;
  track_num: number | null;
  volume_num: number | null;
  artist_name?: string | null;
};

export function getTidalAlbumDownloadTrackInfo(providerIds: string[]): TidalAlbumDownloadTrackInfo[] {
  const albumIds = providerIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (albumIds.length === 0) {
    return [];
  }

  const values = albumIds.map(() => "(?, ?)").join(", ");
  const params = albumIds.flatMap((albumId, index) => [albumId, index]);
  const canonicalRows = db.prepare(`
    WITH input_albums(provider_id, ord) AS (
      VALUES ${values}
    )
    SELECT
      track.title,
      NULL AS version,
      track.position AS track_num,
      COALESCE(track.medium_position, 1) AS volume_num,
      COALESCE(track_credit.credited_name, recording_artist.name, release_artist.name) AS artist_name,
      input_albums.ord
    FROM input_albums
    JOIN ProviderItems provider_release
      ON provider_release.provider = 'tidal'
     AND provider_release.entity_type = 'release'
     AND CAST(provider_release.provider_id AS TEXT) = input_albums.provider_id
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = provider_release.id
     AND release_match.match_state = 'accepted'
    JOIN AlbumEditions release
      ON release.id = release_match.edition_id
    JOIN Tracks track
      ON track.album_edition_id = release.id
    LEFT JOIN Recordings recording
      ON recording.id = track.recording_id
    LEFT JOIN TrackArtistCredits track_credit
      ON track_credit.track_id = track.id
     AND track_credit.ordinal = 0
    LEFT JOIN ArtistMetadata recording_artist
      ON recording_artist.id = recording.artist_metadata_id
    LEFT JOIN ArtistMetadata release_artist
      ON release_artist.id = release.artist_metadata_id
    WHERE recording.is_video = 0
    ORDER BY input_albums.ord, track.medium_position, track.position, track.id
  `).all(...params) as Array<TidalAlbumDownloadTrackInfo & { ord: number }>;

  return canonicalRows.map(({ ord: _ord, ...row }) => row);
}

export class TidalProvider implements StreamingProvider {
  readonly id = "tidal";
  readonly name = "TIDAL";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/tidal",
    auth: {
      kind: "oauth-device",
      managedByApp: true,
    },
    integration: {
      catalogSource: "web-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "video", "playlist"],
    },
    downloadBackends: [
      {
        id: "tiddl",
        capabilities: ["stereo", "spatial", "video"],
        enabled: true,
      },
    ],
    catalog: {
      search: true,
      artistCatalog: true,
      releaseOffers: true,
      videos: true,
    },
    imports: {
      supported: ["followed-artists", "playlist", "favorite-tracks", "mix"],
    },
    qualityMapping: {
      neutral: true,
      stereo: true,
      spatial: true,
      video: true,
    },
    diagnostics: ["auth", "catalog", "download-backend", "rate-limit"],
  };
  readonly capabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: true,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: false,
    losslessStereo: true,
    hiResStereo: true,
    spatialAudio: true,
    lyrics: true,
    musicVideos: true,
    videoPreviews: true,
    videoDownloads: true,
    artwork: true,
    editorialMetadata: true,
    providerIds: true,
    spatialFormats: ["DOLBY_ATMOS"],
    stereoQuality: "Up to MAX (24-bit / 192 kHz)",
    spatialQuality: "Dolby Atmos",
    videoQuality: "Up to FHD (1080p)",
    maxVideoResolution: 1080,
  };
  readonly qualityMapping = tidalQualityMapping;

  isAuthenticated(): boolean {
    return Boolean(tidal.loadToken()?.access_token);
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = options.limit ?? 10;
    const types = options.types?.length ? options.types : ["artists", "albums", "tracks", "videos"];
    const results = await tidal.searchTidal(query, types, limit);
    const items = Array.isArray(results)
      ? results
      : [
        ...(results.artists?.items || []),
        ...(results.albums?.items || []),
        ...(results.tracks?.items || []),
        ...(results.videos?.items || []),
      ];

    return {
      artists: items.filter((item: any) => item?.type === "artist").map((item: any) => this.mapArtist(item)),
      albums: items.filter((item: any) => item?.type === "album").map((item: any) => this.mapAlbum(item)),
      tracks: items.filter((item: any) => item?.type === "track").map((item: any) => this.mapTrack(item)),
      videos: items.filter((item: any) => item?.type === "video").map((item: any) => this.mapVideo(item)),
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return this.mapArtist(await tidal.getArtist(String(id)));
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    return this.listArtistReleaseOffers(id);
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return (await tidal.getArtistVideos(String(id))).map((video: any) => this.mapVideo(video));
  }

  async listImportSources(): Promise<ProviderImportSource[]> {
    const sources: ProviderImportSource[] = [
      {
        category: "followed-artists",
        label: "Followed artists",
        description: "Artists you follow on TIDAL",
        requiresListSelection: false,
      },
      {
        category: "favorite-tracks",
        label: "Favorite tracks",
        description: "Distinct artists from your liked tracks",
        requiresListSelection: false,
      },
    ];

    // Playlists and home-screen mixes are best-effort: a list fetch failing
    // shouldn't sink the whole source list, it just hides that category.
    try {
      const playlists = await tidal.getUserPlaylists();
      if (playlists.length > 0) {
        sources.push({
          category: "playlist",
          label: "Playlists",
          description: "Artists from a playlist's tracks",
          requiresListSelection: true,
          lists: playlists.map((playlist) => ({
            id: playlist.id,
            title: playlist.title,
            subtitle: playlist.itemCount != null ? `${playlist.itemCount} tracks` : null,
            image: playlist.image,
            itemCount: playlist.itemCount,
          })),
        });
      }
    } catch (error) {
      console.warn("[TidalProvider] Failed to list user playlists for import:", error);
    }

    try {
      const home = await tidal.getHomeImportLists();
      if (home.length > 0) {
        sources.push({
          category: "mix",
          label: "Mixes & featured",
          description: "Artists from a mix or featured playlist on your start screen",
          requiresListSelection: true,
          lists: home.map((entry) => ({
            id: entry.id,
            title: entry.title,
            subtitle: entry.subtitle,
            image: entry.image,
          })),
        });
      }
    } catch (error) {
      console.warn("[TidalProvider] Failed to list home mixes for import:", error);
    }

    return sources;
  }

  async getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    let raw: any[];
    switch (selection.category) {
      case "followed-artists":
        raw = await tidal.getFollowedArtists();
        break;
      case "favorite-tracks":
        raw = await tidal.getFavoriteTrackArtists();
        break;
      case "playlist":
        if (!selection.listId) throw new Error("A playlist must be selected");
        raw = await tidal.getPlaylistArtists(selection.listId);
        break;
      case "mix":
        if (!selection.listId) throw new Error("A mix or playlist must be selected");
        raw = await tidal.getHomeListArtists(selection.listId);
        break;
      default:
        throw new Error(`Unsupported import source: ${selection.category}`);
    }
    return raw.map((artist) => this.mapArtist(artist));
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return (await tidal.getArtistAlbums(String(id))).map((album: any) => this.mapAlbum(album));
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    const searchText = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const results = await tidal.searchTidal(searchText, ["ALBUMS"], 25);
    const items = Array.isArray(results) ? results : results.albums?.items || [];
    const albums: ProviderAlbum[] = items.map((album: any) => this.mapAlbum(album));
    if (query.slot === "spatial") {
      return albums.filter((album) => this.isSpatialQuality(album.quality, album.qualityTags));
    }
    if (query.slot === "stereo") {
      return albums.filter((album) => !this.isSpatialQuality(album.quality, album.qualityTags));
    }
    return albums;
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return this.mapAlbum(await tidal.getAlbum(String(id)));
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    return (await tidal.getAlbumTracks(String(id))).map((track: any) => this.mapTrack(track));
  }

  async getAlbumTracksBulk(ids: Array<string | number>): Promise<Map<string, ProviderTrack[]>> {
    const raw = await tidal.getAlbumTracksBulk(ids.map((id) => String(id)));
    const mapped = new Map<string, ProviderTrack[]>();
    for (const [albumId, tracks] of raw) {
      mapped.set(albumId, tracks.map((track: any) => this.mapTrack(track)));
    }
    return mapped;
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    return this.mapTrack(await tidal.getTrack(String(id)));
  }

  async getVideo(id: string | number): Promise<ProviderVideo> {
    return this.mapVideo(await tidal.getVideo(String(id)));
  }

  async getPlaybackInfo(id: string | number, preferredQuality?: string) {
    return getBrowserPlaybackInfo(String(id), preferredQuality);
  }

  async getVideoPlaybackInfo(id: string | number) {
    return getVideoPlaybackInfo(String(id));
  }

  async getArtistBio(id: string | number): Promise<string | null> {
    const res = await tidal.getArtistBio(String(id));
    return res?.text ?? null;
  }

  async getAlbumReview(id: string | number): Promise<string | null> {
    const res = await tidal.getAlbumReview(String(id));
    return res?.text ?? null;
  }

  async getAlbumCredits(id: string | number): Promise<any[]> {
    const res = await tidal.getAlbumCredits(String(id));
    return Array.isArray(res) ? res : [];
  }

  async getAlbumTrackCredits(id: string | number): Promise<Map<string, any[]>> {
    return tidal.getAlbumItemsCredits(String(id));
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.entityType === "album") {
      if (request.imageId) {
        return this.tidalImageUrl("images", request.imageId, this.normalizeSquareSize(request.size, 640));
      }
      const album = await tidal.getAlbum(String(request.providerId || ""));
      return this.tidalImageUrl("images", album?.cover, this.normalizeSquareSize(request.size, "origin"));
    }

    if (request.entityType === "artist") {
      if (request.imageId) {
        return this.tidalImageUrl("images", request.imageId, this.normalizeSquareSize(request.size, 750));
      }
      const artist = await tidal.getArtist(String(request.providerId || ""));
      return this.tidalImageUrl("images", artist?.picture, this.normalizeSquareSize(request.size, 750));
    }

    if (request.entityType === "video") {
      if (request.imageId) {
        return this.tidalImageUrl("images", request.imageId, this.normalizeVideoSize(request.size));
      }
      const video = await tidal.getVideo(String(request.providerId || ""));
      return this.tidalImageUrl("images", video?.image_id, this.normalizeVideoSize(request.size));
    }

    if (request.entityType === "albumVideoCover") {
      return this.tidalImageUrl("videos", request.imageId, this.normalizeSquareSize(request.size, "origin"), "mp4");
    }

    return null;
  }

  async getLyrics(trackId: string | number): Promise<ProviderLyrics | null> {
    try {
      const cc = tidal.getCountryCode();
      const data = await tidal.tidalApiRequest(`/tracks/${trackId}/lyrics?countryCode=${cc}`) as any;
      return {
        text: data?.lyrics || "",
        subtitles: data?.subtitles || "",
        provider: data?.lyricsProvider || this.name,
        raw: data,
      };
    } catch {
      return null;
    }
  }

  logout() {
    return tidal.logout();
  }

  loadToken() {
    return tidal.loadToken();
  }

  async refreshProviderToken() {
    return tidal.refreshTidalToken();
  }

  shouldRefreshToken() {
    return tidal.shouldRefreshToken(tidal.loadToken());
  }

  getRateLimitMetrics() {
    return tidal.getRateLimitMetrics();
  }

  getCountryCode() {
    return tidal.getCountryCode();
  }

  async apiRequest<T = any>(endpoint: string, options?: any): Promise<T> {
    const useV2 = typeof endpoint === "string" && endpoint.startsWith("/v2/");
    const normalizedEndpoint = useV2 ? endpoint.slice(3) : endpoint;
    return (useV2
      ? tidal.tidalApiRequestV2(normalizedEndpoint, options)
      : tidal.tidalApiRequest(normalizedEndpoint)) as Promise<T>;
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    try {
      let token = tidal.loadToken();
      let tokenExpired = false;
      let refreshTokenExpired = false;
      let hoursUntilExpiry = 0;

      if (!token?.access_token) {
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
          message: "Connect your TIDAL account to access remote catalog features.",
        };
      }

      if (token.expires_at) {
        const nowInSeconds = Math.floor(Date.now() / 1000);
        hoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;
        tokenExpired = hoursUntilExpiry < 0;

        if (tokenExpired) {
          await tidal.refreshTidalToken(true);
          token = tidal.loadToken();

          if (token?.expires_at && token.access_token) {
            const newHoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;
            if (newHoursUntilExpiry < 0) {
              refreshTokenExpired = true;
            } else {
              tokenExpired = false;
              hoursUntilExpiry = newHoursUntilExpiry;
            }
          } else {
            refreshTokenExpired = true;
          }
        }
      }

      const connected = Boolean(token?.access_token) && !tokenExpired && !refreshTokenExpired;

      if (connected) {
        return {
          connected: true,
          user: token?.user?.username ? { username: token.user.username } : null,
          tokenExpired,
          refreshTokenExpired,
          hoursUntilExpiry,
          canAccessShell: true,
          canAccessLocalLibrary: true,
          remoteCatalogAvailable: true,
          canAuthenticate: true,
        };
      }

      return {
        connected: false,
        tokenExpired,
        refreshTokenExpired: refreshTokenExpired || !token?.refresh_token,
        hoursUntilExpiry,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: false,
        canAuthenticate: true,
        user: token?.user?.username ? { username: token.user.username } : null,
        message: refreshTokenExpired || !token?.refresh_token
          ? "Your TIDAL session has expired. Reconnect to access remote catalog features."
          : "Connect your TIDAL account to access remote catalog features.",
      };
    } catch (error: any) {
      return {
        connected: false,
        tokenExpired: true,
        refreshTokenExpired: true,
        hoursUntilExpiry: 0,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: false,
        canAuthenticate: true,
        message: "Unable to verify TIDAL authentication status.",
      };
    }
  }

  async startDeviceLogin(): Promise<ProviderDeviceLoginResult> {
    const { startTidalDeviceLogin } = await import("./tidal-auth.js");
    return startTidalDeviceLogin();
  }

  async pollDeviceLogin(): Promise<ProviderDeviceLoginPollResult> {
    const { pollTidalDeviceLogin } = await import("./tidal-auth.js");
    const pollResult = await pollTidalDeviceLogin();
    return {
      logged_in: pollResult.logged_in,
      expired: pollResult.expired,
      remainingSeconds: pollResult.remainingSeconds,
      user: pollResult.user ? { username: pollResult.user.username } : null,
    };
  }

  getMediaUrl(type: string, providerId: string): string {
    return `https://tidal.com/browse/${type}/${providerId}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    const match = url.match(
      /^https?:\/\/(?:listen\.)?tidal\.com\/(?:browse\/)?(track|album|video)\/([A-Za-z0-9-]+)\/?/i,
    );
    if (!match) {
      return null;
    }
    return {
      type: match[1].toLowerCase(),
      providerId: match[2],
    };
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions
  ): Promise<void> {
    const slot = options?.qualityProfile === "spatial" || options?.quality?.toLowerCase().includes("atmos") ? "spatial" : (entityType === "video" ? "video" : "stereo");
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

    return backend.download({
      provider: this.id,
      entityType,
      providerId,
      downloadPath,
      quality: options?.quality,
    }, {
      signal: options?.signal,
      onProgress: (progress) => {
        if (options?.onProgress) {
          options.onProgress(progress);
        }
      }
    });
  }

  async syncSettings(_downloadPath?: string): Promise<void> {
    // Per-job paths are passed as CLI args now; the config file only holds global
    // settings, so the download path is no longer baked into config.toml.
    syncTiddlSettings();
  }

  async syncCredentials(): Promise<void> {
    await syncStoredTidalTokenToDownloaders();
  }

  private isSpatialQuality(quality?: string | null, tags: string[] = []): boolean {
    return hasSpatialAudioQuality([quality, ...tags]);
  }

  private uuidToPath(uuid: string | null | undefined): string | null {
    const trimmed = String(uuid || "").trim();
    return trimmed ? trimmed.replace(/-/g, "/") : null;
  }

  private tidalImageUrl(
    resourceType: "images" | "videos",
    uuid: string | null | undefined,
    size: string | number | null | undefined,
    extension = "jpg",
  ): string | null {
    const imagePath = this.uuidToPath(uuid);
    if (!imagePath) return null;
    return `https://resources.tidal.com/${resourceType}/${imagePath}/${size || "origin"}.${extension}`;
  }

  private normalizeSquareSize(size: string | number | null | undefined, fallback: number | "origin"): string {
    if (size === "origin") return "origin";
    const numeric = typeof size === "number" ? size : Number(size);
    if (!Number.isFinite(numeric)) {
      return fallback === "origin" ? "origin" : `${fallback}x${fallback}`;
    }

    // TIDAL's image CDN only serves fixed square sizes and 403s anything else
    // (a configured 1200 used to produce 1200x1200.jpg -> 403, silently killing
    // provider cover fallbacks). Clamp to the next valid size up so quality
    // never degrades; anything beyond the largest gets the origin image.
    const valid = [80, 160, 320, 640, 1280];
    const clamped = valid.find((candidate) => candidate >= numeric);
    return clamped ? `${clamped}x${clamped}` : "origin";
  }

  private normalizeVideoSize(size: string | number | null | undefined): string {
    // Prefer origin so we keep the provider's native aspect (often 16:9).
    // TIDAL's 3:2 CDN sizes center-crop the native frame — never request those.
    const cropSizes = new Set(["160x107", "480x320", "750x500", "1080x720"]);
    const normalized = String(size || "origin").trim().toLowerCase();
    if (!normalized || cropSizes.has(normalized)) return "origin";
    // Explicit 16:9 CDN sizes pass through; everything else is returned as-is
    // (including "origin") so callers can ask for a specific non-crop variant.
    return String(size || "origin").trim();
  }

  private providerId(...values: unknown[]): string {
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }

      const normalized = String(value).trim();
      if (!normalized || normalized.toLowerCase() === "undefined" || normalized.toLowerCase() === "null") {
        continue;
      }

      return normalized;
    }

    return "";
  }

  private mapProviderArtist(artist: any): ProviderArtist {
    const picture = String(artist?.picture || "").trim();
    return {
      providerId: this.providerId(artist?.providerId, artist?.provider_id, artist?.id, artist?.tidal_id),
      name: artist?.name || artist?.artist_name || "Unknown Artist",
      picture: /^https?:\/\//i.test(picture)
        ? picture
        : this.tidalImageUrl("images", picture, "origin"),
      url: artist?.url,
      popularity: artist?.popularity ?? null,
      types: Array.isArray(artist?.artist_types) ? artist.artist_types : undefined,
      roles: Array.isArray(artist?.artist_roles) ? artist.artist_roles : undefined,
      raw: artist,
    };
  }

  private mapArtist(artist: any): ProviderArtist {
    return this.mapProviderArtist(artist);
  }

  private mapAlbum(album: any): ProviderAlbum {
    const qualityTags = Array.isArray(album.mediaMetadata?.tags)
      ? album.mediaMetadata.tags.map((tag: unknown) => String(tag))
      : [];
    const albumArtists = Array.isArray(album.artists)
      ? album.artists.map((artist: any) => this.mapProviderArtist(artist))
      : [];

    return {
      providerId: this.providerId(album.providerId, album.provider_id, album.id, album.tidal_id),
      title: album.title,
      artist: album.artist
        ? this.mapProviderArtist(album.artist)
        : { providerId: this.providerId(album.artist_provider_id, album.artist_id), name: album.artist_name || "Unknown Artist" },
      artists: albumArtists.length > 0 ? albumArtists : undefined,
      cover: album.cover || album.cover_id || null,
      videoCover: album.videoCover || album.video_cover || null,
      releaseDate: album.releaseDate || album.release_date || null,
      trackCount: album.numberOfTracks ?? album.num_tracks ?? null,
      volumeCount: album.numberOfVolumes ?? album.num_volumes ?? null,
      duration: album.duration ?? null,
      type: album.type,
      explicit: album.explicit == null ? null : Boolean(album.explicit),
      upc: album.upc || null,
      copyright: album.copyright || null,
      popularity: album.popularity ?? null,
      quality: album.quality || album.audioQuality || qualityTags[0] || null,
      qualityTags,
      url: album.url,
      version: album.version || null,
      raw: album,
    };
  }

  /** Test/helper access to album DTO mapping (preserves videoCover). */
  mapAlbumForTests(album: any): ProviderAlbum {
    return this.mapAlbum(album);
  }

  private mapTrack(track: any): ProviderTrack {
    const qualityTags = Array.isArray(track.mediaMetadata?.tags)
      ? track.mediaMetadata.tags.map((tag: unknown) => String(tag))
      : [];
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist: any) => this.mapProviderArtist(artist))
      : [];

    return {
      providerId: this.providerId(track.providerId, track.provider_id, track.id, track.tidal_id),
      title: track.title,
      version: track.version || null,
      artist: track.artist
        ? this.mapProviderArtist(track.artist)
        : {
          providerId: this.providerId(track.artist_provider_id, track.artist_id),
          name: track.artist_name || artists[0]?.name || "Unknown Artist",
        },
      artists: artists.length > 0 ? artists : undefined,
      album: track.album
        ? {
          providerId: this.providerId(track.album.providerId, track.album.provider_id, track.album.id, track.album.tidal_id),
          title: track.album.title,
          artist: track.album.artist
            ? this.mapProviderArtist(track.album.artist)
            : { providerId: "", name: track.album.artist_name || "Unknown Artist" },
        }
        : {
          providerId: this.providerId(track.album_provider_id, track.album_id),
          title: track.album_title || "Unknown",
          artist: { providerId: "", name: "Unknown Artist" },
        },
      duration: track.duration || 0,
      trackNumber: track.trackNumber ?? track.track_number ?? 0,
      volumeNumber: track.volumeNumber ?? track.volume_number ?? 1,
      url: track.url,
      isrc: track.isrc || null,
      releaseDate: track.releaseDate || track.release_date || null,
      copyright: track.copyright || null,
      replayGain: track.replayGain ?? track.replay_gain ?? null,
      peak: track.peak ?? null,
      popularity: track.popularity ?? null,
      quality: track.quality || track.audioQuality || qualityTags[0] || null,
      qualityTags,
      explicit: track.explicit == null ? null : Boolean(track.explicit),
      raw: track,
    };
  }

  private mapVideo(video: any): ProviderVideo {
    return {
      providerId: this.providerId(video.providerId, video.provider_id, video.id, video.tidal_id),
      title: video.title || video.name || "Unknown Video",
      artist: video.artist
        ? this.mapProviderArtist(video.artist)
        : { providerId: this.providerId(video.artist_provider_id, video.artist_id), name: video.artist_name || video.subtitle || "Unknown Artist" },
      artists: (video.artists || []).map((artist: any) => ({
        providerId: this.providerId(artist.providerId, artist.provider_id, artist.id, artist.tidal_id),
        name: artist.name || "Unknown Artist",
        picture: artist.picture || null,
      })),
      duration: video.duration ?? null,
      releaseDate: video.releaseDate || video.release_date || null,
      cover: video.image_id || video.imageId || video.image || video.cover || null,
      quality: video.quality || null,
      explicit: video.explicit == null ? null : Boolean(video.explicit),
      url: video.url,
      isrc: video.isrc || null,
      recordingMbid: video.mbid || video.recording_mbid || null,
      // TIDAL sometimes nests album.id on /videos; keep the provider album id only.
      albumId: this.providerId(video.albumId, video.album_id, video.album?.id) || null,
      raw: video,
    };
  }
}

export const tidalStreamingProvider = new TidalProvider();
downloadBackendRegistry.register(new TiddlBackend());
