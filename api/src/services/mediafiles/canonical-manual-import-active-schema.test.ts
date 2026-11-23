import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * This test runs against the ACTIVE baseline schema and prepares the writes the
 * canonical manual-import boundary performs, so a production column dependency
 * cannot disappear behind the aspirational domain-baseline fixture.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-active-schema-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { resolveManualImportArtistIdentity } = await import("./manual-import-service.js");

/** Columns the canonical manual import boundary writes on TrackFiles. */
const REQUIRED_TRACK_FILE_COLUMNS = [
  "library_id",
  "album_edition_id",
  "track_id",
  "recording_id",
  "file_class",
  "provider_item_id",
  "provider",
  "provider_entity_type",
  "provider_id",
  "source_audio_variant_id",
  "source_quality",
  "imported_quality",
  "verified_at",
];

test("the active TrackFiles schema carries every column canonical manual import writes", () => {
  const columns = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('TrackFiles')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const missing = REQUIRED_TRACK_FILE_COLUMNS.filter((column) => !columns.has(column));
  assert.deepEqual(missing, [], `active TrackFiles is missing: ${missing.join(", ")}`);
});

test("the boundary's TrackFiles update prepares against the active schema", () => {
  // Same shape as CanonicalManualImportService's updateImportedFile. Preparing it
  // is what catches a missing column — SQLite resolves names at prepare time.
  assert.doesNotThrow(() => {
    db.prepare(`
      UPDATE TrackFiles
      SET
        library_id = @libraryId,
        album_edition_id = @editionId,
        track_id = @trackId,
        recording_id = @recordingId,
        file_class = 'audio',
        provider_item_id = NULL,
        provider = NULL,
        provider_entity_type = NULL,
        provider_id = NULL,
        source_audio_variant_id = NULL,
        source_quality = COALESCE(source_quality, quality),
        imported_quality = COALESCE(imported_quality, quality),
        verified_at = CURRENT_TIMESTAMP
      WHERE id = @fileId
    `);
  });
});

test("manual import resolves a MusicBrainz artist UUID to the integer TrackFiles FK", () => {
  const artistMbid = "0fb267f4-2c7c-4717-85bf-06a849a4e655";
  const inserted = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Manual Import Artist')
    RETURNING id
  `).get(artistMbid) as { id: number };

  const identity = resolveManualImportArtistIdentity(artistMbid);
  assert.deepEqual(identity, {
    artistMetadataId: inserted.id,
    artistMbid,
  });

  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO TrackFiles (
        artist_metadata_id, canonical_artist_mbid, file_path, relative_path,
        library_root, filename, extension, file_type
      ) VALUES (?, ?, ?, ?, ?, ?, 'flac', 'track')
    `).run(
      identity!.artistMetadataId,
      identity!.artistMbid,
      "C:/library/manual-import.flac",
      "manual-import.flac",
      "C:/library",
      "manual-import.flac",
    );
  });

  const stored = db.prepare(`
    SELECT artist_metadata_id, canonical_artist_mbid
    FROM TrackFiles
    WHERE file_path = 'C:/library/manual-import.flac'
  `).get() as { artist_metadata_id: number; canonical_artist_mbid: string };
  assert.equal(stored.artist_metadata_id, inserted.id);
  assert.equal(stored.canonical_artist_mbid, artistMbid);
});

test("provider_item_id is a real FK to ProviderItems that survives item deletion", () => {
  db.prepare("INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('fk-artist', 'FK Artist')").run();
  const item = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', 'fk-track', 'FK Track', 'available')
    RETURNING id
  `).get() as { id: number };

  const file = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, provider, provider_entity_type, provider_id, provider_item_id,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'fk-artist'), 'tidal', 'track', 'fk-track', ?,
      'C:/library/fk.flac', 'fk.flac', 'C:/library', 'fk.flac', 'flac', 'track'
    )
    RETURNING id
  `).get(item.id) as { id: number };

  assert.equal(
    (db.prepare("SELECT provider_item_id FROM TrackFiles WHERE id = ?").get(file.id) as { provider_item_id: number | null }).provider_item_id,
    item.id,
    "the FK must actually be stored, not silently dropped",
  );

  // Losing the provider resource must not delete the user's file — the canonical
  // identity on the row is what owns it.
  db.prepare("DELETE FROM ProviderItems WHERE id = ?").run(item.id);
  const after = db.prepare("SELECT id, provider_item_id FROM TrackFiles WHERE id = ?").get(file.id) as
    { id: number; provider_item_id: number | null } | undefined;
  assert.ok(after, "the file row must survive its provider item being deleted");
  assert.equal(after?.provider_item_id, null, "the dangling FK is cleared, not left pointing at a dead row");
});

test("ManualImportService writes the filesystem root path instead of the 'music' key into TrackFiles.library_root (#172)", async () => {
  const { ManualImportService } = await import("./manual-import-service.js");
  const { Config } = await import("../config/config.js");

  const prevMusicPath = process.env.MUSIC_PATH;
  const musicRoot = path.join(tempDir, "stereo-music");
  process.env.MUSIC_PATH = musicRoot;
  try {
  assert.equal(Config.getMusicPath(), musicRoot);
  const trackPath = path.join(musicRoot, "Bastille", "Bad Blood", "01 - Pompeii.flac");
  fs.mkdirSync(path.dirname(trackPath), { recursive: true });
  fs.writeFileSync(trackPath, "not-a-real-flac");

  const artistMbid = "11111111-2222-3333-4444-555555555555";
  const rgMbid = "22222222-2222-3333-4444-555555555555";
  const releaseMbid = "33333333-2222-3333-4444-555555555555";
  const recordingMbid = "44444444-2222-3333-4444-555555555555";
  const trackMbid = "55555555-2222-3333-4444-555555555555";

  const artistId = (db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, 'Bastille') RETURNING id
  `).get(artistMbid) as { id: number }).id;
  const albumId = (db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type)
    VALUES (?, ?, ?, 'Bad Blood', 'Album') RETURNING id
  `).get(rgMbid, artistMbid, artistId) as { id: number }).id;
  const editionId = (db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, release_group_id, artist_mbid, artist_metadata_id, title)
    VALUES (?, ?, ?, ?, ?, 'Bad Blood') RETURNING id
  `).get(releaseMbid, rgMbid, albumId, artistMbid, artistId) as { id: number }).id;
  const recordingId = (db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title, is_video)
    VALUES (?, ?, ?, 'Pompeii', 0) RETURNING id
  `).get(recordingMbid, artistMbid, artistId) as { id: number }).id;
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, album_edition_id, recording_mbid, recording_id, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, 'Pompeii', 1, 1)
  `).run(trackMbid, releaseMbid, editionId, recordingMbid, recordingId);

  const unmappedId = Number(db.prepare(`
    INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension, file_size)
    VALUES (?, ?, 'music', '01 - Pompeii.flac', 'flac', 15)
  `).run(trackPath, path.join("Bastille", "Bad Blood", "01 - Pompeii.flac")).lastInsertRowid);

  const summary = await new ManualImportService().bulkImportUnmapped(
    [{ id: unmappedId, providerId: `mbid-${trackMbid}` }],
  );
  assert.equal(summary.imported, 1);

  const stored = db.prepare(`
    SELECT file_path, library_root, relative_path FROM TrackFiles WHERE canonical_track_mbid = ?
  `).get(trackMbid) as { file_path: string; library_root: string; relative_path: string } | undefined;
  assert.ok(stored);
  assert.equal(stored.library_root, musicRoot);
  assert.notEqual(stored.library_root, "music");
  assert.equal(stored.relative_path, path.relative(musicRoot, stored.file_path));
  } finally {
    if (prevMusicPath === undefined) delete process.env.MUSIC_PATH;
    else process.env.MUSIC_PATH = prevMusicPath;
  }
});

