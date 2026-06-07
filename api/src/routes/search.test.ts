import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-search-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.search.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let searchRouter: typeof import("./search.js").default;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  searchRouter = (await import("./search.js")).default;
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
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

function getSearchHandler(): (req: any, res: any) => Promise<void> {
  const layer = (searchRouter as any).stack.find((entry: any) => entry.route?.path === "/" && entry.route?.methods?.get);
  assert.ok(layer, "Expected GET / search route");
  return layer.route.stack[0].handle;
}

function insertCanonicalArtist() {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Search Artist')
    RETURNING Id
  `).get() as { Id: number };

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES ('artist-id', 'Search Artist', 'artist-mbid', 1)
  `).run();

  return artist;
}

test("local search returns canonical tracks and ignores legacy provider-media tracks", async () => {
  insertCanonicalArtist();

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('rg-mbid', 'artist-mbid', 'Search Album', 'Album', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, country, date)
    VALUES ('release-mbid', 'rg-mbid', 'artist-mbid', 'Search Album', 'Official', 'XW', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, IsVideo)
    VALUES ('recording-mbid', 'artist-mbid', 'Canonical Track Recording', 181000, 0)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES ('track-mbid', 'release-mbid', 'recording-mbid', 1, 1, '1', 'Canonical Search Track', 181000)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, selected_release_mbid, quality
    )
    VALUES ('artist-mbid', 'rg-mbid', 'stereo', 1, 'tidal', 'provider-album-1', 'release-mbid', 'LOSSLESS')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, explicit, quality, duration, asset_id, match_status
    )
    VALUES (
      'tidal', 'track', 'provider-track-1', 'artist-mbid', 'rg-mbid', 'release-mbid',
      'track-mbid', 'recording-mbid', 'Canonical Search Track', 1, 'HIRES_LOSSLESS', 181, 'track-cover', 'verified'
    )
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (id, artist_id, title, type, explicit, quality)
    VALUES ('legacy-track-1', 'artist-id', 'Canonical Search Track Legacy', 'Track', 0, 'LOW')
  `).run();

  const res = createMockResponse();
  await getSearchHandler()({ query: { query: "Canonical Search", type: "tracks", limit: "10" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.tracks.length, 1);
  assert.equal(res.body.results.tracks[0].id, "track-mbid");
  assert.equal(res.body.results.tracks[0].quality, "HIRES_LOSSLESS");
  assert.equal(res.body.results.tracks[0].monitored, true);
});

test("local search returns canonical videos and ignores legacy provider-media videos", async () => {
  const artist = insertCanonicalArtist();
  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (
      ForeignRecordingId, ArtistMetadataId, artist_mbid,
      title, length_ms, IsVideo, MetadataStatus, ReleaseDate, CoverImageId, Monitor
    )
    VALUES (
      'provider-video-1', ?, 'artist-mbid',
      'Canonical Search Video', 201000, 1, 'provider_only', '2023-02-03', 'recording-cover', 1
    )
    RETURNING Id
  `).get(artist.Id) as { Id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, release_date, asset_id, match_status
    )
    VALUES (
      'tidal', 'video', 'provider-video-1', 'artist-mbid', ?,
      'Canonical Search Video', 'FHD', 201, '2023-02-03', 'provider-cover', 'verified'
    )
  `).run(video.Id);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, title, duration, type, explicit, quality, monitor
    )
    VALUES ('legacy-video-1', 'artist-id', 'Canonical Search Video Legacy', 200, 'Music Video', 0, 'LOW', 1)
  `).run();

  const res = createMockResponse();
  await getSearchHandler()({ query: { query: "Canonical Search", type: "videos", limit: "10" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.videos.length, 1);
  assert.equal(res.body.results.videos[0].id, String(video.Id));
  assert.equal(res.body.results.videos[0].quality, "FHD");
  assert.equal(res.body.results.videos[0].monitored, true);
});
