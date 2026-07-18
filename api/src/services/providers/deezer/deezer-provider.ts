import fs from "node:fs";
import path from "node:path";
import { downloadBackendRegistry } from "../../download/download-backend.js";
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
import {
  clearDeezerCredentials,
  loadDeezerCredentials,
  saveDeezerCredentials,
} from "./deezer-auth.js";
import {
  deezerApiAllPages,
  deezerApiRequest,
  type DeezerFetchLike,
  type DeezerPage,
} from "./deezer-api.js";
import { deezerQualityMapping } from "./deezer-quality.js";
import {
  getStreamripBinary,
  StreamripDeezerBackend,
  syncDeezerStreamripConfig,
} from "./streamrip-backend.js";

interface DeezerArtistResource {
  id?: string | number;
  name?: string;
  link?: string;
  picture?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  nb_fan?: number;
  role?: string;
}

interface DeezerAlbumResource {
  id?: string | number;
  title?: string;
  link?: string;
  cover?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  release_date?: string;
  nb_tracks?: number;
  duration?: number;
  record_type?: string;
  explicit_lyrics?: boolean;
  upc?: string;
  fans?: number;
  artist?: DeezerArtistResource;
  contributors?: DeezerArtistResource[];
  tracks?: DeezerPage<DeezerTrackResource>;
}

interface DeezerTrackResource {
  id?: string | number;
  title?: string;
  title_short?: string;
  title_version?: string;
  link?: string;
  duration?: number;
  track_position?: number;
  disk_number?: number;
  release_date?: string;
  explicit_lyrics?: boolean;
  isrc?: string;
  preview?: string;
  rank?: number;
  gain?: number;
  artist?: DeezerArtistResource;
  contributors?: DeezerArtistResource[];
  album?: DeezerAlbumResource;
}

function resourceId(value: unknown): string {
  return value == null ? "" : String(value);
}

function normalizedVersion(raw: string | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  return value.replace(/^\((.*)\)$/u, "$1").trim() || null;
}

function mapArtist(resource: DeezerArtistResource | undefined): ProviderArtist {
  const providerId = resourceId(resource?.id);
  return {
    providerId,
    name: String(resource?.name || "Unknown artist"),
    picture: resource?.picture_xl || resource?.picture_big || resource?.picture_medium || resource?.picture || null,
    url: resource?.link || (providerId ? `https://www.deezer.com/artist/${providerId}` : undefined),
    popularity: typeof resource?.nb_fan === "number"
      ? Math.min(100, Math.max(0, Math.log10(resource.nb_fan + 1) * 16))
      : null,
    roles: resource?.role ? [resource.role] : undefined,
    raw: resource,
  };
}

function mapAlbum(resource: DeezerAlbumResource, fallbackArtist?: ProviderArtist): ProviderAlbum {
  const artist = resource.artist?.id != null ? mapArtist(resource.artist) : fallbackArtist || mapArtist(resource.artist);
  const contributors = (resource.contributors || []).map(mapArtist);
  const artists = contributors.length > 0 ? contributors : [artist];
  const recordType = String(resource.record_type || "ALBUM").toUpperCase();
  return {
    providerId: resourceId(resource.id),
    title: String(resource.title || "Unknown album"),
    artist,
    artists,
    cover: resource.cover_xl || resource.cover_big || resource.cover_medium || resource.cover || null,
    releaseDate: resource.release_date || null,
    trackCount: typeof resource.nb_tracks === "number" ? resource.nb_tracks : resource.tracks?.data?.length ?? null,
    duration: typeof resource.duration === "number" ? resource.duration : null,
    type: recordType,
    explicit: typeof resource.explicit_lyrics === "boolean" ? resource.explicit_lyrics : null,
    upc: resource.upc || null,
    popularity: typeof resource.fans === "number"
      ? Math.min(100, Math.max(0, Math.log10(resource.fans + 1) * 18))
      : null,
    quality: "FLAC",
    qualityTags: ["FLAC", "MP3_320"],
    url: resource.link || `https://www.deezer.com/album/${resourceId(resource.id)}`,
    raw: resource,
  };
}

function mapTrack(resource: DeezerTrackResource, albumOverride?: ProviderAlbum): ProviderTrack {
  const artist = mapArtist(resource.artist);
  const album = albumOverride || mapAlbum(resource.album || {}, artist);
  const contributors = (resource.contributors || []).map(mapArtist);
  return {
    providerId: resourceId(resource.id),
    title: String(resource.title_short || resource.title || "Unknown track"),
    version: normalizedVersion(resource.title_version),
    artist,
    artists: contributors.length > 0 ? contributors : [artist],
    album,
    duration: Number(resource.duration || 0),
    trackNumber: Number(resource.track_position || 0),
    volumeNumber: Number(resource.disk_number || 1),
    url: resource.link || `https://www.deezer.com/track/${resourceId(resource.id)}`,
    isrc: resource.isrc || null,
    releaseDate: resource.release_date || album.releaseDate || null,
    replayGain: typeof resource.gain === "number" ? resource.gain : null,
    popularity: typeof resource.rank === "number" ? Math.min(100, Math.max(0, resource.rank / 10_000)) : null,
    quality: "FLAC",
    qualityTags: ["FLAC", "MP3_320"],
    raw: resource,
  };
}

function executableAvailable(command: string): boolean {
  if (path.isAbsolute(command)) return fs.existsSync(command);
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .some((directory) => fs.existsSync(path.join(directory, process.platform === "win32" ? `${command}.exe` : command))
      || fs.existsSync(path.join(directory, command)));
}

export class DeezerProvider implements StreamingProvider {
  readonly id = "deezer";
  readonly name = "Deezer";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/deezer",
    auth: {
      kind: "external",
      managedByApp: false,
      credentialFields: [{
        key: "arl",
        label: "ARL cookie",
        secret: true,
        required: true,
        helpText: "Copy the arl cookie from a signed-in Deezer web session. It is stored only in the Deezer provider config root.",
      }],
    },
    integration: {
      catalogSource: "official-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "playlist"],
    },
    downloadBackends: [{
      id: "streamrip-deezer",
      capabilities: ["stereo"],
      enabled: true,
      setupNote: "Uses the pinned Streamrip CLI and a Deezer ARL cookie.",
    }],
    catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: false },
    imports: { supported: [] },
    qualityMapping: { neutral: true, stereo: true, spatial: false, video: false },
    diagnostics: ["auth", "catalog", "download-backend", "rate-limit"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: false,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: true,
    hiResStereo: false,
    spatialAudio: false,
    lyrics: false,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: true,
    editorialMetadata: false,
    providerIds: true,
    stereoQuality: "MP3 up to 320 kbps or 16-bit FLAC",
  };
  readonly qualityMapping = deezerQualityMapping;

  constructor(private readonly fetchImpl?: DeezerFetchLike) {}

  isAuthenticated(): boolean {
    return Boolean(loadDeezerCredentials());
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = Math.min(100, Math.max(1, options.limit || 10));
    const types = new Set(options.types?.length ? options.types : ["artists", "albums", "tracks", "videos"]);
    const encoded = encodeURIComponent(query.trim());
    const [artists, albums, tracks] = await Promise.all([
      types.has("artists")
        ? deezerApiRequest<DeezerPage<DeezerArtistResource>>(`/search/artist?q=${encoded}&limit=${limit}`, this.fetchImpl)
        : Promise.resolve({ data: [] }),
      types.has("albums")
        ? deezerApiRequest<DeezerPage<DeezerAlbumResource>>(`/search/album?q=${encoded}&limit=${limit}`, this.fetchImpl)
        : Promise.resolve({ data: [] }),
      types.has("tracks")
        ? deezerApiRequest<DeezerPage<DeezerTrackResource>>(`/search/track?q=${encoded}&limit=${limit}`, this.fetchImpl)
        : Promise.resolve({ data: [] }),
    ]);
    return {
      artists: (artists.data || []).map(mapArtist),
      albums: (albums.data || []).map((album) => mapAlbum(album)),
      tracks: (tracks.data || []).map((track) => mapTrack(track)),
      videos: [],
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return mapArtist(await deezerApiRequest<DeezerArtistResource>(`/artist/${encodeURIComponent(String(id))}`, this.fetchImpl));
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const artist = await this.getArtist(id);
    const albums = await deezerApiAllPages<DeezerAlbumResource>(
      `/artist/${encodeURIComponent(String(id))}/albums?limit=100`,
      this.fetchImpl,
    );
    return albums.map((album) => mapAlbum(album, artist));
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.getArtistAlbums(id);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    if (query.slot !== "stereo") return [];
    const result = await this.search(`${query.artistName} ${query.releaseGroupTitle}`, { types: ["albums"], limit: 25 });
    return result.albums;
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return mapAlbum(await deezerApiRequest<DeezerAlbumResource>(`/album/${encodeURIComponent(String(id))}`, this.fetchImpl));
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    const resource = await deezerApiRequest<DeezerAlbumResource>(`/album/${encodeURIComponent(String(id))}`, this.fetchImpl);
    const album = mapAlbum(resource);
    const firstPage = resource.tracks?.data || [];
    const tracks = resource.tracks?.next
      ? [...firstPage, ...await deezerApiAllPages<DeezerTrackResource>(resource.tracks.next, this.fetchImpl)]
      : firstPage;
    return tracks.map((track, index) => {
      const mapped = mapTrack(track, album);
      // Deezer's live album payload omits track_position even though the
      // ordered `tracks.data` array is authoritative. Preserve that order as
      // matching evidence instead of emitting track number 0 for every row.
      if (mapped.trackNumber <= 0) mapped.trackNumber = index + 1;
      return mapped;
    });
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    return mapTrack(await deezerApiRequest<DeezerTrackResource>(`/track/${encodeURIComponent(String(id))}`, this.fetchImpl));
  }

  async getPlaybackInfo(id: string | number): Promise<ProviderPlaybackInfo | null> {
    const resource = await deezerApiRequest<DeezerTrackResource>(`/track/${encodeURIComponent(String(id))}`, this.fetchImpl);
    return resource.preview ? { type: "bts", url: resource.preview } : null;
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.providerId == null) return null;
    if (request.entityType === "artist") return (await this.getArtist(request.providerId)).picture || null;
    if (request.entityType === "album") return (await this.getAlbum(request.providerId)).cover || null;
    return null;
  }

  async saveCredentials(credentials: Record<string, unknown>): Promise<void> {
    saveDeezerCredentials({ arl: String(credentials.arl || credentials.ARL || "") });
    syncDeezerStreamripConfig();
  }

  logout(): void {
    clearDeezerCredentials();
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const connected = this.isAuthenticated();
    return {
      connected,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 0,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      // The simple catalog API is public; ARL is needed only for acquisition.
      remoteCatalogAvailable: true,
      canAuthenticate: true,
      user: null,
      message: connected
        ? "Deezer ARL is configured for downloads."
        : "Deezer catalog access is available; add an ARL cookie to download.",
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const authenticated = this.isAuthenticated();
    const binary = getStreamripBinary();
    const binaryReady = executableAvailable(binary);
    return [{
      kind: "auth",
      status: authenticated ? "ok" : "warning",
      message: authenticated ? "Deezer ARL cookie is configured." : "Add a Deezer ARL cookie for account-quality downloads.",
      checkedAt,
    }, {
      kind: "catalog",
      status: "ok",
      message: "Deezer public catalog search and metadata are available without account authentication.",
      checkedAt,
    }, {
      kind: "download-backend",
      status: !binaryReady ? "error" : authenticated ? "ok" : "warning",
      message: !binaryReady
        ? `Streamrip executable is missing: ${binary}`
        : authenticated
          ? "Streamrip and Deezer credentials are ready."
          : "Streamrip is installed, but a Deezer ARL cookie is required.",
      checkedAt,
      details: { binary, binaryReady, authenticated },
    }, {
      kind: "rate-limit",
      status: "unknown",
      message: "Deezer does not publish response quota headers on the simple catalog API.",
      checkedAt,
    }];
  }

  getMediaUrl(type: string, providerId: string): string {
    const kind = type === "track" ? "track" : type === "artist" ? "artist" : "album";
    return `https://www.deezer.com/${kind}/${encodeURIComponent(providerId)}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    const match = url.match(/^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(artist|album|track)\/(\d+)/iu);
    return match ? { type: match[1], providerId: match[2] } : null;
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    const backend = downloadBackendRegistry.resolve(this.id, "stereo");
    if (!backend) throw new Error("No Deezer stereo download backend is registered.");
    await backend.download({
      provider: this.id,
      providerId,
      entityType,
      downloadPath,
      quality: options?.quality,
      slot: "stereo",
    }, {
      signal: options?.signal,
      onProgress: (progress) => options?.onProgress?.(progress),
    });
  }

  syncCredentials(): void {
    syncDeezerStreamripConfig();
  }
}

export const deezerStreamingProvider = new DeezerProvider();
downloadBackendRegistry.register(new StreamripDeezerBackend());
