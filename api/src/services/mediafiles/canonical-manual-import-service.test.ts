import assert from "node:assert/strict";
import test, { after } from "node:test";
import { CanonicalManualImportService } from "./canonical-manual-import-service.js";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

/**
 * This suite used to build its database from `domain-v41.ts`. That is the
 * aspirational core schema (32 tables) — production never creates it — and the
 * divergence hid a real bug: the boundary wrote TrackFiles.provider_item_id
 * against an active schema that had no such column, and every test still passed.
 *
 * It now boots the ACTIVE schema, so these cases exercise the table production
 * actually writes. The 55 `ALTER TABLE TrackFiles ADD COLUMN` statements the old
 * fixture needed are gone: canonical_track_mbid, canonical_recording_mbid,
 * provider, provider_entity_type, provider_id and quality all exist natively
 * there.
 */
const { tempDir } = prepareActiveSchemaEnv("canonical-manual-import");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

function fixture() {
  resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);

  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist', 'Artist')").run();
  // TrackFiles.artist_id is NOT NULL with an FK to Artists in the ACTIVE schema.
  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES ('artist', 'Artist', 'artist')").run();
  db.prepare("INSERT INTO Albums (id, mbid, artist_mbid, title) VALUES (1, 'group', 'artist', 'Group')").run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title)
    VALUES (10, 'release-a', 1, 'group', 'artist', 'Release A')
  `).run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title)
    VALUES (20, 'release-b', 1, 'group', 'artist', 'Release B')
  `).run();
  db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (100, 'recording-a', 'Track A')").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (200, 'recording-b', 'Track B')").run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES (1000, 'track-a', 10, 'release-a', 100, 'recording-a', 1, 1, 'Track A')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES (2000, 'track-b', 20, 'release-b', 200, 'recording-b', 1, 1, 'Track B')
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
  db.prepare(`
    INSERT INTO UnmappedFiles (id, file_path, relative_path, library_root, filename, extension)
    VALUES (1, '/incoming/a.flac', 'a.flac', '/incoming', 'a.flac', 'flac')
  `).run();
  return { db, folder: tempDir };
}

test("canonical manual import pins Library, Release, Track and Recording", async () => {
  fixture();
  try {
    let receivedRoot = "";
    const service = new CanonicalManualImportService(db, async (items, options) => {
      receivedRoot = options?.libraryRootPath || "";
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          file_path, relative_path, filename, extension, file_class,
          source_quality, imported_quality
        ) VALUES (
          1, 'artist', '/library/stereo', 'track', 1, 10, 1000, 100,
          '/library/stereo/Artist/Release A/01 Track A.flac',
          'Artist/Release A/01 Track A.flac',
          '01 Track A.flac', 'flac', 'audio', 'lossless', 'lossless'
        )
      `).run();
      db.prepare("UPDATE TrackFiles SET canonical_track_mbid = ? WHERE id = 1").run(items[0].providerId);
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 1 } };
    });

    const summary = await service.import({
      libraryId: 1,
      editionId: 10,
      mappings: [{ unmappedFileId: 1, trackId: 1000 }],
    });

    assert.equal(receivedRoot, "/library/stereo");
    assert.equal(summary.imported, 1);
    assert.deepEqual(db.prepare(`
      SELECT library_id, album_edition_id, track_id, recording_id, file_class, provider
      FROM TrackFiles WHERE id = 1
    `).get(), {
      library_id: 1,
      album_edition_id: 10,
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
      FROM LibraryAlbums release_group
      JOIN LibraryEditions release
        ON release.library_id = release_group.library_id
       AND release.edition_id = 10
      WHERE release_group.library_id = 1 AND release_group.release_group_id = 1
    `).get(), {
      monitored: 1,
      group_mode: "manual",
      // Importing establishes a custom selection and monitors the group, but it
      // is NOT a lock: "automatic curation may not change this" is separate
      // user intent. See the dedicated lock-preservation test below.
      group_locked: 0,
      release_mode: "manual",
      release_locked: 0,
    });
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("changing release rejects stale track assignments before importing", async () => {
  fixture();
  try {
    let called = false;
    const service = new CanonicalManualImportService(db, async () => {
      called = true;
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 1 } };
    });
    await assert.rejects(
      service.import({
        libraryId: 1,
        editionId: 20,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /not an audio track on release 20/,
    );
    assert.equal(called, false);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("manual import needs no acquisition plan and no provider item at all", async () => {
  fixture();
  try {
    // The whole point of manual import: a user maps files onto canonical
    // Library/Release/Track identity with nothing provider-side in the database.
    assert.equal((db.prepare("SELECT COUNT(*) c FROM AcquisitionPlans").get() as { c: number }).c, 0);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM ProviderItems").get() as { c: number }).c, 0);

    const service = new CanonicalManualImportService(db, async () => {
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          file_path, relative_path, filename, extension, file_class
        ) VALUES (
          1, 'artist', '/library/stereo', 'track', 1, 10, 1000, 100,
          '/library/stereo/Artist/Release A/01 Track A.flac',
          'Artist/Release A/01 Track A.flac',
          '01 Track A.flac', 'flac', 'audio'
        )
      `).run();
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 1 } };
    });

    const summary = await service.import({
      libraryId: 1,
      editionId: 10,
      mappings: [{ unmappedFileId: 1, trackId: 1000 }],
    });

    assert.equal(summary.imported, 1);
    assert.deepEqual(db.prepare(`
      SELECT library_id, album_edition_id, track_id, recording_id, provider_item_id
      FROM TrackFiles WHERE id = 1
    `).get(), {
      library_id: 1,
      album_edition_id: 10,
      track_id: 1000,
      recording_id: 100,
      provider_item_id: null,
    });
    // Still no acquisition plan was invented on the way through.
    assert.equal((db.prepare("SELECT COUNT(*) c FROM AcquisitionPlans").get() as { c: number }).c, 0);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("canonical manual import rejects provider provenance from stale command payloads", async () => {
  fixture();
  try {
    const providerItem = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES ('tidal', 'track', 'tidal-track-1', 'Provider Track Title')
      RETURNING id
    `).get() as { id: number };

    let importerCalled = false;
    const service = new CanonicalManualImportService(db, async () => {
      importerCalled = true;
      return { requested: 0, imported: 0, duplicates: 0, skipped: 0, importedFileIds: {} };
    });

    await assert.rejects(
      () => service.import({
        libraryId: 1,
        editionId: 10,
        mappings: [{
          unmappedFileId: 1,
          trackId: 1000,
          providerItemId: providerItem.id,
        }],
      } as unknown as Parameters<CanonicalManualImportService["import"]>[0]),
      /does not accept providerItemId/,
    );
    assert.equal(importerCalled, false, "invalid provider provenance is rejected before filesystem work");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM TrackFiles").get() as { count: number }).count, 0);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("a recording shared by two selected releases keeps the release-track the user chose", async () => {
  fixture();
  try {
    // Release B also carries recording 100 — the SAME recording as Release A's
    // track 1000 — as its own release-track occurrence.
    db.prepare(`
      INSERT INTO Tracks (
        id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
        medium_position, position, title
      ) VALUES (2100, 'track-b-shared', 20, 'release-b', 100, 'recording-a', 1, 2, 'Track A')
    `).run();
    // Both releases are selected into the library.
    db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
      ) VALUES (1, 1, 1, 'auto', 0, 'test', 1)
    `).run();
    for (const editionId of [10, 20]) {
      db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, locked, reason, curation_version
        ) VALUES (1, ?, 'auto', 0, 'test', 1)
      `).run(editionId);
    }

    const service = new CanonicalManualImportService(db, async () => {
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          file_path, relative_path, filename, extension, file_class
        ) VALUES (
          1, 'artist', '/library/stereo', 'track', 1, 20, 2100, 100,
          '/library/stereo/Artist/Release B/02 Track A.flac',
          'Artist/Release B/02 Track A.flac',
          '02 Track A.flac', 'flac', 'audio'
        )
      `).run();
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 1 } };
    });

    // The user explicitly imports onto Release B's occurrence of the recording.
    await service.import({
      libraryId: 1,
      editionId: 20,
      mappings: [{ unmappedFileId: 1, trackId: 2100 }],
    });

    const row = db.prepare(`
      SELECT album_edition_id, track_id, recording_id FROM TrackFiles WHERE id = 1
    `).get() as Record<string, number>;
    // The explicitly chosen release-track occurrence survives; it is NOT
    // re-anchored to Release A's sibling track just because both selected
    // releases share recording 100.
    assert.equal(row.album_edition_id, 20);
    assert.equal(row.track_id, 2100);
    assert.equal(row.recording_id, 100);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("only the newly imported row is updated when the same track exists in another library", async () => {
  fixture();
  try {

    // A SECOND library already holds the very same canonical track.
    db.prepare(`
      INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
      VALUES (2, 'Spatial', '/library/spatial', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO TrackFiles (
        id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
        canonical_track_mbid, file_path, relative_path, filename, extension, file_class,
        verified_at
      ) VALUES (
        99, 'artist', '/library/stereo', 'track', 2, 10, 1000, 100,
        'track-a', '/library/spatial/Artist/Release A/01 Track A.m4a',
        'Artist/Release A/01 Track A.m4a', '01 Track A.m4a', 'm4a', 'audio',
        CURRENT_TIMESTAMP
      )
    `).run();

    const service = new CanonicalManualImportService(db, async () => {
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          canonical_track_mbid, file_path, relative_path, filename, extension, file_class
        ) VALUES (
          1, 'artist', '/library/stereo', 'track', 1, 10, 1000, 100,
          'track-a', '/library/stereo/Artist/Release A/01 Track A.flac',
          'Artist/Release A/01 Track A.flac', '01 Track A.flac', 'flac', 'audio'
        )
      `).run();
      // The importer reports exactly which row it created for which request.
      return {
        requested: 1, imported: 1, duplicates: 0, skipped: 0,
        importedFileIds: { 1: 1 },
      };
    });

    await service.import({
      libraryId: 1,
      editionId: 10,
      mappings: [{ unmappedFileId: 1, trackId: 1000 }],
    });

    // The newly imported row was updated...
    const imported = db.prepare(`
      SELECT library_id, track_id, recording_id, verified_at FROM TrackFiles WHERE id = 1
    `).get() as Record<string, unknown>;
    assert.equal(imported.library_id, 1);
    assert.equal(imported.track_id, 1000);
    assert.ok(imported.verified_at, "the imported row is verified");

    // ...and the other library's pre-existing copy was left completely alone.
    const other = db.prepare(`
      SELECT library_id, file_path, album_edition_id FROM TrackFiles WHERE id = 99
    `).get() as Record<string, unknown>;
    assert.equal(other.library_id, 2, "the other library's row must not be re-pointed");
    assert.equal(other.file_path, "/library/spatial/Artist/Release A/01 Track A.m4a");
    assert.equal(other.album_edition_id, 10);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("manual import monitors and custom-selects without silently locking", async () => {
  fixture();
  try {

    // Reports the row it created for the item it was actually given — this test
    // imports twice with different unmapped file ids, and the operation result
    // must follow the request rather than echo a fixed id.
    const service = new CanonicalManualImportService(db, async (items) => {
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          canonical_track_mbid, file_path, relative_path, filename, extension, file_class
        ) VALUES (
          1, 'artist', '/library/stereo', 'track', 1, 10, 1000, 100, 'track-a',
          '/library/stereo/a.flac', 'a.flac', 'a.flac', 'flac', 'audio'
        )
      `).run();
      return {
        requested: items.length,
        imported: 1,
        duplicates: 0,
        skipped: 0,
        importedFileIds: { [String(items[0].id)]: 1 },
      };
    });

    await service.import({
      libraryId: 1,
      editionId: 10,
      mappings: [{ unmappedFileId: 1, trackId: 1000 }],
    });

    // Monitored and custom-selected, but NOT locked: lock is separate user intent.
    const group = db.prepare(`
      SELECT monitored, selection_mode, locked FROM LibraryAlbums
      WHERE library_id = 1 AND release_group_id = 1
    `).get() as Record<string, unknown>;
    assert.equal(group.monitored, 1);
    assert.equal(group.selection_mode, "manual");
    assert.equal(group.locked, 0, "manual import must not silently lock the group");

    // An existing lock is preserved across a later import.
    db.prepare("UPDATE LibraryAlbums SET locked = 1 WHERE library_id = 1").run();
    db.prepare("UPDATE LibraryEditions SET locked = 1 WHERE library_id = 1").run();
    db.prepare("DELETE FROM TrackFiles WHERE id = 1").run();
    db.prepare(`
      INSERT INTO UnmappedFiles (id, file_path, relative_path, library_root, filename, extension)
      VALUES (2, '/incoming/b.flac', 'b.flac', '/incoming', 'b.flac', 'flac')
    `).run();

    await service.import({
      libraryId: 1,
      editionId: 10,
      mappings: [{ unmappedFileId: 2, trackId: 1000 }],
    });

    assert.equal((db.prepare(`
      SELECT locked FROM LibraryAlbums WHERE library_id = 1 AND release_group_id = 1
    `).get() as { locked: number }).locked, 1, "an existing lock survives a later import");
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("a reported row outside the target library root fails closed", async () => {
  fixture();
  try {

    const service = new CanonicalManualImportService(db, async () => {
      // The row exists but lives outside /library/stereo.
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_root, file_type, library_id, album_edition_id, track_id, recording_id,
          file_path, relative_path, filename, extension, file_class
        ) VALUES (
          7, 'artist', '/library/stereo', 'track', 1, 10, 1000, 100,
          '/somewhere/else/01 Track A.flac', '01 Track A.flac',
          '01 Track A.flac', 'flac', 'audio'
        )
      `).run();
      return { requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 7 } };
    });

    await assert.rejects(
      () => service.import({
        libraryId: 1,
        editionId: 10,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /outside library root/,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("a reported row that does not exist fails closed", async () => {
  fixture();
  try {
    const service = new CanonicalManualImportService(db, async () =>
      ({ requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 1: 4242 } }));

    await assert.rejects(
      () => service.import({
        libraryId: 1,
        editionId: 10,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /no such row exists/,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("an import claimed without operation identity fails closed", async () => {
  fixture();
  try {
    // The importer says it imported a file but names no row for it. Silently
    // treating that as "skipped" would leave a real file on disk with no
    // canonical authority attached.
    const service = new CanonicalManualImportService(db, async () =>
      ({ requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: {} }));

    await assert.rejects(
      () => service.import({
        libraryId: 1,
        editionId: 10,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /reported 0 imported file id\(s\) but claims 1/,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("an operation identity for an unsubmitted mapping fails closed", async () => {
  fixture();
  try {
    // Item 99 was never part of this request — accepting it would let one
    // request's authority land on another operation's row.
    const service = new CanonicalManualImportService(db, async () =>
      ({ requested: 1, imported: 1, duplicates: 0, skipped: 0, importedFileIds: { 99: 1 } }));

    await assert.rejects(
      () => service.import({
        libraryId: 1,
        editionId: 10,
        mappings: [{ unmappedFileId: 1, trackId: 1000 }],
      }),
      /reported unmapped file 99, which was not part of this import request/,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});
