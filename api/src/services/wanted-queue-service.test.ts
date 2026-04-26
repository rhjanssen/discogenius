import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-wanted-queue-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.wanted-queue.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let wantedQueueModule: typeof import("./wanted-queue-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  wantedQueueModule = await import("./wanted-queue-service.js");
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

test("wanted queue service queues missing album targets from the wanted list", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: true });

  assert.deepEqual(result, { albums: 1, tracks: 0, videos: 0 });

  const job = dbModule.db.prepare("SELECT type, ref_id, payload FROM job_queue").get() as any;
  assert.equal(job.type, "DownloadAlbum");
  assert.equal(job.ref_id, "10");

  const payload = JSON.parse(job.payload);
  assert.equal(payload.tidalId, "10");
  assert.equal(payload.type, "album");
  assert.equal(payload.url, "https://tidal.com/browse/album/10");
});

test("wanted queue service does not duplicate track jobs covered by an active album job", () => {
  insertArtist(1, "Artist One");
  insertAlbum(10, 1, "Album One", 1);
  insertTrack(100, 10, 1, "Song One", 1);
  insertTrack(101, 10, 1, "Song Two", 0);
  insertJob(5, "DownloadAlbum", "10", "pending");

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: true });

  assert.deepEqual(result, { albums: 0, tracks: 0, videos: 0 });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM job_queue").get() as any;
  assert.equal(count.count, 1);
});

test("wanted queue service can leave videos out of the acquisition plan", () => {
  insertArtist(1, "Artist One");
  insertVideo(200, 1, "Video One", 1);

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: false });

  assert.deepEqual(result, { albums: 0, tracks: 0, videos: 0 });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM job_queue").get() as any;
  assert.equal(count.count, 0);
});

function insertArtist(id: number, name: string) {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, popularity, monitor)
    VALUES (?, ?, ?, ?)
  `).run(id, name, 50, 1);
}

function insertAlbum(id: number, artistId: number, title: string, monitor: number) {
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, artistId, title, "2024-01-01", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, monitor);

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

function insertJob(id: number, type: string, refId: string, status: string) {
  dbModule.db.prepare(`
    INSERT INTO job_queue (id, type, payload, status, progress, priority, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, "{}", status, 0, 0, refId);
}
