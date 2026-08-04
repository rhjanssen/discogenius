import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("album-track-list-nav");

const { AlbumTrackListNavigationService } = await import("./album-track-list-navigation-service.js");
const { MusicBrainzReleaseGroupReadService } = await import("../metadata/musicbrainz-release-group-read-service.js");
const { LibraryReleaseSelectionService } = await import("./library-release-selection-service.js");

const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

function seedEditionsFixture() {
  resetActiveSchemaRows(db, [
    "ArtistMetadata",
    "Albums",
    "AlbumEditions",
    "Tracks",
    "Recordings",
    "Libraries",
    "LibraryAlbums",
    "LibraryEditions",
  ]);

  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-1', 'Test Artist');
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type) VALUES (1, 'rg-nav-test', 1, 'artist-1', 'Navigation Album', 'Album');

    UPDATE quality_profiles SET allowed_source_formats = '["lossless"]' WHERE id = 1;

    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
    VALUES (1, 'Main Library', '/music', 1, 1, 1),
           (2, 'Second Library', '/music2', 1, 1, 1),
           (3, 'Disabled Library', '/music3', 1, 1, 0);

    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (1, 1, 'manual', 0, 'test', 1), (2, 1, 'manual', 0, 'test', 1);

    -- Standard Edition (id: 10)
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, country, media, track_count)
    VALUES (10, 'rel-std', 1, 'rg-nav-test', 'artist-1', 'Standard Edition', 'US', '["CD"]', 2);

    -- Deluxe Edition (id: 20) with extra track
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, country, media, track_count)
    VALUES (20, 'rel-deluxe', 1, 'rg-nav-test', 'artist-1', 'Deluxe Edition', 'US', '["CD"]', 3);

    -- Unmonitored Edition (id: 30)
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, country, media, track_count)
    VALUES (30, 'rel-unmon', 1, 'rg-nav-test', 'artist-1', 'Unmonitored Edition', 'JP', '["CD"]', 5);

    INSERT INTO Recordings (id, mbid, title, artist_mbid, length_ms)
    VALUES (101, 'rec-101', 'Track 1', 'artist-1', 180000),
           (102, 'rec-102', 'Track 2', 'artist-1', 180000),
           (103, 'rec-103', 'Track 3', 'artist-1', 180000),
           (104, 'rec-104', 'Track 4', 'artist-1', 180000),
           (105, 'rec-105', 'Track 5', 'artist-1', 180000);

    -- Tracks for Standard (recordings 101, 102)
    INSERT INTO Tracks (id, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (1001, 10, 'rel-std', 101, 'rec-101', 1, 1, 'Track 1'), (1002, 10, 'rel-std', 102, 'rec-102', 1, 2, 'Track 2');

    -- Tracks for Deluxe (recordings 101, 102, 103)
    INSERT INTO Tracks (id, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (2001, 20, 'rel-deluxe', 101, 'rec-101', 1, 1, 'Track 1'), (2002, 20, 'rel-deluxe', 102, 'rec-102', 1, 2, 'Track 2'), (2003, 20, 'rel-deluxe', 103, 'rec-103', 1, 3, 'Track 3');

    -- Tracks for Unmonitored (recordings 101..105)
    INSERT INTO Tracks (id, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (3001, 30, 'rel-unmon', 101, 'rec-101', 1, 1, 'Track 1'), (3002, 30, 'rel-unmon', 102, 'rec-102', 1, 2, 'Track 2'), (3003, 30, 'rel-unmon', 103, 'rec-103', 1, 3, 'Track 3'), (3004, 30, 'rel-unmon', 104, 'rec-104', 1, 4, 'Track 4'), (3005, 30, 'rel-unmon', 105, 'rec-105', 1, 5, 'Track 5');
  `);
}

test("unmonitored edition and disabled library edition are excluded from navigation tabs", () => {
  seedEditionsFixture();
  // Monitor edition 10 in disabled library 3 only
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (3, 10, 'auto', 1, 'test', 1)
  `).run();

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 0, "Disabled library monitored edition does not produce tabs");
});

test("monitored edition in enabled library produces tab, unmonitored is excluded", () => {
  seedEditionsFixture();
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 10, 'auto', 1, 'test', 1)
  `).run();

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 1);
  assert.equal(navInfo.tabs[0].editionId, 10);
  assert.equal(navInfo.tabs[0].default, true);
});

test("same edition monitored in two enabled libraries appears once", () => {
  seedEditionsFixture();
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 10, 'auto', 1, 'test', 1), (2, 10, 'auto', 0, 'test', 1)
  `).run();

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 1);
  assert.equal(navInfo.tabs[0].editionId, 10);
  assert.equal(navInfo.tabs[0].default, true);
});

test("strict subset edition collapses onto superset deluxe edition", () => {
  seedEditionsFixture();
  // Standard (10) is a strict subset of Deluxe (20).
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 10, 'auto', 0, 'test', 1), (1, 20, 'auto', 1, 'test', 1)
  `).run();

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 1, "Subset collapses onto superset");
  assert.equal(navInfo.tabs[0].editionId, 20);
  assert.equal(navInfo.tabs[0].default, true);
});

test("partial overlap editions produce separate tabs with exactly one default tab", () => {
  seedEditionsFixture();
  // Edition 40 has recordings 101 and 104 (partial overlap with Deluxe 20: 101, 102, 103)
  db.exec(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, country, media, track_count)
    VALUES (40, 'rel-partial', 1, 'rg-nav-test', 'artist-1', 'Live Edition', 'US', '["Vinyl"]', 2);
    INSERT INTO Tracks (id, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (4001, 40, 'rel-partial', 101, 'rec-101', 1, 1, 'Track 1'), (4002, 40, 'rel-partial', 104, 'rec-104', 1, 2, 'Track 4');
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 20, 'auto', 1, 'test', 1), (1, 40, 'auto', 0, 'test', 1);
  `);

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 2);
  assert.equal(navInfo.tabs.filter((t) => t.default).length, 1);
  const defaultTab = navInfo.tabs.find((t) => t.default);
  assert.equal(defaultTab?.editionId, 20, "Persisted representative becomes default tab");
});

test("/page owns navigation tabs and availability carries none", async () => {
  seedEditionsFixture();
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 20, 'auto', 1, 'test', 1)
  `).run();

  const page = await MusicBrainzReleaseGroupReadService.getPage("rg-nav-test");
  const avail = new LibraryReleaseSelectionService(db).getAvailability("rg-nav-test");

  assert.ok(page);
  assert.deepEqual(page.trackListTabs?.map((tab) => tab.editionId), [20]);
  assert.equal(page.initialTrackListEditionId, 20);
  // Availability enriches the page; it must not be a second source of truth for
  // which track lists exist, or a slow/failed enrichment call can hide an
  // Edition the Library actually monitors.
  for (const library of avail.libraries) {
    assert.equal(
      "trackListTabs" in library,
      false,
      "availability libraries must not carry track-list tabs",
    );
  }
});

test("initial tracks belong to the default tab's edition", async () => {
  seedEditionsFixture();
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 10, 'auto', 0, 'test', 1), (1, 20, 'auto', 1, 'test', 1)
  `).run();

  const page = await MusicBrainzReleaseGroupReadService.getPage("rg-nav-test");
  assert.ok(page);
  const defaultTabs = page.trackListTabs?.filter((tab) => tab.default) ?? [];
  assert.equal(defaultTabs.length, 1);
  assert.equal(defaultTabs[0].editionId, page.initialTrackListEditionId);

  const editionTracks = await MusicBrainzReleaseGroupReadService.getEditionTracks(
    "rg-nav-test",
    page.initialTrackListEditionId!,
  );
  assert.deepEqual(
    page.tracks.map((track) => track.musicbrainz_track_id),
    editionTracks.map((track) => track.musicbrainz_track_id),
  );
});

test("tab resolution is stable across LibraryEditions insertion order", () => {
  const tabsFor = (insertions: string[]) => {
    seedEditionsFixture();
    db.exec(`
      INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, country, media, track_count)
      VALUES (40, 'rel-partial', 1, 'rg-nav-test', 'artist-1', 'Live Edition', 'US', '["Vinyl"]', 2);
      INSERT INTO Tracks (id, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
      VALUES (4001, 40, 'rel-partial', 101, 'rec-101', 1, 1, 'Track 1'), (4002, 40, 'rel-partial', 104, 'rec-104', 1, 2, 'Track 4');
    `);
    for (const insertion of insertions) db.exec(insertion);
    const navInfo = new AlbumTrackListNavigationService(db).getNavigationInfo("rg-nav-test");
    return {
      editionIds: navInfo.tabs.map((tab) => tab.editionId).sort((a, b) => a - b),
      initial: navInfo.initialTrackListEditionId,
    };
  };

  const deluxeFirst = tabsFor([
    "INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version) VALUES (1, 20, 'auto', 1, 'test', 1)",
    "INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version) VALUES (1, 40, 'auto', 0, 'test', 1)",
  ]);
  const liveFirst = tabsFor([
    "INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version) VALUES (1, 40, 'auto', 0, 'test', 1)",
    "INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version) VALUES (1, 20, 'auto', 1, 'test', 1)",
  ]);

  assert.deepEqual(deluxeFirst, liveFirst);
  assert.deepEqual(deluxeFirst.editionIds, [20, 40]);
  assert.equal(deluxeFirst.initial, 20);
});

test("media formats stored as object arrays are parsed correctly in navigation tabs", () => {
  seedEditionsFixture();
  db.prepare(`
    UPDATE AlbumEditions
    SET media = '[{"Format": "Digital Media"}]'
    WHERE id = 10
  `).run();

  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (1, 10, 'auto', 1, 'test', 1)
  `).run();

  const service = new AlbumTrackListNavigationService(db);
  const navInfo = service.getNavigationInfo("rg-nav-test");
  assert.equal(navInfo.tabs.length, 1);
  assert.deepEqual(navInfo.tabs[0].mediaFormats, ["Digital Media"]);
});
