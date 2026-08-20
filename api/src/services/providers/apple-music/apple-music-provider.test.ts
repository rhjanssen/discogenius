import "./setup-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FetchLike } from "./apple-music-api.js";
import { validateAppleMusicCredentials } from "./apple-music-api.js";
import type { AppleMusicAuthToken } from "./apple-music-auth.js";
import { APPLE_MUSIC_DOWNLOADER_CONFIG, buildAppleMusicApiHeaders, loadStoredAppleMusicToken, resolveAppleWrapperHost, syncTokenToDownloader } from "./apple-music-auth.js";
import {
  getAppleAlbum,
  getAppleAlbumTracks,
  getAppleArtist,
  getAppleArtistAlbums,
  getAppleTrack,
  getAppleVideo,
  renderAppleArtwork,
  searchApple,
} from "./apple-music-catalog.js";
import {
  appleAudioQualityArgs,
  AppleMusicBackend,
  describeAppleDownloaderFailure,
  describeAppleDownloaderMissingPrerequisites,
  getAppleMusicDownloaderCapabilitySnapshot,
  getAppleMusicDownloaderBinary,
  parseAppleDownloaderProgressLine,
} from "./apple-music-backend.js";
import { fixtureFor } from "./apple-music-fixtures.js";
import {
  getAppleArtistsForImportSource,
  getAppleImportSources,
  shortImportListSubtitle,
} from "./apple-music-library.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";

test("describeAppleDownloaderFailure maps decryption/session errors to a re-auth instruction", () => {
  const eof = describeAppleDownloaderFailure(1, "Error reading response from device: EOF");
  assert.match(eof, /Re-authenticate Apple Music/i);
  assert.match(eof, /2FA/);
  // The raw downloader detail is preserved for debugging.
  assert.match(eof, /reading response from device/i);

  assert.match(describeAppleDownloaderFailure(1, "CKC error"), /Re-authenticate Apple Music/i);
  assert.match(describeAppleDownloaderFailure(1, "sign-in required"), /Re-authenticate Apple Music/i);
  assert.match(describeAppleDownloaderFailure(1, "Decrypt failed: exit status 1"), /Re-authenticate Apple Music/i);
});

test("describeAppleDownloaderFailure leaves unrelated errors as the raw exit message", () => {
  const other = describeAppleDownloaderFailure(1, "track not available in storefront");
  assert.match(other, /exited with code 1/);
  assert.doesNotMatch(other, /Re-authenticate/i);
});

const TEST_TOKEN: AppleMusicAuthToken = {
  developer_token: "dev-token",
  media_user_token: "user-token",
  storefront: "us",
};

const fixtureFetch: FetchLike = async (url) => ({
  ok: true,
  status: 200,
  async json() {
    return fixtureFor(url);
  },
});

function opts() {
  return { fetchImpl: fixtureFetch, token: TEST_TOKEN };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

test("maps Apple artist into ProviderArtist with rendered artwork", async () => {
  const artist = await getAppleArtist("1419227", opts());
  assert.equal(artist.providerId, "1419227");
  assert.equal(artist.name, "Bastille");
  assert.ok(artist.picture && !artist.picture.includes("{w}"), "artwork template should be rendered");
  assert.match(artist.picture!, /3000x3000/);
});

test("maps Apple album with UPC, explicit flag and neutral-classifiable quality tags", async () => {
  const album = await getAppleAlbum("1440904699", opts());
  assert.equal(album.providerId, "1440904699");
  assert.equal(album.title, "Bad Blood");
  assert.equal(album.upc, "00602537312733");
  assert.equal(album.explicit, true);
  assert.equal(album.trackCount, 13);
  assert.deepEqual(album.qualityTags, ["lossless", "lossy-stereo"]);
  assert.equal(album.videoCover, "https://mzstatic.com/editorialvideo/motion-detail-square.m3u8");
});

test("extractAppleEditorialVideoUrl prefers motionDetailSquare over fallback", async () => {
  const { extractAppleEditorialVideoUrl } = await import("./apple-music-catalog.js");
  assert.equal(
    extractAppleEditorialVideoUrl({
      editorialVideo: {
        motionDetailSquare: { video: "https://example/square.m3u8" },
        motionSquareVideo1x1: { video: "https://example/fallback.m3u8" },
      },
    }),
    "https://example/square.m3u8",
  );
  assert.equal(
    extractAppleEditorialVideoUrl({
      editorialVideo: {
        motionSquareVideo1x1: { video: "https://example/fallback.m3u8" },
      },
    }),
    "https://example/fallback.m3u8",
  );
  assert.equal(extractAppleEditorialVideoUrl({}), null);
});

test("Apple getArtworkUrl returns editorial video URL for albumVideoCover", async () => {
  const { appleMusicStreamingProvider } = await import("./apple-music-provider.js");
  const originalApiOptions = (appleMusicStreamingProvider as any).apiOptions.bind(appleMusicStreamingProvider);
  (appleMusicStreamingProvider as any).apiOptions = () => opts();
  try {
    const url = await appleMusicStreamingProvider.getArtworkUrl({
      entityType: "albumVideoCover",
      imageId: "https://already-a-url.example/motion.m3u8",
    });
    assert.equal(url, "https://already-a-url.example/motion.m3u8");

    const fromAlbum = await appleMusicStreamingProvider.getArtworkUrl({
      entityType: "albumVideoCover",
      providerId: "1440904699",
    });
    assert.equal(fromAlbum, "https://mzstatic.com/editorialvideo/motion-detail-square.m3u8");
  } finally {
    (appleMusicStreamingProvider as any).apiOptions = originalApiOptions;
  }
});

test("Apple getArtworkUrl uses advertised origin dimensions", async () => {
  const { appleMusicStreamingProvider } = await import("./apple-music-provider.js");
  const originalApiOptions = (appleMusicStreamingProvider as any).apiOptions.bind(appleMusicStreamingProvider);
  (appleMusicStreamingProvider as any).apiOptions = () => opts();
  try {
    assert.match(
      String(await appleMusicStreamingProvider.getArtworkUrl({
        entityType: "artist",
        providerId: "1419227",
        size: "origin",
      })),
      /3000x3000/,
    );
    assert.match(
      String(await appleMusicStreamingProvider.getArtworkUrl({
        entityType: "album",
        providerId: "1440904699",
        size: "origin",
      })),
      /1500x1500/,
    );
  } finally {
    (appleMusicStreamingProvider as any).apiOptions = originalApiOptions;
  }
});

test("maps Apple album tracks with ISRC, duration in seconds and track/disc numbers", async () => {
  const tracks = await getAppleAlbumTracks("1440904699", opts());
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].providerId, "1440904918");
  assert.equal(tracks[0].isrc, "GBUM71300776");
  assert.equal(tracks[0].duration, 214); // 214000ms -> 214s
  assert.equal(tracks[0].trackNumber, 4);
  assert.equal(tracks[0].volumeNumber, 1);
});

test("maps a single Apple track and video", async () => {
  const track = await getAppleTrack("1440904918", opts());
  assert.equal(track.title, "Pompeii");
  const video = await getAppleVideo("1452310551", opts());
  assert.equal(video.providerId, "1452310551");
  assert.equal(video.isrc, "GBUM71300999");
  assert.equal(video.duration, 215);
  assert.equal(video.quality, "UHD");
  assert.equal(video.albumId, "1440653916");
  assert.equal(video.relatedTrackId, "1440653947");
  assert.ok(video.cover && !video.cover.includes("{w}"), "video artwork should be rendered");
});

test("artist albums returns all offers including spatial", async () => {
  const albums = await getAppleArtistAlbums("1419227", opts());
  assert.equal(albums.length, 2);
  const spatial = albums.find((a) => a.qualityTags?.includes("atmos"));
  assert.ok(spatial, "should include the Atmos album");
});

test("an Apple Atmos offer remains eligible for its separate stereo stream", async () => {
  const { appleMusicOfferSupportsSlot } = await import("./apple-music-provider.js");
  const album = (await getAppleArtistAlbums("1419227", opts()))
    .find((candidate) => candidate.providerId === "1500000000");

  assert.ok(album);
  assert.deepEqual(album.qualityTags, ["hi-res-lossless", "atmos"]);
  assert.equal(appleMusicOfferSupportsSlot(album, "stereo"), true);
  assert.equal(appleMusicOfferSupportsSlot(album, "spatial"), true);
  assert.equal(appleMusicOfferSupportsSlot(album, "video"), false);
});

test("search routes Apple result buckets into neutral search results", async () => {
  const results = await searchApple("bastille", ["artists", "albums", "tracks", "videos"], 10, opts());
  assert.equal(results.artists.length, 1);
  assert.equal(results.albums.length, 2);
  assert.equal(results.tracks.length, 2);
  assert.equal(results.videos.length, 1);
});

test("renderAppleArtwork substitutes width/height/format placeholders", () => {
  const url = renderAppleArtwork({ url: "https://x/{w}x{h}bb.{f}" }, 640);
  assert.equal(url, "https://x/640x640bb.jpg");
  assert.equal(renderAppleArtwork(undefined), null);
});

test("renderAppleArtwork can request landscape music-video dimensions", () => {
  const url = renderAppleArtwork({ url: "https://x/{w}x{h}mv.{f}" }, 1920, 1080);
  assert.equal(url, "https://x/1920x1080mv.jpg");
});

test("Apple quality mapping translates raw traits into the neutral model", () => {
  assert.equal(appleMusicQualityMapping.toNeutralAudio("hi-res-lossless"), "hires-lossless");
  assert.equal(appleMusicQualityMapping.toNeutralAudio("lossless"), "lossless");
  assert.equal(appleMusicQualityMapping.toNeutralAudio("lossy-stereo"), "lossy");
  assert.equal(appleMusicQualityMapping.toNeutralAudio("atmos"), null);

  const neutral = appleMusicQualityMapping.toNeutral(["lossy-stereo", "hi-res-lossless", "atmos"]);
  assert.equal(neutral.audio, "hires-lossless"); // best stereo tier wins
  assert.deepEqual(neutral.spatial, ["atmos"]);

  assert.equal(appleMusicQualityMapping.fromNeutralAudio("lossless"), "lossless");
});

test("Apple music-video quality maps has4K to UHD and probes HLS when unknown", async () => {
  const { appleVideoQualityTag } = await import("./apple-music-quality.js");
  assert.equal(appleVideoQualityTag(true), "UHD");
  assert.equal(appleVideoQualityTag(false), null);
  assert.equal(appleVideoQualityTag(undefined), null);

  const video = await getAppleVideo("1452310551", opts());
  assert.equal(video.quality, "UHD");

  const { appleVideoQualityFromAttributes } = await import("./apple-music-video-probe.js");
  const hlsMaster = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360',
    "a.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
    "b.m3u8",
  ].join("\n");
  const probed = await appleVideoQualityFromAttributes(
    {
      has4K: false,
      previews: [{ hlsUrl: "https://example.test/preview.m3u8" }],
    },
    {
      fetchImpl: async (url) => {
        assert.equal(url, "https://example.test/preview.m3u8");
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => hlsMaster,
        } as { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
      },
    },
  );
  assert.equal(probed, "FHD");

  const stillUnknown = await appleVideoQualityFromAttributes(
    { has4K: false, previews: [] },
    { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
  );
  assert.equal(stillUnknown, null);
});

test("provider exposes core capability descriptor and conforms to interface", async () => {
  const { appleMusicStreamingProvider } = await import("./apple-music-provider.js");
  const provider = appleMusicStreamingProvider;

  assert.equal(provider.id, "apple-music");
  assert.equal(typeof provider.search, "function");
  assert.equal(typeof provider.getArtist, "function");
  assert.equal(typeof provider.getAlbum, "function");
  assert.equal(typeof provider.getAlbumTracks, "function");
  assert.equal(typeof provider.getTrack, "function");
  assert.equal(typeof provider.getVideo, "function");
  assert.equal(typeof provider.getArtworkUrl, "function");
  assert.equal(typeof provider.getAuthStatus, "function");

  // Detailed capabilities feature-gate the settings UI.
  assert.equal(provider.capabilities.catalogSearch, true);
  assert.equal(provider.capabilities.spatialAudio, true);
  assert.equal(provider.capabilities.lyrics, false);
  assert.equal("getLyrics" in provider, false);
  assert.equal(provider.capabilities.followedArtists, false);
  assert.deepEqual(provider.manifest.imports.supported, ["library-artists", "favorite-tracks", "playlist", "mix"]);
  assert.equal(provider.manifest.integration.catalogSource, "official-api");
  assert.equal(provider.manifest.integration.downloadSource, "native-cli");

  // Quality mapping is wired through the provider.
  const neutral = provider.qualityMapping!.toNeutral(["atmos", "lossless"]);
  assert.equal(neutral.audio, "lossless");
  assert.deepEqual(neutral.spatial, ["atmos"]);
});

test("Apple import sources expose library artists and playlists through the common contract", async () => {
  const sources = await getAppleImportSources(opts());
  assert.deepEqual(
    sources.map((source) => source.category),
    ["library-artists", "favorite-tracks", "playlist", "mix"],
  );
  const playlist = sources.find((source) => source.category === "playlist");
  assert.equal(playlist?.lists?.[0]?.id, "p.test");
  assert.equal(playlist?.lists?.[0]?.title, "Apple Test Playlist");
  assert.equal(playlist?.lists?.[0]?.subtitle, "Fixture playlist");
  const mix = sources.find((source) => source.category === "mix");
  assert.equal(mix?.label, "Made for You");
  assert.equal(mix?.lists?.[0]?.id, "pl.made-for-you");
  assert.equal(mix?.lists?.[0]?.title, "New Music Mix");
  assert.equal(mix?.lists?.[0]?.subtitle, "Based on your listening");
  const editorialMix = mix?.lists?.find((list) => list.id === "pl.dancexl-2021");
  assert.equal(editorialMix?.title, "danceXL 2021");
  // Multi-paragraph Apple editorial description must not become the list subtitle.
  assert.equal(editorialMix?.subtitle, "40 tracks");

  const libraryArtists = await getAppleArtistsForImportSource({ category: "library-artists" }, opts());
  assert.equal(libraryArtists.length, 1);
  assert.equal(libraryArtists[0].providerId, "1419227");
  assert.equal(libraryArtists[0].name, "Bastille");

  const favoriteArtists = await getAppleArtistsForImportSource({ category: "favorite-tracks" }, opts());
  assert.equal(favoriteArtists.length, 1);
  assert.equal(favoriteArtists[0].name, "Bastille");

  const playlistArtists = await getAppleArtistsForImportSource({ category: "playlist", listId: "p.test" }, opts());
  assert.equal(playlistArtists.length, 1);
  assert.equal(playlistArtists[0].name, "Bastille");

  const mixArtists = await getAppleArtistsForImportSource({ category: "mix", listId: "pl.made-for-you" }, opts());
  assert.equal(mixArtists.length, 1);
  assert.equal(mixArtists[0].name, "Bastille");
});

test("Apple import list subtitles keep short copy and omit editorial blobs", () => {
  assert.equal(shortImportListSubtitle("Based on your listening"), "Based on your listening");
  assert.equal(shortImportListSubtitle("Fresh picks for you"), "Fresh picks for you");
  assert.equal(
    shortImportListSubtitle("Rockhits uit 2021\n\nEDM is in de afgelopen tien jaar zo populair geworden."),
    null,
  );
  assert.equal(
    shortImportListSubtitle("<p>Short blurb</p><p>Longer editorial paragraph that should be omitted.</p>"),
    null,
  );
  assert.equal(
    shortImportListSubtitle("A".repeat(120)),
    `${"A".repeat(95)}…`,
  );
});

test("Apple credential validation probes the user's storefront", async () => {
  const validation = await validateAppleMusicCredentials(TEST_TOKEN, { fetchImpl: fixtureFetch });
  assert.equal(validation.storefront, "us");
});

test("Apple downloader config stays headless-safe and follows the app's lyric setting", () => {
  syncTokenToDownloader({ media_user_token: "user-token", storefront: "us" });
  const content = fs.readFileSync(APPLE_MUSIC_DOWNLOADER_CONFIG, "utf-8");
  // Upstream only prints "press Enter to try again" when this is false. With
  // stdin closed that prompt reads EOF and immediately retries forever, so a
  // headless run must exit and let the Discogenius queue own bounded retries.
  assert.match(content, /exit-on-error: true/);
  assert.doesNotMatch(content, /lrc-type:/);
  // embed-lrc MUST stay false: upstream apple-music-dl panics (nil TTML) on
  // tracks without lyrics, aborting the whole album download.
  assert.match(content, /embed-lrc: false/);
  assert.match(content, /save-lrc-file: false/);
  assert.match(content, /embed-cover: true/);
  assert.doesNotMatch(content, /mv-file-format:/);
  assert.match(content, /decrypt-m3u8-port: "127.0.0.1:10020"/);
  assert.match(content, /get-m3u8-port: "127.0.0.1:20020"/);
});

test("Apple wrapper host is the compose service name inside Docker", () => {
  assert.equal(resolveAppleWrapperHost({}), "127.0.0.1");
  assert.equal(resolveAppleWrapperHost({ DOCKER: "true" }), "apple-music-wrapper");
  assert.equal(resolveAppleWrapperHost({ DOCKER: "true", APPLE_MUSIC_WRAPPER_HOST: "wrapper" }), "wrapper");
});

test("Apple provider saveCredentials never persists wrapper Apple account fields", async () => {
  const { appleMusicStreamingProvider } = await import("./apple-music-provider.js");
  const originalEnv = process.env.APPLE_MUSIC_USER_TOKEN;
  const originalDevEnv = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  delete process.env.APPLE_MUSIC_USER_TOKEN;
  delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  try {
    // Even if a caller passes wrapper account fields, they must not reach disk:
    // the wrapper login flows through the transient trigger-file channel only.
    await appleMusicStreamingProvider.saveCredentials({
      mediaUserToken: "user-token",
      storefront: "us",
      wrapperAppleId: "test@example.com",
      wrapperApplePassword: "super-secret",
      validator: async () => ({ storefront: "us" }),
    });
    const token = loadStoredAppleMusicToken();
    assert.equal(token?.media_user_token, "user-token");
    assert.equal((token as unknown as Record<string, unknown> | null)?.wrapper_apple_id, undefined);
    assert.equal((token as unknown as Record<string, unknown> | null)?.wrapper_apple_password, undefined);
  } finally {
    if (originalEnv == null) {
      delete process.env.APPLE_MUSIC_USER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_USER_TOKEN = originalEnv;
    }
    if (originalDevEnv == null) {
      delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_DEVELOPER_TOKEN = originalDevEnv;
    }
  }
});

test("Apple web bearer token auto-resolution is cached across API header builds", async () => {
  const originalFetch = globalThis.fetch;
  const fakeBearer = [
    base64UrlJson({ typ: "JWT" }),
    base64UrlJson({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    "signature",
  ].join(".");
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrls.push(String(url));
    if (String(url) === "https://music.apple.com") {
      return new Response('<script src="/assets/index~test.js"></script>', { status: 200 });
    }
    return new Response(`window.token="${fakeBearer}";`, { status: 200 });
  }) as typeof fetch;
  try {
    const token = { media_user_token: "user-token", storefront: "us" };
    const first = await buildAppleMusicApiHeaders(token);
    const second = await buildAppleMusicApiHeaders(token);
    assert.equal(first.Authorization, `Bearer ${fakeBearer}`);
    assert.equal(second.Authorization, `Bearer ${fakeBearer}`);
    assert.deepEqual(requestedUrls, ["https://music.apple.com", "https://music.apple.com/assets/index~test.js"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Apple catalog calls use the configured storefront when no explicit test token is supplied", async () => {
  const previousDevToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const previousUserToken = process.env.APPLE_MUSIC_USER_TOKEN;
  const previousStorefront = process.env.APPLE_MUSIC_STOREFRONT;
  const requestedUrls: string[] = [];
  process.env.APPLE_MUSIC_DEVELOPER_TOKEN = "dev-token";
  process.env.APPLE_MUSIC_USER_TOKEN = "user-token";
  process.env.APPLE_MUSIC_STOREFRONT = "nl";
  const fetchImpl: FetchLike = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return fixtureFor(url);
      },
    };
  };

  try {
    await searchApple("bastille", ["artists"], 10, { fetchImpl });
    assert.match(requestedUrls[0], /\/v1\/catalog\/nl\/search\?/);
  } finally {
    if (previousDevToken == null) {
      delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_DEVELOPER_TOKEN = previousDevToken;
    }
    if (previousUserToken == null) {
      delete process.env.APPLE_MUSIC_USER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_USER_TOKEN = previousUserToken;
    }
    if (previousStorefront == null) {
      delete process.env.APPLE_MUSIC_STOREFRONT;
    } else {
      process.env.APPLE_MUSIC_STOREFRONT = previousStorefront;
    }
  }
});

test("Apple downloader backend builds provider-id based tool invocations", () => {
  const previousStorefront = process.env.APPLE_MUSIC_STOREFRONT;
  process.env.APPLE_MUSIC_STOREFRONT = "us";
  try {
    const backend = new AppleMusicBackend();
    assert.deepEqual(
      backend.buildArgs("1440904699", {
        provider: "apple-music",
        entityType: "album",
        providerId: "1440904699",
        downloadPath: "/downloads/job",
        quality: "hi-res-lossless",
      }),
      ["--alac-max", "192000", "https://music.apple.com/us/album/1440904699"],
    );
    assert.deepEqual(
      backend.buildArgs("1440904918", {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: "/downloads/job",
        slot: "spatial",
        quality: "LOSSLESS",
      }),
      ["--song", "--atmos", "https://music.apple.com/us/song/1440904918"],
    );
    // A genuinely-lossy request downloads AAC 256 (Apple's lossy floor).
    assert.deepEqual(
      backend.buildArgs("1440904918", {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: "/downloads/job",
        slot: "stereo",
        quality: "LOSSY_STEREO",
      }),
      ["--song", "--aac", "https://music.apple.com/us/song/1440904918"],
    );
    // Apple stores its lossy-stereo catalog trait as HIGH in ProviderItems.
    assert.deepEqual(
      backend.buildArgs("1440904918", {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: "/downloads/job",
        slot: "stereo",
        quality: "HIGH",
      }),
      ["--song", "--aac", "https://music.apple.com/us/song/1440904918"],
    );
    assert.deepEqual(
      backend.buildArgs("1440904918", {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: "/downloads/job",
        slot: "stereo",
        quality: "HIRES_LOSSLESS",
      }),
      ["--song", "--alac-max", "192000", "https://music.apple.com/us/song/1440904918"],
    );
    assert.deepEqual(
      backend.buildArgs("1452310551", {
        provider: "apple-music",
        entityType: "video",
        providerId: "1452310551",
        downloadPath: "/downloads/job",
      }),
      ["--mv-audio-type", "atmos", "--mv-max", "2160", "https://music.apple.com/us/music-video/1452310551"],
    );
  } finally {
    if (previousStorefront == null) {
      delete process.env.APPLE_MUSIC_STOREFRONT;
    } else {
      process.env.APPLE_MUSIC_STOREFRONT = previousStorefront;
    }
  }
});

test("Apple audio arguments apply the configured stereo quality ceiling", () => {
  assert.deepEqual(appleAudioQualityArgs("HIRES_LOSSLESS", "low"), ["--aac"]);
  assert.deepEqual(appleAudioQualityArgs("HIRES_LOSSLESS", "normal"), ["--aac"]);
  assert.deepEqual(appleAudioQualityArgs("HIRES_LOSSLESS", "high"), ["--alac-max", "48000"]);
  assert.deepEqual(appleAudioQualityArgs("HIRES_LOSSLESS", "max"), ["--alac-max", "192000"]);
  assert.deepEqual(appleAudioQualityArgs("LOSSLESS", "max"), ["--alac-max", "48000"]);
  assert.deepEqual(appleAudioQualityArgs("HIGH", "max"), ["--aac"]);
});

test("Apple downloader URLs use the configured storefront", () => {
  const previousDevToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const previousUserToken = process.env.APPLE_MUSIC_USER_TOKEN;
  const previousStorefront = process.env.APPLE_MUSIC_STOREFRONT;
  process.env.APPLE_MUSIC_DEVELOPER_TOKEN = "dev-token";
  process.env.APPLE_MUSIC_USER_TOKEN = "user-token";
  process.env.APPLE_MUSIC_STOREFRONT = "gb";
  try {
    const backend = new AppleMusicBackend();
    assert.deepEqual(
      backend.buildArgs("1440904918", {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: "/downloads/job",
      }),
      ["--song", "https://music.apple.com/gb/song/1440904918"],
    );
  } finally {
    if (previousDevToken == null) {
      delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_DEVELOPER_TOKEN = previousDevToken;
    }
    if (previousUserToken == null) {
      delete process.env.APPLE_MUSIC_USER_TOKEN;
    } else {
      process.env.APPLE_MUSIC_USER_TOKEN = previousUserToken;
    }
    if (previousStorefront == null) {
      delete process.env.APPLE_MUSIC_STOREFRONT;
    } else {
      process.env.APPLE_MUSIC_STOREFRONT = previousStorefront;
    }
  }
});

test("Apple downloader progress parser extracts track counts and provider ids from native output", () => {
  const trackLine = parseAppleDownloaderProgressLine("Track 2 of 13: songs");
  assert.deepEqual(trackLine, {
    currentFileNum: 2,
    totalFiles: 13,
    statusMessage: "Track 2 of 13: songs",
    trackStatus: "downloading",
  });

  const idLine = parseAppleDownloaderProgressLine("1440904918", {
    currentFileNum: 2,
    totalFiles: 13,
  });
  assert.equal(idLine?.currentProviderTrackId, "1440904918");
  assert.equal(idLine?.trackStatus, "downloading");

  const doneLine = parseAppleDownloaderProgressLine("Decrypted", {
    currentFileNum: 2,
    totalFiles: 13,
    providerTrackId: "1440904918",
  });
  assert.equal(doneLine?.currentProviderTrackId, "1440904918");
  assert.equal(doneLine?.trackStatus, "completed");

  const errorLine = parseAppleDownloaderProgressLine("Invalid media-user-token", {
    currentFileNum: 2,
    totalFiles: 13,
    providerTrackId: "1440904918",
  });
  assert.equal(errorLine?.trackStatus, "error");
  assert.equal(errorLine?.isError, true);

  // ALAC→AAC fallback is informational; must not fail the job (Amy soundtrack
  // job 211: "Unavailable, trying to dl aac-lc" with exit code 0).
  const aacFallback = parseAppleDownloaderProgressLine("Unavailable, trying to dl aac-lc", {
    currentFileNum: 12,
    totalFiles: 23,
    providerTrackId: "1440827418",
  });
  assert.equal(aacFallback?.isError, undefined);
  assert.equal(aacFallback?.trackStatus, "downloading");
  assert.match(String(aacFallback?.statusMessage), /aac-lc/i);

  // The success banner contains the word "Errors" and must NOT be treated as
  // a failure — misparsing it once failed completed downloads, whose cleanup
  // then deleted the finished files.
  const successBanner = parseAppleDownloaderProgressLine(
    "=======  [✔ ] Completed: 1/1  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 0  =======",
  );
  assert.equal(successBanner?.isError, undefined);
  assert.equal(successBanner?.trackStatus, "completed");

  const failureBanner = parseAppleDownloaderProgressLine(
    "=======  [✔ ] Completed: 0/1  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======",
  );
  assert.equal(failureBanner?.isError, true);
});

test("Apple downloader readiness snapshot exposes provisioning facts", async () => {
  const snapshot = await getAppleMusicDownloaderCapabilitySnapshot();
  assert.equal(typeof snapshot.downloaderBinary, "string");
  assert.equal(typeof snapshot.downloaderBinaryAvailable, "boolean");
  assert.equal(typeof snapshot.mp4BoxAvailable, "boolean");
  assert.equal(typeof snapshot.wrapperDecryptPortOpen, "boolean");
  assert.equal(typeof snapshot.wrapperM3u8PortOpen, "boolean");
});

test("Apple downloader binary default follows the upstream CLI name", () => {
  const previousBin = process.env.APPLE_MUSIC_DL_BIN;
  delete process.env.APPLE_MUSIC_DL_BIN;
  try {
    assert.equal(getAppleMusicDownloaderBinary(), "apple-music-dl");
    process.env.APPLE_MUSIC_DL_BIN = "custom-amdl";
    assert.equal(getAppleMusicDownloaderBinary(), "custom-amdl");
  } finally {
    if (previousBin == null) {
      delete process.env.APPLE_MUSIC_DL_BIN;
    } else {
      process.env.APPLE_MUSIC_DL_BIN = previousBin;
    }
  }
});

test("Apple downloader prerequisite summary names every missing live dependency", () => {
  const missing = describeAppleDownloaderMissingPrerequisites({
    authenticated: true,
    downloaderBinary: "apple-music-dl",
    downloaderBinaryAvailable: false,
    mp4BoxAvailable: false,
    mp4DecryptAvailable: false,
    wrapperDecryptPortOpen: false,
    wrapperM3u8PortOpen: false,
    downloaderConfigExists: true,
    downloaderWorkingDirectory: "/config/providers/apple-music/.amdl",
  });
  assert.deepEqual(missing, [
    "downloader binary (apple-music-dl)",
    "MP4Box",
    "decryption wrapper port 10020",
    "decryption wrapper port 20020",
  ]);
});

test("parseMediaUrl / getMediaUrl round-trip Apple URLs", async () => {
  const { appleMusicStreamingProvider } = await import("./apple-music-provider.js");
  const parsed = appleMusicStreamingProvider.parseMediaUrl!(
    "https://music.apple.com/us/album/bad-blood/1440904699",
  );
  assert.deepEqual(parsed, { type: "album", providerId: "1440904699" });

  const song = appleMusicStreamingProvider.parseMediaUrl!(
    "https://music.apple.com/us/song/pompeii/1440904918",
  );
  assert.deepEqual(song, { type: "track", providerId: "1440904918" });

  assert.equal(
    appleMusicStreamingProvider.getMediaUrl!("track", "1440904918"),
    "https://music.apple.com/us/song/1440904918",
  );

  // A URL built by getMediaUrl (slug-less) must parse back to the same id/type.
  for (const [type, id] of [["album", "1440904699"], ["track", "1440904918"], ["video", "1452310551"]] as const) {
    const built = appleMusicStreamingProvider.getMediaUrl!(type, id);
    assert.deepEqual(appleMusicStreamingProvider.parseMediaUrl!(built), { type, providerId: id }, `round-trip ${type}`);
  }
});
