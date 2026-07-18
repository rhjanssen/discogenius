import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isDeezerQuotaError } from "./deezer-api.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-deezer-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.STREAMRIP_BIN = "rip-test";

const { DeezerProvider } = await import("./deezer-provider.js");
const {
  clearDeezerCredentials,
  getDeezerCredentialsPath,
  loadDeezerCredentials,
  saveDeezerCredentials,
} = await import("./deezer-auth.js");
const {
  StreamripDeezerBackend,
  buildStreamripArgs,
  getStreamripConfigPath,
  renderStreamripConfig,
  streamripProgressForLine,
  syncDeezerStreamripConfig,
} = await import("./streamrip-backend.js");

const artist = {
  id: 1352097,
  name: "Bastille",
  link: "https://www.deezer.com/artist/1352097",
  picture_xl: "https://images.test/bastille.jpg",
  nb_fan: 2_000_000,
};
const album = {
  id: 658386461,
  title: "& (Ampersand)",
  link: "https://www.deezer.com/album/658386461",
  cover_xl: "https://images.test/album.jpg",
  release_date: "2024-10-25",
  nb_tracks: 2,
  duration: 420,
  record_type: "album",
  explicit_lyrics: true,
  upc: "123456789012",
  artist,
  contributors: [artist],
};
const track = {
  id: 3103033041,
  title: "Eurydice (Dan's Demo)",
  title_short: "Eurydice",
  title_version: "(Dan's Demo)",
  duration: 209,
  track_position: 1,
  disk_number: 1,
  release_date: "2024-10-25",
  explicit_lyrics: false,
  isrc: "QZ8BZ2411232",
  preview: "https://preview.test/track.mp3",
  rank: 500_000,
  gain: -8.4,
  artist,
  contributors: [artist],
  album,
};

function fixtureFetch(input: string) {
  const url = new URL(input);
  let payload: unknown;
  if (url.pathname === "/search/artist") payload = { data: [artist] };
  else if (url.pathname === "/search/album") payload = { data: [album] };
  else if (url.pathname === "/search/track") payload = { data: [track] };
  else if (url.pathname === "/artist/1352097") payload = artist;
  else if (url.pathname === "/artist/1352097/albums") {
    payload = url.searchParams.get("index") === "1"
      ? { data: [{ ...album, id: 658386462, title: "Second" }] }
      : { data: [album], next: "https://api.deezer.com/artist/1352097/albums?limit=100&index=1" };
  } else if (url.pathname === "/album/658386461") {
    payload = {
      ...album,
      tracks: { data: [{ ...track, track_position: undefined }], next: "https://api.deezer.com/album/658386461/tracks?index=1" },
    };
  } else if (url.pathname === "/album/658386461/tracks") {
    payload = { data: [{ ...track, id: 3103033042, track_position: undefined, title_short: "Second" }] };
  } else if (url.pathname === "/track/3103033041") payload = track;
  else payload = { error: { message: `No fixture for ${url.pathname}`, code: 404 } };
  return Promise.resolve({
    ok: !(payload as { error?: unknown }).error,
    status: (payload as { error?: unknown }).error ? 404 : 200,
    json: async () => payload,
  });
}

test("Deezer maps public catalog search into provider-neutral resources", async () => {
  const provider = new DeezerProvider(fixtureFetch);
  const result = await provider.search("Bastille", { limit: 5 });
  assert.equal(result.artists[0].providerId, "1352097");
  assert.equal(result.albums[0].upc, "123456789012");
  assert.equal(result.albums[0].quality, "FLAC");
  assert.equal(result.tracks[0].title, "Eurydice");
  assert.equal(result.tracks[0].version, "Dan's Demo");
  assert.equal(result.tracks[0].isrc, "QZ8BZ2411232");
  assert.deepEqual(result.videos, []);
});

test("Deezer follows artist-album and album-track pagination", async () => {
  const provider = new DeezerProvider(fixtureFetch);
  const albums = await provider.getArtistAlbums("1352097");
  assert.deepEqual(albums.map((item) => item.providerId), ["658386461", "658386462"]);
  assert.ok(albums.every((item) => item.artist.providerId === "1352097"));

  const tracks = await provider.getAlbumTracks("658386461");
  assert.deepEqual(tracks.map((item) => item.providerId), ["3103033041", "3103033042"]);
  assert.deepEqual(tracks.map((item) => item.trackNumber), [1, 2]);
  assert.ok(tracks.every((item) => item.album.providerId === "658386461"));
});

test("Deezer exposes public preview, artwork and URL round trips", async () => {
  const provider = new DeezerProvider(fixtureFetch);
  assert.deepEqual(await provider.getPlaybackInfo("3103033041"), {
    type: "bts",
    url: "https://preview.test/track.mp3",
  });
  assert.equal(await provider.getArtworkUrl({ entityType: "album", providerId: "658386461" }), "https://images.test/album.jpg");
  assert.deepEqual(provider.parseMediaUrl("https://www.deezer.com/nl/track/3103033041?utm=x"), {
    type: "track",
    providerId: "3103033041",
  });
  assert.equal(provider.getMediaUrl("album", "658386461"), "https://www.deezer.com/album/658386461");
});

test("Deezer manifest distinguishes public catalog access from ARL download auth", async () => {
  const provider = new DeezerProvider(fixtureFetch);
  const status = await provider.getAuthStatus();
  assert.equal(status.remoteCatalogAvailable, true);
  assert.equal(provider.capabilities.losslessStereo, true);
  assert.equal(provider.capabilities.spatialAudio, false);
  assert.equal(provider.manifest.downloadBackends[0].id, "streamrip-deezer");
});

test("Deezer credentials stay in the provider root and render a deterministic Streamrip config", () => {
  const arl = "a".repeat(192);
  saveDeezerCredentials({ arl });
  assert.equal(loadDeezerCredentials()?.arl, arl);
  const rendered = renderStreamripConfig(arl);
  assert.match(rendered, /folder_format = "\{id\}"/u);
  assert.match(rendered, /track_format = "\{id\}"/u);
  assert.match(rendered, /use_deezloader = false/u);
  assert.match(rendered, new RegExp(`arl = "${arl}"`, "u"));
});

test("Deezer logout removes every persisted ARL copy without touching other provider files", () => {
  const arl = "logout-secret-".repeat(16);
  saveDeezerCredentials({ arl });
  const authPath = getDeezerCredentialsPath();
  const streamripPath = syncDeezerStreamripConfig();
  assert.equal(streamripPath, getStreamripConfigPath());

  const abandonedTemporary = `${authPath}.tmp`;
  fs.writeFileSync(abandonedTemporary, JSON.stringify({ arl }));
  const otherProviderFile = path.join(tempDir, "providers", "spotify", "auth.json");
  fs.mkdirSync(path.dirname(otherProviderFile), { recursive: true });
  fs.writeFileSync(otherProviderFile, "spotify-credential");

  assert.match(fs.readFileSync(authPath, "utf8"), new RegExp(arl, "u"));
  assert.match(fs.readFileSync(streamripPath!, "utf8"), new RegExp(arl, "u"));
  clearDeezerCredentials();

  assert.equal(fs.existsSync(authPath), false);
  assert.equal(fs.existsSync(abandonedTemporary), false);
  assert.equal(fs.existsSync(streamripPath!), false);
  assert.equal(fs.readFileSync(otherProviderFile, "utf8"), "spotify-credential");
});

test("Streamrip arguments select resource, output root and account quality without prompts", () => {
  const args = buildStreamripArgs({
    provider: "deezer",
    entityType: "album",
    providerId: "658386461",
    downloadPath: path.join(tempDir, "job"),
    quality: "LOSSLESS",
    slot: "stereo",
  });
  assert.ok(args.includes("--no-progress"));
  assert.ok(args.includes("--no-db"));
  assert.ok(args.includes("2"));
  assert.equal(args.at(-1), "https://www.deezer.com/album/658386461");
});

test("Streamrip progress recognizes download, completion and error output", () => {
  assert.equal(streamripProgressForLine("Downloading Test")?.trackStatus, "downloading");
  assert.equal(streamripProgressForLine("Downloaded Test")?.trackStatus, "completed");
  assert.equal(streamripProgressForLine("ERROR unavailable")?.trackStatus, "error");
});

test("isDeezerQuotaError detects Deezer's quota/rate-limit responses", () => {
  assert.equal(isDeezerQuotaError({ error: { code: 4, message: "Quota limit exceeded" } }, 200), true);
  assert.equal(isDeezerQuotaError({ error: { message: "Quota limit exceeded" } }, 200), true);
  assert.equal(isDeezerQuotaError(undefined, 429), true);
  // Unrelated errors are not treated as quota (so they are not retried).
  assert.equal(isDeezerQuotaError({ error: { code: 800, message: "no data" } }, 404), false);
  assert.equal(isDeezerQuotaError(undefined, 200), false);
});

test("Streamrip backend rejects empty success and completes only after a media file exists", async () => {
  const arl = "b".repeat(192);
  saveDeezerCredentials({ arl });
  const downloadPath = path.join(tempDir, "successful-job");
  const progress: number[] = [];
  const backend = new StreamripDeezerBackend(async (_command, args, options) => {
    assert.equal(args.at(-1), "https://www.deezer.com/track/3103033041");
    options.onLine("Downloading Eurydice");
    fs.mkdirSync(downloadPath, { recursive: true });
    fs.writeFileSync(path.join(downloadPath, "3103033041.flac"), "fixture");
  });
  await backend.download({
    provider: "deezer",
    entityType: "track",
    providerId: "3103033041",
    downloadPath,
  }, { onProgress: (update) => progress.push(update.progress) });
  assert.equal(progress.at(-1), 100);

  const emptyPath = path.join(tempDir, "empty-job");
  const emptyBackend = new StreamripDeezerBackend(async () => undefined);
  await assert.rejects(
    emptyBackend.download({ provider: "deezer", entityType: "album", providerId: "658386461", downloadPath: emptyPath }, { onProgress: () => undefined }),
    /produced no Deezer media files/u,
  );
});
