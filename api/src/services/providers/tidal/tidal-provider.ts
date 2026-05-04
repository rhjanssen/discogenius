import {
  IProvider,
  ProviderAlbum,
  ProviderArtist,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
} from "../provider-interface.js";
import * as tidal from "./tidal.js";
import { getBrowserPlaybackInfo, getVideoPlaybackInfo } from "../../playback.js";

export class TidalProvider implements IProvider {
  readonly id = "tidal";
  readonly name = "TIDAL";
  readonly capabilities = {
    hasVideo: true,
    hasLossless: true,
    hasAtmos: true,
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

  async getFollowedArtists(): Promise<ProviderArtist[]> {
    return (await tidal.getFollowedArtists()).map(this.mapArtist);
  }

  async listArtistReleaseOffers(id: string | number, options: { includeAppearsOn?: boolean } = {}): Promise<ProviderAlbum[]> {
    return (await tidal.getArtistAlbums(String(id), options)).map(this.mapAlbum);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    const searchText = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const results = await tidal.searchTidal(searchText, ["ALBUMS"], 25);
    const albums: ProviderAlbum[] = (results.albums?.items || []).map(this.mapAlbum);
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

  async getAlbumReview(id: string | number): Promise<string | null> {
    const res = await tidal.getAlbumReview(String(id));
    return res?.text ?? null;
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
    return tidal.tidalApiRequest(endpoint) as Promise<T>;
  }

  private isSpatialQuality(quality?: string | null, tags: string[] = []): boolean {
    const values = [quality, ...tags].map((value) => String(value || "").toUpperCase());
    return values.includes("DOLBY_ATMOS") || values.includes("SONY_360RA");
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
        : { providerId: "", title: "Unknown", artist: { providerId: "", name: "Unknown Artist" } },
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
      duration: video.duration ?? null,
      releaseDate: video.releaseDate || video.release_date || null,
      cover: video.image_id || video.imageId || video.image || video.cover || null,
      quality: video.quality || null,
      explicit: video.explicit == null ? null : Boolean(video.explicit),
      url: video.url,
      raw: video,
    };
  }
}

export const tidalProvider = new TidalProvider();
