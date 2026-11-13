import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-case-insensitive-root-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { DiskScanService } = await import("./library-scan.js");
const { UnmappedFilesService } = await import("./unmapped-files.js");
const { Config } = await import("../config/config.js");
const {
  isCaseInsensitivePath,
  setCaseSensitivityOverride,
  clearCaseSensitivityCache,
  normalizeComparablePath,
  normalizeResolvedPath,
} = await import("./path-utils.js");
const { RenameTrackFileService } = await import("./rename-track-file-service.js");
const { RequestValidationError } = await import("../../utils/request-validation.js");

function writePcmWav(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const dataSize = sampleRate * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, wav);
}

function seedArtistCatalog(artistMbid: string, artistName: string, albumSuffix = "1") {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, artistName);
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(artistMbid) as { id: number };
  const rgMbid = `album-rg-${albumSuffix}`;
  const editionMbid = `edition-${albumSuffix}`;
  const recordingMbid = `recording-${albumSuffix}`;
  const trackMbid = `track-${albumSuffix}`;
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(rgMbid, artistMbid, "In the City", "album", "2023-01-01");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(editionMbid, rgMbid, artistMbid, "In the City", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)").run(
    recordingMbid,
    "In the City",
    artistMbid,
    0,
  );
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(trackMbid, editionMbid, recordingMbid, "In the City", 1, 1);
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    SELECT library.id, (SELECT id FROM Albums WHERE mbid = ?), 'manual', 0, 'test', 1
    FROM Libraries library WHERE library.enabled = 1
  `).run(rgMbid);
  return { artistId: artist.id, rgMbid, editionMbid, recordingMbid, trackMbid };
}

beforeEach(() => {
  clearCaseSensitivityCache();
  db.prepare("DELETE FROM UnmappedFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
});

afterEach(() => {
  clearCaseSensitivityCache();
  db.prepare("DELETE FROM UnmappedFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
});

test("isCaseInsensitivePath detects case sensitivity and respects per-root override", () => {
  const root = fs.mkdtempSync(path.join(tempDir, "probe-root-"));
  try {
    setCaseSensitivityOverride(root, true);
    assert.equal(isCaseInsensitivePath(root), true);
    assert.equal(isCaseInsensitivePath(path.join(root, "SubFolder", "file.flac")), true);

    setCaseSensitivityOverride(root, false);
    assert.equal(isCaseInsensitivePath(root), false);
    assert.equal(isCaseInsensitivePath(path.join(root, "SubFolder", "file.flac")), false);

    setCaseSensitivityOverride(root, null);
    // On Linux without override, this directory is case-sensitive (or platform default)
    const detected = isCaseInsensitivePath(root);
    assert.equal(typeof detected, "boolean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UnmappedFilesService.deleteFile refuses to delete file matching TrackFiles case-insensitively", () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "unmapped-delete-track-"));
  try {
    const { artistId } = seedArtistCatalog("artist-del-1", "Delete Artist 1", "del-1");
    const linkedPath = path.join(testRoot, "Charli xcx {mbid-260b6184}", "01 - In the City.flac");
    const unmappedPath = path.join(testRoot, "Charli XCX {mbid-260b6184}", "01 - In the City.flac");

    writePcmWav(unmappedPath);

    db.prepare(`
      INSERT INTO TrackFiles (
        file_path, relative_path, library_root, filename, extension, file_type,
        imported_quality, quality, artist_metadata_id
      ) VALUES (?, '01 - In the City.flac', ?, '01 - In the City.flac', 'flac', 'track', 'LOSSLESS', 'LOSSLESS', ?)
    `).run(linkedPath, testRoot, artistId);

    const inserted = db.prepare(`
      INSERT INTO UnmappedFiles (
        file_path, relative_path, library_root, filename, extension, file_size
      ) VALUES (?, '01 - In the City.flac', ?, '01 - In the City.flac', 'flac', 1000)
    `).run(unmappedPath, testRoot);
    const unmappedId = Number(inserted.lastInsertRowid);

    const service = new UnmappedFilesService();

    assert.throws(
      () => service.deleteFile(unmappedId),
      (err: any) => {
        assert.ok(err instanceof RequestValidationError || err instanceof Error);
        assert.match(err.message, /path matches linked track file/i);
        return true;
      },
    );

    // File on disk MUST NOT be deleted
    assert.equal(fs.existsSync(unmappedPath), true, "File on disk must be preserved");
    // UnmappedFiles row must still be intact
    assert.ok(db.prepare("SELECT 1 FROM UnmappedFiles WHERE id = ?").get(unmappedId));
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("UnmappedFilesService.deleteFile refuses to delete file matching ExtraFiles case-insensitively", () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "unmapped-delete-extra-"));
  try {
    const extraPath = path.join(testRoot, "Artist", "cover.jpg");
    const unmappedPath = path.join(testRoot, "artist", "cover.jpg");

    writePcmWav(unmappedPath);

    db.prepare(`
      INSERT INTO ExtraFiles (
        artist_id, relative_path, file_path, library_root, extension, file_type
      ) VALUES ('1', 'cover.jpg', ?, ?, 'jpg', 'cover')
    `).run(extraPath, testRoot);

    const inserted = db.prepare(`
      INSERT INTO UnmappedFiles (
        file_path, relative_path, library_root, filename, extension, file_size
      ) VALUES (?, 'cover.jpg', ?, 'cover.jpg', 'jpg', 1000)
    `).run(unmappedPath, testRoot);
    const unmappedId = Number(inserted.lastInsertRowid);

    const service = new UnmappedFilesService();

    assert.throws(
      () => service.deleteFile(unmappedId),
      (err: any) => {
        assert.ok(err instanceof RequestValidationError || err instanceof Error);
        assert.match(err.message, /path matches linked extra file/i);
        return true;
      },
    );

    // File on disk MUST NOT be deleted
    assert.equal(fs.existsSync(unmappedPath), true, "Extra file on disk must be preserved");
    assert.ok(db.prepare("SELECT 1 FROM UnmappedFiles WHERE id = ?").get(unmappedId));
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("UnmappedFilesService.deleteFiles (bulk) refuses before unlinking when any file matches a track file case-insensitively", () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "unmapped-bulk-"));
  try {
    const { artistId } = seedArtistCatalog("artist-bulk-1", "Bulk Artist 1", "bulk-1");
    const linkedPath = path.join(testRoot, "ARTBAT {mbid-f812b317}", "01 - Track.flac");
    const unmappedLinkedPath = path.join(testRoot, "Artbat {mbid-f812b317}", "01 - Track.flac");
    const genuineUnmappedPath = path.join(testRoot, "Unknown", "stray.flac");

    writePcmWav(unmappedLinkedPath);
    writePcmWav(genuineUnmappedPath);

    db.prepare(`
      INSERT INTO TrackFiles (
        file_path, relative_path, library_root, filename, extension, file_type,
        imported_quality, quality, artist_metadata_id
      ) VALUES (?, '01 - Track.flac', ?, '01 - Track.flac', 'flac', 'track', 'LOSSLESS', 'LOSSLESS', ?)
    `).run(linkedPath, testRoot, artistId);

    const id1 = Number(
      db.prepare(`
        INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension, file_size)
        VALUES (?, '01 - Track.flac', ?, '01 - Track.flac', 'flac', 1000)
      `).run(unmappedLinkedPath, testRoot).lastInsertRowid,
    );

    const id2 = Number(
      db.prepare(`
        INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension, file_size)
        VALUES (?, 'stray.flac', ?, 'stray.flac', 'flac', 500)
      `).run(genuineUnmappedPath, testRoot).lastInsertRowid,
    );

    const service = new UnmappedFilesService();

    assert.throws(
      () => service.deleteFiles([id2, id1]),
      (err: any) => {
        assert.ok(err instanceof RequestValidationError || err instanceof Error);
        assert.match(err.message, /path matches linked track file/i);
        return true;
      },
    );

    // Neither file must have been unlinked
    assert.equal(fs.existsSync(unmappedLinkedPath), true, "Linked file must be preserved");
    assert.equal(fs.existsSync(genuineUnmappedPath), true, "Stray file must be preserved when batch is refused");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("pruneUnmappedFiles prunes false unmapped records pointing to a linked track file case-insensitively without touching disk", async () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "prune-unmapped-ci-"));
  try {
    setCaseSensitivityOverride(testRoot, true);
    const { artistId } = seedArtistCatalog("artist-prune-1", "Prune Artist 1", "prune-1");

    const storedTrackPath = path.join(testRoot, "Charli xcx {mbid-260b6184}", "01 - In the City.flac");
    const onDiskPath = path.join(testRoot, "Charli XCX {mbid-260b6184}", "01 - In the City.flac");

    writePcmWav(onDiskPath);

    db.prepare(`
      INSERT INTO TrackFiles (
        file_path, relative_path, library_root, filename, extension, file_type,
        imported_quality, quality, artist_metadata_id
      ) VALUES (?, '01 - In the City.flac', ?, '01 - In the City.flac', 'flac', 'track', 'LOSSLESS', 'LOSSLESS', ?)
    `).run(storedTrackPath, testRoot, artistId);

    const id = Number(
      db.prepare(`
        INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension, file_size)
        VALUES (?, '01 - In the City.flac', ?, '01 - In the City.flac', 'flac', 1000)
      `).run(onDiskPath, testRoot).lastInsertRowid,
    );

    const pruned = await DiskScanService.pruneUnmappedFiles();
    assert.equal(pruned, 1, "Must prune the 1 false unmapped record");

    // The UnmappedFiles row is removed
    assert.equal(db.prepare("SELECT 1 FROM UnmappedFiles WHERE id = ?").get(id), undefined);
    // The file on disk was NEVER touched
    assert.equal(fs.existsSync(onDiskPath), true, "Real library file on disk must never be touched");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("rescan on a case-insensitive root treats paths differing in case as same track file (no unmapped, no duplicate)", async () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "rescan-ci-root-"));
  setCaseSensitivityOverride(testRoot, true);

  const artistMbid = "260b6184-8828-48eb-945c-bc4cb6fc34ca";
  const { artistId, editionMbid } = seedArtistCatalog(artistMbid, "Charli XCX", "charli-rescan");

  const origMusicPath = Config.getMusicPath;
  const origFiltering = Config.getFilteringConfig;
  Config.getMusicPath = () => testRoot;
  Config.getFilteringConfig = () => ({
    ...origFiltering(),
    include_videos: false,
    include_spatial: false,
  });

  const storedPath = path.join(testRoot, `Charli xcx {mbid-${artistMbid}}`, `In the City (2023) {mbid-${editionMbid}}`, "01 - In the City.wav");
  const onDiskPath = path.join(testRoot, `Charli XCX {mbid-${artistMbid}}`, `In the City (2023) {mbid-${editionMbid}}`, "01 - In the City.wav");

  writePcmWav(onDiskPath);

  db.prepare(`
    INSERT INTO TrackFiles (
      file_path, relative_path, library_root, filename, extension, file_type,
      imported_quality, quality, artist_metadata_id, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (?, '01 - In the City.wav', ?, '01 - In the City.wav', 'wav', 'track', 'LOSSLESS', 'LOSSLESS', ?, 'track-charli-rescan', 'recording-charli-rescan')
  `).run(storedPath, testRoot, artistId);

  // Pre-insert an unmapped file pointing to the onDiskPath to verify it gets cleaned
  db.prepare(`
    INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension, file_size)
    VALUES (?, '01 - In the City.wav', ?, '01 - In the City.wav', 'wav', 1000)
  `).run(onDiskPath, testRoot);

  try {
    const scanResult = await DiskScanService.scan({ artistIds: [String(artistId)] });

    assert.equal(scanResult.filesIndexed, 0, "Should not index as a new file");

    // No unmapped file for this track
    const unmappedRows = db.prepare("SELECT file_path FROM UnmappedFiles WHERE library_root = ?").all(testRoot) as Array<{ file_path: string }>;
    assert.deepEqual(unmappedRows, [], "Must not leave any unmapped file entries");

    // No duplicate in ExtraFiles
    const extraRows = db.prepare("SELECT file_path, file_type FROM ExtraFiles WHERE file_type = 'duplicate'").all();
    assert.deepEqual(extraRows, [], "Must not insert a duplicate into ExtraFiles");
  } finally {
    Config.getMusicPath = origMusicPath;
    Config.getFilteringConfig = origFiltering;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("RenameTrackFileService preview does not skip case-only path rename and reports no conflict", () => {
  const testRoot = fs.mkdtempSync(path.join(tempDir, "rename-ci-preview-"));
  try {
    setCaseSensitivityOverride(testRoot, true);

    const artistMbid = "f812b317-6cd1-4083-9798-b6a4e5f97400";
    const { artistId, editionMbid, rgMbid } = seedArtistCatalog(artistMbid, "ARTBAT", "artbat-preview");

    const storedPath = path.join(testRoot, `artbat {mbid-${artistMbid}}`, `In the City (2023) {mbid-${editionMbid}}`, "01 - In the City.wav");
    const onDiskPath = path.join(testRoot, `ARTBAT {mbid-${artistMbid}}`, `In the City (2023) {mbid-${editionMbid}}`, "01 - In the City.wav");

    writePcmWav(onDiskPath);

    const insert = db.prepare(`
      INSERT INTO TrackFiles (
        file_path, relative_path, library_root, filename, extension, file_type,
        imported_quality, quality, artist_metadata_id, canonical_track_mbid, canonical_recording_mbid,
        canonical_release_mbid, canonical_release_group_mbid
      ) VALUES (?, '01 - In the City.wav', ?, '01 - In the City.wav', 'wav', 'track', 'LOSSLESS', 'LOSSLESS', ?, 'track-artbat-preview', 'recording-artbat-preview', ?, ?)
    `).run(storedPath, testRoot, artistId, editionMbid, rgMbid);
    const trackFileId = Number(insert.lastInsertRowid);

    const previews = RenameTrackFileService.getRenamePreviews({
      artistId: String(artistId),
    });

    assert.equal(previews.length, 1);
    const item = previews[0];
    assert.equal(item.needs_rename, true, "Case-only difference must not be skipped");
    assert.equal(item.conflict, false, "Case-only rename of own file must not be reported as conflict");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
