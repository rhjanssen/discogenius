import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-command-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let serviceModule: typeof import("./album-command-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  // Multi-library contract tests need Spatial enabled (default Settings leave
  // include_spatial off → Spatial library disabled at bootstrap).
  dbModule.db.prepare(`
    UPDATE Libraries SET enabled = 1 WHERE name = 'Spatial'
  `).run();
  serviceModule = await import("./album-command-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM DownloadQueue").run();
  db.prepare("DELETE FROM ProviderTrackMatches").run();
  db.prepare("DELETE FROM ProviderEditionMatches").run();
  db.prepare("DELETE FROM ProviderEditionMembers").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-mbid-1', 'Artist One')").run();
  db.prepare("INSERT INTO Artists (id, mbid, name, monitored) VALUES ('artist-1', 'artist-mbid-1', 'Artist One', 1)").run();
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (1, 'release-group-mbid-1', 1, 'artist-mbid-1', 'Album One', 'Album')
  `).run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function libraryId(name: string): number {
  return (dbModule.db.prepare("SELECT id FROM Libraries WHERE name = ?")
    .get(name) as { id: number }).id;
}

function monitoredLibraryIds(): number[] {
  return (dbModule.db.prepare(`
    SELECT library_id FROM LibraryAlbums WHERE release_group_id = 1 ORDER BY library_id
  `).all() as Array<{ library_id: number }>).map((row) => row.library_id);
}

test("an explicit all-libraries monitor reaches every audio library and no video library", () => {
  const providerResult = serviceModule.AlbumCommandService.setAlbumMonitored(
    "provider-album-1", true, { kind: "all-audio-libraries" },
  );
  assert.equal(providerResult.status, 404);

  const result = serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "all-audio-libraries" },
  );
  assert.equal(result.success, true);

  const rows = dbModule.db.prepare(`
    SELECT library.name, library_album.selection_mode
    FROM LibraryAlbums library_album
    JOIN Libraries library ON library.id = library_album.library_id
    WHERE library_album.release_group_id = 1
    ORDER BY library.name
  `).all() as Array<{ name: string; selection_mode: string }>;
  assert.deepEqual(rows.map((row) => row.name), ["Spatial", "Stereo"]);
  assert.ok(rows.every((row) => row.selection_mode === "manual"));
});

test("monitoring one library leaves the others exactly as they were", () => {
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: libraryId("Stereo") },
  );
  assert.deepEqual(monitoredLibraryIds(), [libraryId("Stereo")]);

  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: libraryId("Spatial") },
  );
  assert.deepEqual(
    monitoredLibraryIds().sort((a, b) => a - b),
    [libraryId("Stereo"), libraryId("Spatial")].sort((a, b) => a - b),
  );

  // Unmonitoring Stereo must not withdraw Spatial.
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", false, { kind: "library", libraryId: libraryId("Stereo") },
  );
  assert.deepEqual(monitoredLibraryIds(), [libraryId("Spatial")]);
});

test("locking an unmonitored album creates no library album row", () => {
  const result = serviceModule.AlbumCommandService.updateAlbum(
    "release-group-mbid-1", undefined, true, { kind: "all-audio-libraries" },
  );
  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  // A lock protects a monitored Album. With nothing monitored there is nothing
  // to protect, and a row created to hold the lock would claim otherwise.
  assert.deepEqual(monitoredLibraryIds(), []);
});

test("locking one library does not touch another library's row", () => {
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "all-audio-libraries" },
  );
  serviceModule.AlbumCommandService.updateAlbum(
    "release-group-mbid-1", undefined, true, { kind: "library", libraryId: libraryId("Stereo") },
  );

  const locks = dbModule.db.prepare(`
    SELECT library.name, library_album.locked
    FROM LibraryAlbums library_album
    JOIN Libraries library ON library.id = library_album.library_id
    WHERE library_album.release_group_id = 1
    ORDER BY library.name
  `).all() as Array<{ name: string; locked: number }>;
  assert.deepEqual(locks, [
    { name: "Spatial", locked: 0 },
    { name: "Stereo", locked: 1 },
  ]);
});

test("unmonitoring an album withdraws the editions monitored under it", () => {
  const stereo = libraryId("Stereo");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title
    )
    VALUES (10, 'edition-mbid-1', 1, 'release-group-mbid-1', 'artist-mbid-1', 'Album One')
  `).run();
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: stereo },
  );
  dbModule.db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version)
    VALUES (?, 10, 'manual', 1)
  `).run(stereo);

  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", false, { kind: "library", libraryId: stereo },
  );

  // An Edition monitored inside an unmonitored Album is the contradiction row
  // existence exists to prevent.
  assert.deepEqual(monitoredLibraryIds(), []);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM LibraryEditions WHERE edition_id = 10")
      .get() as { n: number }).n,
    0,
  );
});

test("monitor-only album add succeeds without reconstructing a legacy provider plan", async () => {
  const result = await serviceModule.AlbumCommandService.addAlbum(
    "release-group-mbid-1",
    false,
    "stereo",
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.commandIds, []);
});

test("monitor-and-download for a track enqueues a wait row, not a command", async () => {
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title
    ) VALUES (10, 'edition-mbid-track', 1, 'release-group-mbid-1', 'artist-mbid-1', 'Album One')
  `).run();
  db.prepare(`
    INSERT INTO Recordings (id, mbid, artist_mbid, title, is_video, metadata_status)
    VALUES (20, 'recording-mbid-1', 'artist-mbid-1', 'Pompeii', 0, 'complete')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, number, title
    ) VALUES (30, 'track-mbid-1', 10, 'edition-mbid-track', 20, 'recording-mbid-1', 1, 1, '1', 'Pompeii')
  `).run();
  const providerItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', 'tidal-track-1', 'Pompeii', 'available')
    RETURNING id
  `).get() as { id: number };
  const releaseItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'release', 'tidal-album-1', 'Album One', 'available')
    RETURNING id
  `).get() as { id: number };
  const member = db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(releaseItem.id, providerItem.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, 10, 'exact', 'accepted', 'automatic', 0.99, 'test_fixture', 1)
    RETURNING id
  `).get(releaseItem.id) as { id: number };
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
      track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, 30, 20, 'accepted', 'automatic', 0.99, 'test_fixture', 1)
  `).run(providerItem.id, member.id, releaseMatch.id);

  const result = await serviceModule.AlbumCommandService.monitorTrack("30", true);
  assert.equal(result.success, true);
  assert.ok(result.commandId && result.commandId > 0);

  const wait = db.prepare(`
    SELECT id, media_kind, command_name, command_id FROM DownloadQueue WHERE id = ?
  `).get(result.commandId) as {
    id: number;
    media_kind: string;
    command_name: string;
    command_id: number | null;
  } | undefined;
  assert.ok(wait);
  assert.equal(wait.media_kind, "track");
  assert.equal(wait.command_name, "DownloadTrack");
  assert.equal(wait.command_id, null);

  const commandCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM commands WHERE name = 'DownloadTrack'
  `).get() as { n: number }).n;
  assert.equal(commandCount, 0);
});

test("unmonitoring an album deletes its files and duplicate extras when cleanup is on", async () => {
  const { updateConfig } = await import("../config/config.js");
  updateConfig("monitoring", { remove_unmonitored_files: true });
  try {
    const { db } = dbModule;
    const stereoId = libraryId("Stereo");
    const edition = db.prepare(`
      INSERT INTO AlbumEditions (
        mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
      ) VALUES ('ed-heartache-pt2', 1, 'release-group-mbid-1', 'artist-mbid-1', 'Heartache Pt. 2', 1)
      RETURNING id
    `).get() as { id: number };
    db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, selection_mode, locked, curation_version
      ) VALUES (?, 1, 'manual', 0, 1)
    `).run(stereoId);
    db.prepare(`
      INSERT INTO LibraryEditions (
        library_id, edition_id, selection_mode, representative, curation_version
      ) VALUES (?, ?, 'manual', 1, 1)
    `).run(stereoId, edition.id);

    const albumDir = path.join(tempDir, "Heartache Pt. 2");
    fs.mkdirSync(albumDir, { recursive: true });
    const m4aPath = path.join(albumDir, "01 - Tuning In.m4a");
    const mp3Path = path.join(albumDir, "01 - Tuning In.mp3");
    fs.writeFileSync(m4aPath, "primary");
    fs.writeFileSync(mp3Path, "duplicate");

    db.prepare(`
      INSERT INTO TrackFiles (
        artist_id, library_id, release_group_id, album_edition_id,
        canonical_release_group_mbid, canonical_release_mbid,
        library_slot, file_path, relative_path, library_root, filename, extension, file_type, quality
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "artist-1",
      stereoId,
      edition.id,
      "release-group-mbid-1",
      "ed-heartache-pt2",
      "stereo",
      m4aPath,
      path.relative(tempDir, m4aPath),
      tempDir,
      "01 - Tuning In.m4a",
      "m4a",
      "track",
      "LOSSY",
    );
    const trackFileId = Number(
      (db.prepare("SELECT id FROM TrackFiles WHERE file_path = ?").get(m4aPath) as { id: number }).id,
    );
    db.prepare(`
      INSERT INTO ExtraFiles (
        artist_id, track_file_id, relative_path, file_path, library_root,
        extension, file_type, library_slot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "artist-1",
      trackFileId,
      path.relative(tempDir, mp3Path),
      mp3Path,
      tempDir,
      "mp3",
      "duplicate",
      "stereo",
    );

    const result = serviceModule.AlbumCommandService.setAlbumMonitored(
      "release-group-mbid-1",
      false,
      { kind: "library", libraryId: stereoId },
    );
    assert.equal(result.success, true);
    assert.equal(fs.existsSync(m4aPath), false, "unmonitored album audio is deleted");
    assert.equal(fs.existsSync(mp3Path), false, "duplicate extra leaves with the album");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM ExtraFiles").get() as { n: number }).n,
      0,
    );
  } finally {
    updateConfig("monitoring", { remove_unmonitored_files: false });
  }
});
