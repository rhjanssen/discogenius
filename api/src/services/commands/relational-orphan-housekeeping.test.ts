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
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlotTrackAssignments").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlotSources").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlotTargets").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
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

test("prunes orphaned relational slot targets, sources, and assignments", () => {
  // Insert parent artist and album for foreign keys
  dbModule.db.prepare(`INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('art-1', 'Artist')`).run();
  dbModule.db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title) VALUES ('rg-1', 'art-1', 'Album')`).run();
  dbModule.db.prepare(`INSERT OR IGNORE INTO Tracks (id, release_mbid, mbid, title) VALUES (101, 'rel-1', 'trk-1', 'Track 1')`).run();

  // Insert valid slot (id: 1)
  const slotId = Number(dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot) VALUES ('art-1', 'rg-1', 'stereo')
  `).run().lastInsertRowid);

  // We temporarily disable FK checks to insert orphans
  dbModule.db.pragma("foreign_keys = OFF");

  // Insert valid target (slot_id: slotId) and orphan target (slot_id: 9999)
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlotTargets (id, slot_id, target_track_id, target_track_mbid, status)
    VALUES (1, ?, 101, 'trk-1', 'unmatched'), (2, 9999, 101, 'trk-1', 'unmatched')
  `).run(slotId);

  // Insert valid source (slot_id: slotId) and orphan source (slot_id: 9999)
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlotSources (id, slot_id, provider, provider_album_id)
    VALUES (1, ?, 'spotify', 'sp-1'), (2, 9999, 'spotify', 'sp-2')
  `).run(slotId);

  // Insert valid assignment and orphan assignment (pointing to non-existent slot/target/source)
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlotTrackAssignments (id, slot_id, target_id, slot_source_id, target_track_id, target_track_mbid, provider, provider_track_id, provider_album_id, match_score, match_method)
    VALUES (1, ?, 1, 1, 101, 'trk-1', 'spotify', 'sp-t-1', 'sp-1', 100, 'exact'),
           (2, 9999, 1, 1, 101, 'trk-1', 'spotify', 'sp-t-2', 'sp-1', 100, 'exact')
  `).run(slotId);

  dbModule.db.pragma("foreign_keys = ON");

  const summary = pruneRelationalOrphans();

  assert.equal(summary.releaseGroupSlotTrackAssignmentsRemoved, 1);
  assert.equal(summary.releaseGroupSlotTargetsRemoved, 1);
  assert.equal(summary.releaseGroupSlotSourcesRemoved, 1);

  const targetsCount = (dbModule.db.prepare("SELECT COUNT(*) as count FROM ReleaseGroupSlotTargets").get() as { count: number }).count;
  const sourcesCount = (dbModule.db.prepare("SELECT COUNT(*) as count FROM ReleaseGroupSlotSources").get() as { count: number }).count;
  const assignmentsCount = (dbModule.db.prepare("SELECT COUNT(*) as count FROM ReleaseGroupSlotTrackAssignments").get() as { count: number }).count;

  assert.equal(targetsCount, 1);
  assert.equal(sourcesCount, 1);
  assert.equal(assignmentsCount, 1);
});

