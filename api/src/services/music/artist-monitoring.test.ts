import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-monitoring-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let monitoringModule: typeof import("./artist-monitoring.js");
let refreshArtistModule: typeof import("./refresh-artist-service.js");

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
  monitoringModule = await import("./artist-monitoring.js");
  refreshArtistModule = await import("./refresh-artist-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM ArtistReleaseGroups").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
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
      INSERT INTO ArtistMetadata (mbid, name, images)
      VALUES (?, ?, ?)
    `).run(
      artistMbid,
      "Bastille",
      JSON.stringify([{ coverType: "Poster", url: "https://example.invalid/bastille.jpg" }]),
    );
    dbModule.db.prepare(`
      INSERT INTO Artists (
        id, name, mbid, picture, cover_image_url, musicbrainz_status,
        musicbrainz_match_method, monitored
      )
      VALUES (?, ?, ?, ?, ?, 'verified', 'musicbrainz-metadata', 0)
    `).run(
      artistMbid,
      "Bastille",
      artistMbid,
      "https://example.invalid/bastille.jpg",
      "https://example.invalid/bastille-fanart.jpg",
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
    SELECT id, name, mbid, picture, cover_image_url, monitored AS monitor, musicbrainz_status
    FROM Artists
    WHERE id = ?
  `).get(artistMbid) as {
    id: string;
    name: string;
    mbid: string;
    picture: string;
    cover_image_url: string;
    monitor: number;
    musicbrainz_status: string;
  };
  const job = dbModule.db.prepare(`
    SELECT name, ref_id, status
    FROM commands
    WHERE id = ?
  `).get(result.commandId) as { name: string; ref_id: string; status: string };

  assert.equal(artist.id, artistMbid);
  assert.equal(artist.name, "Bastille");
  assert.equal(artist.mbid, artistMbid);
  assert.equal(artist.picture, "https://example.invalid/bastille.jpg");
  assert.equal(artist.cover_image_url, "https://example.invalid/bastille-fanart.jpg");
  assert.equal(artist.monitor, 1);
  assert.equal(artist.musicbrainz_status, "verified");
  assert.equal(job.name, "RefreshArtist");
  assert.equal(job.ref_id, artistMbid);
  assert.equal(job.status, "queued");
});

test("unmonitoring an artist clears unlocked library curation and videos", () => {
  const { db } = dbModule;
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "bc411157-431c-4f04-81e1-18e1c21d50ec";

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run(artistMbid, "Bastille");

  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored, monitored_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
  `).run(artistMbid, artistMbid, "Bastille");

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album");
  const canonicalArtistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(artistMbid) as { id: number }).id;
  const releaseGroupId = (db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { id: number }).id;
  const managedArtistId = (db.prepare(`
    INSERT INTO ManagedArtists (artist_id) VALUES (?) RETURNING id
  `).get(canonicalArtistId) as { id: number }).id;
  const stereoLibraryId = (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id;
  const libraryArtistId = (db.prepare(`
    INSERT INTO LibraryArtists (library_id, managed_artist_id, monitored, credited_scope)
    VALUES (?, ?, 1, 'release_and_track_credit')
    RETURNING id
  `).get(stereoLibraryId, managedArtistId) as { id: number }).id;
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
  `).run(stereoLibraryId, releaseGroupId);
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title)
    VALUES ('release-mbid-1', ?, ?, 'Give Me the Future')
  `).run(releaseGroupMbid, artistMbid);
  const editionId = (db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-1'").get() as { id: number }).id;
  const libraryEditionId = (db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
    RETURNING id
  `).get(stereoLibraryId, editionId) as { id: number }).id;
  db.prepare(`
    INSERT INTO LibraryEditionScopes (library_edition_id, library_artist_id, scope_type)
    VALUES (?, ?, 'primary')
  `).run(libraryEditionId, libraryArtistId);

  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status, monitored)
    VALUES (?, ?, ?, 1, 'provider_only', 1)
  `).run("video-recording-1", artistMbid, "Bastille Video");

const changes = monitoringModule.applyArtistMonitoringState(artistMbid, false);

  const artist = db.prepare("SELECT monitored FROM Artists WHERE id = ?").get(artistMbid) as { monitored: number };
  const libraryState = db.prepare(`
    SELECT release_group.monitored, artist.monitored AS artist_monitored
    FROM LibraryAlbums release_group
    JOIN LibraryArtists artist ON artist.library_id = release_group.library_id
    WHERE release_group.release_group_id = ? AND artist.managed_artist_id = ?
  `).get(releaseGroupId, managedArtistId) as { monitored: number; artist_monitored: number };
  const recording = db.prepare("SELECT monitored FROM Recordings WHERE mbid = ?").get("video-recording-1") as { monitored: number };

  assert.equal(changes, 1);
  assert.equal(artist.monitored, 0);
  assert.equal(libraryState.monitored, 0);
  assert.equal(libraryState.artist_monitored, 0);
  assert.equal(recording.monitored, 0);
  assertRetiredProviderCatalogTablesAbsent();
});
