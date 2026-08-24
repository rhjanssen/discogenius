import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { selectVideoInVideoLibraries, seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-managed-artists-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.managed-artists.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let managedArtistsModule: typeof import("./managed-artists.js");

before(async () => {
  dbModule = await import("../../database.js");
  managedArtistsModule = await import("./managed-artists.js");

  dbModule.initDatabase();
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM LibraryAlbums").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getManagedArtistsDueForRefresh uses adaptive policy and keeps stalest artists first", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES
      ('mbid-1', 'Never Scanned'),
      ('mbid-2', 'Recently Scanned'),
      ('mbid-3', 'Stale Scan')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "mbid-1");
  seedLibraryArtistMonitoring(dbModule.db, "mbid-2");
  seedLibraryArtistMonitoring(dbModule.db, "mbid-3");

  const id2 = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'mbid-2'").get() as { id: number }).id;
  const id3 = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'mbid-3'").get() as { id: number }).id;
  dbModule.db.prepare(`
    UPDATE LibraryArtists
    SET metadata_last_checked_at = datetime('now', '-5 hours')
    WHERE artist_metadata_id = ?
  `).run(id2);
  dbModule.db.prepare(`
    UPDATE LibraryArtists
    SET metadata_last_checked_at = datetime('now', '-45 days')
    WHERE artist_metadata_id = ?
  `).run(id3);

  const dueArtists = managedArtistsModule.getManagedArtistsDueForRefresh();

  assert.deepEqual(
    dueArtists.map((artist) => String(artist.id)),
    ["mbid-1", "mbid-3"],
  );
});

test("managed artist listing follows LibraryArtists, not Artists.monitored", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES
      ('listed-mbid', 'Listed'),
      ('projection-only-mbid', 'Projection Only')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "listed-mbid", { monitored: true });
  seedLibraryArtistMonitoring(dbModule.db, "projection-only-mbid", { monitored: false });

  const managed = managedArtistsModule.getManagedArtists();
  assert.deepEqual(managed.map((artist) => String(artist.id)), ["listed-mbid"]);
  assert.equal(managed[0].monitor, 1);
});

test("default artist monitoring scope always includes stereo and gates optional media families", () => {
  dbModule.db.prepare("UPDATE Libraries SET enabled = 1 WHERE name IN ('Stereo', 'Spatial', 'Video')").run();

  assert.deepEqual(
    managedArtistsModule.listDefaultArtistMonitoringLibraries().map((library) => library.name),
    ["Stereo"],
  );
  assert.deepEqual(
    managedArtistsModule.listDefaultArtistMonitoringLibraries({
      includeSpatial: false,
      includeVideos: false,
    }).map((library) => library.name),
    ["Stereo"],
  );
  assert.deepEqual(
    managedArtistsModule.listDefaultArtistMonitoringLibraries({
      includeSpatial: true,
      includeVideos: false,
    }).map((library) => library.name),
    ["Stereo", "Spatial"],
  );
  assert.deepEqual(
    managedArtistsModule.listDefaultArtistMonitoringLibraries({
      includeSpatial: true,
      includeVideos: true,
    }).map((library) => library.name),
    ["Stereo", "Spatial", "Video"],
  );

  dbModule.db.prepare("UPDATE Libraries SET enabled = 0 WHERE name = 'Spatial'").run();
  assert.deepEqual(
    managedArtistsModule.listDefaultArtistMonitoringLibraries({
      includeSpatial: true,
      includeVideos: true,
    }).map((library) => library.name),
    ["Stereo", "Video"],
  );
});

test("artist completion predicate uses canonical locks instead of provider catalog locks", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES
      ('provider-locked-mbid', 'provider Locked'),
      ('slot-locked-mbid', 'Slot Locked'),
      ('video-locked-mbid', 'Video Locked')
  `).run();

  const releaseGroup = dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get("slot-rg-mbid", "slot-locked-mbid", "Slot Album", "album") as { id: number };
  const library = dbModule.db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'manual', 1, 'test', 1)
  `).run(library.id, releaseGroup.id);
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-locked-rec", "video-locked-mbid", "Locked Video");
  const videoId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = 'video-locked-rec'").get() as { id: number }).id;
  selectVideoInVideoLibraries(dbModule.db, videoId);

  const predicate = managedArtistsModule.buildArtistCompletionPredicate("a");
  assert.match(predicate, /LibraryAlbums/);
  assert.doesNotMatch(predicate, /ProviderAlbums/);
});
