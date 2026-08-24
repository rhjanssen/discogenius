import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-rebind-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let libraryFilesModule: typeof import("./library-files.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  libraryFilesModule = await import("./library-files.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM Libraries").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  seedTestLibrary(db, { name: "Rebind Stereo", rootPath: path.join(tempDir, "stereo") });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("rebind moves a scan-imported file from an unmonitored sibling onto the selected edition", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-bbx", "artist-mbid", "Bad Blood");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 33)
  `).run("rel-bbx-selected", "rg-bbx", "artist-mbid", "Bad Blood X");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 33)
  `).run("rel-bbx-sibling", "rg-bbx", "artist-mbid", "Bad Blood X");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-mmxxiii", "Pompeii MMXXIII", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("t-mmxxiii-selected", "rel-bbx-selected", "rec-mmxxiii", "Pompeii MMXXIII");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 2, 1)
  `).run("t-mmxxiii-sibling", "rel-bbx-sibling", "rec-mmxxiii", "Pompeii MMXXIII");
  db.prepare(`
    UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bbx'").get() as { id: number };
  const selectedEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-bbx-selected'")
    .get() as { id: number };
  const siblingEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-bbx-sibling'")
    .get() as { id: number };
  const selectedTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-mmxxiii-selected'")
    .get() as { id: number };
  const siblingTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-mmxxiii-sibling'")
    .get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };

  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(library.id, selectedEdition.id);

  const filePath = path.join(tempDir, "stereo", "Bastille", "Bad Blood X (2023)", "101 - Pompeii MMXXIII.m4a");
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, 'Bastille/Bad Blood X/101 - Pompeii MMXXIII.m4a', '101 - Pompeii MMXXIII.m4a', 'm4a',
      'rg-bbx', 'rel-bbx-sibling', 't-mmxxiii-sibling', 'rec-mmxxiii'
    )
  `).run(library.id, siblingEdition.id, siblingTrack.id, path.join(tempDir, "stereo"), filePath);

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 1);

  const rebound = db.prepare(`
    SELECT album_edition_id, track_id, canonical_release_mbid, canonical_track_mbid
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as {
    album_edition_id: number;
    track_id: number;
    canonical_release_mbid: string;
    canonical_track_mbid: string;
  };
  assert.equal(rebound.album_edition_id, selectedEdition.id);
  assert.equal(rebound.track_id, selectedTrack.id);
  assert.equal(rebound.canonical_release_mbid, "rel-bbx-selected");
  assert.equal(rebound.canonical_track_mbid, "t-mmxxiii-selected");
});
