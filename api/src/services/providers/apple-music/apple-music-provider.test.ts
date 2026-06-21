import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-apple-music-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");

import type { FetchLike } from "./apple-music-api.js";
import type { AppleMusicAuthToken } from "./apple-music-auth.js";
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
import { fixtureFor } from "./apple-music-fixtures.js";
import { appleMusicQualityMapping } from "./apple-music-quality.js";

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

test("maps Apple artist into ProviderArtist with rendered artwork", async () => {
  const artist = await getAppleArtist("1419227", opts());
  assert.equal(artist.providerId, "1419227");
  assert.equal(artist.name, "Bastille");
  assert.ok(artist.picture && !artist.picture.includes("{w}"), "artwork template should be rendered");
  assert.match(artist.picture!, /750x750/);
});

test("maps Apple album with UPC, explicit flag and neutral-classifiable quality tags", async () => {
  const album = await getAppleAlbum("1440904699", opts());
  assert.equal(album.providerId, "1440904699");
  assert.equal(album.title, "Bad Blood");
  assert.equal(album.upc, "00602537312733");
  assert.equal(album.explicit, true);
  assert.equal(album.trackCount, 13);
  assert.deepEqual(album.qualityTags, ["lossless", "lossy-stereo"]);
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
});

test("artist albums returns all offers including spatial", async () => {
  const albums = await getAppleArtistAlbums("1419227", opts());
  assert.equal(albums.length, 2);
  const spatial = albums.find((a) => a.qualityTags?.includes("atmos"));
  assert.ok(spatial, "should include the Atmos album");
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
  assert.equal(provider.capabilities.followedArtists, false);

  // Quality mapping is wired through the provider.
  const neutral = provider.qualityMapping!.toNeutral(["atmos", "lossless"]);
  assert.equal(neutral.audio, "lossless");
  assert.deepEqual(neutral.spatial, ["atmos"]);
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
    "https://music.apple.com/song/1440904918",
  );

  // A URL built by getMediaUrl (slug-less) must parse back to the same id/type.
  for (const [type, id] of [["album", "1440904699"], ["track", "1440904918"], ["video", "1452310551"]] as const) {
    const built = appleMusicStreamingProvider.getMediaUrl!(type, id);
    assert.deepEqual(appleMusicStreamingProvider.parseMediaUrl!(built), { type, providerId: id }, `round-trip ${type}`);
  }
});
