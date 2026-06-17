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
} from "../streaming-provider.js";
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
    ),
    matched_releases AS (
      SELECT DISTINCT
        input_albums.provider_id,
        input_albums.ord,
        COALESCE(provider_item.release_mbid, selected_slot.selected_release_mbid) AS release_mbid
      FROM input_albums
      LEFT JOIN ProviderItems provider_item
        ON provider_item.provider = 'tidal'
       AND provider_item.entity_type = 'album'
       AND CAST(provider_item.provider_id AS TEXT) = input_albums.provider_id
      LEFT JOIN ReleaseGroupSlots selected_slot
        ON selected_slot.selected_provider = 'tidal'
       AND (
         selected_slot.selected_provider_id = input_albums.provider_id
         OR selected_slot.selected_provider_id LIKE input_albums.provider_id || ';%'
         OR selected_slot.selected_provider_id LIKE '%;' || input_albums.provider_id || ';%'
         OR selected_slot.selected_provider_id LIKE '%;' || input_albums.provider_id
       )
    )
    SELECT
      track.title,
      NULL AS version,
      track.position AS track_num,
      COALESCE(track.medium_position, 1) AS volume_num,
      COALESCE(release_artist.name, canonical_artist.name) AS artist_name,
      matched_releases.ord
    FROM matched_releases
    JOIN Tracks track
      ON track.release_mbid = matched_releases.release_mbid
    LEFT JOIN Recordings recording
      ON recording.mbid = track.recording_mbid
    LEFT JOIN AlbumReleases release
      ON release.mbid = track.release_mbid
    LEFT JOIN ArtistMetadata release_artist
      ON release_artist.mbid = COALESCE(recording.artist_mbid, release.artist_mbid)
    LEFT JOIN Artists canonical_artist
      ON canonical_artist.mbid = COALESCE(recording.artist_mbid, release.artist_mbid)
    WHERE matched_releases.release_mbid IS NOT NULL
      AND COALESCE(recording.is_video, 0) = 0
    ORDER BY matched_releases.ord ASC, COALESCE(track.medium_position, 1) ASC, track.position ASC
  `).all(...params) as Array<TidalAlbumDownloadTrackInfo & { ord: number }>;

  if (canonicalRows.length > 0) {
    return canonicalRows.map(({ ord: _ord, ...row }) => row);
  }

  const legacyPlaceholders = albumIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT m.title,
           m.version,
           m.track_number AS track_num,
           COALESCE(m.volume_number, 1) AS volume_num,
           ar.name AS artist_name
    FROM ProviderMedia m
    LEFT JOIN Artists ar ON ar.id = m.artist_id
    WHERE m.album_id IN (${legacyPlaceholders}) AND m.type != 'Music Video'
    ORDER BY m.volume_number, m.track_number
  `).all(...albumIds) as TidalAlbumDownloadTrackInfo[];
}

export class TidalProvider implements StreamingProvider {
  readonly id = "tidal";
  readonly name = "TIDAL";
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
  };

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
    return (await tidal.getArtistAlbums(String(id))).map((album: any) => this.mapAlbum(album));
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return (await tidal.getArtistVideos(String(id))).map((video: any) => this.mapVideo(video));
  }

  async getArtistCatalogPage(id: string | number): Promise<any> {
    return tidal.getArtistPage(String(id));
  }

  async getFollowedArtists(): Promise<ProviderArtist[]> {
    return (await tidal.getFollowedArtists()).map((artist: any) => this.mapArtist(artist));
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

  async getSimilarArtists(id: string | number): Promise<ProviderArtist[]> {
    const res = await tidal.getArtistSimilar(String(id));
    return (Array.isArray(res) ? res : []).map((artist: any) => this.mapArtist(artist));
  }

  async getAlbumReview(id: string | number): Promise<string | null> {
    const res = await tidal.getAlbumReview(String(id));
    return res?.text ?? null;
  }

  async getSimilarAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const res = await tidal.getAlbumSimilar(String(id));
    return (Array.isArray(res) ? res : []).map((album: any) => this.mapAlbum(album));
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
      return this.tidalImageUrl("images", request.imageId, this.normalizeVideoSize(request.size));
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

    return `${numeric}x${numeric}`;
  }

  private normalizeVideoSize(size: string | number | null | undefined): string {
    const normalized = String(size || "1080x720");
    if (normalized === "origin" || normalized === "1280x720") return "1080x720";
    if (normalized === "640x360") return "480x320";
    return normalized;
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
    return {
      providerId: this.providerId(artist?.providerId, artist?.provider_id, artist?.id, artist?.tidal_id),
      name: artist?.name || artist?.artist_name || "Unknown Artist",
      picture: artist?.picture || null,
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
      releaseDate: album.releaseDate || album.release_date || null,
      trackCount: album.numberOfTracks ?? album.num_tracks ?? null,
      volumeCount: album.numberOfVolumes ?? album.num_volumes ?? null,
      duration: album.duration ?? null,
      type: album.type,
      explicit: album.explicit == null ? null : Boolean(album.explicit),
      upc: album.upc || null,
      quality: album.quality || album.audioQuality || qualityTags[0] || null,
      qualityTags,
      url: album.url,
      version: album.version || null,
      raw: album,
    };
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
      quality: track.quality || track.audioQuality || qualityTags[0] || null,
      qualityTags,
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
      raw: video,
    };
  }
}

export const tidalStreamingProvider = new TidalProvider();
downloadBackendRegistry.register(new TiddlBackend());
