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
  ProviderLyrics,
  ProviderManifest,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  StreamingProvider,
} from "../streaming-provider.js";
import {
  amazonMusicApiRequest,
  unwrapAmazonData,
  validateAmazonMusicCredentials,
  type AmazonMusicApiOptions,
} from "./amazon-music-api.js";
import {
  clearAmazonMusicCredentials,
  DEFAULT_AMAZON_MUSIC_API_BASE,
  loadAmazonMusicCredentials,
  saveAmazonMusicCredentials,
  type AmazonMusicCredentials,
} from "./amazon-music-auth.js";
import {
  AmazonMusicBackend,
  getAmazonMusicBridgePath,
  getAmazonMusicPython,
} from "./amazon-music-backend.js";
import { amazonMusicQualityMapping } from "./amazon-music-quality.js";

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = Number(value);
    if (value != null && Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function resourceId(resource: any): string {
  return pickString(resource?.id, resource?.asin, resource?.catalogId, resource?.catalog_id, resource?.track_id, resource?.album_id, resource?.artist_id);
}

function imageUrl(resource: any): string | null {
  const images = Array.isArray(resource?.images) ? resource.images : [];
  const image = images.find((entry: any) => entry?.url || typeof entry === "string");
  return pickString(resource?.image, resource?.image_url, resource?.cover, resource?.artwork?.url, image?.url, image) || null;
}

function listFromPayload(payload: any, ...keys: string[]): any[] {
  const data = unwrapAmazonData<any>(payload);
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.results?.[key])) return data.results[key];
  }
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function artistResource(resource: any): any {
  const direct = resource?.artist || resource?.album_artist || resource?.albumArtist;
  if (direct && typeof direct === "object") return direct;
  if (Array.isArray(resource?.artists) && resource.artists[0]) return resource.artists[0];
  if (typeof direct === "string") return { name: direct };
  return {};
}

function mapAmazonArtist(resource: any): ProviderArtist {
  const id = resourceId(resource);
  return {
    providerId: id,
    name: pickString(resource?.name, resource?.title, resource?.artist_name) || "Unknown artist",
    picture: imageUrl(resource),
    url: pickString(resource?.url, resource?.link) || (id ? `https://music.amazon.com/artists/${id}` : undefined),
    popularity: pickNumber(resource?.popularity, resource?.rank),
    raw: resource,
  };
}

function qualityDescriptor(resource: any): { quality: string | null; tags: string[] } {
  const candidates = [
    resource?.quality,
    resource?.audio_quality,
    resource?.audioQuality,
    resource?.available_qualities,
    resource?.availableQualities,
    resource?.formats,
    resource?.audio_traits,
  ].flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value]);
  const serialized = candidates.map((value) => typeof value === "string" ? value : JSON.stringify(value));
  const neutral = amazonMusicQualityMapping.toNeutral(serialized);
  const quality = neutral.audio === "hires-lossless"
    ? "HIRES_LOSSLESS"
    : neutral.audio === "lossy"
      ? "LOSSY"
      : neutral.audio === "lossless"
        ? "LOSSLESS"
        : null;
  const tags = quality ? [quality] : [];
  if (neutral.spatial?.includes("atmos")) tags.push("DOLBY_ATMOS");
  return { quality, tags };
}

function mapAmazonAlbum(resource: any, fallbackArtist?: ProviderArtist): ProviderAlbum {
  const id = resourceId(resource);
  const artist = resourceId(artistResource(resource)) || pickString(artistResource(resource)?.name)
    ? mapAmazonArtist(artistResource(resource))
    : fallbackArtist || mapAmazonArtist({});
  const artists = Array.isArray(resource?.artists) ? resource.artists.map(mapAmazonArtist) : [artist];
  const descriptor = qualityDescriptor(resource);
  const rawType = pickString(resource?.type, resource?.album_type, resource?.release_type).toUpperCase();
  return {
    providerId: id,
    title: pickString(resource?.title, resource?.name, resource?.album_name) || "Unknown album",
    artist,
    artists,
    cover: imageUrl(resource),
    releaseDate: pickString(resource?.release_date, resource?.releaseDate, resource?.date) || null,
    trackCount: pickNumber(resource?.track_count, resource?.trackCount, resource?.total_tracks, resource?.tracks?.length),
    volumeCount: pickNumber(resource?.disc_count, resource?.volumeCount),
    duration: (() => {
      const raw = pickNumber(resource?.duration, resource?.duration_ms, resource?.durationMs);
      return raw != null && raw > 10_000 ? Math.round(raw / 1000) : raw;
    })(),
    type: rawType.includes("SINGLE") ? "SINGLE" : rawType.includes("EP") ? "EP" : "ALBUM",
    explicit: typeof resource?.explicit === "boolean" ? resource.explicit : null,
    upc: pickString(resource?.upc, resource?.barcode, resource?.external_ids?.upc) || null,
    copyright: pickString(resource?.copyright) || null,
    popularity: pickNumber(resource?.popularity, resource?.rank),
    quality: descriptor.quality,
    qualityTags: descriptor.tags,
    url: pickString(resource?.url, resource?.link) || (id ? `https://music.amazon.com/albums/${id}` : undefined),
    version: pickString(resource?.version, resource?.subtitle) || null,
    raw: resource,
  };
}

function mapAmazonTrack(resource: any, albumOverride?: ProviderAlbum): ProviderTrack {
  const artist = mapAmazonArtist(artistResource(resource));
  const albumRaw = resource?.album && typeof resource.album === "object" ? resource.album : {};
  const album = albumOverride || mapAmazonAlbum(albumRaw, artist);
  const descriptor = qualityDescriptor(resource);
  const durationRaw = pickNumber(resource?.duration, resource?.duration_ms, resource?.durationMs) || 0;
  const artists = Array.isArray(resource?.artists) ? resource.artists.map(mapAmazonArtist) : [artist];
  return {
    providerId: resourceId(resource),
    title: pickString(resource?.title, resource?.name, resource?.track_name) || "Unknown track",
    version: pickString(resource?.version, resource?.subtitle) || null,
    artist,
    artists,
    album,
    duration: durationRaw > 10_000 ? Math.round(durationRaw / 1000) : durationRaw,
    trackNumber: pickNumber(resource?.track_number, resource?.trackNumber, resource?.position) || 0,
    volumeNumber: pickNumber(resource?.disc_number, resource?.volumeNumber, resource?.disc) || 1,
    url: pickString(resource?.url, resource?.link) || undefined,
    isrc: pickString(resource?.isrc, resource?.external_ids?.isrc) || null,
    releaseDate: pickString(resource?.release_date, resource?.releaseDate, album.releaseDate) || null,
    copyright: pickString(resource?.copyright) || null,
    replayGain: pickNumber(resource?.replay_gain, resource?.gain),
    peak: pickNumber(resource?.peak),
    popularity: pickNumber(resource?.popularity, resource?.rank),
    quality: descriptor.quality,
    qualityTags: descriptor.tags,
    raw: resource,
  };
}

function executableAvailable(command: string): boolean {
  if (path.isAbsolute(command)) return fs.existsSync(command);
  return String(process.env.PATH || "").split(path.delimiter).some((directory) => fs.existsSync(path.join(directory, command)));
}

export class AmazonMusicProvider implements StreamingProvider {
  readonly id = "amazon-music";
  readonly name = "Amazon Music";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/amazon-music",
    auth: {
      kind: "external",
      managedByApp: false,
      comingSoon: true,
      setupIntro:
        "Amazon Music is temporarily listed as Soon. Catalog and downloads depend on the community amazon-music bridge and its hosted token API (https://amz.dezalty.com), which is currently unreliable. Discogenius will re-enable connection when that path is usable again.",
      setupInstructions: [
        "No action needed until Amazon Music leaves Soon.",
      ],
      credentialFields: [],
    },
    integration: {
      catalogSource: "unofficial-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "playlist"],
    },
    downloadBackends: [{
      id: "amazon-music-cli",
      capabilities: ["stereo", "spatial"],
      enabled: false,
      setupNote: "Disabled while Amazon Music is marked Soon. Re-enable with amazon-music 1.7.7 once the unofficial token/API host is usable again.",
    }],
    catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: false },
    imports: { supported: [] },
    qualityMapping: { neutral: true, stereo: true, spatial: true, video: false },
    diagnostics: ["auth", "catalog", "download-backend", "rate-limit"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: false,
    audioPreviews: false,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: true,
    hiResStereo: true,
    spatialAudio: true,
    lyrics: true,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: true,
    editorialMetadata: false,
    providerIds: true,
    spatialFormats: ["DOLBY_ATMOS"],
    stereoQuality: "Up to MAX (24-bit / 192 kHz, account tier dependent)",
    spatialQuality: "Dolby Atmos (account tier dependent)",
    videoQuality: "Not available",
  };
  readonly qualityMapping = amazonMusicQualityMapping;

  constructor(private readonly apiOptions: AmazonMusicApiOptions = {}) {}

  isAuthenticated(): boolean {
    if (this.manifest.auth.comingSoon) return false;
    return Boolean(this.apiOptions.credentials ?? loadAmazonMusicCredentials());
  }

  private request<T>(route: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    return amazonMusicApiRequest<T>(route, params, this.apiOptions);
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = Math.min(100, Math.max(1, options.limit || 10));
    const types = new Set(options.types?.length ? options.types : ["artists", "albums", "tracks", "videos"]);
    const searchType = async (type: "artist" | "album" | "track") => this.request<any>("search", {
      query: query.trim(),
      type,
      max_results: limit,
    });
    const [artists, albums, tracks] = await Promise.all([
      types.has("artists") ? searchType("artist") : null,
      types.has("albums") ? searchType("album") : null,
      types.has("tracks") ? searchType("track") : null,
    ]);
    return {
      artists: artists ? listFromPayload(artists, "artists", "artist").map(mapAmazonArtist) : [],
      albums: albums ? listFromPayload(albums, "albums", "album").map((row) => mapAmazonAlbum(row)) : [],
      tracks: tracks ? listFromPayload(tracks, "tracks", "track").map((row) => mapAmazonTrack(row)) : [],
      videos: [],
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return mapAmazonArtist(unwrapAmazonData(await this.request<any>("artist", { id: String(id) })));
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const payload = await this.request<any>("artist", { id: String(id) });
    const data = unwrapAmazonData<any>(payload);
    const artist = mapAmazonArtist(data?.artist || data);
    return listFromPayload(payload, "albums", "discography", "releases").map((row) => mapAmazonAlbum(row, artist));
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.getArtistAlbums(id);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    if (query.slot === "video") return [];
    const result = await this.search(`${query.artistName} ${query.releaseGroupTitle}`, { types: ["albums"], limit: 25 });
    return query.slot === "spatial"
      ? result.albums.filter((album) => album.qualityTags?.includes("DOLBY_ATMOS"))
      : result.albums;
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return mapAmazonAlbum(unwrapAmazonData(await this.request<any>("album", { id: String(id) })));
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    const payload = await this.request<any>("album", { id: String(id) });
    const data = unwrapAmazonData<any>(payload);
    const album = mapAmazonAlbum(data?.album || data);
    return listFromPayload(payload, "tracks", "items").map((row) => mapAmazonTrack(row, album));
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    return mapAmazonTrack(unwrapAmazonData(await this.request<any>("track", { id: String(id) })));
  }

  async getLyrics(trackId: string | number): Promise<ProviderLyrics | null> {
    const data = unwrapAmazonData<any>(await this.request<any>("lyrics", { id: String(trackId) }));
    const text = pickString(data?.text, data?.lyrics, typeof data === "string" ? data : "");
    const subtitles = pickString(data?.lrc, data?.synced, data?.subtitles);
    return text || subtitles ? { text, subtitles, provider: this.name, raw: data } : null;
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.providerId == null) return null;
    if (request.entityType === "artist") return (await this.getArtist(request.providerId)).picture || null;
    if (request.entityType === "album") return (await this.getAlbum(request.providerId)).cover || null;
    return null;
  }

  async saveCredentials(credentials: Record<string, unknown>): Promise<void> {
    const candidate: AmazonMusicCredentials = {
      accessToken: pickString(credentials.accessToken, credentials.access_token, credentials.token),
      apiBase: pickString(credentials.apiBase, credentials.api_base) || DEFAULT_AMAZON_MUSIC_API_BASE,
    };
    const validator = credentials.validator as ((value: AmazonMusicCredentials) => Promise<void>) | undefined;
    if (validator) await validator(candidate);
    else await validateAmazonMusicCredentials(candidate, this.apiOptions);
    saveAmazonMusicCredentials(candidate);
  }

  logout(): void {
    clearAmazonMusicCredentials();
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    if (this.manifest.auth.comingSoon) {
      return {
        connected: false,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 0,
        canAccessShell: false,
        canAccessLocalLibrary: false,
        remoteCatalogAvailable: false,
        canAuthenticate: false,
        user: null,
        message: "Amazon Music is marked Soon until the unofficial token/API host is reliable again.",
      };
    }
    const connected = this.isAuthenticated();
    return {
      connected,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 0,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: connected,
      canAuthenticate: true,
      user: null,
      message: connected
        ? "Amazon Music external API credentials are configured."
        : "An external Amazon Music API token is required; Amazon's official Web API remains closed beta.",
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const credentials = this.apiOptions.credentials ?? loadAmazonMusicCredentials();
    const python = getAmazonMusicPython();
    const bridge = getAmazonMusicBridgePath();
    const pythonReady = executableAvailable(python);
    const bridgeReady = fs.existsSync(bridge);
    return [{
      kind: "auth",
      status: credentials ? "ok" : "warning",
      message: credentials ? "Amazon Music external API token is configured." : "Configure an Amazon Music external API token.",
      checkedAt,
      details: { apiBase: credentials?.apiBase || DEFAULT_AMAZON_MUSIC_API_BASE },
    }, {
      kind: "catalog",
      status: credentials ? "ok" : "disabled",
      message: credentials
        ? "Unofficial Amazon Music catalog adapter is configured; live entitlement still depends on the external service."
        : "Amazon Music catalog access is disabled until the external API is connected.",
      checkedAt,
    }, {
      kind: "download-backend",
      status: credentials && pythonReady && bridgeReady ? "ok" : "error",
      message: !pythonReady
        ? `Amazon Music Python runtime is missing: ${python}`
        : !bridgeReady
          ? `Amazon Music download bridge is missing: ${bridge}`
          : credentials
            ? "Amazon Music download bridge is installed."
            : "Amazon Music downloader is installed, but the external API token is missing.",
      checkedAt,
      details: { python, pythonReady, bridge, bridgeReady },
    }, {
      kind: "rate-limit",
      status: "unknown",
      message: "Quota is controlled by the configured external API service and subscription tier.",
      checkedAt,
    }];
  }

  getMediaUrl(type: string, providerId: string): string {
    const segment = type === "track" ? "tracks" : type === "artist" ? "artists" : "albums";
    return `https://music.amazon.com/${segment}/${encodeURIComponent(providerId)}`;
  }

  parseMediaUrl(input: string): { type: string; providerId: string } | null {
    try {
      const url = new URL(input);
      if (!/(^|\.)amazon\.[a-z.]+$/iu.test(url.hostname) && !url.hostname.startsWith("music.amazon.")) return null;
      const trackAsin = url.searchParams.get("trackAsin");
      if (trackAsin) return { type: "track", providerId: trackAsin };
      const match = url.pathname.match(/^\/(artists?|albums?|tracks?|playlists?)\/([A-Za-z0-9]+)/u);
      if (!match) return null;
      const rawType = match[1].toLowerCase();
      const type = rawType.startsWith("artist") ? "artist" : rawType.startsWith("album") ? "album" : rawType.startsWith("track") ? "track" : "playlist";
      return { type, providerId: match[2] };
    } catch {
      return null;
    }
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    const capability = entityType === "video"
      ? "video"
      : options?.qualityProfile === "spatial" || String(options?.quality || "").toLowerCase().includes("atmos")
        ? "spatial"
        : "stereo";
    const backend = downloadBackendRegistry.resolve(this.id, capability);
    if (!backend) throw new Error(`No Amazon Music ${capability} download backend is registered.`);
    await backend.download({
      provider: this.id,
      entityType,
      providerId,
      downloadPath,
      quality: options?.quality,
      slot: capability,
    }, {
      signal: options?.signal,
      onProgress: (progress) => options?.onProgress?.(progress),
    });
  }
}

export const amazonMusicStreamingProvider = new AmazonMusicProvider();
downloadBackendRegistry.register(new AmazonMusicBackend());
