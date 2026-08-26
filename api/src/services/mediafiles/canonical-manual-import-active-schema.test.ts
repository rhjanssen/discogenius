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
