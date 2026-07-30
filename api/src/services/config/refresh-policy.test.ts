import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-policy-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.refresh-policy.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshPolicyModule: typeof import("./refresh-policy.js");

before(async () => {
  dbModule = await import("../../database.js");
  refreshPolicyModule = await import("./refresh-policy.js");
  dbModule.initDatabase();
});

beforeEach(() => {
  for (const table of ["ProviderItems", "AlbumEditions", "Albums", "ArtistMetadata", "Artists"]) {
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

function dateDaysAgo(days: number): string {
  return daysAgo(days).slice(0, 10);
}

function seedArtist() {
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
}

function seedAlbum(releaseGroupMbid: string, editionMbid: string, date: string) {
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, "artist-mbid", "Canonical Album", "Album", date);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date)
    VALUES (?, ?, ?, ?, ?)
  `).run(editionMbid, releaseGroupMbid, "artist-mbid", "Canonical Album Release", date);
}

function insertProviderItem(overrides: Partial<Record<string, unknown>>) {
  const row = {
    provider: "tidal",
    entity_type: "track",
    provider_id: "provider-track",
    artist_mbid: "artist-mbid",
    release_group_mbid: "release-group-mbid",
    edition_mbid: "release-mbid",
    track_mbid: null,
    recording_mbid: null,
    title: "Canonical Track",
    library_slot: "stereo",
    updated_at: daysAgo(1),
    ...overrides,
  };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, updated_at
    ) VALUES (@provider, @entity_type, @provider_id, @title, @updated_at)
  `).run(row);
}

test("artist release freshness reads canonical Albums without legacy provider rows", () => {
  seedArtist();
  seedAlbum("release-group-old", "release-old", dateDaysAgo(400));
  seedAlbum("release-group-recent", "release-recent", dateDaysAgo(10));

  assert.equal(
    refreshPolicyModule.getLatestArtistReleaseTimestamp("artist-local"),
    Date.parse(dateDaysAgo(10)),
  );
  assert.equal(refreshPolicyModule.hasRecentArtistRelease("artist-local"), true);
  assert.equal(refreshPolicyModule.hasRecentArtistRelease("artist-mbid"), true);
  assert.equal(
    refreshPolicyModule.shouldRefreshArtist({
      artistId: "artist-local",
      lastScanned: daysAgo(13),
      refreshDays: null,
    }),
    true,
  );
});

test("inactive artist policy uses canonical release group dates", () => {
  seedArtist();
  seedAlbum("release-group-old", "release-old", dateDaysAgo(365 * 6));

  assert.equal(refreshPolicyModule.hasInactiveArtistCatalog("artist-local"), true);
  assert.equal(
    refreshPolicyModule.shouldRefreshArtist({
      artistId: "artist-local",
      lastScanned: daysAgo(13),
      refreshDays: null,
    }),
    false,
  );
});

test("track-set refresh policy reads canonical ProviderItems without legacy media rows", () => {
  seedArtist();
  seedAlbum("release-group-mbid", "release-mbid", dateDaysAgo(120));
  insertProviderItem({
    entity_type: "album",
    provider_id: "provider-album",
    title: "Canonical Album",
  });
  insertProviderItem({
    entity_type: "track",
    provider_id: "provider-track",
    track_mbid: "track-mbid",
    recording_mbid: "recording-mbid",
    title: "Canonical Track",
    updated_at: daysAgo(1),
  });

  assert.equal(refreshPolicyModule.shouldRefreshTrackSet({ albumId: "provider-album" }), false);

  dbModule.db.prepare("UPDATE ProviderItems SET updated_at = ? WHERE provider_id = ?")
    .run(daysAgo(70), "provider-track");
  assert.equal(refreshPolicyModule.shouldRefreshTrackSet({ albumId: "provider-album" }), true);
});

test("track-set refresh policy scopes equal album IDs to the requested provider", () => {
  seedArtist();
  seedAlbum("release-group-mbid", "release-mbid", dateDaysAgo(120));
  insertProviderItem({
    provider: "tidal",
    entity_type: "album",
    provider_id: "42",
    title: "Tidal album",
  });
  insertProviderItem({
    provider: "tidal",
    entity_type: "track",
    provider_id: "tidal-track",
    updated_at: daysAgo(1),
  });
  insertProviderItem({
    provider: "apple-music",
    entity_type: "album",
    provider_id: "42",
    title: "Apple album",
  });

  assert.equal(
    refreshPolicyModule.shouldRefreshTrackSet({ albumId: "42", provider: "tidal" }),
    false,
  );
  assert.equal(
    refreshPolicyModule.shouldRefreshTrackSet({ albumId: "42", provider: "apple-music" }),
    true,
  );
});

test("video refresh policy reads canonical ProviderItems for the artist", () => {
  seedArtist();
  insertProviderItem({
    entity_type: "video",
    provider_id: "provider-video",
    release_group_mbid: null,
    edition_mbid: null,
    recording_mbid: "video-recording-mbid",
    title: "Canonical Video",
    library_slot: "video",
    updated_at: daysAgo(1),
  });

  assert.equal(refreshPolicyModule.shouldRefreshVideos({ artistId: "artist-local" }), false);

  dbModule.db.prepare("UPDATE ProviderItems SET updated_at = ? WHERE provider_id = ?")
    .run(daysAgo(70), "provider-video");
  assert.equal(refreshPolicyModule.shouldRefreshVideos({ artistId: "artist-local" }), true);
});
