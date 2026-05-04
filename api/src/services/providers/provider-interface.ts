export interface ProviderCapabilities {
  hasVideo: boolean;
  hasLossless?: boolean;
  hasAtmos?: boolean;
}

export interface IProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  isAuthenticated?(): boolean;
  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults>;
  getArtist(id: string | number): Promise<ProviderArtist>;
  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]>;
  getArtistVideos?(id: string | number): Promise<ProviderVideo[]>;
  getFollowedArtists?(): Promise<ProviderArtist[]>;
  listArtistReleaseOffers?(id: string | number, options?: { includeAppearsOn?: boolean }): Promise<ProviderAlbum[]>;
  searchReleaseGroup?(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]>;
  getAlbum(id: string | number): Promise<ProviderAlbum>;
  getAlbumTracks(id: string | number): Promise<ProviderTrack[]>;
  getTrack(id: string | number): Promise<ProviderTrack>;
  getVideo?(id: string | number): Promise<ProviderVideo>;
  getPlaybackInfo?(id: string | number, preferredQuality?: string): Promise<{ url?: string; contentType?: string | null; type?: string; segments?: string[] } | null>;
  getVideoPlaybackInfo?(id: string | number): Promise<{ url: string; contentType?: string | null } | null>;

  getPlaylist?(id: string | number): Promise<any>;
  getPlaylistTracks?(id: string | number): Promise<ProviderTrack[]>;
  getUserPlaylists?(): Promise<any[]>;
  
  getArtistBio?(id: string | number): Promise<string | null>;
  getAlbumReview?(id: string | number): Promise<string | null>;
  
  logout?(): void | Promise<void>;
  loadToken?(): any;
  refreshProviderToken?(): Promise<void>;
  shouldRefreshToken?(): boolean;

  getRateLimitMetrics?(): any;
  getCountryCode?(): string;
  apiRequest?<T = any>(endpoint: string, options?: any): Promise<T>;
}

export interface ProviderSearchResults {
  artists: ProviderArtist[];
  albums: ProviderAlbum[];
  tracks: ProviderTrack[];
  videos: ProviderVideo[];
}

export type ProviderSearchType = "artists" | "albums" | "tracks" | "videos";

export interface ProviderSearchOptions {
  limit?: number;
  types?: ProviderSearchType[];
}

export interface ProviderArtist {
  providerId: string;
  name: string;
  picture?: string | null;
  url?: string;
  popularity?: number | null;
  types?: string[];
  roles?: string[];
  raw?: unknown;
}

export interface ProviderAlbum {
  providerId: string;
  title: string;
  artist: ProviderArtist;
  cover?: string | null;
  releaseDate?: string | null;
  trackCount?: number | null;
  volumeCount?: number | null;
  duration?: number | null;
  type?: "ALBUM" | "EP" | "SINGLE" | string;
  explicit?: boolean | null;
  upc?: string | null;
  quality?: string | null;
  qualityTags?: string[];
  url?: string;
  version?: string | null;
  raw?: unknown;
}

export interface ProviderTrack {
  providerId: string;
  title: string;
  artist: ProviderArtist;
  album: ProviderAlbum;
  duration: number;
  trackNumber: number;
  volumeNumber?: number;
  url?: string;
  isrc?: string | null;
  quality?: string | null;
  raw?: unknown;
}

export interface ProviderVideo {
  providerId: string;
  title: string;
  artist: ProviderArtist;
  duration?: number | null;
  releaseDate?: string | null;
  cover?: string | null;
  quality?: string | null;
  explicit?: boolean | null;
  url?: string;
  raw?: unknown;
}

export interface ProviderReleaseGroupSearch {
  artistName: string;
  releaseGroupMbid?: string | null;
  releaseGroupTitle: string;
  releaseDate?: string | null;
  slot: "stereo" | "spatial" | "video";
  preferredTrackCount?: number | null;
  preferredVolumeCount?: number | null;
}
