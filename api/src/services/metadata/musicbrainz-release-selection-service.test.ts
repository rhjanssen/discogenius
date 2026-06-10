import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-selection-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let selectionModule: typeof import("./musicbrainz-release-selection-service.js");

before(async () => {
  dbModule = await import("../../database.js");
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

type ReleaseInput = {
  status?: string | null;
  country?: string | null;
  date?: string | null;
  barcode?: string | null;
  mediaCount?: number | null;
  format?: string | null;
};

function insertRelease(mbid: string, trackCount: number, input: ReleaseInput = {}): void {
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title,
      status, country, date, barcode, media_count, track_count
    )
    VALUES (?, 'group-mbid', 'artist-mbid', 'Album', ?, ?, ?, ?, ?, ?)
  `).run(
    mbid,
    input.status ?? null,
    input.country ?? null,
    input.date ?? null,
    input.barcode ?? null,
    input.mediaCount ?? 1,
    trackCount,
  );

  if (input.format) {
    dbModule.db.prepare(`
      INSERT INTO AlbumReleaseMedia (release_mbid, position, format, track_count)
      VALUES (?, 1, ?, ?)
    `).run(mbid, input.format, trackCount);
  }
}

test("representative release defaults to the MusicBrainz release with the most tracks", () => {
  insertRelease("standard-release", 12);
  insertRelease("deluxe-release", 18);


  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "deluxe-release");
});

test("representative release prefers releases with imported files first", () => {
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
  assert.equal(selected?.imported_file_count, 1);
});

test("local import release follows Lidarr by preferring releases with imported files first", () => {
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
    .selectLocalImportRelease("group-mbid");

  assert.equal(selected?.mbid, "standard-release");
  assert.equal(selected?.imported_file_count, 1);
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

test("representative release prefers official digital worldwide releases when track counts tie", () => {
  insertRelease("local-vinyl-release", 12, {
    status: "Official",
    country: "US",
    date: "2020-01-01",
    barcode: "123",
    format: "Vinyl",
  });
  insertRelease("worldwide-digital-release", 12, {
    status: "Official",
    country: "XW",
    date: "2020-01-01",
    barcode: "456",
    format: "Digital Media",
  });

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "worldwide-digital-release");
});

test("representative release recognizes JSON-stored worldwide country codes", () => {
  insertRelease("local-digital-release", 12, {
    status: "Official",
    country: JSON.stringify(["US"]),
    date: "2020-01-01",
    barcode: "123",
    format: "Digital Media",
  });
  insertRelease("worldwide-digital-release", 12, {
    status: "Official",
    country: JSON.stringify(["XW"]),
    date: "2020-01-01",
    barcode: "456",
    format: "Digital Media",
  });

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "worldwide-digital-release");
});

test("representative release uses earliest dated release and stable mbid ordering as final tie breakers", () => {
  insertRelease("later-release", 12, {
    status: "Official",
    country: "XW",
    date: "2020-02-01",
    barcode: "123",
    format: "Digital Media",
  });
  insertRelease("earlier-release", 12, {
    status: "Official",
    country: "XW",
    date: "2020-01-01",
    barcode: "456",
    format: "Digital Media",
  });

  const selected = selectionModule.MusicBrainzReleaseSelectionService
    .selectRepresentativeRelease("group-mbid");

  assert.equal(selected?.mbid, "earlier-release");
});
