import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-relational-orphans-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let pruneRelationalOrphans: typeof import("./relational-orphan-housekeeping.js").pruneRelationalOrphans;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  ({ pruneRelationalOrphans } = await import("./relational-orphan-housekeeping.js"));
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItemMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM MetadataFiles").run();
  dbModule.db.prepare("DELETE FROM LyricFiles").run();
  dbModule.db.prepare("DELETE FROM ExtraFiles").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("prunes stale direct provider matches while preserving composites and folder sidecars", () => {
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'album', 'live-offer', 'Live offer')
  `).run();
  const insertMatch = dbModule.db.prepare(`
    INSERT INTO ProviderItemMatches (
      provider, provider_item_type, provider_item_id,
      musicbrainz_release_mbid, status
    ) VALUES ('tidal', 'album', ?, 'release-mbid', 'verified')
  `);
  insertMatch.run("live-offer");
  insertMatch.run("removed-offer");
  insertMatch.run("removed-part-a;removed-part-b");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, track_file_id, relative_path, file_path, library_root,
      extension, type, file_type
    ) VALUES ('artist', NULL, 'artist.nfo', ?, ?, '.nfo', 'artistMetadata', 'metadata')
  `).run(path.join(tempDir, "artist.nfo"), tempDir);
  dbModule.db.prepare(`
    INSERT INTO LyricFiles (
      artist_id, track_file_id, relative_path, file_path, library_root, extension
    ) VALUES ('artist', NULL, 'folder.lrc', ?, ?, '.lrc')
  `).run(path.join(tempDir, "folder.lrc"), tempDir);
  dbModule.db.prepare(`
    INSERT INTO ExtraFiles (
      artist_id, track_file_id, relative_path, file_path, library_root,
      extension, file_type
    ) VALUES ('artist', NULL, 'cover.jpg', ?, ?, '.jpg', 'cover')
  `).run(path.join(tempDir, "cover.jpg"), tempDir);

  const summary = pruneRelationalOrphans();

  assert.equal(summary.providerItemMatchesRemoved, 1);
  assert.deepEqual(
    (dbModule.db.prepare(`
      SELECT provider_item_id
      FROM ProviderItemMatches
      ORDER BY provider_item_id
    `).all() as Array<{ provider_item_id: string }>).map((row) => row.provider_item_id),
    ["live-offer", "removed-part-a;removed-part-b"],
  );
  for (const table of ["MetadataFiles", "LyricFiles", "ExtraFiles"]) {
    const row = dbModule.db.prepare(`
      SELECT track_file_id
      FROM ${table}
    `).get() as { track_file_id: number | null } | undefined;
    assert.ok(row, `${table} folder-scoped row should be retained`);
    assert.equal(row.track_file_id, null);
  }
});
