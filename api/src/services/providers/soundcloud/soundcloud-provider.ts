import fs from "node:fs";
import path from "node:path";

import { downloadBackendRegistry } from "../../download/download-backend.js";
import { resolveCommandPath } from "../../../utils/health.js";
import type {
  ProviderAlbum,
  ProviderArtist,
  ProviderArtworkRequest,
  ProviderAuthStatus,
  ProviderCapabilities,
  ProviderDiagnosticResult,
  ProviderDownloadOptions,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderManifest,
  ProviderPlaybackInfo,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  StreamingProvider,
} from "../streaming-provider.js";
import { getYtDlpBinary } from "../youtube-music/yt-dlp-backend.js";
import {
  clearSoundCloudCredentials,
  getSoundCloudCredentialState,
  loadSoundCloudCredentials,
  saveSoundCloudCredentials,
  SOUNDCLOUD_COOKIES_FILE,
} from "./soundcloud-auth.js";
import {
  soundcloudApiAllPages,
  soundcloudApiRequest,
  soundcloudGetMe,
  soundcloudResourceId,
  type SoundCloudFetchLike,
  type SoundCloudPlaylistResource,
  type SoundCloudTrackResource,
  type SoundCloudUserResource,
} from "./soundcloud-api.js";
import { SoundCloudBackend } from "./soundcloud-backend.js";
import { soundcloudQualityMapping } from "./soundcloud-quality.js";
import {
  PLAYLIST_TRACKLIST_COVERAGE_METHOD,
  playlistCoversCanonicalTracklist,
  rankSoundCloudPlaylistCandidates,
  shouldWideSearchSoundCloudPlaylists,
  type CanonicalTrackForCoverage,
} from "./soundcloud-playlist-match.js";

function commandAvailable(command: string): boolean {
  if (command.includes("/") || command.includes("\\") || /^[A-Za-z]:/u.test(command)) {
    return fs.existsSync(command);
  }
  return Boolean(resolveCommandPath(command));
}

function artworkUrl(url: string | null | undefined): string | null {
  const value = String(url || "").trim();
  if (!value) return null;
  return value.replace("-large.", "-t500x500.").replace("-badge.", "-t500x500.");
}

function durationSeconds(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 1000);
}

function calendarDay(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  return match?.[1] || null;
}

function mapArtist(resource: SoundCloudUserResource | undefined): ProviderArtist {
  const providerId = soundcloudResourceId(resource?.id);
  const name = String(resource?.username || resource?.full_name || "Unknown artist");
  return {
    providerId,
    name,
    picture: artworkUrl(resource?.avatar_url),
    url: resource?.permalink_url || (providerId ? `https://soundcloud.com/${providerId}` : undefined),
    popularity: typeof resource?.followers_count === "number"
      ? Math.min(100, Math.max(0, Math.log10(resource.followers_count + 1) * 16))
      : null,
    raw: resource,
  };
}

function playlistType(resource: SoundCloudPlaylistResource): string {
  if (resource.is_album) return "ALBUM";
  const setType = String(resource.set_type || "").toLowerCase();
  if (setType.includes("ep")) return "EP";
  if (setType.includes("single")) return "SINGLE";
  if (setType) return setType.toUpperCase();
  // User playlists/sets are not official albums — keep them distinguishable for match evidence.
  return "PLAYLIST";
}

function mapAlbum(
  resource: SoundCloudPlaylistResource,
  fallbackArtist?: ProviderArtist,
): ProviderAlbum {
  const artist = resource.user?.id != null ? mapArtist(resource.user) : fallbackArtist || mapArtist(resource.user);
  const providerId = soundcloudResourceId(resource.id);
  return {
    providerId,
    title: String(resource.title || "Unknown album"),
    artist,
    artists: [artist],
    cover: artworkUrl(resource.artwork_url) || artist.picture || null,
    releaseDate: calendarDay(resource.release_date || resource.display_date || resource.created_at),
    trackCount: typeof resource.track_count === "number"
      ? resource.track_count
      : resource.tracks?.length ?? null,
    duration: durationSeconds(resource.duration) || null,
    type: playlistType(resource),
    upc: resource.publisher_metadata?.upc_or_ean || null,
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    url: resource.permalink_url || (providerId ? `https://soundcloud.com/playlists/${providerId}` : undefined),
    raw: resource,
  };
}

function mapTrack(
  resource: SoundCloudTrackResource,
  albumOverride?: ProviderAlbum,
  trackNumber = 0,
): ProviderTrack {
  const artist = mapArtist(resource.user);
  const album = albumOverride || {
    providerId: "",
    title: String(
      resource.publisher_metadata?.album_title
      || resource.publisher_metadata?.release_title
      || "SoundCloud",
    ),
    artist,
    artists: [artist],
    cover: artworkUrl(resource.artwork_url),
    releaseDate: calendarDay(resource.release_date || resource.display_date || resource.created_at),
    trackCount: null,
    duration: null,
    type: "SINGLE",
    upc: resource.publisher_metadata?.upc_or_ean || null,
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    url: undefined,
    raw: null,
  };
  const providerId = soundcloudResourceId(resource.id);
  return {
    providerId,
    title: String(resource.title || "Unknown track"),
    version: null,
    artist,
    artists: [artist],
    album,
    duration: durationSeconds(resource.duration),
    trackNumber,
    volumeNumber: 1,
    url: resource.permalink_url || (providerId ? `https://soundcloud.com/tracks/${providerId}` : undefined),
    isrc: resource.publisher_metadata?.isrc || null,
    releaseDate: calendarDay(resource.release_date || resource.display_date || resource.created_at) || album.releaseDate || null,
    popularity: null,
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    raw: resource,
  };
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

export function parseSoundCloudUrl(url: string): { type: string; providerId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(parsed.protocol)) return null;
  const host = normalizedHost(parsed.hostname);
  if (!["soundcloud.com", "on.soundcloud.com", "m.soundcloud.com", "api.soundcloud.com"].includes(host)) {
    return null;
  }

  const apiTrack = parsed.pathname.match(/\/tracks\/(?:soundcloud%3Atracks%3A)?(\d+)/iu);
  if (apiTrack) return { type: "track", providerId: apiTrack[1]! };

  const apiPlaylist = parsed.pathname.match(/\/playlists\/(?:soundcloud%3Aplaylists%3A)?(\d+)/iu);
  if (apiPlaylist) return { type: "album", providerId: apiPlaylist[1]! };

  const apiUser = parsed.pathname.match(/\/users\/(?:soundcloud%3Ausers%3A)?(\d+)/iu);
  if (apiUser) return { type: "artist", providerId: apiUser[1]! };

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === "playlists" && segments[1] && /^\d+$/u.test(segments[1])) {
    return { type: "album", providerId: segments[1] };
  }
  // Permalink paths need resolve; keep numeric ids only here.
  return null;
}

export class SoundCloudProvider implements StreamingProvider {
  readonly id = "soundcloud";
  readonly name = "SoundCloud";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/soundcloud",
    auth: {
      kind: "external",
      managedByApp: false,
      setupIntro:
        "Experimental. SoundCloud uses a browser session oauth_token plus the public web client_id — "
        + "not official OAuth 2.1 with a registered app secret. "
        + "Major-label tracks on free accounts are often SNIP or encrypted HLS only; "
        + "treat pasted tokens as temporary and revoke the browser session when finished testing.",
      setupInstructions: [
        "Open https://soundcloud.com while signed in, then open DevTools → Network.",
        "Find a request to api-v2.soundcloud.com (or api-auth.soundcloud.com/connect/session).",
        "Copy the oauth / access_token value (Authorization: OAuth … or the session JSON access_token).",
        "Paste it into OAuth token. Leave Client id blank to use the built-in public web client id.",
        "Optional: export soundcloud.com cookies with \"Get cookies.txt LOCALLY\" for yt-dlp fallback when native progressive streams are unavailable.",
      ],
      credentialFields: [
        {
          key: "oauthToken",
          label: "OAuth token",
          secret: true,
          required: true,
          helpText: "Browser session oauth_token / access_token. Stored only under config/providers/soundcloud/.",
        },
        {
          key: "clientId",
          label: "Client id",
          secret: false,
          required: false,
          helpText: "Public SoundCloud web client_id. Leave blank to use the built-in default.",
        },
        {
          key: "cookies",
          label: "SoundCloud cookies (optional)",
          secret: true,
          multiline: true,
          required: false,
          helpText: "Netscape cookies.txt or a Cookie header. Helps yt-dlp when native progressive streams are unavailable.",
        },
      ],
    },
    integration: {
      catalogSource: "unofficial-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "playlist"],
    },
    downloadBackends: [{
      id: "soundcloud-yt-dlp",
      capabilities: ["stereo"],
      enabled: true,
      setupNote:
        "Prefers native progressive MP3 when the account can resolve it; falls back to yt-dlp with the oauth header. "
        + "Lossy only. Free accounts often get SNIP previews or encrypted HLS on major-label tracks; Go+ is closer to other streamers.",
    }],
    catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: false },
    imports: { supported: ["favorite-tracks", "playlist"] },
    qualityMapping: { neutral: true, stereo: true, spatial: false, video: false },
    diagnostics: ["auth", "catalog", "download-backend"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: false,
    audioPreviews: true,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: false,
    hiResStereo: false,
    spatialAudio: false,
    lyrics: false,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: true,
    editorialMetadata: false,
    providerIds: true,
    stereoQuality: "Up to lossy MP3/AAC (progressive or HLS)",
    spatialQuality: "Not available",
    videoQuality: "Not available",
  };
  readonly qualityMapping = soundcloudQualityMapping;

  constructor(private readonly fetchImpl?: SoundCloudFetchLike) {}

  isAuthenticated(): boolean {
    return getSoundCloudCredentialState().configured;
  }

  private fetchOptions() {
    return { fetchImpl: this.fetchImpl };
  }

  async search(query: string, options: ProviderSearchOptions = {}): Promise<ProviderSearchResults> {
    const limit = Math.min(50, Math.max(1, options.limit || 10));
    const types = new Set(options.types?.length ? options.types : ["artists", "albums", "tracks"]);
    const encoded = encodeURIComponent(query.trim());
    const [artists, albums, tracks] = await Promise.all([
      types.has("artists")
        ? soundcloudApiRequest<{ collection?: SoundCloudUserResource[] }>(
          `/search/users?q=${encoded}&limit=${limit}`,
          this.fetchOptions(),
        )
        : Promise.resolve({ collection: [] }),
      types.has("albums")
        ? soundcloudApiRequest<{ collection?: SoundCloudPlaylistResource[] }>(
          `/search/albums?q=${encoded}&limit=${limit}`,
          this.fetchOptions(),
        )
        : Promise.resolve({ collection: [] }),
      types.has("tracks")
        ? soundcloudApiRequest<{ collection?: SoundCloudTrackResource[] }>(
          `/search/tracks?q=${encoded}&limit=${limit}`,
          this.fetchOptions(),
        )
        : Promise.resolve({ collection: [] }),
    ]);
    return {
      artists: (artists.collection || []).map(mapArtist),
      albums: (albums.collection || []).map((album) => mapAlbum(album)),
      tracks: (tracks.collection || []).map((track) => mapTrack(track)),
      videos: [],
    };
  }

  async getArtist(id: string | number): Promise<ProviderArtist> {
    return mapArtist(await soundcloudApiRequest<SoundCloudUserResource>(
      `/users/${encodeURIComponent(String(id))}`,
      this.fetchOptions(),
    ));
  }

  async getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    const artist = await this.getArtist(id);
    const albums = await soundcloudApiAllPages<SoundCloudPlaylistResource>(
      `/users/${encodeURIComponent(String(id))}/albums?limit=50`,
      { ...this.fetchOptions(), maxPages: 10 },
    );
    // Some accounts expose sets only under /playlists; merge when albums are thin.
    if (albums.length === 0) {
      const playlists = await soundcloudApiAllPages<SoundCloudPlaylistResource>(
        `/users/${encodeURIComponent(String(id))}/playlists?limit=50`,
        { ...this.fetchOptions(), maxPages: 5 },
      );
      return playlists.map((playlist) => mapAlbum(playlist, artist));
    }
    return albums.map((album) => mapAlbum(album, artist));
  }

  async listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.getArtistAlbums(id);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    if (query.slot !== "stereo") return [];

    const widePlaylistSearch = shouldWideSearchSoundCloudPlaylists(
      query.primaryType,
      query.secondaryTypes,
    );
    const artistQuery = `${query.artistName} ${query.releaseGroupTitle}`.trim();
    const titleQuery = String(query.releaseGroupTitle || "").trim();

    // Official Album/EP/Single path: album search only (no noisy fan playlists).
    if (!widePlaylistSearch) {
      const result = await this.search(artistQuery, { types: ["albums"], limit: 25 });
      return result.albums;
    }

    // Mixtape / dj-mix / demo / Other: cast a wider net across user playlists/sets.
    const [albumHits, playlistHits, titlePlaylistHits] = await Promise.all([
      soundcloudApiRequest<{ collection?: SoundCloudPlaylistResource[] }>(
        `/search/albums?q=${encodeURIComponent(artistQuery)}&limit=25`,
        this.fetchOptions(),
      ),
      soundcloudApiRequest<{ collection?: SoundCloudPlaylistResource[] }>(
        `/search/playlists?q=${encodeURIComponent(artistQuery)}&limit=25`,
        this.fetchOptions(),
      ),
      titleQuery && titleQuery.toLowerCase() !== artistQuery.toLowerCase()
        ? soundcloudApiRequest<{ collection?: SoundCloudPlaylistResource[] }>(
          `/search/playlists?q=${encodeURIComponent(titleQuery)}&limit=25`,
          this.fetchOptions(),
        )
        : Promise.resolve({ collection: [] as SoundCloudPlaylistResource[] }),
    ]);

    const byId = new Map<string, ProviderAlbum>();
    for (const resource of [
      ...(albumHits.collection || []),
      ...(playlistHits.collection || []),
      ...(titlePlaylistHits.collection || []),
    ]) {
      const album = mapAlbum(resource);
      if (!album.providerId || byId.has(album.providerId)) continue;
      byId.set(album.providerId, album);
    }

    const ranked = rankSoundCloudPlaylistCandidates(
      Array.from(byId.values()),
      query.releaseGroupTitle,
      query.preferredTrackCount,
    );

    const preferredTracks = Array.isArray(query.preferredTracks)
      ? query.preferredTracks.filter((track) => String(track.title || "").trim())
      : [];
    if (preferredTracks.length === 0) {
      // Without a tracklist we only return title-ranked candidates; the caller
      // should supply preferredTracks for mixtape coverage conviction.
      return ranked.slice(0, 10);
    }

    const covering: Array<{ album: ProviderAlbum; extras: number }> = [];
    for (const candidate of ranked.slice(0, 8)) {
      try {
        const tracks = await this.getAlbumTracks(candidate.providerId);
        if (!playlistCoversCanonicalTracklist(preferredTracks as CanonicalTrackForCoverage[], tracks)) {
          continue;
        }
        const extras = Math.max(0, tracks.length - preferredTracks.length);
        // Stamp coverage method on raw so the artist-match path can force probable.
        covering.push({
          album: {
            ...candidate,
            raw: {
              ...(candidate.raw && typeof candidate.raw === "object" ? candidate.raw as object : {}),
              _discogeniusMatchMethod: PLAYLIST_TRACKLIST_COVERAGE_METHOD,
              _discogeniusCoverageExtras: extras,
            },
          },
          extras,
        });
      } catch {
        // Skip playlists we cannot hydrate.
      }
    }

    covering.sort((left, right) =>
      left.extras - right.extras
      || String(left.album.providerId).localeCompare(String(right.album.providerId)));
    return covering.map((row) => row.album);
  }

  async getAlbum(id: string | number): Promise<ProviderAlbum> {
    return mapAlbum(await soundcloudApiRequest<SoundCloudPlaylistResource>(
      `/playlists/${encodeURIComponent(String(id))}?representation=full`,
      this.fetchOptions(),
    ));
  }

  async getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    const resource = await soundcloudApiRequest<SoundCloudPlaylistResource>(
      `/playlists/${encodeURIComponent(String(id))}?representation=full`,
      this.fetchOptions(),
    );
    const album = mapAlbum(resource);
    const tracks = resource.tracks || [];
    // Full representation may include stub tracks (id only). Hydrate missing titles.
    const mapped: ProviderTrack[] = [];
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index]!;
      if (track.title) {
        mapped.push(mapTrack(track, album, index + 1));
        continue;
      }
      const trackId = soundcloudResourceId(track.id);
      if (!trackId) continue;
      try {
        const full = await soundcloudApiRequest<SoundCloudTrackResource>(
          `/tracks/${encodeURIComponent(trackId)}`,
          this.fetchOptions(),
        );
        mapped.push(mapTrack(full, album, index + 1));
      } catch {
        mapped.push(mapTrack(track, album, index + 1));
      }
    }
    return mapped;
  }

  async getTrack(id: string | number): Promise<ProviderTrack> {
    return mapTrack(await soundcloudApiRequest<SoundCloudTrackResource>(
      `/tracks/${encodeURIComponent(String(id))}`,
      this.fetchOptions(),
    ));
  }

  async getPlaybackInfo(id: string | number): Promise<ProviderPlaybackInfo | null> {
    const track = await soundcloudApiRequest<SoundCloudTrackResource>(
      `/tracks/${encodeURIComponent(String(id))}`,
      this.fetchOptions(),
    );
    const { resolveSoundCloudMediaUrl } = await import("./soundcloud-api.js");
    // Browser preview may use SNIP progressive (30s) when full streams are
    // DRM-only or unavailable for the account. Downloads still reject SNIP.
    // Only progressive HTTP is safe for the BTS play proxy; plain HLS would
    // need the HLS playlist path, and encrypted HLS needs DRM.
    const media = await resolveSoundCloudMediaUrl(track, {
      ...this.fetchOptions(),
      allowSnipped: true,
    });
    if (!media?.url || media.protocol !== "progressive") return null;
    return { type: "bts", url: media.url };
  }

  async listImportSources(): Promise<ProviderImportSource[]> {
    const credentials = loadSoundCloudCredentials();
    let userId = credentials?.userId || "";
    if (!userId) {
      try {
        const me = await soundcloudGetMe(this.fetchOptions());
        userId = soundcloudResourceId(me.id);
      } catch {
        userId = "";
      }
    }

    const sources: ProviderImportSource[] = [{
      category: "favorite-tracks",
      label: "Liked tracks",
      description: "Artists from tracks you liked on SoundCloud.",
      requiresListSelection: false,
    }];

    if (userId) {
      try {
        const playlists = await soundcloudApiAllPages<SoundCloudPlaylistResource>(
          `/users/${encodeURIComponent(userId)}/playlists?limit=50`,
          { ...this.fetchOptions(), maxPages: 5 },
        );
        sources.push({
          category: "playlist",
          label: "Playlists",
          description: "Import artists appearing in one of your SoundCloud playlists.",
          requiresListSelection: true,
          lists: playlists.map((playlist) => ({
            id: soundcloudResourceId(playlist.id),
            title: String(playlist.title || "Untitled playlist"),
            subtitle: playlist.user?.username || null,
            image: artworkUrl(playlist.artwork_url),
            itemCount: playlist.track_count ?? playlist.tracks?.length ?? null,
          })),
        });
      } catch {
        // Playlists are optional; likes still work as a category.
      }
    }
    return sources;
  }

  async getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    const credentials = loadSoundCloudCredentials();
    let userId = credentials?.userId || "";
    if (!userId) {
      const me = await soundcloudGetMe(this.fetchOptions());
      userId = soundcloudResourceId(me.id);
    }

    const artists = new Map<string, ProviderArtist>();
    const addFromTracks = (tracks: SoundCloudTrackResource[]) => {
      for (const track of tracks) {
        const artist = mapArtist(track.user);
        if (artist.providerId) artists.set(artist.providerId, artist);
      }
    };

    if (selection.category === "favorite-tracks") {
      const tracks = await soundcloudApiAllPages<SoundCloudTrackResource | { track?: SoundCloudTrackResource }>(
        `/users/${encodeURIComponent(userId)}/likes/tracks?limit=50`,
        { ...this.fetchOptions(), maxPages: 10 },
      );
      addFromTracks(tracks.map((item) => ("track" in item && item.track ? item.track : item as SoundCloudTrackResource)));
      return Array.from(artists.values());
    }

    if (selection.category === "playlist") {
      const listId = String(selection.listId || "").trim();
      if (!listId) throw new Error("SoundCloud playlist import requires listId.");
      const playlist = await soundcloudApiRequest<SoundCloudPlaylistResource>(
        `/playlists/${encodeURIComponent(listId)}?representation=full`,
        this.fetchOptions(),
      );
      addFromTracks(playlist.tracks || []);
      return Array.from(artists.values());
    }

    throw new Error(`SoundCloud does not support import category: ${selection.category}`);
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.providerId == null) return null;
    if (request.entityType === "artist") return (await this.getArtist(request.providerId)).picture || null;
    if (request.entityType === "album") return (await this.getAlbum(request.providerId)).cover || null;
    return null;
  }

  async saveCredentials(credentials: Record<string, unknown>): Promise<void> {
    saveSoundCloudCredentials(credentials);
    // Validate immediately so Auth UI surfaces bad tokens before a refresh job.
    await soundcloudGetMe(this.fetchOptions());
  }

  logout(): void {
    clearSoundCloudCredentials();
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const state = getSoundCloudCredentialState();
    if (!state.configured) {
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
        message: "Add a SoundCloud oauth token to enable catalog matching and downloads.",
      };
    }
    try {
      const me = await soundcloudGetMe(this.fetchOptions());
      const product = me.consumer_subscription?.product?.id || "free";
      return {
        connected: true,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 0,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: true,
        canAuthenticate: true,
        user: { username: me.username || me.full_name || undefined },
        message: `Connected as ${me.username || me.full_name || me.id} (${product}).`,
      };
    } catch (error) {
      return {
        connected: false,
        tokenExpired: true,
        refreshTokenExpired: false,
        hoursUntilExpiry: 0,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: false,
        canAuthenticate: true,
        user: null,
        message: error instanceof Error ? error.message : "SoundCloud token validation failed.",
      };
    }
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const state = getSoundCloudCredentialState();
    const ytDlpBinary = getYtDlpBinary();
    const ytDlpAvailable = commandAvailable(ytDlpBinary);
    const ffmpegAvailable = commandAvailable("ffmpeg");
    let authStatus: ProviderDiagnosticResult["status"] = state.configured ? "ok" : "warning";
    let authMessage = state.configured
      ? "SoundCloud oauth token is configured."
      : "Add a SoundCloud oauth token for catalog and downloads.";
    if (state.configured) {
      try {
        await soundcloudGetMe(this.fetchOptions());
      } catch (error) {
        authStatus = "error";
        authMessage = error instanceof Error ? error.message : "SoundCloud token validation failed.";
      }
    }
    return [
      {
        kind: "auth",
        status: authStatus,
        message: authMessage,
        checkedAt,
        details: {
          authKind: this.manifest.auth.kind,
          cookiesConfigured: state.cookiesConfigured,
          userId: state.userId,
        },
      },
      {
        kind: "catalog",
        status: state.configured && authStatus === "ok" ? "ok" : "warning",
        message: state.configured && authStatus === "ok"
          ? "SoundCloud api-v2 catalog search is available with the configured session."
          : "SoundCloud catalog calls require a valid oauth token.",
        checkedAt,
      },
      {
        kind: "download-backend",
        status: !ytDlpAvailable && !ffmpegAvailable ? "warning" : "ok",
        message: ytDlpAvailable
          ? "Native progressive download is preferred; yt-dlp is available as fallback."
          : "Native progressive MP3 download works without yt-dlp; install yt-dlp for encrypted/HLS fallback.",
        checkedAt,
        details: {
          ytDlpBinary,
          ytDlpAvailable,
          ffmpegAvailable,
          cookiesPath: SOUNDCLOUD_COOKIES_FILE,
          cookiesConfigured: state.cookiesConfigured,
          credentialsPath: path.join("providers", "soundcloud", "credentials.json"),
        },
      },
    ];
  }

  getMediaUrl(type: string, providerId: string): string {
    if (type === "artist") return `https://soundcloud.com/${encodeURIComponent(providerId)}`;
    if (type === "track") return `https://api.soundcloud.com/tracks/${encodeURIComponent(providerId)}`;
    return `https://soundcloud.com/playlists/${encodeURIComponent(providerId)}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    return parseSoundCloudUrl(url);
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    if (entityType === "video") {
      throw new Error("SoundCloud does not provide music-video downloads in Discogenius.");
    }
    const backend = downloadBackendRegistry.resolve(this.id, "stereo");
    if (!backend) throw new Error("No SoundCloud stereo download backend is registered.");
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
}

export const soundcloudStreamingProvider = new SoundCloudProvider();
downloadBackendRegistry.register(new SoundCloudBackend());
