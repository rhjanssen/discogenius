import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.curation.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let curationModule: typeof import("./curation-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  curationModule = await import("./curation-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM media_artists").run();
  db.prepare("DELETE FROM album_artists").run();
  db.prepare("DELETE FROM library_files").run();
  db.prepare("DELETE FROM media").run();
  db.prepare("DELETE FROM albums").run();
  db.prepare("DELETE FROM artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertArtist() {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, popularity, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Artist One", 90, 1);
}

function insertAlbum(album: {
  id: number;
  title: string;
  version?: string | null;
  quality: "LOSSLESS" | "HIRES_LOSSLESS";
  numTracks: number;
  mbid: string;
  mbReleaseGroupId: string;
}) {
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, version, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, upc, mbid, mb_release_group_id,
      mb_primary, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    album.id,
    1,
    album.title,
    album.version ?? null,
    "2024-01-01",
    "ALBUM",
    1,
    album.quality,
    album.numTracks,
    1,
    0,
    album.numTracks * 180,
    `upc-${album.mbid}`,
    album.mbid,
    album.mbReleaseGroupId,
    "album",
    0,
  );

  dbModule.db.prepare(`
    INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(album.id, 1, "Artist One", 0, "MAIN", "ALBUMS", "ALBUM");
}

function insertTrack(albumId: number, trackId: number, title: string, isrc: string) {
  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, release_date, type, explicit, quality,
      track_number, volume_number, duration, isrc, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trackId, 1, albumId, title, "2024-01-01", "Track", 1, "LOSSLESS", 1, 1, 180, isrc, 0);
}

test("curation uses exact release identity without collapsing a MusicBrainz release group", async () => {
  insertArtist();

  insertAlbum({
    id: 10,
    title: "Album",
    quality: "LOSSLESS",
    numTracks: 1,
    mbid: "mb-release-standard",
    mbReleaseGroupId: "mb-release-group-shared",
  });
  insertAlbum({
    id: 11,
    title: "Album",
    quality: "HIRES_LOSSLESS",
    numTracks: 1,
    mbid: "mb-release-standard",
    mbReleaseGroupId: "mb-release-group-shared",
  });
  insertAlbum({
    id: 20,
    title: "Album",
    version: "Deluxe Edition",
    quality: "HIRES_LOSSLESS",
    numTracks: 1,
    mbid: "mb-release-deluxe",
    mbReleaseGroupId: "mb-release-group-shared",
  });

  insertTrack(10, 100, "Song One", "ISRC-STANDARD-1");
  insertTrack(11, 110, "Song One", "ISRC-STANDARD-1");
  insertTrack(20, 200, "Song One Deluxe Mix", "ISRC-DELUXE-1");

  await curationModule.CurationService.processRedundancy("1", "music");

  const rows = dbModule.db.prepare(`
    SELECT id, monitor, redundant
    FROM albums
    ORDER BY id
  `).all() as Array<{ id: number; monitor: number; redundant: string | null }>;

  assert.deepEqual(rows, [
    { id: 10, monitor: 0, redundant: "11" },
    { id: 11, monitor: 1, redundant: null },
    { id: 20, monitor: 1, redundant: null },
  ]);
});
