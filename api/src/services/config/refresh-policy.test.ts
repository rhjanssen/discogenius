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
  for (const table of [
    "ProviderItems",
    "Tracks",
    "Recordings",
    "AlbumEditions",
    "Albums",
    "LibraryArtists",
    "ArtistMetadata",
  ]) {
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
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
}

function seedAlbum(releaseGroupMbid: string, releaseMbid: string, date: string) {
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, "artist-mbid", "Canonical Album", "Album", date);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid", "Canonical Album Release", date);
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

  return (dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, updated_at
    ) VALUES (@provider, @entity_type, @provider_id, @title, @updated_at)
    RETURNING id
  `).get(row) as { id: number }).id;
}

test("artist release freshness reads canonical Albums without legacy provider rows", () => {
  seedArtist();
  seedAlbum("release-group-old", "release-old", dateDaysAgo(400));
  seedAlbum("release-group-recent", "release-recent", dateDaysAgo(10));

  assert.equal(
    refreshPolicyModule.getLatestArtistReleaseTimestamp("artist-mbid"),
    Date.parse(dateDaysAgo(10)),
  );
  assert.equal(refreshPolicyModule.hasRecentArtistRelease("artist-mbid"), true);
  assert.equal(refreshPolicyModule.hasRecentArtistRelease("artist-mbid"), true);
  assert.equal(
    refreshPolicyModule.shouldRefreshArtist({
      artistId: "artist-mbid",
      lastScanned: daysAgo(13),
      refreshDays: null,
    }),
    true,
  );
});

test("inactive artist policy uses canonical release group dates", () => {
  seedArtist();
  seedAlbum("release-group-old", "release-old", dateDaysAgo(365 * 6));

  assert.equal(refreshPolicyModule.hasInactiveArtistCatalog("artist-mbid"), true);
  assert.equal(
    refreshPolicyModule.shouldRefreshArtist({
      artistId: "artist-mbid",
      lastScanned: daysAgo(13),
      refreshDays: null,
    }),
    false,
  );
});

test("track-set refresh policy reads canonical ProviderItems without legacy media rows", () => {
  seedArtist();
  seedAlbum("release-group-mbid", "release-mbid", dateDaysAgo(120));
  const releaseItemId = insertProviderItem({
    entity_type: "release",
    provider_id: "provider-album",
    title: "Canonical Album",
  });
  const trackItemId = insertProviderItem({
    entity_type: "track",
    provider_id: "provider-track",
    track_mbid: "track-mbid",
    recording_mbid: "recording-mbid",
    title: "Canonical Track",
    updated_at: daysAgo(1),
  });
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(releaseItemId, trackItemId);

  assert.equal(refreshPolicyModule.shouldRefreshTrackSet({ albumId: "provider-album" }), false);

  dbModule.db.prepare("UPDATE ProviderItems SET updated_at = ? WHERE provider_id = ?")
    .run(daysAgo(70), "provider-track");
  assert.equal(refreshPolicyModule.shouldRefreshTrackSet({ albumId: "provider-album" }), true);
});

test("track-set refresh policy scopes equal album IDs to the requested provider", () => {
  seedArtist();
  seedAlbum("release-group-mbid", "release-mbid", dateDaysAgo(120));
  const tidalReleaseItemId = insertProviderItem({
    provider: "tidal",
    entity_type: "release",
    provider_id: "42",
    title: "Tidal album",
  });
  const tidalTrackItemId = insertProviderItem({
    provider: "tidal",
    entity_type: "track",
    provider_id: "tidal-track",
    updated_at: daysAgo(1),
  });
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(tidalReleaseItemId, tidalTrackItemId);
  insertProviderItem({
    provider: "apple-music",
    entity_type: "release",
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
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_mbid, artist_metadata_id, title, is_video, metadata_status
    ) VALUES (
      'video-recording-mbid',
      'artist-mbid',
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'),
      'Canonical Video',
      1,
      'musicbrainz'
    )
    RETURNING id
  `).get() as { id: number };
  const videoItemId = insertProviderItem({
    entity_type: "video",
    provider_id: "provider-video",
    release_group_mbid: null,
    release_mbid: null,
    recording_mbid: "video-recording-mbid",
    title: "Canonical Video",
    library_slot: "video",
    updated_at: daysAgo(1),
  });
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(videoItemId, recording.id);

  assert.equal(refreshPolicyModule.shouldRefreshVideos({ artistId: "artist-mbid" }), false);

  dbModule.db.prepare("UPDATE ProviderItems SET updated_at = ? WHERE provider_id = ?")
    .run(daysAgo(70), "provider-video");
  assert.equal(refreshPolicyModule.shouldRefreshVideos({ artistId: "artist-mbid" }), true);
});
