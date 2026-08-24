import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-delete-"));
const musicRoot = path.join(tempDir, "music");
fs.mkdirSync(musicRoot, { recursive: true });
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let deleteModule: typeof import("./library-file-delete-service.js");
let scopeModule: typeof import("./library-deletion-scope.js");
let configModule: typeof import("../config/config.js");
let fixtures: typeof import("../../test-support/library-fixtures.js");

const ARTIST_MBID = "artist-mbid";
const ARTIST_ID = 42;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  // Point the music library root at our temp folder for path resolution.
  const current = configModule.readConfig();
  configModule.writeConfig({
    ...current,
    path: {
      ...current.path,
      music_path: musicRoot,
    },
  });
  deleteModule = await import("./library-file-delete-service.js");
  scopeModule = await import("./library-deletion-scope.js");
  fixtures = await import("../../test-support/library-fixtures.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM MetadataFileLibraries").run();
  db.prepare("DELETE FROM LyricFileLibraries").run();
  db.prepare("DELETE FROM ExtraFileLibraries").run();
  db.prepare("DELETE FROM MetadataFiles").run();
  db.prepare("DELETE FROM LyricFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  // Candidate plans outlive the monitored rows now, so the reset has to
  // drop them explicitly instead of relying on a cascade.
  db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM Libraries").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  fs.rmSync(musicRoot, { recursive: true, force: true });
  fs.mkdirSync(musicRoot, { recursive: true });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedArtist(): void {
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (?, ?, 'Artist')
    ON CONFLICT(mbid) DO UPDATE SET name = excluded.name
  `).run(ARTIST_ID, ARTIST_MBID);
}

function seedAlbum(releaseGroupMbid: string): void {
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, 'Album', 'Album')
  `).run(releaseGroupMbid, ARTIST_MBID);
}

function seedTrack(trackMbid: string, releaseGroupMbid: string): number {
  const { db } = dbModule;
  const album = db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { id: number };
  const editionMbid = `${releaseGroupMbid}-edition`;
  const recordingMbid = `${trackMbid}-recording`;
  const edition = db.prepare(`
    INSERT INTO AlbumEditions (release_group_id, mbid, release_group_mbid, artist_mbid, title)
    VALUES (?, ?, ?, ?, 'Edition')
    RETURNING id
  `).get(album.id, editionMbid, releaseGroupMbid, ARTIST_MBID) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, 'Track')
    RETURNING id
  `).get(recordingMbid, ARTIST_MBID) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      album_edition_id, mbid, release_mbid, recording_id, recording_mbid,
      title, position, medium_position
    ) VALUES (?, ?, ?, ?, ?, 'Track', 1, 1)
    RETURNING id
  `).get(edition.id, trackMbid, editionMbid, recording.id, recordingMbid) as { id: number };
  return track.id;
}

type TrackFileInput = {
  libraryId: number | null;
  relativePath: string;
  releaseGroupMbid?: string | null;
  trackMbid?: string | null;
  trackId?: number | null;
  providerId?: string | null;
  provider?: string | null;
  fileType?: string;
  librarySlot?: string;
  writeFile?: boolean;
};

function seedTrackFile(input: TrackFileInput): { id: number; filePath: string } {
  const { db } = dbModule;
  const filePath = path.join(musicRoot, input.relativePath);
  if (input.writeFile !== false) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "audio");
  }
  const row = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, file_type, library_slot, library_root, library_id,
      file_path, relative_path, filename, extension,
      canonical_release_group_mbid, canonical_track_mbid, track_id,
      provider, provider_id
    ) VALUES (?, ?, ?, 'music', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    ARTIST_ID,
    input.fileType ?? "track",
    input.librarySlot ?? "stereo",
    input.libraryId,
    filePath,
    input.relativePath,
    path.basename(filePath),
    path.extname(filePath).replace(".", ""),
    input.releaseGroupMbid ?? null,
    input.trackMbid ?? null,
    input.trackId ?? null,
    input.provider ?? null,
    input.providerId ?? null,
  ) as { id: number };
  return { id: row.id, filePath };
}

function seedExtra(input: {
  relativePath: string;
  libraryIds: number[];
  trackFileId?: number | null;
  fileType?: string;
  writeFile?: boolean;
}): { id: number; filePath: string } {
  const { db } = dbModule;
  const filePath = path.join(musicRoot, input.relativePath);
  if (input.writeFile !== false) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "cover");
  }
  const row = db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, track_file_id, relative_path, file_path, library_root,
      extension, type, file_type
    ) VALUES (?, ?, ?, ?, 'music', ?, 'cover', ?)
    RETURNING id
  `).get(
    ARTIST_ID,
    input.trackFileId ?? null,
    input.relativePath,
    filePath,
    path.extname(filePath).replace(".", ""),
    input.fileType ?? "cover",
  ) as { id: number };
  const associate = db.prepare(`
    INSERT OR IGNORE INTO MetadataFileLibraries (metadata_file_id, library_id) VALUES (?, ?)
  `);
  for (const libraryId of input.libraryIds) {
    associate.run(row.id, libraryId);
  }
  return { id: row.id, filePath };
}

function countTrackFiles(): number {
  return (dbModule.db.prepare("SELECT COUNT(*) AS c FROM TrackFiles").get() as { c: number }).c;
}

function extraLibraryIds(metadataFileId: number): number[] {
  return (dbModule.db.prepare(`
    SELECT library_id FROM MetadataFileLibraries WHERE metadata_file_id = ? ORDER BY library_id
  `).all(metadataFileId) as Array<{ library_id: number }>).map((row) => row.library_id);
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

test("deletion refuses to run without an explicit library scope", () => {
  seedArtist();
  seedAlbum("rg-scope");
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  assert.throws(
    () => deleteModule.deleteReleaseGroupLibraryFiles("rg-scope", {}),
    /explicit target Library/,
  );
});

test("an omitted libraryId never resolves to every library", () => {
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  assert.throws(
    () => scopeModule.deletionScopeFromRequest({}),
    /2 libraries are configured/,
  );
});

test("a single configured library resolves implicitly at the request boundary", () => {
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  assert.deepEqual(scopeModule.deletionScopeFromRequest({}), { kind: "library", libraryId });
});

test("an explicit allLibraries request is a distinct named operation", () => {
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  assert.deepEqual(
    scopeModule.deletionScopeFromRequest({ allLibraries: "true" }),
    { kind: "all-libraries" },
  );
  assert.throws(
    () => scopeModule.deletionScopeFromRequest({ libraryId: 1, allLibraries: true }),
    /either libraryId or allLibraries/,
  );
});

test("an unknown libraryId fails closed rather than deleting everything", () => {
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  assert.throws(
    () => scopeModule.deletionScopeFromRequest({ libraryId: 9999 }),
    /Library 9999 does not exist/,
  );
});

// ---------------------------------------------------------------------------
// Library-scoped album, artist, track and video deletion
// ---------------------------------------------------------------------------

test("deleting an album from one library preserves the other library sharing the root", () => {
  seedArtist();
  seedAlbum("rg-shared");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  const flac = seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-shared",
  });
  const mp3 = seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-shared",
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-shared", { libraryId: lossless });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(flac.filePath), false);
  assert.equal(fs.existsSync(mp3.filePath), true);
  assert.equal(countTrackFiles(), 1);
  assert.equal(
    (dbModule.db.prepare("SELECT library_id FROM TrackFiles").get() as { library_id: number }).library_id,
    lossy,
  );
});

test("explicit all-library album deletion removes both libraries' files", () => {
  seedArtist();
  seedAlbum("rg-all");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  const flac = seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-all",
  });
  const mp3 = seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-all",
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-all", { allLibraries: true });

  assert.equal(result.deleted, 2);
  assert.equal(fs.existsSync(flac.filePath), false);
  assert.equal(fs.existsSync(mp3.filePath), false);
  assert.equal(countTrackFiles(), 0);
});

test("deleting an artist's files is scoped to one library", () => {
  seedArtist();
  seedAlbum("rg-artist");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  const flac = seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-artist",
  });
  const mp3 = seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-artist",
  });

  const result = deleteModule.deleteArtistLibraryFiles(String(ARTIST_ID), { libraryId: lossy });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(flac.filePath), true);
  assert.equal(fs.existsSync(mp3.filePath), false);
});

test("deleting a track's files is scoped to one library", () => {
  seedArtist();
  seedAlbum("rg-track");
  const trackId = seedTrack("track-mbid", "rg-track");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  const flac = seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-track",
    trackMbid: "track-mbid",
    trackId,
  });
  const mp3 = seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-track",
    trackMbid: "track-mbid",
    trackId,
  });

  const result = deleteModule.deleteTrackLibraryFiles("track-mbid", { libraryId: lossless });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(flac.filePath), false);
  assert.equal(fs.existsSync(mp3.filePath), true);
});

test("a provider id that collides with a canonical track mbid is not deleted", () => {
  seedArtist();
  seedAlbum("rg-collision");
  const trackId = seedTrack("track-mbid", "rg-collision");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const canonical = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Wanted.flac"),
    releaseGroupMbid: "rg-collision",
    trackMbid: "track-mbid",
    trackId,
  });
  // A completely unrelated file whose provider-native id happens to equal the
  // canonical Track MBID. The old `OR provider_id = ?` predicate deleted it.
  const collision = seedTrackFile({
    libraryId,
    relativePath: path.join("Other Artist", "Other Album", "01 Unrelated.flac"),
    provider: "tidal",
    providerId: "track-mbid",
  });

  const result = deleteModule.deleteTrackLibraryFiles("track-mbid", { libraryId });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(canonical.filePath), false);
  assert.equal(fs.existsSync(collision.filePath), true);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS c FROM TrackFiles WHERE id = ?")
      .get(collision.id) as { c: number }).c,
    1,
  );
});

test("video deletion resolves the canonical recording within one library", () => {
  seedArtist();
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const videoLibrary = fixtures.seedTestLibrary(dbModule.db, { name: "Videos", rootPath: musicRoot });
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, is_video) VALUES ('video-mbid', 'Clip', 1)
    RETURNING id
  `).get() as { id: number };

  const owned = seedTrackFile({
    libraryId: videoLibrary,
    relativePath: path.join("Artist", "Videos", "Clip.mp4"),
    fileType: "video",
  });
  const other = seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Videos", "Clip 1080p.mp4"),
    fileType: "video",
  });
  dbModule.db.prepare("UPDATE TrackFiles SET recording_id = ? WHERE id IN (?, ?)")
    .run(recording.id, owned.id, other.id);

  const result = deleteModule.deleteVideoLibraryFiles("video-mbid", { libraryId: videoLibrary });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(owned.filePath), false);
  assert.equal(fs.existsSync(other.filePath), true);
});

// ---------------------------------------------------------------------------
// Unassigned (legacy) rows
// ---------------------------------------------------------------------------

test("an unassigned file is adopted only when exactly one library root owns it", () => {
  seedArtist();
  seedAlbum("rg-legacy");
  const soleLibrary = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const legacy = seedTrackFile({
    libraryId: null,
    relativePath: path.join("Artist", "Album", "01 Legacy.flac"),
    releaseGroupMbid: "rg-legacy",
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-legacy", { libraryId: soleLibrary });
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(legacy.filePath), false);
});

test("an unassigned file under a shared root is left alone by a scoped deletion", () => {
  seedArtist();
  seedAlbum("rg-ambiguous");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  const legacy = seedTrackFile({
    libraryId: null,
    relativePath: path.join("Artist", "Album", "01 Legacy.flac"),
    releaseGroupMbid: "rg-ambiguous",
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-ambiguous", { libraryId: lossless });

  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(legacy.filePath), true);
  assert.equal(countTrackFiles(), 1);
});

// ---------------------------------------------------------------------------
// Shared extras
// ---------------------------------------------------------------------------

test("a shared cover survives the first library's deletion and is removed with the last", () => {
  seedArtist();
  seedAlbum("rg-cover");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-cover",
  });
  seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-cover",
  });
  const cover = seedExtra({
    relativePath: path.join("Artist", "Album", "cover.jpg"),
    libraryIds: [lossless, lossy],
  });

  const first = deleteModule.deleteReleaseGroupLibraryFiles("rg-cover", { libraryId: lossless });
  assert.equal(first.extras.released, 1);
  assert.equal(first.extras.retained, 1);
  assert.equal(first.extras.deleted, 0);
  assert.equal(fs.existsSync(cover.filePath), true);
  assert.deepEqual(extraLibraryIds(cover.id), [lossy]);

  const second = deleteModule.deleteReleaseGroupLibraryFiles("rg-cover", { libraryId: lossy });
  assert.equal(second.extras.released, 1);
  assert.equal(second.extras.deleted, 1);
  assert.equal(fs.existsSync(cover.filePath), false);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS c FROM MetadataFiles").get() as { c: number }).c,
    0,
  );
});

test("a cover owned by another library is not released by a scoped deletion", () => {
  seedArtist();
  seedAlbum("rg-foreign-cover");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-foreign-cover",
  });
  const cover = seedExtra({
    relativePath: path.join("Artist", "Album", "cover.jpg"),
    libraryIds: [lossy],
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-foreign-cover", { libraryId: lossless });

  assert.equal(result.extras.released, 0);
  assert.equal(result.extras.retained, 1);
  assert.equal(fs.existsSync(cover.filePath), true);
  assert.deepEqual(extraLibraryIds(cover.id), [lossy]);
});

test("a track-linked lyric file follows its playable file", () => {
  seedArtist();
  seedAlbum("rg-lyrics");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const trackFile = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-lyrics",
  });
  const lyrics = seedExtra({
    relativePath: path.join("Artist", "Album", "01 Track.lrc"),
    libraryIds: [libraryId],
    trackFileId: trackFile.id,
    fileType: "lyrics",
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-lyrics", { libraryId });

  assert.equal(result.extras.deleted, 1);
  assert.equal(fs.existsSync(lyrics.filePath), false);
});

// ---------------------------------------------------------------------------
// Filesystem safety
// ---------------------------------------------------------------------------

test("a failed physical deletion leaves the database row in place", () => {
  seedArtist();
  seedAlbum("rg-fs-failure");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const trackFile = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-fs-failure",
  });

  const realRm = fs.rmSync;
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) === trackFile.filePath) {
      throw new Error("EPERM: operation not permitted");
    }
    return realRm(target, options);
  }) as typeof fs.rmSync;

  try {
    const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-fs-failure", { libraryId });
    assert.equal(result.errors, 1);
    assert.equal(result.deleted, 0);
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = realRm;
  }

  assert.equal(fs.existsSync(trackFile.filePath), true);
  assert.equal(countTrackFiles(), 1);
});

test("an unmanaged user file keeps the album directory in place", () => {
  seedArtist();
  seedAlbum("rg-unmanaged");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const trackFile = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-unmanaged",
  });
  const unmanaged = path.join(path.dirname(trackFile.filePath), "notes.txt");
  fs.writeFileSync(unmanaged, "user notes");

  deleteModule.deleteReleaseGroupLibraryFiles("rg-unmanaged", { libraryId });

  assert.equal(fs.existsSync(trackFile.filePath), false);
  assert.equal(fs.existsSync(unmanaged), true);
  assert.equal(fs.existsSync(path.dirname(trackFile.filePath)), true);
});

test("a missing file still clears its database row and reports the gap", () => {
  seedArtist();
  seedAlbum("rg-missing");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Gone.flac"),
    releaseGroupMbid: "rg-missing",
    writeFile: false,
  });

  const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-missing", { libraryId });

  assert.equal(result.missing, 1);
  assert.equal(result.deleted, 0);
  assert.equal(countTrackFiles(), 0);
});

// ---------------------------------------------------------------------------
// Provider cleanup never removes local media
// ---------------------------------------------------------------------------

test("deleting a provider item leaves the local file and nulls its provenance", () => {
  seedArtist();
  seedAlbum("rg-provider");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const { db } = dbModule;

  const item = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'track', '12345', 'Track')
    RETURNING id
  `).get() as { id: number };

  const trackFile = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-provider",
    provider: "tidal",
    providerId: "12345",
  });
  db.prepare("UPDATE TrackFiles SET provider_item_id = ? WHERE id = ?").run(item.id, trackFile.id);

  db.prepare("DELETE FROM ProviderItems WHERE id = ?").run(item.id);

  assert.equal(fs.existsSync(trackFile.filePath), true);
  const row = db.prepare("SELECT provider_item_id FROM TrackFiles WHERE id = ?")
    .get(trackFile.id) as { provider_item_id: number | null };
  assert.equal(row.provider_item_id, null);
});

// ---------------------------------------------------------------------------
// Linked-extra ordering and root containment
// ---------------------------------------------------------------------------

test("deleting one track removes only its own linked extras", () => {
  seedArtist();
  seedAlbum("rg-linked");
  const trackOneId = seedTrack("track-one", "rg-linked");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  // Two playable tracks in one folder, each with its own lyric sidecar.
  const trackOne = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 One.flac"),
    releaseGroupMbid: "rg-linked",
    trackMbid: "track-one",
    trackId: trackOneId,
  });
  const trackTwo = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "02 Two.flac"),
    releaseGroupMbid: "rg-linked",
  });
  const lyricsOne = seedExtra({
    relativePath: path.join("Artist", "Album", "01 One.lrc"),
    libraryIds: [libraryId],
    trackFileId: trackOne.id,
    fileType: "lyrics",
  });
  const lyricsTwo = seedExtra({
    relativePath: path.join("Artist", "Album", "02 Two.lrc"),
    libraryIds: [libraryId],
    trackFileId: trackTwo.id,
    fileType: "lyrics",
  });

  const result = deleteModule.deleteTrackLibraryFiles("track-one", { libraryId });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(trackOne.filePath), false);
  assert.equal(fs.existsSync(trackTwo.filePath), true);
  // The extras FK is ON DELETE SET NULL, so reading the link after deleting the
  // playable row would have found nothing and left this file behind.
  assert.equal(fs.existsSync(lyricsOne.filePath), false, "the deleted track's lyrics must go");
  assert.equal(fs.existsSync(lyricsTwo.filePath), true, "the surviving track keeps its lyrics");
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS c FROM MetadataFiles WHERE id = ?")
      .get(lyricsOne.id) as { c: number }).c,
    0,
  );
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS c FROM MetadataFiles WHERE id = ?")
      .get(lyricsTwo.id) as { c: number }).c,
    1,
  );
});

test("a row pointing outside the target library root is refused", () => {
  seedArtist();
  seedAlbum("rg-outside");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  // A stale/corrupt row whose path escaped the managed root entirely.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-outside-"));
  const outsidePath = path.join(outsideDir, "Escaped.flac");
  fs.writeFileSync(outsidePath, "audio");
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, file_type, library_slot, library_root, library_id,
      file_path, relative_path, filename, extension, canonical_release_group_mbid
    ) VALUES (?, 'track', 'stereo', ?, ?, ?, 'Escaped.flac', 'Escaped.flac', 'flac', ?)
  `).run(ARTIST_ID, outsideDir, libraryId, outsidePath, "rg-outside");

  try {
    const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-outside", { libraryId });

    assert.equal(result.skippedOutsideRoot, 1);
    assert.equal(result.deleted, 0);
    assert.equal(fs.existsSync(outsidePath), true, "a path outside the root is never removed");
    assert.equal(countTrackFiles(), 1, "and its row survives with it");
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("a folder-level cover survives while another library still has media there", () => {
  seedArtist();
  seedAlbum("rg-folder-shared");
  const lossless = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });
  const lossy = fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: musicRoot });

  seedTrackFile({
    libraryId: lossless,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-folder-shared",
  });
  seedTrackFile({
    libraryId: lossy,
    relativePath: path.join("Artist", "Album", "01 Track.mp3"),
    releaseGroupMbid: "rg-folder-shared",
  });
  // A legacy folder extra with no association rows at all.
  const cover = seedExtra({
    relativePath: path.join("Artist", "Album", "cover.jpg"),
    libraryIds: [],
  });

  deleteModule.deleteReleaseGroupLibraryFiles("rg-folder-shared", { libraryId: lossless });

  assert.equal(
    fs.existsSync(cover.filePath),
    true,
    "the lossy library still has media in this folder",
  );
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS c FROM MetadataFiles WHERE id = ?")
      .get(cover.id) as { c: number }).c,
    1,
  );
});

test("a failed physical deletion leaves the linked extras alone too", () => {
  seedArtist();
  seedAlbum("rg-fs-extras");
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: musicRoot });

  const trackFile = seedTrackFile({
    libraryId,
    relativePath: path.join("Artist", "Album", "01 Track.flac"),
    releaseGroupMbid: "rg-fs-extras",
  });
  const lyrics = seedExtra({
    relativePath: path.join("Artist", "Album", "01 Track.lrc"),
    libraryIds: [libraryId],
    trackFileId: trackFile.id,
    fileType: "lyrics",
  });

  const realRm = fs.rmSync;
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) === trackFile.filePath) throw new Error("EPERM");
    return realRm(target, options);
  }) as typeof fs.rmSync;
  try {
    const result = deleteModule.deleteReleaseGroupLibraryFiles("rg-fs-extras", { libraryId });
    assert.equal(result.errors, 1);
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = realRm;
  }

  assert.equal(fs.existsSync(trackFile.filePath), true);
  assert.equal(fs.existsSync(lyrics.filePath), true, "the sidecar follows its file, not the attempt");
  assert.equal(countTrackFiles(), 1);
});
