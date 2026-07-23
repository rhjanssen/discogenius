import { spawn } from "node:child_process";
import fs from "node:fs";

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
  ProviderLyrics,
  ProviderReleaseGroupSearch,
  ProviderSearchOptions,
  ProviderSearchResults,
  ProviderTrack,
  ProviderVideo,
  StreamingProvider,
} from "../streaming-provider.js";
import {
  clearYouTubeMusicCredentials,
  getYouTubeMusicCredentialState,
  saveYouTubeMusicCredentials,
  YOUTUBE_MUSIC_COOKIES_FILE,
} from "./youtube-music-auth.js";
import { YouTubeMusicCatalog } from "./youtube-music-catalog.js";
import { youtubeMusicQualityMapping } from "./youtube-music-quality.js";
import { getYtMusicBridgeScript, getYtMusicPythonBinary } from "./ytmusicapi-bridge.js";
import { getYtDlpBinary, YtDlpBackend } from "./yt-dlp-backend.js";

export interface YouTubeMusicCapabilitySnapshot {
  pythonBinary: string;
  pythonAvailable: boolean;
  bridgeScript: string;
  bridgeScriptAvailable: boolean;
  ytmusicapiAvailable: boolean;
  ytDlpBinary: string;
  ytDlpAvailable: boolean;
  ffmpegAvailable: boolean;
  browserHeadersConfigured: boolean;
  cookiesConfigured: boolean;
}

function probePythonModule(binary: string, moduleName: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["-c", `import ${moduleName}`], { stdio: "ignore" });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timeout.unref?.();
  });
}

function commandAvailable(command: string): boolean {
  if (command.includes("/") || command.includes("\\") || /^[A-Za-z]:/u.test(command)) {
    return fs.existsSync(command);
  }
  return Boolean(resolveCommandPath(command));
}

export async function getYouTubeMusicCapabilitySnapshot(): Promise<YouTubeMusicCapabilitySnapshot> {
  const pythonBinary = getYtMusicPythonBinary();
  const bridgeScript = getYtMusicBridgeScript();
  const ytDlpBinary = getYtDlpBinary();
  const pythonAvailable = commandAvailable(pythonBinary);
  const credentials = getYouTubeMusicCredentialState();
  return {
    pythonBinary,
    pythonAvailable,
    bridgeScript,
    bridgeScriptAvailable: fs.existsSync(bridgeScript),
    ytmusicapiAvailable: pythonAvailable ? await probePythonModule(pythonBinary, "ytmusicapi") : false,
    ytDlpBinary,
    ytDlpAvailable: commandAvailable(ytDlpBinary),
    ffmpegAvailable: commandAvailable("ffmpeg"),
    ...credentials,
  };
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const RESOURCE_ID = /^[A-Za-z0-9_-]{8,200}$/u;

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

export function parseYouTubeMusicUrl(url: string): { type: string; providerId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(parsed.protocol)) return null;
  const host = normalizedHost(parsed.hostname);
  if (!["youtube.com", "music.youtube.com", "youtu.be"].includes(host)) return null;

  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    return VIDEO_ID.test(id) ? { type: "video", providerId: id } : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "watch") {
    const id = parsed.searchParams.get("v") || "";
    if (!VIDEO_ID.test(id)) return null;
    return { type: host === "music.youtube.com" ? "track" : "video", providerId: id };
  }
  if (["shorts", "live", "embed"].includes(segments[0] || "")) {
    const id = segments[1] || "";
    return VIDEO_ID.test(id) ? { type: "video", providerId: id } : null;
  }
  if (segments[0] === "playlist") {
    const id = parsed.searchParams.get("list") || "";
    return RESOURCE_ID.test(id) ? { type: "album", providerId: id } : null;
  }
  if (segments[0] === "channel") {
    const id = segments[1] || "";
    return RESOURCE_ID.test(id) ? { type: "artist", providerId: id } : null;
  }
  if (segments[0] === "browse") {
    const id = segments[1] || "";
    if (!RESOURCE_ID.test(id)) return null;
    return { type: id.startsWith("UC") ? "artist" : "album", providerId: id };
  }
  return null;
}

export class YouTubeMusicProvider implements StreamingProvider {
  readonly id = "youtube-music";
  readonly name = "YouTube Music";
  readonly manifest: ProviderManifest = {
    id: this.id,
    displayName: this.name,
    configRoot: "providers/youtube-music",
  auth: {
    kind: "external",
    managedByApp: false,
    // Public YouTube media remains downloadable through yt-dlp without browser
    // credentials; auth adds account/restricted-media access.
    mediaAccessRequiresConnection: false,
    setupIntro:
      "Follow the steps below, then paste the DevTools exports. Secret values stay masked and are stored only in this provider's config directory.",
    setupInstructions: [
      "Open https://music.youtube.com while signed in, then open DevTools → Network and reload Library.",
      "Find a request whose URL contains youtubei/v1/browse (or another youtubei call).",
      "Right-click it → Copy → Copy as Node.js fetch and paste the whole snippet into Browser headers. Discogenius keeps Authorization, Cookie (if present), and the other auth headers it needs.",
      "Chrome often omits Cookie from that paste and only sets credentials: \"include\". If there is no cookie line in the headers object, also export cookies with the \"Get cookies.txt LOCALLY\" extension for youtube.com / music.youtube.com and paste that into YouTube cookies — that file is what fills Cookie for ytmusicapi and yt-dlp.",
    ],
    credentialFields: [
      {
        key: "headersJson",
        label: "Browser headers (Copy as Node.js fetch)",
        secret: true,
        multiline: true,
        required: false,
        helpText: "Paste the full fetch(...) snippet. Do not paste the Response JSON.",
      },
      {
        key: "cookies",
        label: "YouTube cookies (cookies.txt)",
        secret: true,
        multiline: true,
        required: false,
        helpText: "Required when the fetch paste has no cookie header (common with credentials: \"include\"). Use \"Get cookies.txt LOCALLY\".",
      },
    ],
  },
    integration: {
      catalogSource: "unofficial-api",
      downloadSource: "native-cli",
      stableResourceIds: ["artist", "album", "track", "video", "playlist"],
    },
    downloadBackends: [{
      id: "yt-dlp",
      capabilities: ["stereo", "video"],
      enabled: true,
      setupNote: "Requires ytmusicapi for catalog access plus yt-dlp and ffmpeg for lossy audio/video downloads.",
    }],
    catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: true },
    imports: { supported: ["library-artists", "playlist", "favorite-tracks", "mix"] },
    qualityMapping: { neutral: true, stereo: true, spatial: false, video: true },
    diagnostics: ["auth", "catalog", "download-backend"],
  };
  readonly capabilities: ProviderCapabilities = {
    catalogSearch: true,
    artistCatalog: true,
    followedArtists: true,
    audioPreviews: false,
    audioDownloads: true,
    lossyStereo: true,
    losslessStereo: false,
    hiResStereo: false,
    spatialAudio: false,
    lyrics: true,
    musicVideos: true,
    videoPreviews: false,
    videoDownloads: true,
    artwork: true,
    editorialMetadata: false,
    providerIds: true,
    stereoQuality: "Up to LOW (lossy Opus/AAC)",
    spatialQuality: "Not available",
    videoQuality: "Up to UHD (2160p)",
    maxVideoResolution: 2160,
  };
  readonly qualityMapping = youtubeMusicQualityMapping;

  private readonly catalog: YouTubeMusicCatalog;
  private readonly capabilityProbe: () => Promise<YouTubeMusicCapabilitySnapshot>;

  constructor(options: {
    catalog?: YouTubeMusicCatalog;
    capabilityProbe?: () => Promise<YouTubeMusicCapabilitySnapshot>;
  } = {}) {
    this.catalog = options.catalog || new YouTubeMusicCatalog();
    this.capabilityProbe = options.capabilityProbe || getYouTubeMusicCapabilitySnapshot;
  }

  isAuthenticated(): boolean {
    const state = getYouTubeMusicCredentialState();
    return state.browserHeadersConfigured || state.cookiesConfigured;
  }

  search(query: string, options?: ProviderSearchOptions): Promise<ProviderSearchResults> {
    return this.catalog.search(query, options);
  }

  getArtist(id: string | number): Promise<ProviderArtist> {
    return this.catalog.getArtist(id);
  }

  getArtistAlbums(id: string | number): Promise<ProviderAlbum[]> {
    return this.catalog.getArtistAlbums(id);
  }

  getArtistVideos(id: string | number): Promise<ProviderVideo[]> {
    return this.catalog.getArtistVideos(id);
  }

  listArtistReleaseOffers(id: string | number): Promise<ProviderAlbum[]> {
    return this.catalog.getArtistAlbums(id);
  }

  async searchReleaseGroup(query: ProviderReleaseGroupSearch): Promise<ProviderAlbum[]> {
    if (query.slot !== "stereo") return [];
    const results = await this.catalog.search(`${query.artistName} ${query.releaseGroupTitle}`.trim(), {
      limit: 25,
      types: ["albums"],
    });
    return results.albums;
  }

  getAlbum(id: string | number): Promise<ProviderAlbum> {
    return this.catalog.getAlbum(id);
  }

  getAlbumTracks(id: string | number): Promise<ProviderTrack[]> {
    return this.catalog.getAlbumTracks(id);
  }

  getTrack(id: string | number): Promise<ProviderTrack> {
    return this.catalog.getTrack(id);
  }

  getVideo(id: string | number): Promise<ProviderVideo> {
    return this.catalog.getVideo(id);
  }

  getLyrics(id: string | number): Promise<ProviderLyrics | null> {
    return this.catalog.getLyrics(id);
  }

  listImportSources(): Promise<ProviderImportSource[]> {
    return this.catalog.listImportSources();
  }

  getArtistsForImportSource(selection: ProviderImportSelection): Promise<ProviderArtist[]> {
    return this.catalog.getArtistsForImportSource(selection);
  }

  async getArtworkUrl(request: ProviderArtworkRequest): Promise<string | null> {
    if (request.entityType === "artist" && request.providerId != null) {
      return (await this.getArtist(request.providerId)).picture || null;
    }
    if (request.entityType === "album" && request.providerId != null) {
      return (await this.getAlbum(request.providerId)).cover || null;
    }
    if (request.entityType === "video" && request.providerId != null) {
      return (await this.getVideo(request.providerId)).cover || null;
    }
    return null;
  }

  logout(): void {
    clearYouTubeMusicCredentials();
  }

  saveCredentials(credentials: Record<string, unknown>): void {
    saveYouTubeMusicCredentials({
      headers: credentials.headersJson ?? credentials.headers,
      cookies: credentials.cookies ?? credentials.cookiesText,
    });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const connected = this.isAuthenticated();
    return {
      connected,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 0,
      canAccessShell: true,
      canAccessLocalLibrary: connected,
      // ytmusicapi supports public catalog browsing without browser auth.
      remoteCatalogAvailable: true,
      canAuthenticate: true,
      user: null,
      message: connected
        ? undefined
        : "Public YouTube Music catalog access is available. Add browser headers or cookies for library imports, restricted media, and account-specific availability.",
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticResult[]> {
    const checkedAt = new Date().toISOString();
    const snapshot = await this.capabilityProbe();
    const catalogReady = snapshot.pythonAvailable && snapshot.bridgeScriptAvailable && snapshot.ytmusicapiAvailable;
    const downloaderReady = snapshot.ytDlpAvailable && snapshot.ffmpegAvailable;
    const authenticated = snapshot.browserHeadersConfigured || snapshot.cookiesConfigured;
    return [
      {
        kind: "auth",
        status: authenticated ? "ok" : "warning",
        message: authenticated
          ? "YouTube browser credentials are configured in the provider-owned config directory."
          : "Public catalog access needs no login; browser headers/cookies are still required for library imports and restricted media.",
        checkedAt,
        details: {
          authKind: this.manifest.auth.kind,
          managedByApp: this.manifest.auth.managedByApp,
          browserHeadersConfigured: snapshot.browserHeadersConfigured,
          cookiesConfigured: snapshot.cookiesConfigured,
        },
      },
      {
        kind: "catalog",
        status: catalogReady ? "ok" : "error",
        message: catalogReady
          ? "ytmusicapi catalog bridge is ready."
          : "YouTube Music catalog provisioning is incomplete; Python, ytmusicapi, or the provider bridge is missing.",
        checkedAt,
        details: {
          pythonBinary: snapshot.pythonBinary,
          pythonAvailable: snapshot.pythonAvailable,
          bridgeScript: snapshot.bridgeScript,
          bridgeScriptAvailable: snapshot.bridgeScriptAvailable,
          ytmusicapiAvailable: snapshot.ytmusicapiAvailable,
        },
      },
      {
        kind: "download-backend",
        status: downloaderReady ? "ok" : "error",
        message: downloaderReady
          ? "yt-dlp and ffmpeg are ready for YouTube Music audio and video downloads."
          : "YouTube downloads require both yt-dlp and ffmpeg.",
        checkedAt,
        details: {
          ytDlpBinary: snapshot.ytDlpBinary,
          ytDlpAvailable: snapshot.ytDlpAvailable,
          ffmpegAvailable: snapshot.ffmpegAvailable,
          cookiesPathConfigured: fs.existsSync(YOUTUBE_MUSIC_COOKIES_FILE),
        },
      },
    ];
  }

  getMediaUrl(type: string, providerId: string): string {
    if (type === "artist") return `https://music.youtube.com/channel/${encodeURIComponent(providerId)}`;
    if (type === "album" || type === "playlist") {
      return type === "playlist" || /^(?:OLAK5uy_|PL|RD)/u.test(providerId)
        ? `https://music.youtube.com/playlist?list=${encodeURIComponent(providerId)}`
        : `https://music.youtube.com/browse/${encodeURIComponent(providerId)}`;
    }
    const host = type === "video" ? "www.youtube.com" : "music.youtube.com";
    return `https://${host}/watch?v=${encodeURIComponent(providerId)}`;
  }

  parseMediaUrl(url: string): { type: string; providerId: string } | null {
    return parseYouTubeMusicUrl(url);
  }

  async downloadItem(
    providerId: string,
    entityType: "album" | "track" | "video",
    downloadPath: string,
    options?: ProviderDownloadOptions,
  ): Promise<void> {
    const capability = entityType === "video" ? "video" : "stereo";
    const backend = downloadBackendRegistry.resolve(this.id, capability);
    if (!backend) {
      throw new Error(`No download backend resolved for ${this.id} and capability ${capability}.`);
    }
    return backend.download(
      {
        provider: this.id,
        entityType,
        providerId,
        downloadPath,
        quality: options?.quality,
        slot: capability,
      },
      {
        signal: options?.signal,
        onProgress: (progress) => options?.onProgress?.(progress),
      },
    );
  }

  syncCredentials(): void {
    // Both integrations read the provider-owned files directly per request.
  }

  syncSettings(): void {
    // yt-dlp settings are job-scoped command arguments; no global config file.
  }
}

export const youtubeMusicStreamingProvider = new YouTubeMusicProvider();
downloadBackendRegistry.register(new YtDlpBackend());
