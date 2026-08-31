import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  enableVideoLibraryForTests,
  selectVideoInVideoLibraries,
  seedLibraryArtistMonitoring,
} from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-monitoring-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let monitoringModule: typeof import("./artist-monitoring.js");
let refreshArtistModule: typeof import("./refresh-artist-service.js");
let curationModule: typeof import("./curation-service.js");

function assertRetiredProviderCatalogTablesAbsent() {
  const rows = dbModule.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ProviderAlbums', 'ProviderMedia', 'ProviderAlbumArtists', 'ProviderMediaArtists')
  `).all() as Array<{ name: string }>;
  assert.deepEqual(rows, []);
}

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  enableVideoLibraryForTests(dbModule.db);
  monitoringModule = await import("./artist-monitoring.js");
  refreshArtistModule = await import("./refresh-artist-service.js");
  curationModule = await import("./curation-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM LibraryEditionScopes").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM LibraryVideos").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM ArtistReleaseGroups").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("monitoring a named MusicBrainz search result hydrates display metadata before queuing intake", async () => {
  const artistMbid = "b53cab0a-f355-41eb-9bce-bf619b6d760e";
  const originalUpsert = refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist;
  refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist = (async (mbid: string, options = {}) => {
    assert.equal(mbid, artistMbid);
    assert.equal(options.monitorArtist, false);

    dbModule.db.prepare(`
      INSERT INTO ArtistMetadata (mbid, name, picture, cover_image_url, images)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      artistMbid,
      "Bastille",
      "https://example.invalid/bastille.jpg",
      "https://example.invalid/bastille-fanart.jpg",
      JSON.stringify([{ coverType: "Poster", url: "https://example.invalid/bastille.jpg" }]),
    );
    return artistMbid;
  }) as typeof refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist;

  let result: Awaited<ReturnType<typeof monitoringModule.monitorArtistAndQueueIntake>>;
  try {
    result = await monitoringModule.monitorArtistAndQueueIntake({
      artistId: artistMbid,
      artistName: "Bastille",
      priority: 1,
      trigger: 1,
    });
  } finally {
    refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist = originalUpsert;
  }

  const artist = dbModule.db.prepare(`
    SELECT id, name, mbid, picture, cover_image_url
    FROM ArtistMetadata
    WHERE mbid = ?
  `).get(artistMbid) as {
    id: number;
    name: string;
    mbid: string;
    picture: string;
    cover_image_url: string;
  };
  const job = dbModule.db.prepare(`
    SELECT name, ref_id, status
    FROM commands
    WHERE id = ?
  `).get(result.commandId) as { name: string; ref_id: string; status: string };

  assert.equal(artist.mbid, artistMbid);
  assert.equal(artist.name, "Bastille");
  assert.equal(artist.picture, "https://example.invalid/bastille.jpg");
  assert.equal(artist.cover_image_url, "https://example.invalid/bastille-fanart.jpg");
  assert.equal(result.artist?.effective_monitor, 1);
  assert.equal(job.name, "RefreshArtist");
  assert.equal(job.ref_id, artistMbid);
  assert.equal(job.status, "queued");
  const libraryArtists = dbModule.db.prepare(`
    SELECT library.name, library_artist.policy
    FROM LibraryArtists library_artist
    JOIN Libraries library ON library.id = library_artist.library_id
    JOIN ArtistMetadata canonical ON canonical.id = library_artist.artist_metadata_id
    WHERE canonical.mbid = ?
    ORDER BY library.id
  `).all(artistMbid) as Array<{ name: string; policy: string }>;
  assert.ok(libraryArtists.length > 0);
  assert.ok(libraryArtists.every((row) => row.policy === "all"));
});

test("provider-match curation does not manufacture monitoring for an unmonitored artist", async () => {
  const artistMbid = "11111111-2222-4333-8444-555555555555";
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Catalog Artist')
  `).run(artistMbid);

  await curationModule.CurationService.processAll(artistMbid);

  const libraryArtists = dbModule.db.prepare(`
    SELECT library_artist.policy
    FROM LibraryArtists library_artist
    JOIN ArtistMetadata canonical ON canonical.id = library_artist.artist_metadata_id
    WHERE canonical.mbid = ?
  `).all(artistMbid) as Array<{ policy: string }>;
  const monitoredAlbums = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM LibraryAlbums library_album
    JOIN Albums album ON album.id = library_album.release_group_id
    WHERE album.artist_mbid = ?
  `).get(artistMbid) as { count: number };

  assert.equal(libraryArtists.length, 0);
  assert.equal(monitoredAlbums.count, 0);
});

test("unmonitoring an artist clears unlocked library curation and videos", () => {
  const { db } = dbModule;
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "bc411157-431c-4f04-81e1-18e1c21d50ec";

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bastille");

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album");
  const canonicalArtistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(artistMbid) as { id: number }).id;
  const releaseGroupId = (db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { id: number }).id;
  const { artistMetadataId } = seedLibraryArtistMonitoring(db, artistMbid);
  assert.equal(artistMetadataId, canonicalArtistId);
  const stereoLibraryId = (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id;
  const libraryArtistId = (db.prepare(`
    SELECT id FROM LibraryArtists
    WHERE library_id = ? AND artist_metadata_id = ?
  `).get(stereoLibraryId, canonicalArtistId) as { id: number }).id;
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(stereoLibraryId, releaseGroupId);
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title)
    VALUES ('release-mbid-1', ?, ?, 'Give Me the Future')
  `).run(releaseGroupMbid, artistMbid);
  const editionId = (db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-1'").get() as { id: number }).id;
  const libraryEditionId = (db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
    RETURNING id
  `).get(stereoLibraryId, editionId) as { id: number }).id;
  db.prepare(`
    INSERT INTO LibraryEditionScopes (library_edition_id, library_artist_id, scope_type)
    VALUES (?, ?, 'primary')
  `).run(libraryEditionId, libraryArtistId);

  const videoRecordingId = (db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_mbid, title, is_video, metadata_status
    ) VALUES (?, ?, ?, 1, 'provider_only')
    RETURNING id
  `).get("video-recording-1", artistMbid, "Bastille Video") as { id: number }).id;
  selectVideoInVideoLibraries(db, videoRecordingId);

  const changes = monitoringModule.applyArtistMonitoringState(artistMbid, false);

  const membership = db.prepare(`
    SELECT COUNT(*) AS n FROM LibraryArtists WHERE artist_metadata_id = ?
  `).get(canonicalArtistId) as { n: number };
  const albumRow = db.prepare(`
    SELECT id FROM LibraryAlbums WHERE release_group_id = ?
  `).get(releaseGroupId) as { id: number } | undefined;
  const videoSelections = db.prepare(`
    SELECT COUNT(*) AS n FROM LibraryVideos WHERE video_recording_id = ?
  `).get(videoRecordingId) as { n: number };

  assert.equal(changes, 1);
  assert.equal(membership.n, 0);
  assert.equal(albumRow, undefined);
  assert.equal(videoSelections.n, 0);
  assertRetiredProviderCatalogTablesAbsent();
});

test("pause keeps LibraryArtists membership; unmonitor deletes it", () => {
  const { db } = dbModule;
  const artistMbid = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bakermat");
  const { artistMetadataId } = seedLibraryArtistMonitoring(db, artistMbid);

  const pause = monitoringModule.applyArtistPolicyState(artistMbid, "none");
  const pausedMembership = db.prepare(`
    SELECT policy, path, credited_scope
    FROM LibraryArtists
    WHERE artist_metadata_id = ?
  `).all(artistMetadataId) as Array<{ policy: string; path: string | null; credited_scope: string }>;

  assert.ok(pause > 0);
  assert.ok(pausedMembership.length > 0);
  assert.ok(pausedMembership.every((row) => row.policy === "none"));
  assert.equal(monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.effective_monitor, 1);
  assert.equal(monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.policy, "none");

  monitoringModule.applyArtistMonitoringState(artistMbid, false);
  const afterUnmonitor = db.prepare(`
    SELECT COUNT(*) AS n FROM LibraryArtists WHERE artist_metadata_id = ?
  `).get(artistMetadataId) as { n: number };
  assert.equal(afterUnmonitor.n, 0);
  assert.equal(monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.effective_monitor, 0);
  assert.equal(monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.policy, null);
});

test("artist monitoring and policy changes preserve independent library memberships", () => {
  const { db } = dbModule;
  const artistMbid = "c3d4e5f6-a7b8-4901-c234-56789abcdef0";
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Scoped Artist");

  const libraries = db.prepare(`
    SELECT id, name FROM Libraries
    WHERE enabled = 1
    ORDER BY id
    LIMIT 2
  `).all() as Array<{ id: number; name: string }>;
  assert.equal(libraries.length, 2, "the active schema fixture exposes two enabled libraries");
  const [first, second] = libraries;

  assert.equal(monitoringModule.applyArtistMonitoringState(artistMbid, true, [first.id]), 1);
  let memberships = monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.memberships ?? [];
  assert.deepEqual(memberships.map((membership) => membership.library_id), [first.id]);

  assert.equal(monitoringModule.applyArtistMonitoringState(artistMbid, true, [second.id]), 1);
  assert.equal(monitoringModule.applyArtistPolicyState(artistMbid, "none", [first.id]), 1);
  memberships = monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.memberships ?? [];
  assert.deepEqual(
    memberships.map((membership) => [membership.library_id, membership.policy]),
    [[first.id, "none"], [second.id, "all"]],
  );
  assert.equal(
    monitoringModule.loadArtistWithEffectiveMonitor(artistMbid)?.policy,
    null,
    "a singular policy must not invent one answer for mixed memberships",
  );

  assert.equal(monitoringModule.applyArtistMonitoringState(artistMbid, false, [first.id]), 1);
  const remaining = monitoringModule.loadArtistWithEffectiveMonitor(artistMbid);
  assert.equal(remaining?.effective_monitor, 1);
  assert.equal(remaining?.policy, "all");
  assert.deepEqual(remaining?.memberships.map((membership) => membership.library_id), [second.id]);
});

test("unmonitoring one artist preserves shared automatic album curation", () => {
  const { db } = dbModule;
  const firstArtist = "d4e5f6a7-b8c9-4012-d345-6789abcdef01";
  const secondArtist = "e5f6a7b8-c9d0-4123-e456-789abcdef012";
  const releaseGroupMbid = "f6a7b8c9-d0e1-4234-f567-89abcdef0123";
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?), (?, ?)")
    .run(firstArtist, "First Artist", secondArtist, "Second Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, 'Shared Album', 'Album')
  `).run(releaseGroupMbid, firstArtist);
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title)
    VALUES ('shared-edition', ?, ?, 'Shared Album')
  `).run(releaseGroupMbid, firstArtist);

  const libraryId = (db.prepare("SELECT id FROM Libraries WHERE enabled = 1 ORDER BY id LIMIT 1")
    .get() as { id: number }).id;
  monitoringModule.applyArtistMonitoringState(firstArtist, true, [libraryId]);
  monitoringModule.applyArtistMonitoringState(secondArtist, true, [libraryId]);
  const releaseGroupId = (db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { id: number }).id;
  const editionId = (db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'shared-edition'").get() as { id: number }).id;
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'shared-test', 1)
  `).run(libraryId, releaseGroupId);
  const libraryEditionId = Number((db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (?, ?, 'auto', 'shared-test', 1)
    RETURNING id
  `).get(libraryId, editionId) as { id: number }).id);
  const membershipIds = db.prepare(`
    SELECT id FROM LibraryArtists
    WHERE library_id = ?
      AND artist_metadata_id IN (SELECT id FROM ArtistMetadata WHERE mbid IN (?, ?))
    ORDER BY id
  `).all(libraryId, firstArtist, secondArtist) as Array<{ id: number }>;
  for (const membership of membershipIds) {
    db.prepare(`
      INSERT INTO LibraryEditionScopes (library_edition_id, library_artist_id, scope_type)
      VALUES (?, ?, 'release_credit')
    `).run(libraryEditionId, membership.id);
  }

  monitoringModule.applyArtistMonitoringState(firstArtist, false, [libraryId]);
  assert.ok(db.prepare("SELECT 1 FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?")
    .get(libraryId, releaseGroupId));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM LibraryEditionScopes WHERE library_edition_id = ?")
    .get(libraryEditionId) as { n: number }).n, 1);

  monitoringModule.applyArtistMonitoringState(secondArtist, false, [libraryId]);
  assert.equal(db.prepare("SELECT 1 FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?")
    .get(libraryId, releaseGroupId), undefined);
});

test("updateArtistLibraryState separates policy pause from unmonitor", async () => {
  const { db } = dbModule;
  const artistMbid = "b2c3d4e5-f6a7-4890-b123-456789abcdef";

  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bastille");
  seedLibraryArtistMonitoring(db, artistMbid);

  const conflict = await monitoringModule.updateArtistLibraryState({
    artistId: artistMbid,
    monitored: false,
    policy: "none",
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.status, 400);
  }

  const missingPolicy = await monitoringModule.updateArtistLibraryState({
    artistId: artistMbid,
    monitored: false,
  });
  assert.equal(missingPolicy.ok, true);
  if (missingPolicy.ok) {
    assert.equal(missingPolicy.monitored, false);
    assert.equal(missingPolicy.policy, null);
  }

  const noMembership = await monitoringModule.updateArtistLibraryState({
    artistId: artistMbid,
    policy: "all",
  });
  assert.equal(noMembership.ok, false);
  if (!noMembership.ok) {
    assert.equal(noMembership.status, 409);
  }

  const remonitor = await monitoringModule.updateArtistLibraryState({
    artistId: artistMbid,
    monitored: true,
    policy: "none",
  });
  assert.equal(remonitor.ok, true);
  if (remonitor.ok) {
    assert.equal(remonitor.monitored, true);
    assert.equal(remonitor.policy, "none");
  }

  const resume = await monitoringModule.updateArtistLibraryState({
    artistId: artistMbid,
    policy: "all",
  });
  assert.equal(resume.ok, true);
  if (resume.ok) {
    assert.equal(resume.monitored, true);
    assert.equal(resume.policy, "all");
  }

  const membership = db.prepare(`
    SELECT COUNT(*) AS n FROM LibraryArtists library_artist
    JOIN ArtistMetadata metadata ON metadata.id = library_artist.artist_metadata_id
    WHERE metadata.mbid = ?
  `).get(artistMbid) as { n: number };
  assert.ok(membership.n > 0);
});
