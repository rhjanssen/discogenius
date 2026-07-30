import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * canonical-manual-import-service.test.ts builds its fixture from
 * `domain-v41.ts` — the ASPIRATIONAL schema, which is not what production runs.
 * That blind spot let the boundary ship an UPDATE writing
 * TrackFiles.provider_item_id while the active baseline had no such column, so
 * every canonical manual import would have thrown "no such column" at runtime
 * with a fully green suite.
 *
 * This test runs against the ACTIVE baseline schema and prepares the writes the
 * boundary performs, so a column the production writers depend on cannot go
 * missing again without a failure.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-active-schema-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;

/** Columns the canonical manual import boundary writes on TrackFiles. */
const REQUIRED_TRACK_FILE_COLUMNS = [
  "library_id",
  "album_release_id",
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
        album_release_id = @releaseId,
        track_id = @trackId,
        recording_id = @recordingId,
        file_class = 'audio',
        provider_item_id = @providerItemId,
        provider = @provider,
        provider_entity_type = CASE WHEN @providerItemId IS NULL THEN NULL ELSE 'track' END,
        provider_id = @providerExternalId,
        source_audio_variant_id = (
          SELECT id
          FROM ProviderItemAudioVariants
          WHERE provider_item_id = @providerItemId
            AND availability NOT IN ('unavailable', 'restricted')
          ORDER BY verified_at DESC, id DESC
          LIMIT 1
        ),
        source_quality = COALESCE(source_quality, quality),
        imported_quality = COALESCE(imported_quality, quality),
        verified_at = CURRENT_TIMESTAMP
      WHERE id = @fileId
    `);
  });
});

test("provider_item_id is a real FK to ProviderItems that survives item deletion", () => {
  db.prepare("INSERT OR IGNORE INTO Artists (id, name) VALUES ('fk-artist', 'FK Artist')").run();
  const item = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', 'fk-track', 'FK Track', 'available')
    RETURNING id
  `).get() as { id: number };

  const file = db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, provider_item_id,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'fk-artist', 'tidal', 'track', 'fk-track', ?,
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
