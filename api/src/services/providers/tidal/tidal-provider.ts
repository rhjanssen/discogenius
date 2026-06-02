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
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { db } from "../../../database.js";
import { Config } from "../../config.js";
import { buildStreamingMediaUrl, getDownloadBackendForMediaType } from "../../download-routing.js";
import { clearHistory, syncDiscogeniusSettings, buildTidalDlNgEnv, getTidalDlNgCommand, parseProgress } from "./tidal-dl-ng.js";
import { loadStoredTidalToken, syncStoredTidalTokenToDownloaders } from "./tidal-auth.js";
import { ensureOrpheusRuntime, syncOrpheusSettings, spawnOrpheusDownload, parseOrpheusProgress, syncTokenToOrpheusSession } from "../../orpheus.js";
import { MediaSeedService } from "../../media-seed-service.js";

export class TidalProvider implements StreamingProvider {
  readonly id = "tidal";
  readonly name = "TIDAL";
  readonly capabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: true,
    playlists: true,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
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
      artists: items.filter((item: any) => item?.type === "artist").map(this.mapArtist),
      albums: items.filter((item: any) => item?.type === "album").map(this.mapAlbum),
      tracks: items.filter((item: any) => item?.type === "track").map(this.mapTrack),
      videos: items.filter((item: any) => item?.type === "video").map(this.mapVideo),
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return this.mapArtist(await tidal.getArtist(String(id)));
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    return (await tidal.getArtistAlbums(String(id))).map(this.mapAlbum);
  }

  async getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return (await tidal.getArtistVideos(String(id))).map(this.mapVideo);
  }

  async getArtistCatalogPage(id: string | number): Promise<any> {
    return tidal.getArtistPage(String(id));
  }

  async getFollowedArtists(): Promise<ProviderArtist[]> {
    return (await tidal.getFollowedArtists()).map(this.mapArtist);
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return (await tidal.getArtistAlbums(String(id))).map(this.mapAlbum);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    const searchText = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const results = await tidal.searchTidal(searchText, ["ALBUMS"], 25);
    const items = Array.isArray(results) ? results : results.albums?.items || [];
    const albums: ProviderAlbum[] = items.map(this.mapAlbum);
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
    return (await tidal.getAlbumTracks(String(id))).map(this.mapTrack);
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

  async getPlaylist(id: string | number) {
    return tidal.getPlaylist(String(id));
  }

  async getPlaylistTracks(id: string | number): Promise<any[]> {
    const res = await tidal.getPlaylistTracks(String(id));
    const items = Array.isArray(res) ? res : (res?.items || []);
    return items.map((t: any) => this.mapTrack(t));
  }

  async getUserPlaylists(): Promise<any[]> {
    const res = await tidal.getUserPlaylists();
    return Array.isArray(res) ? res : (res?.items || []);
  }

  async getArtistBio(id: string | number): Promise<string | null> {
    const res = await tidal.getArtistBio(String(id));
    return res?.text ?? null;
  }

  async getSimilarArtists(id: string | number): Promise<ProviderArtist[]> {
    const res = await tidal.getArtistSimilar(String(id));
    return (Array.isArray(res) ? res : []).map(this.mapArtist);
  }

  async getAlbumReview(id: string | number): Promise<string | null> {
    const res = await tidal.getAlbumReview(String(id));
    return res?.text ?? null;
  }

  async getSimilarAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const res = await tidal.getAlbumSimilar(String(id));
    return (Array.isArray(res) ? res : []).map(this.mapAlbum);
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
      /^https?:\/\/(?:listen\.)?tidal\.com\/(?:browse\/)?(track|album|video|playlist)\/([A-Za-z0-9-]+)\/?/i,
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
    entityType: "album" | "track" | "video" | "playlist",
    downloadPath: string,
    options?: ProviderDownloadOptions
  ): Promise<void> {
    // Ensure the target subtree is empty before starting.
    try {
      await fs.promises.rm(downloadPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });

    const albumIds = providerId.split(";").filter(Boolean);
    const backend = getDownloadBackendForMediaType(entityType);

    let lastProgress = 0;
    let completedTracks = 0;
    let totalTracks = 0;
    const trackProgress: Map<string, number> = new Map();
    let currentTrackName = '';
    let statusMessage = '';

    type AlbumTrackInfo = { title: string; trackNum: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' };
    let albumTracks: AlbumTrackInfo[] = [];
    let currentTrackIndex = -1;
    if (entityType === 'album') {
      try {
        const placeholders = albumIds.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT m.title,
                   m.version,
                   m.track_number as track_num,
                   COALESCE(m.volume_number, 1) as volume_num,
                   ar.name as artist_name
            FROM ProviderMedia m
            LEFT JOIN Artists ar ON ar.id = m.artist_id
            WHERE m.album_id IN (${placeholders}) AND m.type != 'Music Video'
            ORDER BY m.volume_number, m.track_number
        `).all(...albumIds) as any[];
        if (rows.length > 0) {
          totalTracks = rows.length;
          const hasMultipleVolumes = rows.some((row) => Number(row.volume_num || 1) > 1);
          albumTracks = rows.map((row) => {
            const normalizedVersion = String(row.version || '').trim();
            const baseTitle = normalizedVersion && !row.title?.toLowerCase().includes(normalizedVersion.toLowerCase())
              ? `${row.title} (${normalizedVersion})`
              : row.title;
            return {
              title: row.artist_name ? `${row.artist_name} - ${baseTitle}` : baseTitle,
              trackNum: hasMultipleVolumes
                ? (Number(row.volume_num || 1) * 100) + Number(row.track_num || 0)
                : Number(row.track_num || 0),
              status: 'queued' as const,
            };
          });
        }
      } catch (e) {
        console.warn(`[TidalProvider] Could not pre-fetch album tracks for ${providerId}:`, e);
      }
    }

    const normalizeTrackMatchText = (value: string) => value
      .toLowerCase()
      .replace(/^[^-]+\s-\s/, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

    const updateAlbumTrackStatus = (
      trackTitle: string,
      status: 'downloading' | 'completed' | 'error' | 'skipped',
      preferredIndex?: number,
    ) => {
      if (albumTracks.length === 0) return;

      if (preferredIndex !== undefined && preferredIndex >= 0 && preferredIndex < albumTracks.length) {
        albumTracks[preferredIndex].status = status;
        return;
      }

      const normalizedIncoming = normalizeTrackMatchText(trackTitle);
      const idx = albumTracks.findIndex((track) => {
        if (track.status === 'completed' || track.status === 'error' || track.status === 'skipped') {
          return false;
        }

        const normalizedTrack = normalizeTrackMatchText(track.title);
        return normalizedIncoming === normalizedTrack
          || normalizedIncoming.includes(normalizedTrack)
          || normalizedTrack.includes(normalizedIncoming);
      });

      if (idx >= 0) {
        albumTracks[idx].status = status;
      }
    };

    const emitDownloadProgress = (state: any) => {
      if (options?.onProgress) {
        options.onProgress(state);
      }
    };

    let currentAlbumIndex = 0;
    let tracksCompletedInPreviousAlbums = 0;
    let currentAlbumCompletedTracks = 0;

    const downloadSingleAlbum = (currentAlbumId: string): Promise<void> => {
      return new Promise((resolveSingle, rejectSingle) => {
        (async () => {
          const currentTidalUrl = buildStreamingMediaUrl(entityType, currentAlbumId);
        let settled = false;
        let hardTimeout: NodeJS.Timeout | undefined;
        let idleTimeout: NodeJS.Timeout | undefined;

        const DOWNLOAD_TIMEOUT_MS = Number(process.env.DISCOGENIUS_DOWNLOAD_TIMEOUT_MS || '0');
        const DOWNLOAD_IDLE_TIMEOUT_MS = Number(process.env.DISCOGENIUS_DOWNLOAD_IDLE_TIMEOUT_MS || '0');

        const clearTimeouts = () => {
          if (hardTimeout) {
            clearTimeout(hardTimeout);
            hardTimeout = undefined;
          }
          if (idleTimeout) {
            clearTimeout(idleTimeout);
            idleTimeout = undefined;
          }
        };

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeouts();

          if (error) {
            try {
              if (entityType === 'album') {
                db.prepare(`UPDATE upgrade_queue SET status = 'skipped' WHERE album_id = ? AND status = 'pending'`).run(currentAlbumId);
              } else {
                db.prepare(`UPDATE upgrade_queue SET status = 'skipped' WHERE media_id = ? AND status = 'pending'`).run(currentAlbumId);
              }
            } catch (e) {
              console.error(`[TidalProvider] Failed to update upgrade_queue skip-list for ${currentAlbumId}:`, e);
            }
            rejectSingle(error);
          } else {
            resolveSingle();
          }
        };

        try {
          let downloadProcess: ChildProcess;
          if (backend === 'tidal-dl-ng') {
            clearHistory();
            await syncDiscogeniusSettings(downloadPath);
            const env = buildTidalDlNgEnv();
            const args = ['dl', currentTidalUrl];
            console.log(`[TidalProvider] Running: tidal-dl-ng ${args.join(' ')}`);
            const cmd = getTidalDlNgCommand();
            downloadProcess = spawn(cmd.command, [...cmd.args, ...args], { env });
          } else {
            const token = loadStoredTidalToken();
            if (!token?.access_token) {
              throw new Error('TIDAL authentication is required before starting Orpheus downloads');
            }
            await ensureOrpheusRuntime();
            await syncTokenToOrpheusSession(token);
            await syncOrpheusSettings(downloadPath);
            console.log(`[TidalProvider] Running: orpheus.py download tidal ${entityType} ${currentAlbumId}`);
            downloadProcess = await spawnOrpheusDownload(entityType as 'track' | 'album' | 'playlist', currentAlbumId, downloadPath);
          }

          if (options?.signal) {
            const onAbort = () => {
              if (!settled && !downloadProcess.killed) {
                console.log(`[TidalProvider] Abort signal received, killing download process...`);
                downloadProcess.kill('SIGKILL');
                finish(new Error('Download process aborted'));
              }
            };
            options.signal.addEventListener('abort', onAbort);
          }

          const resetIdleTimeout = () => {
            if (DOWNLOAD_IDLE_TIMEOUT_MS <= 0) return;
            if (idleTimeout) clearTimeout(idleTimeout);

            idleTimeout = setTimeout(() => {
              if (settled) return;
              const message = `Download idle timeout (${DOWNLOAD_IDLE_TIMEOUT_MS}ms)`;
              console.error(`[TidalProvider] ${message}`);
              if (!downloadProcess.killed) {
                downloadProcess.kill('SIGKILL');
              }
              finish(new Error(message));
            }, DOWNLOAD_IDLE_TIMEOUT_MS);
          };

          if (DOWNLOAD_TIMEOUT_MS > 0) {
            hardTimeout = setTimeout(() => {
              if (settled) return;
              const message = `Download timeout (${DOWNLOAD_TIMEOUT_MS}ms)`;
              console.error(`[TidalProvider] ${message}`);
              if (!downloadProcess.killed) {
                downloadProcess.kill('SIGKILL');
              }
              finish(new Error(message));
            }, DOWNLOAD_TIMEOUT_MS);
          }

          resetIdleTimeout();
          currentAlbumCompletedTracks = 0;

          const handleOrpheusProgress = (progress: any) => {
            if (!progress) return false;

            if (progress.statusMessage) {
              statusMessage = progress.statusMessage;
            }

            if (progress.currentTrack && progress.totalTracks) {
              if (albumIds.length <= 1) {
                totalTracks = progress.totalTracks;
              }
              currentAlbumCompletedTracks = Math.max(currentAlbumCompletedTracks, progress.currentTrack - 1);
              completedTracks = tracksCompletedInPreviousAlbums + currentAlbumCompletedTracks;
              currentTrackIndex = tracksCompletedInPreviousAlbums + Math.max(0, progress.currentTrack - 1);
              const overallProgress = Math.round((completedTracks / totalTracks) * 100);
              lastProgress = Math.max(lastProgress, overallProgress);
              emitDownloadProgress({
                progress: overallProgress,
                currentFileNum: completedTracks,
                totalFiles: totalTracks,
                currentTrack: currentTrackName || undefined,
                state: 'downloading',
                statusMessage,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.currentTrackName) {
              currentTrackName = progress.currentTrackName;
              updateAlbumTrackStatus(progress.currentTrackName, 'downloading', currentTrackIndex);
              emitDownloadProgress({
                progress: lastProgress,
                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1,
                totalFiles: totalTracks || undefined,
                currentTrack: currentTrackName,
                trackStatus: 'downloading',
                state: 'downloading',
                statusMessage: progress.statusMessage || statusMessage,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.trackProgress !== undefined) {
              if (currentTrackName) {
                trackProgress.set(currentTrackName, progress.trackProgress);
                updateAlbumTrackStatus(currentTrackName, 'downloading', currentTrackIndex);
              }

              const currentFileNum = totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1;
              const overallProgress = totalTracks > 0
                ? Math.round(((completedTracks + progress.trackProgress / 100) / totalTracks) * 100)
                : progress.trackProgress;
              lastProgress = Math.max(lastProgress, overallProgress);
              emitDownloadProgress({
                progress: overallProgress,
                currentFileNum,
                totalFiles: totalTracks || undefined,
                currentTrack: currentTrackName || undefined,
                trackProgress: progress.trackProgress,
                trackStatus: currentTrackName ? 'downloading' : undefined,
                state: 'downloading',
                statusMessage,
                speed: progress.speed,
                eta: progress.eta,
                size: progress.size,
                sizeleft: progress.sizeleft,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.isTrackComplete) {
              currentAlbumCompletedTracks += 1;
              completedTracks = tracksCompletedInPreviousAlbums + currentAlbumCompletedTracks;
              if (currentTrackName) {
                trackProgress.set(currentTrackName, 100);
                updateAlbumTrackStatus(currentTrackName, 'completed', currentTrackIndex);
              }
              const overallProgress = totalTracks > 0
                ? Math.round((completedTracks / totalTracks) * 100)
                : 100;
              lastProgress = Math.max(lastProgress, overallProgress);
              emitDownloadProgress({
                progress: overallProgress,
                currentFileNum: completedTracks,
                totalFiles: totalTracks || undefined,
                currentTrack: currentTrackName || undefined,
                trackProgress: currentTrackName ? 100 : undefined,
                trackStatus: currentTrackName ? 'completed' : undefined,
                state: 'downloading',
                statusMessage: progress.statusMessage || statusMessage,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.isTrackFailed) {
              if (currentTrackName) {
                updateAlbumTrackStatus(currentTrackName, 'error', currentTrackIndex);
              }
              emitDownloadProgress({
                progress: lastProgress,
                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1,
                totalFiles: totalTracks || undefined,
                currentTrack: currentTrackName || undefined,
                trackStatus: currentTrackName ? 'error' : undefined,
                state: 'downloading',
                statusMessage: progress.statusMessage || statusMessage,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.isEntityComplete) {
              const isLastAlbum = currentAlbumIndex === albumIds.length - 1;
              if (isLastAlbum) {
                emitDownloadProgress({
                  progress: 100,
                  currentFileNum: totalTracks || completedTracks,
                  totalFiles: totalTracks || completedTracks,
                  state: 'completed',
                  statusMessage: progress.statusMessage || statusMessage,
                  tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                    ...t,
                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                  })) : undefined,
                });
              }
            }

            return true;
          };

          const handleTidalDlNgProgress = (progress: any) => {
            if (!progress) return false;

            const fallbackTrackTitle = currentTrackName || options?.qualityProfile;

            if (progress.statusMessage) {
              statusMessage = progress.statusMessage;
            }

            if (progress.totalTracks && progress.currentTrack) {
              if (albumIds.length <= 1) {
                totalTracks = progress.totalTracks;
              }
              currentAlbumCompletedTracks = Math.max(currentAlbumCompletedTracks, progress.currentTrack - 1);
              completedTracks = tracksCompletedInPreviousAlbums + currentAlbumCompletedTracks;
              currentTrackIndex = tracksCompletedInPreviousAlbums + Math.max(0, progress.currentTrack - 1);
              const overallProgress = Math.round((completedTracks / totalTracks) * 100);

              if (overallProgress !== lastProgress) {
                lastProgress = overallProgress;
                emitDownloadProgress({
                  progress: overallProgress,
                  currentFileNum: completedTracks,
                  totalFiles: totalTracks,
                  currentTrack: progress.listName || currentTrackName,
                  state: progress.state || 'downloading',
                  statusMessage,
                  tracks: albumTracks.length > 0 ? albumTracks : undefined,
                });
              }
            }

            if (progress.isComplete && progress.trackTitle) {
              currentAlbumCompletedTracks += 1;
              completedTracks = tracksCompletedInPreviousAlbums + currentAlbumCompletedTracks;
              trackProgress.set(progress.trackTitle, 100);
              currentTrackName = progress.trackTitle;
              updateAlbumTrackStatus(progress.trackTitle, progress.state === 'failed' ? 'error' : 'completed', currentTrackIndex);

              const overallProgress = totalTracks > 0
                ? Math.round((completedTracks / totalTracks) * 100)
                : Math.round((completedTracks / Math.max(completedTracks, 1)) * 100);

              emitDownloadProgress({
                progress: overallProgress,
                currentFileNum: completedTracks,
                totalFiles: totalTracks,
                currentTrack: progress.trackTitle,
                trackProgress: 100,
                trackStatus: progress.state === 'failed' ? 'error' : 'completed',
                state: progress.state || 'downloading',
                statusMessage: progress.statusMessage || `Downloaded: ${progress.trackTitle}`,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            } else if (progress.progress > 0 && progress.trackTitle) {
              trackProgress.set(progress.trackTitle, progress.progress);
              currentTrackName = progress.trackTitle;
              updateAlbumTrackStatus(progress.trackTitle, 'downloading', currentTrackIndex);

              const overallProgress = totalTracks > 0
                ? Math.round(((completedTracks + progress.progress / 100) / totalTracks) * 100)
                : progress.progress;

              if (overallProgress !== lastProgress) {
                lastProgress = overallProgress;
                emitDownloadProgress({
                  progress: overallProgress,
                  currentFileNum: completedTracks + 1,
                  totalFiles: totalTracks || undefined,
                  currentTrack: progress.trackTitle,
                  trackProgress: progress.progress,
                  trackStatus: 'downloading',
                  state: 'downloading',
                  statusMessage,
                  tracks: albumTracks.length > 0 ? albumTracks : undefined,
                });
              }
            } else if (progress.progress > lastProgress) {
              lastProgress = progress.progress;
              emitDownloadProgress({
                progress: progress.progress,
                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : undefined,
                totalFiles: totalTracks || undefined,
                currentTrack: fallbackTrackTitle || undefined,
                trackProgress: fallbackTrackTitle ? progress.progress : undefined,
                trackStatus: fallbackTrackTitle ? 'downloading' : undefined,
                state: progress.state || 'downloading',
                statusMessage,
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            if (progress.isListComplete && progress.listName) {
              const isLastAlbum = currentAlbumIndex === albumIds.length - 1;
              if (isLastAlbum) {
                totalTracks = completedTracks;
                emitDownloadProgress({
                  progress: 100,
                  currentFileNum: completedTracks,
                  totalFiles: completedTracks,
                  state: 'completed',
                  statusMessage: `Finished: ${progress.listName}`,
                  tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                    ...t,
                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                  })) : undefined,
                });
              }
            }

            if (progress.statusMessage && !progress.trackTitle && !progress.totalTracks && !progress.isListComplete) {
              emitDownloadProgress({
                progress: lastProgress,
                currentFileNum: completedTracks > 0 ? completedTracks : undefined,
                totalFiles: totalTracks || undefined,
                currentTrack: fallbackTrackTitle || undefined,
                trackProgress: fallbackTrackTitle
                  ? (currentTrackName ? trackProgress.get(currentTrackName) : lastProgress)
                  : undefined,
                trackStatus: fallbackTrackTitle ? 'downloading' : undefined,
                statusMessage: progress.statusMessage,
                state: progress.state || 'downloading',
                tracks: albumTracks.length > 0 ? albumTracks : undefined,
              });
            }

            return true;
          };

          const handleBackendProgressLine = (line: string) => {
            if (backend === 'tidal-dl-ng') {
              return handleTidalDlNgProgress(parseProgress(line));
            }
            return handleOrpheusProgress(parseOrpheusProgress(line));
          };

          downloadProcess.stdout?.on("data", (data: Buffer) => {
            try {
              resetIdleTimeout();
              const output = data.toString();
              const lines = output.split(/\r?\n|\r/g);
              for (const line of lines) {
                if (!line.trim()) continue;
                console.log(`[${backend}] ${line}`);
                handleBackendProgressLine(line);
              }
            } catch (error: any) {
              const message = `Failed to parse download output: ${error?.message || 'unknown parser error'}`;
              console.error(`[TidalProvider] ${message}`);
              if (!downloadProcess.killed) {
                downloadProcess.kill('SIGKILL');
              }
              finish(new Error(message));
            }
          });

          let stderrOutput = '';
          downloadProcess.stderr?.on("data", (data: Buffer) => {
            try {
              resetIdleTimeout();
              const output = data.toString();
              stderrOutput += output;
              const lines = output.split(/\r?\n|\r/g);
              let handledProgress = false;

              if (backend === 'orpheus' || backend === 'tidal-dl-ng') {
                for (const line of lines) {
                  if (!line.trim()) continue;
                  handledProgress = handleBackendProgressLine(line) || handledProgress;
                }
              }

              if (!handledProgress && !output.includes('WARNING') && !output.includes('ffmpeg version')) {
                console.error(`[${backend} stderr] ${output}`);
              }
            } catch (error: any) {
              const message = `Failed to process stderr: ${error?.message || 'unknown stderr error'}`;
              console.error(`[TidalProvider] ${message}`);
              if (!downloadProcess.killed) {
                downloadProcess.kill('SIGKILL');
              }
              finish(new Error(message));
            }
          });

          downloadProcess.on("close", (code) => {
            if (settled) return;
            if (code === 0) {
              finish();
            } else {
              finish(new Error(`Download process exited with code ${code}. Stderr: ${stderrOutput.slice(-500)}`));
            }
          });
        } catch (error: any) {
          finish(error);
        }
      })().catch(rejectSingle);
    });
  };

    for (const albumId of albumIds) {
      await downloadSingleAlbum(albumId);
      tracksCompletedInPreviousAlbums = completedTracks;
      currentAlbumIndex++;
    }
  }

  async syncSettings(downloadPath?: string): Promise<void> {
    await syncDiscogeniusSettings(downloadPath);
    await syncOrpheusSettings(downloadPath);
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

  private mapArtist(artist: any): ProviderArtist {
    return {
      providerId: String(artist.id ?? artist.tidal_id),
      name: artist.name,
      picture: artist.picture || null,
      url: artist.url,
      popularity: artist.popularity ?? null,
      types: Array.isArray(artist.artist_types) ? artist.artist_types : undefined,
      roles: Array.isArray(artist.artist_roles) ? artist.artist_roles : undefined,
      raw: artist,
    };
  }

  private mapAlbum(album: any): ProviderAlbum {
    const qualityTags = Array.isArray(album.mediaMetadata?.tags)
      ? album.mediaMetadata.tags.map((tag: unknown) => String(tag))
      : [];

    return {
      providerId: String(album.id ?? album.tidal_id),
      title: album.title,
      artist: album.artist
        ? {
          providerId: String(album.artist.id ?? album.artist.tidal_id),
          name: album.artist.name,
          picture: album.artist.picture || null,
        }
        : { providerId: String(album.artist_id || ""), name: album.artist_name || "Unknown Artist" },
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
    return {
      providerId: String(track.id ?? track.tidal_id),
      title: track.title,
      artist: track.artist
        ? { providerId: String(track.artist.id ?? track.artist.tidal_id), name: track.artist.name }
        : { providerId: String(track.artist_id || ""), name: track.artist_name || "Unknown Artist" },
      album: track.album
        ? {
          providerId: String(track.album.id ?? track.album.tidal_id),
          title: track.album.title,
          artist: { providerId: "", name: "Unknown Artist" },
        }
        : {
          providerId: String(track.album_id || ""),
          title: track.album_title || "Unknown",
          artist: { providerId: "", name: "Unknown Artist" },
        },
      duration: track.duration || 0,
      trackNumber: track.trackNumber ?? track.track_number ?? 0,
      volumeNumber: track.volumeNumber ?? track.volume_number ?? 1,
      url: track.url,
      isrc: track.isrc || null,
      quality: track.quality || track.audioQuality || null,
      raw: track,
    };
  }

  private mapVideo(video: any): ProviderVideo {
    return {
      providerId: String(video.id ?? video.tidal_id),
      title: video.title || video.name || "Unknown Video",
      artist: video.artist
        ? {
          providerId: String(video.artist.id ?? video.artist.tidal_id),
          name: video.artist.name,
          picture: video.artist.picture || null,
        }
        : { providerId: String(video.artist_id || ""), name: video.artist_name || video.subtitle || "Unknown Artist" },
      artists: (video.artists || []).map((artist: any) => ({
        providerId: String(artist.id ?? artist.tidal_id ?? ""),
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
