import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { ensureEditionBarcodeIndex } from "./edition-barcode-index.js";

const { tempDir } = prepareActiveSchemaEnv("barcode-index");
const { db, dbModule } = await openActiveSchemaDb();
after(() => closeActiveSchemaDb(dbModule, tempDir));

test("barcode lookup preserves normalized identity through insert, correction, rollback, delete and restart", () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('barcode-artist', 'Barcode artist')").run();
  db.prepare("INSERT INTO Albums (mbid, title, artist_mbid) VALUES ('barcode-group', 'Barcode fixture', 'barcode-artist')").run();
  const insert = db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, barcode)
    VALUES (?, 'barcode-group', 'barcode-artist', 'Edition', ?) RETURNING id`);
  const values = ['000-123 456', 'UPC:00123456', '123456', '000', 'none', null];
  const ids = values.map((value, i) => (insert.get(`barcode-edition-${i}`, value) as { id: number }).id);
  const lookup = (barcode: string) => (db.prepare('SELECT edition_id FROM EditionBarcodeIndex WHERE barcode = ? ORDER BY edition_id')
    .all(barcode) as Array<{ edition_id: number }>).map(row => row.edition_id);
  assert.deepEqual(lookup('123456'), ids.slice(0, 3));
  assert.deepEqual(lookup('0'), [ids[3]]);
  db.prepare('UPDATE AlbumEditions SET barcode = ? WHERE id = ?').run('00987', ids[0]);
  assert.deepEqual(lookup('123456'), ids.slice(1, 3));
  assert.deepEqual(lookup('987'), [ids[0]]);
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE AlbumEditions SET barcode = NULL WHERE id = ?').run(ids[0]);
    throw new Error('rollback');
  })(), /rollback/);
  assert.deepEqual(lookup('987'), [ids[0]]);
  db.prepare('DELETE FROM AlbumEditions WHERE id = ?').run(ids[0]);
  assert.deepEqual(lookup('987'), []);
  ensureEditionBarcodeIndex(db);
  assert.deepEqual(lookup('123456'), ids.slice(1, 3));
  assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT edition_id FROM EditionBarcodeIndex WHERE barcode = ?').all('123456')), /SEARCH.*idx_edition_barcode_value/);
});

test("provider rematch dependency lookups use indexes on the active schema", () => {
  for (const [table, column] of [
    ['AcquisitionPlanSources', 'provider_edition_match_id'],
    ['AcquisitionPlanTracks', 'provider_audio_variant_id'],
    ['TrackFiles', 'source_audio_variant_id'],
    ['TrackLibraryIndex', 'recording_id'],
  ]) {
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = ?`).all(1));
    assert.match(plan, /SEARCH.*INDEX/, `${table}.${column} must not scan all rows during a rematch`);
  }
});
