import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import { CanonicalManualVideoImportService } from "./canonical-manual-video-import-service.js";

const { tempDir } = prepareActiveSchemaEnv("canonical-manual-video-import");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";
const VIDEO_MBID = "22222222-2222-4222-8222-222222222222";

function fixture() {
  resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, ?, 'Bastille')").run(ARTIST_MBID);
  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, 'Bastille', ?)").run(ARTIST_MBID, ARTIST_MBID);
  db.prepare(`
    INSERT INTO Recordings (
      id, mbid, title, artist_metadata_id, artist_mbid, artist_credit, is_video
    ) VALUES (10, ?, 'Pompeii', 1, ?, 'Bastille', 1)
  `).run(VIDEO_MBID, ARTIST_MBID);
  db.prepare(`
    INSERT INTO Recordings (
      id, mbid, title, is_video
    ) VALUES (20, '33333333-3333-4333-8333-333333333333', 'Audio recording', 0)
  `).run();
  db.prepare(`
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy,
      require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 0, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'Video', '["video"]', '["video"]', 'video', 0, 'none', '{}', 'preserve')
  `).run();
  db.prepare(`
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
    VALUES (3, 'Music Videos', '/library/videos', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO UnmappedFiles (
      id, file_path, relative_path, library_root, filename, extension
    ) VALUES (
      7, '/incoming/Bastille - Pompeii.mkv', 'Bastille - Pompeii.mkv',
      '/incoming', 'Bastille - Pompeii.mkv', 'mkv'
    )
  `).run();
}

test("canonical video import pins the exact TrackFiles row without provider provenance", async () => {
  fixture();
  try {
    let receivedRoot = "";
    let receivedIdentity = "";
    const service = new CanonicalManualVideoImportService(db, async (items, options) => {
      receivedRoot = options?.libraryRootPath || "";
      receivedIdentity = items[0]?.providerId || "";
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_id, library_root, library_slot,
          file_path, relative_path, filename, extension, file_type, file_class,
          provider, provider_entity_type, provider_id, source_quality, quality
        ) VALUES (
          70, ?, 3, '/library/videos', 'video',
          '/library/videos/Bastille/Pompeii.mkv', 'Bastille/Pompeii.mkv',
          'Pompeii.mkv', 'mkv', 'video', 'video',
          'tidal', 'video', 'stale-provider-video', '1080p', '1080p'
        )
      `).run(ARTIST_MBID);
      return {
        requested: 1,
        imported: 1,
        duplicates: 0,
        skipped: 0,
        importedFileIds: { 7: 70 },
      };
    });

    const summary = await service.import({
      libraryId: 3,
      mappings: [{ unmappedFileId: 7, recordingId: 10 }],
    });

    assert.equal(summary.imported, 1);
    assert.equal(receivedRoot, "/library/videos");
    assert.equal(receivedIdentity, VIDEO_MBID);
    assert.deepEqual(db.prepare(`
      SELECT
        library_id, recording_id, canonical_recording_mbid, canonical_artist_mbid,
        track_id, album_edition_id, release_group_id, file_type, file_class,
        provider_item_id, provider, provider_entity_type, provider_id,
        source_audio_variant_id, source_quality, imported_quality
      FROM TrackFiles WHERE id = 70
    `).get(), {
      library_id: 3,
      recording_id: 10,
      canonical_recording_mbid: VIDEO_MBID,
      canonical_artist_mbid: ARTIST_MBID,
      track_id: null,
      album_edition_id: null,
      release_group_id: null,
      file_type: "video",
      file_class: "video",
      provider_item_id: null,
      provider: null,
      provider_entity_type: null,
      provider_id: null,
      source_audio_variant_id: null,
      source_quality: null,
      imported_quality: "1080p",
    });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM LibraryVideos WHERE video_recording_id = 10")
        .get() as { n: number }).n,
      1,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("canonical video import rejects an audio Recording before filesystem work", async () => {
  fixture();
  try {
    let importerCalled = false;
    const service = new CanonicalManualVideoImportService(db, async () => {
      importerCalled = true;
      return { requested: 0, imported: 0, duplicates: 0, skipped: 0, importedFileIds: {} };
    });
    await assert.rejects(
      service.import({
        libraryId: 3,
        mappings: [{ unmappedFileId: 7, recordingId: 20 }],
      }),
      /is not a video/,
    );
    assert.equal(importerCalled, false);
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("canonical video import rejects an exact importer row outside the chosen library root", async () => {
  fixture();
  try {
    const service = new CanonicalManualVideoImportService(db, async () => {
      db.prepare(`
        INSERT INTO TrackFiles (
          id, artist_id, library_id, library_root, library_slot,
          file_path, relative_path, filename, extension, file_type
        ) VALUES (
          71, ?, 3, '/library/other', 'video',
          '/library/other/Pompeii.mkv', 'Pompeii.mkv', 'Pompeii.mkv', 'mkv', 'video'
        )
      `).run(ARTIST_MBID);
      return {
        requested: 1,
        imported: 1,
        duplicates: 0,
        skipped: 0,
        importedFileIds: { 7: 71 },
      };
    });
    await assert.rejects(
      service.import({
        libraryId: 3,
        mappings: [{ unmappedFileId: 7, recordingId: 10 }],
      }),
      /outside library root/,
    );
  } finally {
    resetActiveSchemaRows(db, ["UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});
