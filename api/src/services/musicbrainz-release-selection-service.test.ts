import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-selection-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let selectionModule: typeof import("./musicbrainz-release-selection-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  selectionModule = await import("./musicbrainz-release-selection-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-id", "Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("group-mbid", "artist-mbid", "Album");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertRelease(mbid: string, trackCount: number): void {
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, 'group-mbid', 'artist-mbid', 'Album', ?)
  `).run(mbid, trackCount);
}

test("representative release defaults to the MusicBrainz release with the most tracks", () => {
  insertRelease("standard-release", 12);
  insertRelease("deluxe-release", 18);

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "deluxe-release");
});

test("representative release preserves a release already represented by imported files", () => {
  insertRelease("standard-release", 12);
  insertRelease("deluxe-release", 18);
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_path, relative_path, library_root, filename, extension,
      file_type, canonical_release_mbid
    )
    VALUES (
      'artist-id', '/library/standard.flac', 'standard.flac', 'stereo',
      'standard.flac', '.flac', 'track', 'standard-release'
    )
  `).run();

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "standard-release");
});

test("representative release applies the Lidarr-like ranking only within provider-matched releases", () => {
  insertRelease("standard-release", 12);
  insertRelease("deluxe-release", 18);

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid", {
      availableReleaseMbids: ["standard-release"],
    });

  assert.equal(selected?.mbid, "standard-release");
});
