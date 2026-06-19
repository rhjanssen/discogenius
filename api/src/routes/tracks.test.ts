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

function getRouteHandler(pathName: string, method: "post" | "patch"): (req: any, res: any) => Promise<void> | void {
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
