import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-amazon-music-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.AMAZON_MUSIC_PYTHON = "python-amazon-test";

const { AmazonMusicProvider } = await import("./amazon-music-provider.js");
const { amazonMusicQualityMapping } = await import("./amazon-music-quality.js");
const {
  AmazonMusicBackend,
  amazonProgressForLine,
  buildAmazonMusicBridgeArgs,
  normalizeAmazonMusicDownloadFilenames,
} = await import("./amazon-music-backend.js");
const {
  ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV,
  DEFAULT_AMAZON_MUSIC_API_BASE,
  loadAmazonMusicCredentials,
  normalizeAmazonMusicApiBase,
  saveAmazonMusicCredentials,
} = await import("./amazon-music-auth.js");
const {
  amazonMusicApiRequest,
  AmazonMusicApiError,
} = await import("./amazon-music-api.js");

const credentials = { accessToken: "test-token-123456", apiBase: DEFAULT_AMAZON_MUSIC_API_BASE };
const artist = {
  id: "A1BASTILLE",
  name: "Bastille",
  image: "https://images.test/bastille.jpg",
};
const album = {
  id: "B0ALBUM123",
  title: "Ampersand",
  artist,
  image: "https://images.test/album.jpg",
  release_date: "2024-10-25",
  track_count: 1,
  type: "album",
  upc: "123456789012",
  available_qualities: ["UHD_192", "SPATIAL_ATMOS_HIGH_EC-3"],
};
const track = {
  id: "B0TRACK123",
  title: "Blue Sky & The Painter",
  artist,
  album,
  duration_ms: 210_000,
  track_number: 1,
  disc_number: 1,
  isrc: "GBUM72400001",
  available_qualities: ["UHD_192", "SPATIAL_ATMOS_HIGH_EC-3"],
};

function amazonFetch(input: string) {
  const url = new URL(input);
  let data: unknown;
  if (url.pathname === "/account") data = { id: "account" };
  else if (url.pathname === "/search") {
    const type = url.searchParams.get("type");
    data = type === "artist" ? [artist] : type === "album" ? [album] : [track];
  } else if (url.pathname === "/artist") data = { ...artist, albums: [album] };
  else if (url.pathname === "/album") data = { ...album, tracks: [track] };
  else if (url.pathname === "/track") data = track;
  else if (url.pathname === "/lyrics") data = { text: "Blue sky", lrc: "[00:01.00]Blue sky" };
  else return Promise.resolve({ ok: false, status: 404, json: async () => ({ success: false, message: "missing fixture" }) });
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) });
}

test("Amazon Music maps search and multi-axis quality without inventing provider catalog rows", async () => {
  const provider = new AmazonMusicProvider({ credentials, fetchImpl: amazonFetch });
  const result = await provider.search("Bastille");
  assert.equal(result.artists[0].providerId, "A1BASTILLE");
  assert.equal(result.albums[0].providerId, "B0ALBUM123");
  assert.equal(result.albums[0].upc, "123456789012");
  assert.equal(result.albums[0].quality, "HIRES_LOSSLESS");
  assert.deepEqual(result.albums[0].qualityTags, ["HIRES_LOSSLESS", "DOLBY_ATMOS"]);
  assert.equal(result.tracks[0].duration, 210);
  assert.equal(result.tracks[0].isrc, "GBUM72400001");
  assert.deepEqual(result.videos, []);
});

test("Amazon Music maps the downloader's concrete HD/UHD quality identifiers", () => {
  assert.equal(amazonMusicQualityMapping.toNeutralAudio("HD_44"), "lossless");
  assert.equal(amazonMusicQualityMapping.toNeutralAudio("UHD_192"), "hires-lossless");
  assert.deepEqual(
    amazonMusicQualityMapping.toNeutral(["HD_44", "SPATIAL_ATMOS_HIGH_EC-3"]),
    { audio: "lossless", spatial: ["atmos"] },
  );
});

test("Amazon Music keeps missing or unrecognized quality evidence neutral", async () => {
  const unknownAlbum = { ...album, available_qualities: ["future-tier-with-no-known-fidelity"] };
  const unknownTrack = { ...track, album: unknownAlbum, available_qualities: [] };
  const provider = new AmazonMusicProvider({
    credentials,
    fetchImpl: async (input) => {
      const resource = new URL(input).pathname === "/track" ? unknownTrack : unknownAlbum;
      return { ok: true, status: 200, json: async () => ({ success: true, data: resource }) };
    },
  });

  const mappedAlbum = await provider.getAlbum("B0UNKNOWNALBUM");
  const mappedTrack = await provider.getTrack("B0UNKNOWNTRACK");
  assert.equal(mappedAlbum.quality, null);
  assert.deepEqual(mappedAlbum.qualityTags, []);
  assert.equal(mappedTrack.quality, null);
  assert.deepEqual(mappedTrack.qualityTags, []);
  assert.notEqual(mappedAlbum.quality, "LOSSLESS");
});

test("Amazon Music maps artist discography, album tracks and lyrics", async () => {
  const provider = new AmazonMusicProvider({ credentials, fetchImpl: amazonFetch });
  assert.deepEqual((await provider.getArtistAlbums("A1BASTILLE")).map((item) => item.providerId), ["B0ALBUM123"]);
  assert.deepEqual((await provider.getAlbumTracks("B0ALBUM123")).map((item) => item.providerId), ["B0TRACK123"]);
  assert.deepEqual(await provider.getLyrics("B0TRACK123"), {
    text: "Blue sky",
    subtitles: "[00:01.00]Blue sky",
    provider: "Amazon Music",
    raw: { text: "Blue sky", lrc: "[00:01.00]Blue sky" },
  });
});

test("Amazon Music spatial search filters to explicitly Atmos-capable offers", async () => {
  const provider = new AmazonMusicProvider({ credentials, fetchImpl: amazonFetch });
  const offers = await provider.searchReleaseGroup({
    artistName: "Bastille",
    releaseGroupTitle: "Ampersand",
    slot: "spatial",
  });
  assert.equal(offers.length, 1);
  assert.ok(offers[0].qualityTags?.includes("DOLBY_ATMOS"));
});

test("Amazon Music credentials validate before persistence and URL parsing handles album track links", async () => {
  const provider = new AmazonMusicProvider({ fetchImpl: amazonFetch });
  await provider.saveCredentials({
    accessToken: credentials.accessToken,
    apiBase: credentials.apiBase,
  });
  assert.deepEqual(loadAmazonMusicCredentials(), credentials);
  assert.deepEqual(provider.parseMediaUrl("https://music.amazon.com/albums/B0ALBUM123?trackAsin=B0TRACK123"), {
    type: "track",
    providerId: "B0TRACK123",
  });
  assert.deepEqual(provider.parseMediaUrl("https://music.amazon.co.uk/artists/A1BASTILLE"), {
    type: "artist",
    providerId: "A1BASTILLE",
  });
});

test("Amazon Music API bases reject credential disclosure and private SSRF targets by default", async () => {
  const previous = process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV];
  delete process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV];
  try {
    assert.throws(() => normalizeAmazonMusicApiBase("https://user:secret@example.com"), /embedded credentials/u);
    assert.throws(() => normalizeAmazonMusicApiBase("https://example.com/api#account"), /fragment/u);
    assert.throws(() => normalizeAmazonMusicApiBase("http://example.com"), /HTTPS/u);
    assert.throws(() => normalizeAmazonMusicApiBase("https://127.0.0.1:8080"), /Private or loopback/u);
    assert.throws(() => normalizeAmazonMusicApiBase("https://[::1]"), /Private or loopback/u);

    let requests = 0;
    await assert.rejects(
      () => amazonMusicApiRequest("account", {}, {
        credentials: { ...credentials, apiBase: "https://catalog.example.net" },
        resolveHostname: async () => ["169.254.169.254"],
        fetchImpl: async () => {
          requests += 1;
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        },
      }),
      (error: unknown) => error instanceof AmazonMusicApiError && error.status === 400 && /private or non-public/u.test(error.message),
    );
    assert.equal(requests, 0);

    await amazonMusicApiRequest("account", {}, {
      credentials: { ...credentials, apiBase: "https://catalog.example.net/v1" },
      resolveHostname: async () => ["8.8.8.8", "2001:4860:4860::8888"],
      fetchImpl: async (input) => {
        requests += 1;
        assert.equal(input, "https://catalog.example.net/v1/account");
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      },
    });
    assert.equal(requests, 1);
  } finally {
    if (previous == null) delete process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV];
    else process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV] = previous;
  }
});

test("Amazon Music self-hosted private bases require and honor the explicit opt-in", async () => {
  const previous = process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV];
  process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV] = "true";
  try {
    let authorization = "";
    const payload = await amazonMusicApiRequest<{ success: true }>("account", {}, {
      credentials: { ...credentials, apiBase: "http://127.0.0.1:8787/api" },
      fetchImpl: async (input, init) => {
        assert.equal(input, "http://127.0.0.1:8787/api/account");
        authorization = String(init?.headers?.Authorization || "");
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      },
    });
    assert.equal(payload.success, true);
    assert.equal(authorization, `Bearer ${credentials.accessToken}`);
  } finally {
    if (previous == null) delete process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV];
    else process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV] = previous;
  }
});

test("Amazon Music API requests abort on their bounded deadline", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    () => amazonMusicApiRequest("account", {}, {
      credentials,
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        signal = init?.signal;
        return new Promise(() => undefined);
      },
    }),
    (error: unknown) => error instanceof AmazonMusicApiError && error.status === 504 && /timed out/u.test(error.message),
  );
  assert.equal(signal?.aborted, true);
});

test("Amazon Music manifest truthfully declares the unofficial external dependency", async () => {
  const provider = new AmazonMusicProvider({ credentials, fetchImpl: amazonFetch });
  assert.equal(provider.manifest.integration.catalogSource, "unofficial-api");
  assert.equal(provider.manifest.auth.kind, "external");
  assert.equal(provider.manifest.auth.comingSoon, true);
  assert.equal(provider.manifest.downloadBackends[0].enabled, false);
  assert.equal(provider.isAuthenticated(), false);
  assert.equal((await provider.getAuthStatus()).canAuthenticate, false);
  assert.equal(provider.capabilities.spatialAudio, true);
  assert.equal(provider.capabilities.musicVideos, false);
});

test("Amazon Music bridge arguments are non-interactive and never expose the token", () => {
  const args = buildAmazonMusicBridgeArgs({
    provider: "amazon-music",
    entityType: "album",
    providerId: "B0ALBUM123",
    downloadPath: path.join(tempDir, "job"),
    quality: "HIRES_LOSSLESS",
    slot: "spatial",
  });
  assert.ok(args.includes("Atmos_EC-3"));
  assert.ok(!args.some((value) => value.includes(credentials.accessToken)));
  assert.ok(args.includes("B0ALBUM123"));
});

test("Amazon Music normalizes downloaded files to provider IDs using exact ISRC/title evidence", async () => {
  const root = path.join(tempDir, "normalize");
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "Bastille - Blue Sky & The Painter (Max).flac");
  fs.writeFileSync(source, "fixture");
  const count = await normalizeAmazonMusicDownloadFilenames(root, [{
    id: "B0TRACK123",
    title: "Blue Sky & The Painter",
    isrc: "GBUM72400001",
    trackNumber: 1,
    volumeNumber: 1,
  }], async () => ({
    title: "Blue Sky & The Painter",
    isrc: "GBUM72400001",
    trackNumber: 1,
    volumeNumber: 1,
  }));
  assert.equal(count, 1);
  assert.equal(fs.existsSync(path.join(root, "B0TRACK123.flac")), true);

  await assert.rejects(
    normalizeAmazonMusicDownloadFilenames(root, [{ id: "../../config", title: "Unsafe" }]),
    /unsafe path characters/u,
  );
});

test("Amazon Music progress parser consumes structured bridge events", () => {
  assert.equal(amazonProgressForLine('DG_PROGRESS {"progress":42,"message":"working"}')?.progress, 42);
  assert.equal(amazonProgressForLine("Amazon Music download failed")?.trackStatus, "error");
});

test("Amazon Music backend renames a single track and rejects empty success", async () => {
  saveAmazonMusicCredentials(credentials);
  const root = path.join(tempDir, "track-job");
  const progress: number[] = [];
  const backend = new AmazonMusicBackend(async (_command, _args, options) => {
    assert.equal(options.env.AMAZON_MUSIC_API_TOKEN, credentials.accessToken);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "human name.opus"), "fixture");
    options.onLine('DG_PROGRESS {"progress":50,"message":"working"}');
  });
  await backend.download({
    provider: "amazon-music",
    entityType: "track",
    providerId: "B0TRACK123",
    downloadPath: root,
    slot: "stereo",
  }, { onProgress: (value) => progress.push(value.progress ?? -1) });
  assert.equal(fs.existsSync(path.join(root, "B0TRACK123.opus")), true);
  assert.equal(progress.at(-1), 100);

  const emptyRoot = path.join(tempDir, "empty-job");
  const empty = new AmazonMusicBackend(async () => undefined);
  await assert.rejects(
    empty.download({ provider: "amazon-music", entityType: "track", providerId: "B0TRACK123", downloadPath: emptyRoot }, { onProgress: () => undefined }),
    /no provider-identifiable media files/u,
  );

  let unsafeRunnerCalled = false;
  const unsafe = new AmazonMusicBackend(async () => {
    unsafeRunnerCalled = true;
  });
  await assert.rejects(
    unsafe.download({ provider: "amazon-music", entityType: "track", providerId: "../../config", downloadPath: root }, { onProgress: () => undefined }),
    /unsafe path characters/u,
  );
  assert.equal(unsafeRunnerCalled, false);
});
