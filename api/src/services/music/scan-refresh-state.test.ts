import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-scan-refresh-state-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.scan-refresh-state.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let scanRefreshStateModule: typeof import("./scan-refresh-state.js");

before(async () => {
  dbModule = await import("../../database.js");
  scanRefreshStateModule = await import("./scan-refresh-state.js");
  dbModule.initDatabase();
});

beforeEach(() => {
  for (const table of ["ProviderItems", "ArtistMetadata", "Artists"]) {
    dbModule.db.prepare(`DELETE FROM ${table}`).run();
  }
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedArtist() {
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
}

function insertProviderItem(overrides: Partial<Record<string, unknown>>) {
  const row = {
    provider: "tidal",
    entity_type: "track",
    provider_id: "provider-track",
    artist_mbid: "artist-mbid",
    release_group_mbid: "release-group-mbid",
    release_mbid: "release-mbid",
    track_mbid: null,
    recording_mbid: null,
    title: "Canonical Track",
    library_slot: "stereo",
    updated_at: daysAgo(1),
    ...overrides,
  };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, library_slot, updated_at
    ) VALUES (
      @provider, @entity_type, @provider_id, @artist_mbid, @release_group_mbid,
      @release_mbid, @track_mbid, @recording_mbid, @title, @library_slot, @updated_at
    )
  `).run(row);
}

test("track refresh state uses canonical ProviderItems and ignores absent legacy provider rows", () => {
  seedArtist();
  const recentScan = daysAgo(1);
  insertProviderItem({
    entity_type: "album",
    provider_id: "provider-album",
    title: "Canonical Album",
    updated_at: recentScan,
  });
  insertProviderItem({
    entity_type: "track",
    provider_id: "provider-track",
    track_mbid: "track-mbid",
    recording_mbid: "recording-mbid",
    title: "Canonical Track",
    updated_at: recentScan,
  });

  assert.equal(scanRefreshStateModule.shouldRefreshTracks("provider-album", 30), false);
  assert.deepEqual(scanRefreshStateModule.getTrackRefreshState("provider-album", 30), {
    shouldRefresh: false,
    missingTracks: false,
    oldestScanTime: new Date(recentScan).getTime(),
  });
});

test("track refresh state treats missing or stale provider track items as refresh due", () => {
  seedArtist();
  insertProviderItem({
    entity_type: "album",
    provider_id: "provider-album",
    title: "Canonical Album",
    updated_at: daysAgo(1),
  });

  assert.equal(scanRefreshStateModule.shouldRefreshTracks("provider-album", 30), true);

  insertProviderItem({
    entity_type: "track",
    provider_id: "provider-track",
    title: "Canonical Track",
    updated_at: daysAgo(40),
  });

  assert.equal(scanRefreshStateModule.shouldRefreshTracks("provider-album", 30), true);
  const state = scanRefreshStateModule.getTrackRefreshState("provider-album", 30);
  assert.equal(state.shouldRefresh, true);
  assert.equal(state.missingTracks, false);
});

test("video refresh state uses canonical ProviderItems for the artist", () => {
  seedArtist();
  insertProviderItem({
    entity_type: "video",
    provider_id: "provider-video",
    release_group_mbid: null,
    release_mbid: null,
    recording_mbid: "video-recording-mbid",
    title: "Canonical Video",
    library_slot: "video",
    updated_at: daysAgo(1),
  });

  assert.equal(scanRefreshStateModule.shouldRefreshVideos("artist-local", 30), false);

  dbModule.db.prepare("UPDATE ProviderItems SET updated_at = ? WHERE provider_id = ?")
    .run(daysAgo(40), "provider-video");
  assert.equal(scanRefreshStateModule.shouldRefreshVideos("artist-local", 30), true);
});
