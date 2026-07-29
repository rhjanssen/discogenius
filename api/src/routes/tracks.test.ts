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
  db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryReleases").run();
  db.prepare("DELETE FROM LibraryReleaseGroups").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
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

function insertLibrarySelection(): { libraryId: number; libraryReleaseId: number } {
  const { db } = dbModule;
  const library = db.prepare("SELECT id FROM Libraries WHERE enabled = 1 ORDER BY id LIMIT 1")
    .get() as { id: number };
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-mbid'")
    .get() as { id: number };
  const release = db.prepare("SELECT id FROM AlbumReleases WHERE mbid = 'release-mbid'")
    .get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 1, 'manual', 0, 'route_test', 1)
  `).run(library.id, releaseGroup.id);
  const libraryRelease = db.prepare(`
    INSERT INTO LibraryReleases (
      library_id, release_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'manual', 0, 'route_test', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number };
  return { libraryId: library.id, libraryReleaseId: libraryRelease.id };
}

function insertTidalPlan(): { libraryId: number; trackId: number; recordingId: number; releaseGroupId: number; releaseId: number } {
  const { db } = dbModule;
  const selection = insertLibrarySelection();
  const release = db.prepare(`
    SELECT id, release_group_id FROM AlbumReleases WHERE mbid = 'release-mbid'
  `).get() as { id: number; release_group_id: number };
  const track = db.prepare(`
    SELECT id, recording_id FROM Tracks WHERE mbid = 'track-mbid'
  `).get() as { id: number; recording_id: number };
  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', 'tidal-album', 'Track Album')
    RETURNING id
  `).get() as { id: number };
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, popularity
    ) VALUES ('tidal', 'track', 'tidal-track', 'Canonical Track', 90)
    RETURNING id
  `).get() as { id: number };
  const member = db.prepare(`
    INSERT INTO ProviderReleaseMembers (
      provider_release_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderReleaseMatches (
      provider_release_item_id, release_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, release.id) as { id: number };
  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_release_member_id, provider_release_match_id, track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(member.id, releaseMatch.id, track.id, track.recording_id) as { id: number };
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'hires-lossless', 'hires-lossless', 'HIRES_LOSSLESS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };
  const plan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_release_id, provider, composition, download_mode, state,
      planner_version, policy_hash, computed_at
    ) VALUES (?, 'tidal', 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
    RETURNING id
  `).get(selection.libraryReleaseId) as { id: number };
  const source = db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_release_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.id) as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id, source_quality_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(plan.id, track.id, source.id, trackMatch.id, variant.id, JSON.stringify({ quality: "HIRES_LOSSLESS" }));
  return {
    libraryId: selection.libraryId,
    trackId: track.id,
    recordingId: track.recording_id,
    releaseGroupId: release.release_group_id,
    releaseId: release.id,
  };
}

test("POST track monitor creates normalized library release-group selections", async () => {
  insertCanonicalTrackFixture();

  const res = createMockResponse();
  await getRouteHandler("/", "post")({ body: { id: "track-mbid" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  const selections = dbModule.db.prepare(`
    SELECT lrg.monitored AS wanted, lrg.selection_mode, lrg.reason
    FROM LibraryReleaseGroups lrg
    JOIN Albums a ON a.id = lrg.release_group_id
    WHERE a.mbid = 'rg-mbid'
    ORDER BY lrg.library_id
  `).all() as Array<{ wanted: number; selection_mode: string; reason: string }>;
  assert.ok(selections.length > 0);
  assert.ok(selections.every((selection) => selection.wanted === 1));
  assert.ok(selections.every((selection) => selection.selection_mode === "manual"));
  assert.ok(selections.every((selection) => selection.reason === "track_monitor_action"));

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

test("PATCH track updates normalized library release-group wanted state", () => {
  insertCanonicalTrackFixture();
  dbModule.db.prepare(`
    INSERT INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
    )
    SELECT id, (SELECT id FROM Albums WHERE mbid = 'rg-mbid'), 1, 'manual', 0, 'test', 1
    FROM Libraries
    WHERE enabled = 1
  `).run();

  const res = createMockResponse();
  getRouteHandler("/:trackId", "patch")({
    params: { trackId: "track-mbid" },
    body: { monitored: false, monitored_lock: true },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const selections = dbModule.db.prepare(`
    SELECT monitored AS wanted
    FROM LibraryReleaseGroups
    WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'rg-mbid')
  `).all() as Array<{ wanted: number }>;
  assert.ok(selections.length > 0);
  assert.ok(selections.every((selection) => selection.wanted === 0));
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
  const selection = insertLibrarySelection();
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
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id, album_release_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, file_class
    )
    SELECT
      'artist-id', ?, release.release_group_id, release.id, track.id, track.recording_id,
      '/music/' || track.mbid || '.flac', track.mbid || '.flac', '/music',
      track.mbid || '.flac', '.flac', 'track', 'audio'
    FROM Tracks track
    JOIN AlbumReleases release ON release.id = track.album_release_id
    WHERE track.mbid IN ('track-low', 'track-high')
  `).run(selection.libraryId);

  const res = createMockResponse();
  getRouteHandler("/", "get")({
    query: { sort: "popularity", dir: "desc", limit: "10", offset: "0" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.items.map((track: { id: string }) => track.id),
    ["track-high", "track-low"],
  );
  assert.equal(res.body.items[0].popularity, 80);
});

test("GET tracks filters selected offers and keeps remote quality separate from local files", () => {
  insertCanonicalTrackFixture();
  const { db } = dbModule;
  const plan = insertTidalPlan();
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id, album_release_id, track_id, recording_id,
      provider, provider_entity_type, provider_id, file_path,
      relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (
      'artist-id', ?, ?, ?, ?, ?, 'tidal', 'track', 'tidal-track',
      '/music/Canonical Track.flac', 'Canonical Track.flac', '/music',
      'Canonical Track.flac', '.flac', 'track', 'LOSSLESS'
    )
  `).run(plan.libraryId, plan.releaseGroupId, plan.releaseId, plan.trackId, plan.recordingId);

  const selected = createMockResponse();
  getRouteHandler("/", "get")({
    query: { provider: "tidal", quality_tier: "MAX", limit: "10", offset: "0" },
  }, selected);

  assert.equal(selected.statusCode, 200);
  assert.equal(selected.body.total, 1);
  assert.deepEqual(selected.body.items[0].qualityTags, ["HIRES_LOSSLESS", "LOSSLESS"]);
  assert.deepEqual(selected.body.items[0].remoteOffers, [{
    slot: "stereo",
    provider: "tidal",
    providerAlbumId: "tidal-album",
    quality: "HIRES_LOSSLESS",
    matchStatus: "accepted",
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
