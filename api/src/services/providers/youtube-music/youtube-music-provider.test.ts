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
  youtubeMusicArtworkUrl,
} = await import("./youtube-music-provider.js");
const {
  YtDlpBackend,
  buildYouTubeMusicSourceUrl,
  parseYtDlpProgressLine,
} = await import("./yt-dlp-backend.js");
const {
  PythonYtMusicBridge,
  getYtMusicBridgeScript,
  mapYtMusicBridgeFailure,
  YOUTUBE_MUSIC_AUTH_REQUIRED_MESSAGE,
} = await import("./ytmusicapi-bridge.js");

const ARTIST_ID = "UCbastille00000000000001";
const ALBUM_ID = "MPREb_badblood_test";
const TRACK_ID = "F90Cw4l-8NY";
const SECOND_TRACK_ID = "4JjXAZlaelA";
const VIDEO_ID = "VgXOPeobPcI";

test("YouTube Music origin artwork requests uncapped Google and max-res video sources", async () => {
  const googleSource = "https://lh3.googleusercontent.com/music-cover=w544-h544-l90-rj";
  assert.equal(
    youtubeMusicArtworkUrl(googleSource, "origin"),
    "https://lh3.googleusercontent.com/music-cover=s0",
  );
  assert.equal(
    youtubeMusicArtworkUrl(
      "https://i.ytimg.com/vi/VgXOPeobPcI/hq720.jpg?sqp=crop",
      "origin",
    ),
    "https://i.ytimg.com/vi/VgXOPeobPcI/maxresdefault.jpg",
  );

  const provider = new YouTubeMusicProvider({
    catalog: {} as any,
  });
  assert.equal(
    await provider.getArtworkUrl({
      entityType: "album",
      imageId: googleSource,
      size: "origin",
    }),
    "https://lh3.googleusercontent.com/music-cover=s0",
  );
});

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
          counterpart: {
            videoId: VIDEO_ID,
            title: "Pompeii (Official Music Video)",
          },
        };
        break;
      case "get_track_counterparts": {
        const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
        const counterparts: Record<string, unknown> = {};
        for (const id of ids) {
          counterparts[id] = id === TRACK_ID
            ? { videoId: VIDEO_ID, title: "Pompeii (Official Music Video)" }
            : null;
        }
        result = { counterparts };
        break;
      }
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
          // ytmusicapi get_song shape (Music client), not WEB playerMicroformatRenderer.
          microformat: {
            microformatDataRenderer: {
              publishDate: "2013-01-21T08:00:00-08:00",
              uploadDate: "2013-01-21T08:00:00-08:00",
            },
          },
          streamingData: {
            adaptiveFormats: [
              { height: 720, mimeType: "video/mp4" },
              { height: 1080, mimeType: "video/mp4" },
            ],
          },
        };
        break;
      case "get_lyrics":
        result = {
          text: "I was left to my own devices",
          subtitles: "[00:00.00]I was left to my own devices",
          provider: "Source: LyricFind",
        };
        break;
      case "list_import_sources":
        result = {
          libraryArtists: [artistFixture],
          playlists: [{ playlistId: "PL_bastille_test", title: "Bastille favorites", count: 12 }],
          favoriteTracksAvailable: true,
          discoveryPlaylists: [{ playlistId: "PL_discovery_mix", title: "Your Mix 1", count: 50 }],
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
  assert.equal(tracks[0].counterpartVideoId, VIDEO_ID, "ATV album track should resolve OMV counterpart");
  assert.equal(tracks[1].trackNumber, 2);
  assert.equal(tracks[1].duration, 241);
  assert.equal(tracks[1].counterpartVideoId ?? null, null);
  assert.ok(bridge.calls.some((call) => call.operation === "get_track_counterparts"));

  const single = await catalog.getTrack(TRACK_ID);
  assert.equal(single.counterpartVideoId, VIDEO_ID);

  const video = await catalog.getVideo(VIDEO_ID);
  assert.equal(video.releaseDate, "2013-01-21");
  assert.equal(video.duration, 233);
  assert.equal(video.quality, "FHD");

  const lyrics = await catalog.getLyrics(TRACK_ID);
  assert.equal(lyrics?.subtitles, "[00:00.00]I was left to my own devices");
  assert.equal(lyrics?.provider, "Source: LyricFind");
});

test("album track counterpart enrich keeps self-OMV video ids", async () => {
  const bridge = new FixtureBridge();
  const originalRequest = bridge.request.bind(bridge);
  bridge.request = async <T,>(operation: import("./ytmusicapi-bridge.js").YtMusicBridgeOperation, payload: Record<string, unknown> = {}) => {
    if (operation === "get_track_counterparts") {
      const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
      const counterparts: Record<string, unknown> = {};
      for (const id of ids) {
        counterparts[id] = { videoId: id, videoType: "MUSIC_VIDEO_TYPE_OMV", kind: "yt-self-omv" };
      }
      return { counterparts } as T;
    }
    return originalRequest<T>(operation, payload);
  };
  const catalog = new YouTubeMusicCatalog(bridge);
  const tracks = await catalog.getAlbumTracks(ALBUM_ID);
  assert.equal(tracks[0].counterpartVideoId, tracks[0].providerId);
});

test("authenticated import adapter exposes library, liked music, playlists, and discovery mixes", async () => {
  const bridge = new FixtureBridge();
  const catalog = new YouTubeMusicCatalog(bridge);
  const sources = await catalog.listImportSources();
  assert.deepEqual(
    sources.map((source) => source.category),
    ["library-artists", "favorite-tracks", "playlist", "mix"],
  );
  assert.equal(sources[2].lists?.[0].id, "PL_bastille_test");
  assert.equal(sources[3].label, "Mixed for you");
  assert.equal(sources[3].lists?.[0].id, "PL_discovery_mix");

  const artists = await catalog.getArtistsForImportSource({ category: "playlist", listId: "PL_bastille_test" });
  assert.equal(artists[0].name, "Bastille");
  assert.deepEqual(bridge.calls.at(-1)?.payload, { category: "playlist", listId: "PL_bastille_test" });

  const mixArtists = await catalog.getArtistsForImportSource({ category: "mix", listId: "PL_discovery_mix" });
  assert.equal(mixArtists[0].name, "Bastille");
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
  assert.equal(provider.name, "YouTube Music");
  assert.equal(provider.manifest.displayName, provider.name);
  assert.equal(provider.manifest.integration.catalogSource, "unofficial-api");
  assert.equal(provider.manifest.integration.downloadSource, "native-cli");
  assert.deepEqual(provider.manifest.imports.supported, ["library-artists", "playlist", "favorite-tracks", "mix"]);
  assert.equal(provider.capabilities.lossyStereo, true);
  assert.equal(provider.capabilities.losslessStereo, false);
  assert.equal(provider.capabilities.spatialAudio, false);
  assert.equal(provider.capabilities.musicVideos, true);
  assert.equal(provider.capabilities.lyrics, true);
  assert.equal(results.albums[0].title, "Bad Blood");
  assert.equal((await provider.getLyrics(TRACK_ID))?.text, "I was left to my own devices");

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
    headers: JSON.stringify({
      Authorization: "SAPISIDHASH test-hash",
      "X-Goog-AuthUser": "0",
      "sec-ch-ua": "should-be-dropped",
    }),
    cookies: "Cookie: SAPISID=test-secret; __Secure-3PAPISID=second-secret",
  });

  const state = getYouTubeMusicCredentialState();
  assert.deepEqual(state, { browserHeadersConfigured: true, cookiesConfigured: true });
  assert.equal(path.dirname(YOUTUBE_MUSIC_HEADERS_FILE), path.dirname(YOUTUBE_MUSIC_COOKIES_FILE));
  assert.match(YOUTUBE_MUSIC_HEADERS_FILE, /providers[\\/]youtube-music[\\/]browser\.json$/u);
  const storedHeaders = loadYouTubeMusicHeaders();
  assert.equal(storedHeaders?.Cookie, "SAPISID=test-secret; __Secure-3PAPISID=second-secret");
  assert.equal(storedHeaders?.Authorization, "SAPISIDHASH test-hash");
  assert.equal(storedHeaders?.["X-Goog-AuthUser"], "0");
  assert.equal((storedHeaders as Record<string, string> | null)?.["sec-ch-ua"], undefined);
  const cookies = fs.readFileSync(YOUTUBE_MUSIC_COOKIES_FILE, "utf8");
  assert.match(cookies, /^# Netscape HTTP Cookie File/u);
  assert.match(cookies, /\.youtube\.com\tTRUE\t\/\tTRUE\t2147483647\tSAPISID\ttest-secret/u);

  assert.throws(
    () => saveYouTubeMusicCredentials({ headers: { Cookie: "safe\r\nInjected: bad" } }),
    /control character/i,
  );
  assert.throws(
    () => saveYouTubeMusicCredentials({
      headers: JSON.stringify({
        responseContext: { serviceTrackingParams: [] },
        contents: { singleColumnBrowseResultsRenderer: {} },
      }),
    }),
    /response body, not request headers/i,
  );
  clearYouTubeMusicCredentials();
  assert.deepEqual(getYouTubeMusicCredentialState(), { browserHeadersConfigured: false, cookiesConfigured: false });
});

test("Copy as Node.js fetch paste is accepted and trimmed to auth headers", () => {
  clearYouTubeMusicCredentials();
  const fetchPaste = `fetch("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false", {
  "headers": {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "authorization": "SAPISIDHASH abc123",
    "content-type": "application/json",
    "sec-ch-ua": "\\"Chromium\\";v=\\"120\\"",
    "sec-fetch-mode": "same-origin",
    "x-goog-authuser": "0",
    "x-origin": "https://music.youtube.com",
    "cookie": "SAPISID=fetch-secret; SID=session",
    "Referer": "https://music.youtube.com/"
  },
  "body": "{\\"context\\":{}}",
  "method": "POST"
});`;

  saveYouTubeMusicCredentials({ headers: fetchPaste });

  const stored = JSON.parse(fs.readFileSync(YOUTUBE_MUSIC_HEADERS_FILE, "utf8")) as Record<string, string>;
  assert.equal(stored.Authorization, "SAPISIDHASH abc123");
  assert.equal(stored.Cookie, "SAPISID=fetch-secret; SID=session");
  assert.equal(stored["X-Goog-AuthUser"], "0");
  assert.equal(stored["x-origin"], "https://music.youtube.com");
  assert.equal(stored.Accept, "*/*");
  assert.equal(stored["Content-Type"], "application/json");
  assert.equal(stored["sec-ch-ua"], undefined);
  assert.equal(stored.Referer, undefined);
  assert.equal(getYouTubeMusicCredentialState().cookiesConfigured, true);
  clearYouTubeMusicCredentials();
});

test("fetch paste without Cookie can be completed with a cookies.txt export", () => {
  clearYouTubeMusicCredentials();
  const fetchWithoutCookie = `fetch("https://music.youtube.com/youtubei/v1/browse", {
  "headers": {
    "authorization": "SAPISIDHASH xyz",
    "x-goog-authuser": "1",
    "content-type": "application/json"
  },
  "method": "POST",
  "credentials": "include"
});`;
  const netscape = [
    "# Netscape HTTP Cookie File",
    ".youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\textension-secret",
  ].join("\n");

  assert.throws(
    () => saveYouTubeMusicCredentials({ headers: fetchWithoutCookie }),
    /missing Cookie/i,
  );

  saveYouTubeMusicCredentials({ headers: fetchWithoutCookie, cookies: netscape });
  assert.equal(loadYouTubeMusicHeaders()?.Cookie, "SAPISID=extension-secret");
  assert.equal(loadYouTubeMusicHeaders()?.Authorization, "SAPISIDHASH xyz");
  assert.equal(loadYouTubeMusicHeaders()?.["X-Goog-AuthUser"], "1");
  clearYouTubeMusicCredentials();
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
    headers: {
      Authorization: "SAPISIDHASH keep-me",
      Cookie: "stale=header",
      "X-Goog-AuthUser": "0",
    },
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

test("liked-songs sign-in KeyError is mapped to a reconnect message", async () => {
  const rawKeyError = [
    'KeyError: "Unable to find \'twoColumnBrowseResultsRenderer\' using path ',
    "['contents', 'twoColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', ",
    "'sectionListRenderer', 'contents', 0] on {'singleColumnBrowseResultsRenderer': ",
    "{'tabs': [{'tabRenderer': {'selected': True, 'content': {'sectionListRenderer': ",
    "{'contents': [{'itemSectionRenderer': {'contents': [{'messageRenderer': ",
    "{'text': {'runs': [{'text': 'Looking for what you’ve liked?'}]}, ",
    "'button': {'buttonRenderer': {'text': {'runs': [{'text': 'Sign in'}]}}}]}}]}}]}}]}\"",
  ].join("");

  assert.equal(mapYtMusicBridgeFailure(rawKeyError, ""), YOUTUBE_MUSIC_AUTH_REQUIRED_MESSAGE);
  assert.equal(
    mapYtMusicBridgeFailure("RuntimeError: YouTube Music authentication is missing or expired. Sign in at music.youtube.com", ""),
    YOUTUBE_MUSIC_AUTH_REQUIRED_MESSAGE,
  );
  assert.match(mapYtMusicBridgeFailure("ValueError: unsupported import category: nope", ""), /unsupported import category/i);

  const bridge = new PythonYtMusicBridge({
    scriptPath: getYtMusicBridgeScript(),
    headersPath: path.join(testConfigDir, "missing-browser.json"),
    pythonBinary: "fixture-python",
    runner: async () => ({ code: 1, stdout: "", stderr: rawKeyError }),
  });
  await assert.rejects(
    () => bridge.request("get_import_artists", { category: "favorite-tracks" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ytmusicapi bridge failed/);
      assert.match(error.message, /authentication is missing or expired/i);
      assert.doesNotMatch(error.message, /twoColumnBrowseResultsRenderer/i);
      return true;
    },
  );
});

test("liked music import fails clearly when browser headers are missing", async () => {
  clearYouTubeMusicCredentials();
  const catalog = new YouTubeMusicCatalog(new FixtureBridge());
  await assert.rejects(
    () => catalog.getArtistsForImportSource({ category: "favorite-tracks" }),
    /authentication is missing or expired/i,
  );
});

test("stub User-Agent is upgraded when saving YouTube Music credentials", () => {
  clearYouTubeMusicCredentials();
  saveYouTubeMusicCredentials({
    headers: {
      Authorization: "SAPISIDHASH test-hash",
      Cookie: "SAPISID=test-secret; __Secure-3PAPISID=second-secret",
      "User-Agent": "Mozilla/5.0",
    },
  });
  const stored = loadYouTubeMusicHeaders();
  assert.ok(stored?.["User-Agent"]);
  assert.notEqual(stored?.["User-Agent"], "Mozilla/5.0");
  assert.match(stored?.["User-Agent"] || "", /Firefox|Chrome|Safari/i);
  clearYouTubeMusicCredentials();
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
  assert.equal(audioArgs[audioArgs.indexOf("--js-runtimes") + 1], "node");
  assert.ok(audioArgs.includes("--extract-audio"));
  // `best` means "do not re-encode". YouTube serves AAC *or* Opus and the tier
  // does not decide which, so forcing Opus decoded AAC and re-encoded it — a
  // second lossy generation that could only lose signal.
  assert.equal(audioArgs[audioArgs.indexOf("--audio-format") + 1], "best");
  assert.ok(!audioArgs.includes("--audio-quality"), "no re-encode quality to set");
  assert.ok(audioArgs.includes("--no-playlist"));
  assert.equal(audioArgs.at(-1), `https://music.youtube.com/watch?v=${TRACK_ID}`);
  assert.ok(audioArgs.some((arg) => arg.endsWith("%(id)s.%(ext)s")));
  assert.ok(!audioArgs.includes("--cookies"));

  const videoArgs = backend.buildArgs({ ...audioRequest, entityType: "video", providerId: VIDEO_ID });
  const videoFormat = videoArgs[videoArgs.indexOf("--format") + 1];
  assert.match(String(videoFormat), /bestvideo\*\[height<=\d+\]\+bestaudio\/best\[height<=\d+\]\/best/);
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
