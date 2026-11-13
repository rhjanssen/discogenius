import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import type { AcoustIdIdentificationResult } from "./acoustid-identification-service.js";

const { tempDir } = prepareActiveSchemaEnv("unmapped-recheck");
const { db, dbModule } = await openActiveSchemaDb();
const { UnmappedFileRepository } = await import("../../repositories/mediafiles/UnmappedFileRepository.js");
const { ImportService } = await import("./import-service.js");
const { UnmappedFilesService } = await import("./unmapped-files.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

const ROOT = path.join(tempDir, "music");
const REL_MBID = "fe990411-1111-2222-3333-444444444444";
const incomingDir = path.join(ROOT, "The Who", `Maximum As & Bs [${REL_MBID}]`);
const incomingFile = path.join(incomingDir, "107 - My Generation (mono version).flac");

const tags = new Map<string, { tags: Record<string, string>; durationSeconds: number | null }>();

function makeService(): InstanceType<typeof UnmappedFilesService> {
  return new UnmappedFilesService(
    new UnmappedFileRepository(db),
    new ImportService(),
    async () => ({ recordingIds: [] }) as unknown as AcoustIdIdentificationResult,
    async () => null,
    async (filePath) => tags.get(filePath) ?? { tags: {}, durationSeconds: null },
  );
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.writeFileSync(incomingFile, "flac-bytes");
  tags.clear();

  resetActiveSchemaRows(db, ["commands", "UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);

  db.prepare(`INSERT INTO MetadataProfiles (id, name, release_type_policy) VALUES (1, 'Default', '{}')`).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'High', '["lossless"]', '["lossless"]', 'lossless', 0, 'none', '{}', 'preserve')
  `).run();
  db.prepare(`
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
    VALUES (1, 'Music', ?, 1, 1, 1)
  `).run(ROOT);
  db.prepare(`
    INSERT INTO ArtistMetadata (id, mbid, name, updated_at)
    VALUES (1, 'who-mbid', 'The Who', '2026-01-01 00:00:00')
  `).run();
});

test("recheckExistingUnmappedFiles skips unchanged unmapped files when artist catalog has not changed (#113)", async () => {
  const stats = fs.statSync(incomingFile);
  db.prepare(`
    INSERT INTO UnmappedFiles (
      id, file_path, relative_path, library_root, filename, extension,
      file_size, file_mtime_ms, detected_artist, detected_album, detected_track,
      reason, ignored, created_at, updated_at
    ) VALUES (
      1, ?, ?, 'music', ?, 'flac',
      ?, ?, 'The Who', 'Maximum As & Bs', 'My Generation (mono version)',
      'No matching release found in catalog', 0, '2026-01-02 00:00:00', '2026-01-02 00:00:00'
    )
  `).run(
    incomingFile,
    path.relative(ROOT, incomingFile),
    path.basename(incomingFile),
    stats.size,
    stats.mtimeMs,
  );

  let parsedCount = 0;
  const service = new UnmappedFilesService(
    new UnmappedFileRepository(db),
    new ImportService(),
    async () => ({ recordingIds: [] }) as unknown as AcoustIdIdentificationResult,
    async () => null,
    async () => {
      parsedCount++;
      return { tags: {}, durationSeconds: null };
    },
  );

  const summary = await service.recheckExistingUnmappedFiles();
  assert.equal(summary.skippedFolders, 1);
  assert.equal(summary.checkedFolders, 0);
  assert.equal(summary.queuedFiles, 0);
  assert.equal(parsedCount, 0, "unchanged file with unchanged artist catalog must not be re-parsed");

  const row = db.prepare("SELECT reason, updated_at FROM UnmappedFiles WHERE id = 1").get() as {
    reason: string;
    updated_at: string;
  };
  assert.equal(row.reason, "No matching release found in catalog");
  assert.equal(row.updated_at, "2026-01-02 00:00:00");
});

test("recheckExistingUnmappedFiles re-evaluates and queues ImportUnmappedFiles after artist catalog updates (#113)", async () => {
  const stats = fs.statSync(incomingFile);
  db.prepare(`
    INSERT INTO UnmappedFiles (
      id, file_path, relative_path, library_root, filename, extension,
      file_size, file_mtime_ms, detected_artist, detected_album, detected_track,
      reason, ignored, created_at, updated_at
    ) VALUES (
      1, ?, ?, 'music', ?, 'flac',
      ?, ?, 'The Who', 'Maximum As & Bs', 'My Generation (mono version)',
      'No matching release found in catalog', 0, '2026-01-02 00:00:00', '2026-01-02 00:00:00'
    )
  `).run(
    incomingFile,
    path.relative(ROOT, incomingFile),
    path.basename(incomingFile),
    stats.size,
    stats.mtimeMs,
  );

  // Simulate catalog refresh adding the album, edition, recording, and track with a newer updated_at.
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_mbid, title, first_release_date, updated_at)
    VALUES (1, 'rg-who', 'who-mbid', 'Maximum As & Bs', '1984-01-01', '2026-01-03 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid,
      title, status, date, country, media_count, media, updated_at
    ) VALUES (
      10, ?, 1, 'rg-who', 'who-mbid',
      'Maximum As & Bs', 'Official', '1984-01-01', '["XE"]', 1, '[{"format":"CD"}]', '2026-01-03 00:00:00'
    )
  `).run(REL_MBID);
  db.prepare(`INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (100, 'rec-gen', 'My Generation (mono version)', 198000)`).run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title, length_ms
    ) VALUES (1000, 'track-gen', 10, ?, 100, 'rec-gen', 1, 7, 'My Generation (mono version)', 198000)
  `).run(REL_MBID);

  tags.set(incomingFile, {
    tags: {
      MUSICBRAINZ_ALBUMID: REL_MBID,
      ALBUM: "Maximum As & Bs",
      ALBUMARTIST: "The Who",
      TITLE: "My Generation (mono version)",
      TRACK: "7",
    },
    durationSeconds: 197,
  });

  const summary = await makeService().recheckExistingUnmappedFiles();
  assert.equal(summary.skippedFolders, 0);
  assert.equal(summary.checkedFolders, 1);
  assert.equal(summary.queuedFiles, 1);

  const cmd = db.prepare(`
    SELECT payload FROM commands WHERE name = 'ImportUnmappedFiles'
  `).get() as { payload: string } | undefined;
  assert.ok(cmd, "ImportUnmappedFiles command should be queued for rename + retag");
  const payload = JSON.parse(cmd.payload) as {
    applyStandardTags?: boolean;
    canonical?: { editionId: number; mappings: Array<{ unmappedFileId: number; trackId: number }> };
  };
  assert.equal(payload.applyStandardTags, true);
  assert.equal(payload.canonical?.editionId, 10);
  assert.deepEqual(payload.canonical?.mappings, [{ unmappedFileId: 1, trackId: 1000 }]);
});
