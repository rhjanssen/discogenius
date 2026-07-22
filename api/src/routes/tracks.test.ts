import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tracks-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.tracks.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let tracksRouter: typeof import("./v1/track.js").default;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  tracksRouter = (await import("./v1/track.js")).default;
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

type MockResponse = {
  statusCode: number;
  body: any;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function getRouteHandler(pathName: string, method: "get" | "post" | "patch"): (req: any, res: any) => Promise<void> | void {
  const layer = (tracksRouter as any).stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${pathName} route`);
  return layer.route.stack[0].handle;
}

function insertCanonicalTrackFixture() {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Track Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitored)
    VALUES ('artist-id', 'Track Artist', 'artist-mbid', 1)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('rg-mbid', 'artist-mbid', 'Track Album', 'Album', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, country, date)
    VALUES ('release-mbid', 'rg-mbid', 'artist-mbid', 'Track Album', 'Official', 'XW', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video)
    VALUES ('recording-mbid', 'artist-mbid', 'Track Recording', 180000, 0)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES ('track-mbid', 'release-mbid', 'recording-mbid', 1, 1, '1', 'Canonical Track', 180000)
  `).run();
}

test("POST track monitor creates canonical release-group slot", async () => {
  insertCanonicalTrackFixture();

  const res = createMockResponse();
  await getRouteHandler("/", "post")({ body: { id: "track-mbid" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  const slot = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, slot, monitored AS wanted
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = 'rg-mbid'
  `).get() as { artist_mbid: string; release_group_mbid: string; slot: string; wanted: number };
  assert.equal(slot.artist_mbid, "artist-mbid");
  assert.equal(slot.slot, "stereo");
  assert.equal(slot.wanted, 1);

  const legacyProviderMedia = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'")
    .get();
  assert.equal(legacyProviderMedia, undefined);
});

test("track monitor route rejects provider-only track IDs", async () => {
  const res = createMockResponse();
  getRouteHandler("/:trackId/monitor", "post")({
    params: { trackId: "provider-track-only" },
    body: { monitored: true },
  }, res);

  assert.equal(res.statusCode, 404);
});

test("PATCH track updates canonical release-group wanted state", () => {
  insertCanonicalTrackFixture();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored)
    VALUES ('artist-mbid', 'rg-mbid', 'stereo', 1)
  `).run();

  const res = createMockResponse();
  getRouteHandler("/:trackId", "patch")({
    params: { trackId: "track-mbid" },
    body: { monitored: false, monitored_lock: true },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const slot = dbModule.db.prepare("SELECT monitored AS wanted FROM ReleaseGroupSlots WHERE release_group_mbid = 'rg-mbid'")
    .get() as { wanted: number };
  assert.equal(slot.wanted, 0);
});

test("GET tracks sorts popularity by track evidence instead of artist popularity", () => {
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, popularity)
    VALUES ('artist-mbid', 'Track Artist', 100)
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitored)
    VALUES ('artist-id', 'Track Artist', 'artist-mbid', 1)
  `).run();
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('rg-mbid', 'artist-mbid', 'Track Album', 'Album', '2024-01-01')
  `).run();
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, country, date)
    VALUES ('release-mbid', 'rg-mbid', 'artist-mbid', 'Track Album', 'Official', 'XW', '2024-01-01')
  `).run();
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_release_mbid, selected_provider_id, monitored
    )
    VALUES ('artist-mbid', 'rg-mbid', 'stereo', 'release-mbid', 'provider-album', 1)
  `).run();
  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, popularity)
    VALUES
      ('recording-low', 'artist-mbid', 'Low Track Recording', 180000, 0, 5),
      ('recording-high', 'artist-mbid', 'High Track Recording', 180000, 0, 80)
  `).run();
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES
      ('track-low', 'release-mbid', 'recording-low', 1, 1, '1', 'Low Track', 180000),
      ('track-high', 'release-mbid', 'recording-high', 1, 2, '2', 'High Track', 180000)
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, quality, library_slot, popularity
    )
    VALUES
      ('tidal', 'track', 'provider-low', 'artist-mbid', 'rg-mbid', 'release-mbid', 'track-low', 'recording-low', 'Low Track', 'LOSSLESS', 'stereo', 10),
      ('tidal', 'track', 'provider-high', 'artist-mbid', 'rg-mbid', 'release-mbid', 'track-high', 'recording-high', 'High Track', 'LOSSLESS', 'stereo', 90)
  `).run();

  const res = createMockResponse();
  getRouteHandler("/", "get")({
    query: { sort: "popularity", dir: "desc", limit: "10", offset: "0" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.items.map((track: { id: string }) => track.id),
    ["track-high", "track-low"],
  );
  assert.equal(res.body.items[0].popularity, 90);
});

test("GET tracks filters selected offers and keeps remote quality separate from local files", () => {
  insertCanonicalTrackFixture();
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider,
      selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES ('artist-mbid', 'rg-mbid', 'stereo', 1, 'tidal', 'tidal-album', 'release-mbid', 'HIRES_LOSSLESS', 'verified')
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, quality, library_slot
    ) VALUES
      ('deezer', 'track', 'deezer-track', 'deezer-album', 'artist-mbid', 'rg-mbid',
       'release-mbid', 'track-mbid', 'recording-mbid', 'Canonical Track', 'FLAC', 'stereo'),
      ('tidal', 'track', 'tidal-track', 'tidal-album', 'artist-mbid', 'rg-mbid',
       'release-mbid', 'track-mbid', 'recording-mbid', 'Canonical Track', 'HIRES_LOSSLESS', 'stereo')
  `).run();
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, library_slot, file_path,
      relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (
      'artist-id', 'artist-mbid', 'rg-mbid', 'release-mbid', 'track-mbid', 'recording-mbid',
      'stereo', '/music/Canonical Track.flac', 'Canonical Track.flac', '/music',
      'Canonical Track.flac', '.flac', 'track', 'LOSSLESS'
    )
  `).run();

  const selected = createMockResponse();
  getRouteHandler("/", "get")({
    query: { provider: "tidal", quality_tier: "MAX", limit: "10", offset: "0" },
  }, selected);

  assert.equal(selected.statusCode, 200);
  assert.equal(selected.body.total, 1);
  assert.deepEqual(selected.body.items[0].qualityTags, ["HIRES_LOSSLESS"]);
  assert.deepEqual(selected.body.items[0].remoteOffers, [{
    slot: "stereo",
    provider: "tidal",
    providerAlbumId: "tidal-album",
    quality: "HIRES_LOSSLESS",
    matchStatus: "verified",
    selectedReleaseMbid: "release-mbid",
    providerTrackId: "tidal-track",
  }]);
  assert.equal(selected.body.items[0].preview_provider, "tidal");
  assert.equal(selected.body.items[0].preview_provider_track_id, "tidal-track");
  assert.equal(selected.body.items[0].files[0].quality, "LOSSLESS");

  const wrongProvider = createMockResponse();
  getRouteHandler("/", "get")({
    query: { provider: "apple-music", limit: "10", offset: "0" },
  }, wrongProvider);
  assert.equal(wrongProvider.body.total, 0);
});
