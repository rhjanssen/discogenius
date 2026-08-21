import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectVideoInVideoLibraries } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-prune-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { LibraryFilesService } = await import("./library-files.js");

function reset() {
  for (const t of [
    "TrackFiles", "LibraryVideos", "LibraryEditions", "LibraryAlbums",
    "ProviderVideoMatches", "ProviderItems", "Tracks", "Recordings", "AlbumEditions",
    "Albums", "Artists", "ArtistMetadata",
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}
beforeEach(reset);
afterEach(reset);

let testLibraryId = 0;

function seedArtist() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("art1", "Prune Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Prune Artist");
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Prune Canonical', '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    )
    SELECT
      'Prune Canonical',
      'C:/lib',
      metadata_profile.id,
      quality_profile.id,
      1
    FROM MetadataProfiles metadata_profile
    JOIN quality_profiles quality_profile
      ON NOT EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      )
    WHERE metadata_profile.name = 'Prune Canonical'
    ORDER BY quality_profile.id
    LIMIT 1
  `).run();
  testLibraryId = (db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Prune Canonical'
  `).get() as { id: number }).id;
}

function seedLibraryGroup(rg: string, monitored: number, lock = 0) {
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'album')`)
    .run(rg, "artist-mbid", `RG ${rg}`);
  // Unmonitored means no row at all — there is no monitored column to set to 0.
  if (monitored) {
    db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, selection_mode, locked, curation_version
      )
      SELECT ?, id, 'auto', ?, 1
      FROM Albums
      WHERE mbid = ?
    `).run(testLibraryId, lock, rg);
  }
}

function seedVideoRecording(monitored: number, providerId: string) {
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
    RETURNING id
  `).get(`mb-video-${providerId}`, "A Video", "artist-mbid") as { id: number };
  // A LibraryVideos row is the monitoring statement; unmonitored means none.
  if (monitored) selectVideoInVideoLibraries(db, recording.id);
  const providerItem = db.prepare(`INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', ?, 'A Video')
    RETURNING id`).get(providerId) as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerItem.id, recording.id);
  return recording.id;
}

let tfId = 0;
function insertFile(o: {
  fileType: string; slot: string; rg?: string | null; rec?: string | null;
  recordingId?: number | null;
  providerEntityType?: string | null; providerId?: string | null;
  albumEditionId?: number | null;
  releaseMbid?: string | null;
  quality?: string | null;
}) {
  tfId += 1;
  const info = db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id, album_edition_id,
      recording_id,
      canonical_release_group_mbid, canonical_release_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "art1",
    o.rg ? testLibraryId : null,
    o.rg ? (db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(o.rg) as { id: number }).id : null,
    o.albumEditionId ?? null,
    o.recordingId ?? null,
    o.rg ?? null,
    o.releaseMbid ?? null,
    o.rec ?? null,
    o.providerId ? "tidal" : null, o.providerEntityType ?? null, o.providerId ?? null, o.slot,
    `C:/lib/f${tfId}`, `f${tfId}`, "C:/lib", `f${tfId}`, "flac", o.fileType, o.quality ?? null,
  );
  return Number(info.lastInsertRowid);
}

test("selectUnmonitoredFileRows keeps monitored/locked anchors and selects only unmonitored, classifiable files", () => {
  seedArtist();
  seedLibraryGroup("rg-mon", 1);
  seedLibraryGroup("rg-unmon", 0);
  // A lock lives on the LibraryAlbums row, so it cannot outlive monitoring: an
  // unmonitored-but-locked Album is unrepresentable now, and the locked case
  // that matters is a monitored Album the user pinned.
  seedLibraryGroup("rg-lock", 1, 1);
  const monitoredVideoRecordingId = seedVideoRecording(1, "vp-mon");
  const unmonitoredVideoRecordingId = seedVideoRecording(0, "vp-unmon");

  const fMonAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-mon" });        // keep
  const fUnmonAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-unmon" });     // SELECT
  const fLockAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-lock" });       // keep (monitored + locked)
  const fMonVideo = insertFile({
    fileType: "video",
    slot: "video",
    recordingId: monitoredVideoRecordingId,
    providerEntityType: "video",
    providerId: "vp-mon",
  }); // keep
  const fUnmonVideo = insertFile({
    fileType: "video",
    slot: "video",
    recordingId: unmonitoredVideoRecordingId,
    providerEntityType: "video",
    providerId: "vp-unmon",
  }); // SELECT
  const fNoAnchor = insertFile({ fileType: "track", slot: "stereo" });                       // keep (unclassifiable)

  const selectedIds = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id).sort((a, b) => a - b);

  assert.deepEqual(selectedIds, [fUnmonAudio, fUnmonVideo].sort((a, b) => a - b));
  // Sanity: the kept ones are absent.
  for (const keptId of [fMonAudio, fLockAudio, fMonVideo, fNoAnchor]) {
    assert.equal(selectedIds.includes(keptId), false, `file ${keptId} should be kept`);
  }
});

test("an unmonitored library release group does not affect monitored sibling release groups", () => {
  seedArtist();
  seedLibraryGroup("rg-a", 1);
  seedLibraryGroup("rg-b", 0);
  const keep = insertFile({ fileType: "track", slot: "stereo", rg: "rg-a" });
  const select = insertFile({ fileType: "track", slot: "stereo", rg: "rg-b" });

  const ids = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id);
  assert.deepEqual(ids, [select]);
  assert.equal(ids.includes(keep), false);
});

test("files of an unmonitored edition are pruned even when the album stays monitored", () => {
  seedArtist();
  seedLibraryGroup("rg-bad-blood", 1);
  const albumId = (db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bad-blood'").get() as { id: number }).id;
  const dutch = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-dutch', ?, 'rg-bad-blood', 'artist-mbid', 'Bad Blood', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  const deluxe = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-x', ?, 'rg-bad-blood', 'artist-mbid', 'Bad Blood X', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, curation_version
    ) VALUES (?, ?, 'manual', 1, 1)
  `).run(testLibraryId, dutch.id);

  const keep = insertFile({
    fileType: "track",
    slot: "stereo",
    rg: "rg-bad-blood",
    albumEditionId: dutch.id,
    releaseMbid: "ed-dutch",
  });
  const prune = insertFile({
    fileType: "track",
    slot: "stereo",
    rg: "rg-bad-blood",
    albumEditionId: deluxe.id,
    releaseMbid: "ed-x",
  });

  const ids = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id);
  assert.deepEqual(ids, [prune]);
  assert.equal(ids.includes(keep), false);
});

test("duplicate leftover files that fill a monitored edition hole keep the best copy", () => {
  seedArtist();
  seedLibraryGroup("rg-bad-blood", 1);
  const albumId = (db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bad-blood'").get() as { id: number }).id;
  const dutch = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-dutch-hole', ?, 'rg-bad-blood', 'artist-mbid', 'Bad Blood', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  const deluxe = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-x-hole', ?, 'rg-bad-blood', 'artist-mbid', 'Bad Blood X', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  const older = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-2014-hole', ?, 'rg-bad-blood', 'artist-mbid', 'All This Bad Blood', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, curation_version
    ) VALUES (?, ?, 'manual', 1, 1)
  `).run(testLibraryId, dutch.id);

  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES ('rec-oblivion', 'Oblivion', 'artist-mbid', 0)
    RETURNING id
  `).get() as { id: number };
  const bonusRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES ('rec-bonus', 'Bonus Track', 'artist-mbid', 0)
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES ('trk-dutch-oblivion', ?, 'ed-dutch-hole', ?, 'rec-oblivion', 1, 1, 'Oblivion')
  `).run(dutch.id, recording.id);
  db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES ('trk-x-oblivion', ?, 'ed-x-hole', ?, 'rec-oblivion', 1, 1, 'Oblivion')
  `).run(deluxe.id, recording.id);
  db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES ('trk-x-bonus', ?, 'ed-x-hole', ?, 'rec-bonus', 1, 2, 'Bonus Track')
  `).run(deluxe.id, bonusRecording.id);

  const keepFiller = insertFile({
    fileType: "track",
    slot: "stereo",
    rg: "rg-bad-blood",
    albumEditionId: older.id,
    releaseMbid: "ed-2014-hole",
    recordingId: recording.id,
    quality: "HIRES_LOSSLESS",
  });
  const pruneDuplicate = insertFile({
    fileType: "track",
    slot: "stereo",
    rg: "rg-bad-blood",
    albumEditionId: deluxe.id,
    releaseMbid: "ed-x-hole",
    recordingId: recording.id,
    quality: "LOSSLESS",
  });
  const pruneBonus = insertFile({
    fileType: "track",
    slot: "stereo",
    rg: "rg-bad-blood",
    albumEditionId: deluxe.id,
    releaseMbid: "ed-x-hole",
    recordingId: bonusRecording.id,
    quality: "LOSSLESS",
  });

  const ids = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [pruneDuplicate, pruneBonus].sort((a, b) => a - b));
  assert.equal(ids.includes(keepFiller), false);
});

test("unmonitored edition folders lose untracked extra media when cleanup is on", () => {
  seedArtist();
  seedLibraryGroup("rg-bad-blood", 1);
  const albumId = (db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bad-blood'").get() as { id: number }).id;
  const deluxe = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-x-live', ?, 'rg-bad-blood', 'artist-mbid', 'Bad Blood X', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  const leftover = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES ('ed-2014-live', ?, 'rg-bad-blood', 'artist-mbid', 'All This Bad Blood', 1)
    RETURNING id
  `).get(albumId) as { id: number };
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, curation_version
    ) VALUES (?, ?, 'manual', 1, 1)
  `).run(testLibraryId, deluxe.id);

  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES ('rec-oblivion-live', 'Oblivion', 'artist-mbid', 0)
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES ('trk-x-oblivion-live', ?, 'ed-x-live', ?, 'rec-oblivion-live', 1, 1, 'Oblivion')
  `).run(deluxe.id, recording.id);

  const leftoverDir = path.join(tempDir, "All This Bad Blood (2014)");
  fs.mkdirSync(leftoverDir, { recursive: true });
  const holeFillPath = path.join(leftoverDir, "108 - Oblivion.flac");
  const extraPath = path.join(leftoverDir, "101 - Pompeii.flac");
  fs.writeFileSync(holeFillPath, "hole-fill");
  fs.writeFileSync(extraPath, "untracked-extra");

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id, album_edition_id, recording_id,
      canonical_release_group_mbid, canonical_release_mbid, canonical_recording_mbid,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "art1",
    testLibraryId,
    albumId,
    leftover.id,
    recording.id,
    "rg-bad-blood",
    "ed-2014-live",
    "rec-oblivion-live",
    "stereo",
    holeFillPath,
    path.relative(tempDir, holeFillPath),
    tempDir,
    "108 - Oblivion.flac",
    "flac",
    "track",
    "LOSSLESS",
  );

  const result = LibraryFilesService.pruneUnmonitoredFiles("art1");
  assert.equal(fs.existsSync(holeFillPath), true, "hole-fill copy of the missing monitored track stays");
  assert.equal(fs.existsSync(extraPath), false, "untracked extra in the unmonitored folder is removed");
  assert.ok(result.deleted >= 1);
});
