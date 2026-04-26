import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-wanted-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.wanted.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let wantedModule: typeof import("./wanted-query-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  wantedModule = await import("./wanted-query-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM job_queue").run();
  db.prepare("DELETE FROM library_files").run();
  db.prepare("DELETE FROM media_artists").run();
  db.prepare("DELETE FROM album_artists").run();
  db.prepare("DELETE FROM media").run();
  db.prepare("DELETE FROM albums").run();
  db.prepare("DELETE FROM artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("wanted list exposes monitored missing albums as album targets", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertTrack(101, 10, 1, "Song Two", 1);

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "album:10");
  assert.equal(result.items[0].monitorScope, "release");
  assert.equal(result.items[0].queueStatus, "missing");
  assert.match(result.items[0].reason, /all monitored album tracks/);
});

test("wanted list exposes partial monitored albums as track targets", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertTrack(101, 10, 1, "Song Two", 0);

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "track:100");
  assert.equal(result.items[0].type, "track");
  assert.equal(result.items[0].monitorScope, "manual_track");
  assert.match(result.items[0].reason, /partial-album/);
});

test("wanted list omits imported tracks", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertLibraryFile(1, 10, 100, "track");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 0);
});

test("wanted list omits monitored albums with imported album files even when track rows are missing", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertLibraryFile(1, 10, null, "track");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 0);
});

test("wanted list includes locked monitored items as explicit user intent", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1, 1);
  insertTrack(100, 10, 1, "Song One", 1);

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "album:10");
  assert.equal(result.items[0].monitorLocked, true);
});

test("wanted list reports queued status from active jobs", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertJob(5, "DownloadAlbum", "10", "pending");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].queueStatus, "queued");
  assert.equal(result.items[0].activeJobId, 5);
});

test("wanted list treats active album jobs as covering missing track targets", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertTrack(101, 10, 1, "Song Two", 0);
  insertJob(5, "DownloadAlbum", "10", "pending");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "track:100");
  assert.equal(result.items[0].queueStatus, "queued");
  assert.equal(result.items[0].activeJobId, 5);
});

test("wanted list supports artist and type filters", () => {
  insertArtist(1, "Artist One");
  insertArtist(2, "Artist Two");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertVideo(200, 2, "Video One", 1);

  const result = wantedModule.WantedQueryService.listWanted({ artistId: "2", type: "video" });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "video:200");
  assert.equal(result.items[0].monitorScope, "video");
});

function insertArtist(id: number, name: string) {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, popularity, monitor)
    VALUES (?, ?, ?, ?)
  `).run(id, name, 50, 1);
}

function insertAlbum(id: number, artistId: number, title: string, monitor: number, monitorLock = 0) {
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, artistId, title, "2024-01-01", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, monitor, monitorLock);

  dbModule.db.prepare(`
    INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, artistId, `Artist ${artistId}`, 0, "MAIN", "ALBUMS", "ALBUM");
}

function insertTrack(id: number, albumId: number, artistId: number, title: string, monitor: number) {
  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, release_date, type, explicit, quality,
      track_number, volume_number, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, artistId, albumId, title, "2024-01-01", "Track", 0, "LOSSLESS", 1, 1, 180, monitor);
}

function insertVideo(id: number, artistId: number, title: string, monitor: number) {
  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, title, release_date, type, explicit, quality,
      track_number, volume_number, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, artistId, title, "2024-01-01", "Music Video", 0, "LOSSLESS", 1, 1, 180, monitor);
}

function insertLibraryFile(id: number, albumId: number, mediaId: number | null, fileType: "track" | "video") {
  dbModule.db.prepare(`
    INSERT INTO library_files (
      id, artist_id, media_id, album_id, file_type, file_path, relative_path,
      library_root, filename, extension, file_size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    1,
    mediaId,
    albumId,
    fileType,
    `/music/${mediaId}.flac`,
    `${mediaId}.flac`,
    "music",
    `${mediaId}.flac`,
    "flac",
    100,
  );
}

function insertJob(id: number, type: string, refId: string, status: string) {
  dbModule.db.prepare(`
    INSERT INTO job_queue (id, type, payload, status, progress, priority, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, "{}", status, 0, 0, refId);
}
