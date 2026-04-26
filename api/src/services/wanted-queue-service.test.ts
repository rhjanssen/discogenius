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
  db.prepare("DELETE FROM video_files").run();
  db.prepare("DELETE FROM provider_videos").run();
  db.prepare("DELETE FROM videos").run();
  db.prepare("DELETE FROM provider_tracks").run();
  db.prepare("DELETE FROM provider_releases").run();
  db.prepare("DELETE FROM track_files").run();
  db.prepare("DELETE FROM release_group_monitoring").run();
  db.prepare("DELETE FROM tracks").run();
  db.prepare("DELETE FROM album_releases").run();
  db.prepare("DELETE FROM release_groups").run();
  db.prepare("DELETE FROM managed_artists").run();
  db.prepare("DELETE FROM artist_metadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("wanted queue service queues missing release targets through provider candidates", () => {
  seedArtist();
  seedReleaseGroup(10, 100);
  seedTrack(1000, 100, "Song One");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: true });

  assert.deepEqual(result, { albums: 1, tracks: 0, videos: 0 });

  const job = dbModule.db.prepare("SELECT type, ref_id, payload FROM job_queue").get() as any;
  assert.equal(job.type, "DownloadAlbum");
  assert.equal(job.ref_id, "tidal-album-10");

  const payload = JSON.parse(job.payload);
  assert.equal(payload.tidalId, "tidal-album-10");
  assert.equal(payload.providerItemId, "tidal-album-10");
  assert.equal(payload.albumReleaseId, "100");
  assert.equal(payload.libraryType, "stereo");
  assert.equal(payload.type, "album");
  assert.equal(payload.url, "https://tidal.com/browse/album/tidal-album-10");
});

test("wanted queue service skips release targets that still need provider availability", () => {
  seedArtist();
  seedReleaseGroup(10, 100);
  seedTrack(1000, 100, "Song One");

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: true });

  assert.deepEqual(result, { albums: 0, tracks: 0, videos: 0 });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM job_queue").get() as any;
  assert.equal(count.count, 0);
});

test("wanted queue service does not duplicate release jobs covered by an active provider job", () => {
  seedArtist();
  seedReleaseGroup(10, 100);
  seedTrack(1000, 100, "Song One");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");
  insertJob(5, "DownloadAlbum", "tidal-album-10", "pending");

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: true });

  assert.deepEqual(result, { albums: 0, tracks: 0, videos: 0 });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM job_queue").get() as any;
  assert.equal(count.count, 1);
});

test("wanted queue service can leave videos out of the acquisition plan", () => {
  seedArtist();
  seedVideo(200, "Video One");
  seedProviderVideo("tidal", "tidal-video-200", 200);

  const result = wantedQueueModule.WantedQueueService.queueWantedItems({ includeVideos: false });

  assert.deepEqual(result, { albums: 0, tracks: 0, videos: 0 });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM job_queue").get() as any;
  assert.equal(count.count, 0);
});

function seedArtist() {
  dbModule.db.prepare(`
    INSERT INTO artist_metadata (id, foreign_artist_id, name, sort_name)
    VALUES (?, ?, ?, ?)
  `).run(1, "mb-artist-1", "Artist One", "Artist One");

  dbModule.db.prepare(`
    INSERT INTO managed_artists (id, artist_metadata_id, monitored, monitor_new_items, path)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, 1, 1, "all", "/music/Artist One");
}

function seedReleaseGroup(releaseGroupId: number, selectedReleaseId: number) {
  dbModule.db.prepare(`
    INSERT INTO release_groups (
      id, artist_metadata_id, foreign_release_group_id, title, album_type,
      monitored, clean_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(releaseGroupId, 1, `mb-rg-${releaseGroupId}`, "Album One", "album", 1, "album one");

  dbModule.db.prepare(`
    INSERT INTO album_releases (
      id, release_group_id, foreign_release_id, title, status,
      release_date, track_count, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(selectedReleaseId, releaseGroupId, `mb-release-${selectedReleaseId}`, "Album One", "Official", "2024-01-01", 1, 1);

  dbModule.db.prepare(`
    INSERT INTO release_group_monitoring (
      release_group_id, library_type, monitored, selected_release_id, redundancy_state
    ) VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupId, "stereo", 1, selectedReleaseId, "selected");
}

function seedTrack(id: number, albumReleaseId: number, title: string) {
  dbModule.db.prepare(`
    INSERT INTO tracks (
      id, foreign_track_id, foreign_recording_id, album_release_id,
      artist_metadata_id, track_number, absolute_track_number, title,
      duration, isrcs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `mb-track-${id}`, `mb-recording-${id}`, albumReleaseId, 1, "1", 1, title, 180, JSON.stringify([`USABC${id}`]));
}

function seedProviderRelease(
  provider: string,
  providerReleaseId: string,
  releaseGroupId: number,
  albumReleaseId: number,
  libraryType: "stereo" | "atmos",
) {
  dbModule.db.prepare(`
    INSERT INTO provider_releases (
      provider, provider_release_id, release_group_id, album_release_id,
      library_type, title, artist_name, quality, track_count, confidence, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(provider, providerReleaseId, releaseGroupId, albumReleaseId, libraryType, "Album One", "Artist One", "LOSSLESS", 1, 1, 100);
}

function seedVideo(id: number, title: string) {
  dbModule.db.prepare(`
    INSERT INTO videos (id, artist_metadata_id, title, monitored)
    VALUES (?, ?, ?, ?)
  `).run(id, 1, title, 1);
}

function seedProviderVideo(provider: string, providerVideoId: string, videoId: number) {
  dbModule.db.prepare(`
    INSERT INTO provider_videos (provider, provider_video_id, video_id, title, artist_name, quality)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider, providerVideoId, videoId, "Video One", "Artist One", "1080p");
}

function insertJob(id: number, type: string, refId: string, status: string) {
  dbModule.db.prepare(`
    INSERT INTO job_queue (id, type, payload, status, progress, priority, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, "{}", status, 0, 0, refId);
}
