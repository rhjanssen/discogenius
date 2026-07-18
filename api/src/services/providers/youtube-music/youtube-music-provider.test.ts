import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { DownloadProgress, DownloadRequest } from "../../download/download-backend.js";
import type { YtDlpProcess } from "./yt-dlp-backend.js";
import type { YtMusicBridge, YtMusicBridgeOperation } from "./ytmusicapi-bridge.js";

const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-youtube-music-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = testConfigDir;

const {
  YOUTUBE_MUSIC_COOKIES_FILE,
  YOUTUBE_MUSIC_HEADERS_FILE,
  clearYouTubeMusicCredentials,
  getYouTubeMusicCredentialState,
  loadYouTubeMusicHeaders,
  normalizeYouTubeMusicCookies,
  saveYouTubeMusicCredentials,
} = await import("./youtube-music-auth.js");
const { YouTubeMusicCatalog } = await import("./youtube-music-catalog.js");
const { youtubeMusicQualityMapping } = await import("./youtube-music-quality.js");
const {
  YouTubeMusicProvider,
  parseYouTubeMusicUrl,
} = await import("./youtube-music-provider.js");
const {
  YtDlpBackend,
  buildYouTubeMusicSourceUrl,
  parseYtDlpProgressLine,
} = await import("./yt-dlp-backend.js");
const {
  PythonYtMusicBridge,
  getYtMusicBridgeScript,
} = await import("./ytmusicapi-bridge.js");

const ARTIST_ID = "UCbastille00000000000001";
const ALBUM_ID = "MPREb_badblood_test";
const TRACK_ID = "F90Cw4l-8NY";
const SECOND_TRACK_ID = "4JjXAZlaelA";
const VIDEO_ID = "VgXOPeobPcI";

const artistFixture = {
  channelId: ARTIST_ID,
  name: "Bastille",
  thumbnails: [
    { url: "https://img.test/artist-120.jpg", width: 120, height: 120 },
    { url: "https://img.test/artist-750.jpg", width: 750, height: 750 },
  ],
};

const albumFixture = {
  browseId: ALBUM_ID,
  title: "Bad Blood",
  type: "Album",
  year: 2013,
  trackCount: 2,
  artists: [{ id: ARTIST_ID, name: "Bastille" }],
  thumbnails: [{ url: "https://img.test/bad-blood.jpg", width: 544, height: 544 }],
  tracks: [
    {
      videoId: TRACK_ID,
      title: "Pompeii",
      duration: "3:34",
      artists: [{ id: ARTIST_ID, name: "Bastille" }],
    },
    {
      videoId: SECOND_TRACK_ID,
      title: "Things We Lost in the Fire",
      duration_seconds: 241,
      artists: [{ id: ARTIST_ID, name: "Bastille" }],
    },
  ],
};

const videoFixture = {
  videoId: VIDEO_ID,
  title: "Pompeii (Official Music Video)",
  duration: "3:53",
  artists: [{ id: ARTIST_ID, name: "Bastille" }],
  thumbnails: [{ url: "https://img.test/pompeii-video.jpg", width: 1280, height: 720 }],
};

class FixtureBridge implements YtMusicBridge {
  readonly calls: Array<{ operation: YtMusicBridgeOperation; payload: Record<string, unknown> }> = [];

  async request<T = unknown>(
    operation: YtMusicBridgeOperation,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ operation, payload });
    let result: unknown;
    switch (operation) {
      case "search":
        result = {
          artists: [artistFixture],
          albums: [albumFixture],
          tracks: [albumFixture.tracks[0]],
          videos: [videoFixture],
        };
        break;
      case "get_artist":
        result = artistFixture;
        break;
      case "get_artist_albums":
        result = [albumFixture];
        break;
      case "get_artist_videos":
        result = [videoFixture];
        break;
      case "get_album":
        // ytmusicapi's get_album response does not consistently echo the
        // requested browseId; the adapter must retain the requested stable id.
        result = { ...albumFixture, browseId: undefined };
        break;
      case "get_track":
        result = {
          videoDetails: {
            videoId: TRACK_ID,
            title: "Pompeii",
            author: "Bastille",
            channelId: ARTIST_ID,
            lengthSeconds: "214",
            thumbnail: { thumbnails: [{ url: "https://img.test/pompeii.jpg", width: 640, height: 640 }] },
          },
        };
        break;
      case "get_video":
        result = {
          videoDetails: {
            videoId: VIDEO_ID,
            title: "Pompeii (Official Music Video)",
            author: "Bastille",
            channelId: ARTIST_ID,
            lengthSeconds: "233",
            thumbnail: { thumbnails: videoFixture.thumbnails },
          },
          microformat: { playerMicroformatRenderer: { publishDate: "2013-01-21" } },
        };
        break;
      case "list_import_sources":
        result = {
          libraryArtists: [artistFixture],
          playlists: [{ playlistId: "PL_bastille_test", title: "Bastille favorites", count: 12 }],
          favoriteTracksAvailable: true,
        };
        break;
      case "get_import_artists":
        result = [artistFixture];
        break;
    }
    return result as T;
  }
}

test("YouTube Music quality maps every available audio codec to lossy", () => {
  assert.equal(youtubeMusicQualityMapping.toNeutralAudio("opus"), "lossy");
  assert.equal(youtubeMusicQualityMapping.toNeutralAudio("AAC"), "lossy");
  assert.equal(youtubeMusicQualityMapping.toNeutralAudio("lossless"), null);
  assert.deepEqual(youtubeMusicQualityMapping.toNeutral(["opus"]), { audio: "lossy", spatial: [] });
  assert.equal(youtubeMusicQualityMapping.fromNeutralAudio("hires-lossless"), "YOUTUBE_LOSSY");
});

test("fixture-backed catalog maps search, album tracks, artists, and videos", async () => {
  const bridge = new FixtureBridge();
  const catalog = new YouTubeMusicCatalog(bridge);
  const search = await catalog.search("Bastille", { limit: 5 });

  assert.equal(search.artists[0].providerId, ARTIST_ID);
  assert.equal(search.artists[0].picture, "https://img.test/artist-750.jpg");
  assert.equal(search.albums[0].providerId, ALBUM_ID);
  assert.equal(search.albums[0].quality, "YOUTUBE_LOSSY");
  assert.equal(search.tracks[0].providerId, TRACK_ID);
  assert.equal(search.tracks[0].duration, 214);
  assert.equal(search.videos[0].providerId, VIDEO_ID);

  const tracks = await catalog.getAlbumTracks(ALBUM_ID);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].album.providerId, ALBUM_ID);
  assert.equal(tracks[0].trackNumber, 1);
  assert.equal(tracks[1].trackNumber, 2);
  assert.equal(tracks[1].duration, 241);

  const video = await catalog.getVideo(VIDEO_ID);
  assert.equal(video.releaseDate, "2013-01-21");
  assert.equal(video.duration, 233);
});

test("authenticated import adapter exposes library, liked music, and playlists", async () => {
  const bridge = new FixtureBridge();
  const catalog = new YouTubeMusicCatalog(bridge);
  const sources = await catalog.listImportSources();
  assert.deepEqual(sources.map((source) => source.category), ["library-artists", "favorite-tracks", "playlist"]);
  assert.equal(sources[2].lists?.[0].id, "PL_bastille_test");

  const artists = await catalog.getArtistsForImportSource({ category: "playlist", listId: "PL_bastille_test" });
  assert.equal(artists[0].name, "Bastille");
  assert.deepEqual(bridge.calls.at(-1)?.payload, { category: "playlist", listId: "PL_bastille_test" });
  await assert.rejects(
    () => catalog.getArtistsForImportSource({ category: "playlist" }),
    /playlist must be selected/i,
  );
});

test("provider manifest is honest about lossy audio and delegates the catalog contract", async () => {
  const catalog = new YouTubeMusicCatalog(new FixtureBridge());
  const provider = new YouTubeMusicProvider({ catalog });
  const results = await provider.search("Bastille");

  assert.equal(provider.id, "youtube-music");
  assert.equal(provider.name, "YouTube / YouTube Music");
  assert.equal(provider.manifest.displayName, provider.name);
  assert.equal(provider.manifest.integration.catalogSource, "unofficial-api");
  assert.equal(provider.manifest.integration.downloadSource, "native-cli");
  assert.deepEqual(provider.manifest.imports.supported, ["library-artists", "playlist", "favorite-tracks"]);
  assert.equal(provider.capabilities.lossyStereo, true);
  assert.equal(provider.capabilities.losslessStereo, false);
  assert.equal(provider.capabilities.spatialAudio, false);
  assert.equal(provider.capabilities.musicVideos, true);
  assert.equal(results.albums[0].title, "Bad Blood");

  const spatial = await provider.searchReleaseGroup({
    artistName: "Bastille",
    releaseGroupTitle: "Bad Blood",
    slot: "spatial",
  });
  assert.deepEqual(spatial, []);
});

test("URL parsing preserves stable IDs across YouTube and YouTube Music hosts", () => {
  assert.deepEqual(
    parseYouTubeMusicUrl(`https://music.youtube.com/watch?v=${TRACK_ID}&list=RDAMVM${TRACK_ID}`),
    { type: "track", providerId: TRACK_ID },
  );
  assert.deepEqual(
    parseYouTubeMusicUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`),
    { type: "video", providerId: VIDEO_ID },
  );
  assert.deepEqual(
    parseYouTubeMusicUrl(`https://youtu.be/${VIDEO_ID}?si=test`),
    { type: "video", providerId: VIDEO_ID },
  );
  assert.deepEqual(
    parseYouTubeMusicUrl(`https://music.youtube.com/browse/${ALBUM_ID}`),
    { type: "album", providerId: ALBUM_ID },
  );
  assert.deepEqual(
    parseYouTubeMusicUrl(`https://music.youtube.com/channel/${ARTIST_ID}`),
    { type: "artist", providerId: ARTIST_ID },
  );
  assert.equal(parseYouTubeMusicUrl(`https://example.com/watch?v=${VIDEO_ID}`), null);
  assert.equal(parseYouTubeMusicUrl("https://youtube.com/@bastille"), null, "handles are not stable channel IDs");
});

test("credentials are normalized into provider-owned header and Netscape cookie files", () => {
  clearYouTubeMusicCredentials();
  saveYouTubeMusicCredentials({
    headers: JSON.stringify({ "X-Goog-AuthUser": "0" }),
    cookies: "Cookie: SAPISID=test-secret; __Secure-3PAPISID=second-secret",
  });

  const state = getYouTubeMusicCredentialState();
  assert.deepEqual(state, { browserHeadersConfigured: true, cookiesConfigured: true });
  assert.equal(path.dirname(YOUTUBE_MUSIC_HEADERS_FILE), path.dirname(YOUTUBE_MUSIC_COOKIES_FILE));
  assert.match(YOUTUBE_MUSIC_HEADERS_FILE, /providers[\\/]youtube-music[\\/]browser\.json$/u);
  assert.equal(loadYouTubeMusicHeaders()?.Cookie, "SAPISID=test-secret; __Secure-3PAPISID=second-secret");
  const cookies = fs.readFileSync(YOUTUBE_MUSIC_COOKIES_FILE, "utf8");
  assert.match(cookies, /^# Netscape HTTP Cookie File/u);
  assert.match(cookies, /\.youtube\.com\tTRUE\t\/\tTRUE\t2147483647\tSAPISID\ttest-secret/u);

  assert.throws(
    () => saveYouTubeMusicCredentials({ headers: { Cookie: "safe\r\nInjected: bad" } }),
    /control character/i,
  );
  clearYouTubeMusicCredentials();
  assert.deepEqual(getYouTubeMusicCredentialState(), { browserHeadersConfigured: false, cookiesConfigured: false });
});

test("Netscape cookies retain only domains applicable to music.youtube.com", () => {
  const netscape = [
    "# Netscape HTTP Cookie File",
    ".youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tyoutube-secret",
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2147483647\t__Secure-3PSID\thttp-only-secret",
    "music.youtube.com\tFALSE\t/\tTRUE\t2147483647\tHOST_ONLY\thost-secret",
    "youtube.com\tFALSE\t/\tTRUE\t2147483647\tROOT_HOST_ONLY\troot-host-secret",
    "www.youtube.com\tFALSE\t/\tTRUE\t2147483647\tWWW_ONLY\twww-secret",
    ".google.com\tTRUE\t/\tTRUE\t2147483647\tGOOGLE\tgoogle-secret",
    ".example.com\tTRUE\t/\tTRUE\t2147483647\tUNRELATED\tunrelated-secret",
  ].join("\n");

  clearYouTubeMusicCredentials();
  saveYouTubeMusicCredentials({
    headers: { Cookie: "stale=header", "X-Goog-AuthUser": "0" },
    cookies: netscape,
  });

  assert.equal(
    loadYouTubeMusicHeaders()?.Cookie,
    "SAPISID=youtube-secret; __Secure-3PSID=http-only-secret; HOST_ONLY=host-secret",
  );
  const stored = fs.readFileSync(YOUTUBE_MUSIC_COOKIES_FILE, "utf8");
  assert.match(stored, /^# Netscape HTTP Cookie File/u);
  assert.match(stored, /^#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t2147483647\t__Secure-3PSID\thttp-only-secret$/mu);
  for (const excluded of ["root-host-secret", "www-secret", "google-secret", "unrelated-secret"]) {
    assert.doesNotMatch(stored, new RegExp(excluded, "u"));
  }
  clearYouTubeMusicCredentials();
});

test("Netscape cookies reject exports without a cookie applicable to music.youtube.com", () => {
  const unrelated = [
    "# Netscape HTTP Cookie File",
    ".google.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tgoogle-secret",
    ".example.com\tTRUE\t/\tTRUE\t2147483647\tSESSION\tunrelated-secret",
  ].join("\n");
  assert.throws(
    () => normalizeYouTubeMusicCookies(unrelated),
    /does not contain any cookies for music\.youtube\.com/u,
  );
});

test("diagnostics distinguish public catalog access from authenticated library access", async () => {
  const provider = new YouTubeMusicProvider({
    catalog: new YouTubeMusicCatalog(new FixtureBridge()),
    capabilityProbe: async () => ({
      pythonBinary: "/opt/ytmusic-venv/bin/python",
      pythonAvailable: true,
      bridgeScript: "/app/api/src/services/providers/youtube-music/ytmusicapi-bridge.py",
      bridgeScriptAvailable: true,
      ytmusicapiAvailable: true,
      ytDlpBinary: "yt-dlp",
      ytDlpAvailable: true,
      ffmpegAvailable: true,
      browserHeadersConfigured: false,
      cookiesConfigured: false,
    }),
  });
  const auth = await provider.getAuthStatus();
  assert.equal(auth.connected, false);
  assert.equal(auth.remoteCatalogAvailable, true);
  assert.equal(auth.canAccessLocalLibrary, false);

  const diagnostics = await provider.getDiagnostics();
  assert.deepEqual(diagnostics.map((item) => item.status), ["warning", "ok", "ok"]);
  assert.match(diagnostics[0].message, /Public catalog access/u);
});

test("Python bridge is dependency-injectable and passes a bounded JSON request", async () => {
  let captured: unknown;
  const bridge = new PythonYtMusicBridge({
    scriptPath: getYtMusicBridgeScript(),
    headersPath: path.join(testConfigDir, "missing-browser.json"),
    pythonBinary: "fixture-python",
    runner: async (request) => {
      captured = request;
      return { code: 0, stdout: JSON.stringify({ artists: [artistFixture] }), stderr: "" };
    },
  });
  const result = await bridge.request<{ artists: unknown[] }>("search", { query: "Bastille", limit: 1 });
  assert.equal(result.artists.length, 1);
  const request = captured as { binary: string; args: string[]; input: string; timeoutMs: number };
  assert.equal(request.binary, "fixture-python");
  assert.equal(request.args.at(-1), "search");
  assert.deepEqual(JSON.parse(request.input), { query: "Bastille", limit: 1 });
  assert.equal(request.timeoutMs, 45_000);
});

test("yt-dlp arguments use provider-ID filenames and select audio/video formats explicitly", () => {
  const missingCookies = path.join(testConfigDir, "missing-cookies.txt");
  const backend = new YtDlpBackend({ cookiesPath: missingCookies });
  const audioRequest: DownloadRequest = {
    provider: "youtube-music",
    entityType: "track",
    providerId: TRACK_ID,
    downloadPath: path.join(testConfigDir, "audio-job"),
  };
  const audioArgs = backend.buildArgs(audioRequest);
  assert.ok(audioArgs.includes("--extract-audio"));
  assert.ok(audioArgs.includes("opus"));
  assert.ok(audioArgs.includes("--no-playlist"));
  assert.equal(audioArgs.at(-1), `https://music.youtube.com/watch?v=${TRACK_ID}`);
  assert.ok(audioArgs.some((arg) => arg.endsWith("%(id)s.%(ext)s")));
  assert.ok(!audioArgs.includes("--cookies"));

  const videoArgs = backend.buildArgs({ ...audioRequest, entityType: "video", providerId: VIDEO_ID });
  assert.ok(videoArgs.includes("bestvideo*+bestaudio/best"));
  assert.ok(videoArgs.includes("--merge-output-format"));
  assert.equal(videoArgs.at(-1), `https://www.youtube.com/watch?v=${VIDEO_ID}`);

  const albumArgs = backend.buildArgs({ ...audioRequest, entityType: "album", providerId: ALBUM_ID });
  assert.ok(albumArgs.includes("--yes-playlist"));
  assert.equal(albumArgs.at(-1), `https://music.youtube.com/browse/${ALBUM_ID}`);
  assert.throws(() => buildYouTubeMusicSourceUrl("track", "not-an-id"), /Invalid YouTube video ID/u);
  assert.throws(
    () => buildYouTubeMusicSourceUrl("video", `https://example.com/watch?v=${VIDEO_ID}`),
    /Only youtube\.com/u,
  );
});

test("yt-dlp progress parser keeps provider identity and playlist-wide progress", () => {
  const event = parseYtDlpProgressLine(
    `DG_PROGRESS\t50.0%\t2\t4\t${TRACK_ID}\tPompeii\t1.2MiB/s\t00:05`,
  );
  assert.ok(event);
  assert.equal(event.progress, 38);
  assert.equal(event.currentFileNum, 2);
  assert.equal(event.totalFiles, 4);
  assert.equal(event.currentProviderTrackId, TRACK_ID);
  assert.equal(event.trackProgress, 50);
  assert.equal(event.speed, "1.2MiB/s");

  const completed = parseYtDlpProgressLine(`DG_DONE\t4\t4\t${TRACK_ID}\tPompeii\t/tmp/${TRACK_ID}.opus`);
  assert.equal(completed?.progress, 100);
  assert.equal(completed?.trackStatus, "completed");
});

class FakeYtDlpProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

function baseDownloadRequest(downloadPath: string): DownloadRequest {
  return {
    provider: "youtube-music",
    entityType: "track",
    providerId: TRACK_ID,
    downloadPath,
  };
}

test("yt-dlp backend reports progress and rejects a zero-file success", async () => {
  const successProgress: DownloadProgress[] = [];
  const successBackend = new YtDlpBackend({
    binary: "fixture-yt-dlp",
    cookiesPath: path.join(testConfigDir, "missing-cookies.txt"),
    spawnImpl: () => {
      const child = new FakeYtDlpProcess();
      queueMicrotask(() => {
        child.stdout.write(`DG_PROGRESS\t42.0%\t1\t1\t${TRACK_ID}\tPompeii\t2MiB/s\t00:03\n`);
        child.stdout.write(`DG_DONE\t1\t1\t${TRACK_ID}\tPompeii\t/tmp/${TRACK_ID}.opus\n`);
        child.emit("close", 0);
      });
      return child as unknown as YtDlpProcess;
    },
    mediaFileFinder: async () => [path.join(testConfigDir, `${TRACK_ID}.opus`)],
  });
  await successBackend.download(baseDownloadRequest(path.join(testConfigDir, "success-job")), {
    onProgress: (progress) => successProgress.push(progress),
  });
  assert.ok(successProgress.some((progress) => progress.currentProviderTrackId === TRACK_ID));
  assert.equal(successProgress.at(-1)?.progress, 100);

  const emptyBackend = new YtDlpBackend({
    spawnImpl: () => {
      const child = new FakeYtDlpProcess();
      queueMicrotask(() => child.emit("close", 0));
      return child as unknown as YtDlpProcess;
    },
    mediaFileFinder: async () => [],
  });
  await assert.rejects(
    () => emptyBackend.download(baseDownloadRequest(path.join(testConfigDir, "empty-job")), { onProgress() {} }),
    /without producing provider-ID-named media files/u,
  );
});

test("yt-dlp backend terminates the child process when a running job is cancelled", async () => {
  const controller = new AbortController();
  let child: FakeYtDlpProcess | null = null;
  const backend = new YtDlpBackend({
    spawnImpl: () => {
      child = new FakeYtDlpProcess();
      setImmediate(() => controller.abort());
      return child as unknown as YtDlpProcess;
    },
    mediaFileFinder: async () => [path.join(testConfigDir, `${TRACK_ID}.opus`)],
  });
  await assert.rejects(
    () => backend.download(baseDownloadRequest(path.join(testConfigDir, "cancel-job")), {
      signal: controller.signal,
      onProgress() {},
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal((child as FakeYtDlpProcess | null)?.killed, true);
});
