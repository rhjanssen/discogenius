import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-organizer-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let organizerModule: typeof import("./organizer.js");
let configModule: typeof import("../config/config.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  organizerModule = await import("./organizer.js");
  configModule = await import("../config/config.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM MetadataFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();

  const config = configModule.readConfig();
  config.metadata.save_album_cover = true;
  config.metadata.save_artist_picture = true;
  config.metadata.save_video_thumbnail = true;
  config.metadata.save_nfo = true;
  config.metadata.save_lyrics = true;
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("organizer resolves exact provider track ids to their linked canonical track", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 2);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track-2",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "track-2",
    "recording-2",
    "Track Two",
    "matched",
    1,
  );

  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "provider-track-2",
    releaseMbid: "release-1",
    fallbackAlbumId: "provider-album-1",
    fallbackArtistId: "artist-local",
    fallbackQuality: "LOSSLESS",
  });

  assert.equal(row?.canonical_track_mbid, "track-2");
  assert.equal(row?.canonical_recording_mbid, "recording-2");
  assert.equal(row?.title, "Track Two");
  assert.equal(row?.id, "provider-track-2");
  assert.equal(row?.album_id, "provider-album-1");
  assert.equal(row?.track_number, 2);
  assert.equal(row?.volume_number, 1);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("metadata pruning removes artist pictures without legacy media_id column", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, provider_entity_type, canonical_artist_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "Canonical Artist/folder.jpg",
    path.join(tempDir, "Canonical Artist", "folder.jpg"),
    tempDir,
    "jpg",
    "cover",
    "cover",
    "artist",
    "artist-mbid",
  );
  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, canonical_artist_mbid, canonical_release_group_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "Canonical Artist/Canonical Album/cover.jpg",
    path.join(tempDir, "Canonical Artist", "Canonical Album", "cover.jpg"),
    tempDir,
    "jpg",
    "cover",
    "cover",
    "artist-mbid",
    "release-group-1",
  );

  const config = configModule.readConfig();
  config.metadata.save_artist_picture = false;
  configModule.writeConfig(config);

  await organizerModule.OrganizerService.pruneDisabledMetadata();

  const remaining = dbModule.db.prepare(`
    SELECT file_path
    FROM MetadataFiles
    ORDER BY file_path ASC
  `).all() as Array<{ file_path: string }>;

  assert.equal(remaining.length, 1);
  assert.match(remaining[0].file_path, /cover\.jpg$/);
});

test("singleton sidecar relocation uses clean metadata identity columns", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");

  const oldDir = path.join(tempDir, "old");
  const newDir = path.join(tempDir, "new");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldPath = path.join(oldDir, "cover.jpg");
  const newPath = path.join(newDir, "cover.jpg");
  fs.writeFileSync(oldPath, "cover");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, provider, provider_entity_type, provider_id, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "old/cover.jpg",
    oldPath,
    tempDir,
    "jpg",
    "cover",
    "cover",
    "tidal",
    "album",
    "provider-album-1",
    "stereo",
  );

  (organizerModule.OrganizerService as any).relocateSingletonSidecar({
    artistId: "artist-local",
    albumId: "provider-album-1",
    expectedPath: newPath,
    libraryRoot: tempDir,
    fileType: "cover",
  });

  assert.equal(fs.existsSync(newPath), true);
  assert.equal(fs.existsSync(oldPath), false);
  const rows = dbModule.db.prepare(`
    SELECT provider_id, canonical_release_group_mbid, canonical_release_mbid, file_path
    FROM MetadataFiles
    WHERE file_type = 'cover'
  `).all() as Array<{
    provider_id: string | null;
    canonical_release_group_mbid: string | null;
    canonical_release_mbid: string | null;
    file_path: string;
  }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_id, "provider-album-1");
  assert.equal(rows[0].file_path, newPath);
});
