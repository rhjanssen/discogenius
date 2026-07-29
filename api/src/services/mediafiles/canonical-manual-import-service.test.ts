import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { CanonicalManualImportService } from "./canonical-manual-import-service.js";

function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-canonical-import-"));
  const db = new Database(path.join(folder, "test.db"));
  db.pragma("foreign_keys = ON");
  createDomainSchemaV41(db);
  db.exec(`
    CREATE TABLE UnmappedFiles (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      filename TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist', 'Artist')").run();
  db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group', 1, 'Group')").run();
  db.prepare("INSERT INTO AlbumReleases (id, mbid, release_group_id, title) VALUES (10, 'release-a', 1, 'Release A')").run();
  db.prepare("INSERT INTO AlbumReleases (id, mbid, release_group_id, title) VALUES (20, 'release-b', 1, 'Release B')").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (100, 'recording-a', 'Track A')").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (200, 'recording-b', 'Track B')").run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_release_id, recording_id, medium_position, position, title
    ) VALUES (1000, 'track-a', 10, 100, 1, 1, 'Track A')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_release_id, recording_id, medium_position, position, title
    ) VALUES (2000, 'track-b', 20, 200, 1, 1, 'Track B')
  `).run();
  db.prepare(`
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy,
      require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'High', '["lossless"]', '["lossless"]', 'lossless', 0, 'none', '{}', 'preserve')
  `).run();
  db.prepare(`
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
    VALUES (1, 'Stereo', '/library/stereo', 1, 1)
  `).run();
  db.prepare("INSERT INTO UnmappedFiles (id, file_path, filename) VALUES (1, '/incoming/a.flac', 'a.flac')").run();
  return { db, folder };
}

test("canonical manual import pins Library, Release, Track and Recording", async () => {
  const { db, folder } = fixture();
  try {
    let receivedRoot = "";
    const service = new CanonicalManualImportService(db, async (items, options) => {
      receivedRoot = options?.libraryRootPath || "";
      db.prepare(`
        INSERT INTO TrackFiles (
          id, library_id, album_release_id, track_id, recording_id,
          file_path, relative_path, filename, extension, file_class,
          source_quality, imported_quality
        ) VALUES (
          1, 1, 10, 1000, 100,
          '/library/stereo/Artist/Release A/01 Track A.flac',
          'Artist/Release A/01 Track A.flac',
          '01 Track A.flac', 'flac', 'audio', 'lossless', 'lossless'
        )
      `).run();
      db.exec("ALTER TABLE TrackFiles ADD COLUMN canonical_track_mbid TEXT");
      db.exec("ALTER TABLE TrackFiles ADD COLUMN provider TEXT");
      db.exec("ALTER TABLE TrackFiles ADD COLUMN provider_entity_type TEXT");
      db.exec("ALTER TABLE TrackFiles ADD COLUMN provider_id TEXT");
      db.exec("ALTER TABLE TrackFiles ADD COLUMN quality TEXT");
      db.prepare("UPDATE TrackFiles SET canonical_track_mbid = ? WHERE id = 1").run(items[0].providerId);
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0 };
    });

    const summary = await service.import({
      libraryId: 1,
      releaseId: 10,
      mappings: [{ unmappedFileId: 1, trackId: 1000 }],
    });

    assert.equal(receivedRoot, "/library/stereo");
    assert.equal(summary.imported, 1);
    assert.deepEqual(db.prepare(`
      SELECT library_id, album_release_id, track_id, recording_id, file_class, provider
      FROM TrackFiles WHERE id = 1
    `).get(), {
      library_id: 1,
      album_release_id: 10,
      track_id: 1000,
      recording_id: 100,
      file_class: "audio",
      provider: null,
    });
    assert.deepEqual(db.prepare(`
      SELECT
        release_group.monitored,
        release_group.selection_mode AS group_mode,
        release_group.locked AS group_locked,
        release.selection_mode AS release_mode,
        release.locked AS release_locked
      FROM LibraryReleaseGroups release_group
      JOIN LibraryReleases release
        ON release.library_id = release_group.library_id
       AND release.release_id = 10
      WHERE release_group.library_id = 1 AND release_group.release_group_id = 1
    `).get(), {
      monitored: 1,
      group_mode: "manual",
      group_locked: 1,
      release_mode: "manual",
      release_locked: 1,
    });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("changing release rejects stale track assignments before importing", async () => {
  const { db, folder } = fixture();
  try {
    let called = false;
    const service = new CanonicalManualImportService(db, async () => {
      called = true;
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0 };
    });
    await assert.rejects(
      service.import({
        libraryId: 1,
        releaseId: 20,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /not an audio track on release 20/,
    );
    assert.equal(called, false);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
