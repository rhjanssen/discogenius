import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-recovery-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { getExistingLibraryMediaIds } = await import("./download-recovery.js");

function resetRows() {
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
}

beforeEach(resetRows);
afterEach(resetRows);

test("download recovery resolves existing album files through canonical provider offers", () => {
  const filePath = path.join(tempDir, "library", "music", "Artist", "Album", "01 - Track.flac");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "audio");

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Artist", "artist-mbid");
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid", "artist-mbid", "Album", "album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-mbid", "rg-mbid", "artist-mbid", "Album", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-mbid", "artist-mbid", "Track", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-mbid", "release-mbid", "recording-mbid", "Track", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      title, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "album", "provider-album", "artist-mbid", "rg-mbid", "release-mbid", "Album", "stereo");
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, selected_release_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid", "rg-mbid", "stereo", 1, "tidal", "provider-album", "release-mbid");
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "artist-mbid",
    "rg-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "tidal",
    "track",
    "provider-track",
    "stereo",
    filePath,
    path.relative(path.join(tempDir, "library", "music"), filePath),
    path.join(tempDir, "library", "music"),
    "01 - Track.flac",
    "flac",
    "track",
  );

  const recovered = getExistingLibraryMediaIds("album", "provider-album");

  assert.deepEqual(recovered, ["track-mbid"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderAlbums").get() as { count: number }).count, 0);
});
