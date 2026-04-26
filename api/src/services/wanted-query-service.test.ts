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

test("wanted list exposes monitored release groups as exact release targets", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100 });
  seedTrack(1000, 100, "Song One");
  seedTrack(1001, 100, "Song Two");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "album:stereo:tidal-album-10");
  assert.equal(result.items[0].monitorScope, "release");
  assert.equal(result.items[0].albumId, "10");
  assert.equal(result.items[0].albumReleaseId, "100");
  assert.equal(result.items[0].libraryType, "stereo");
  assert.equal(result.items[0].provider, "tidal");
  assert.equal(result.items[0].queueStatus, "missing");
  assert.match(result.items[0].reason, /selected monitored release/);
});

test("wanted list omits releases whose selected tracks are already imported", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100 });
  seedTrack(1000, 100, "Song One");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");
  seedTrackFile(1000, 100, 10, "stereo");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 0);
});

test("wanted list marks selected releases without provider candidates as unavailable", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100 });
  seedTrack(1000, 100, "Song One");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "album:stereo:100");
  assert.equal(result.items[0].providerItemId, null);
  assert.equal(result.items[0].queueStatus, "unavailable");
  assert.match(result.items[0].reason, /provider availability/);
});

test("wanted list filters redundant release groups out of wanted state", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100 });
  seedTrack(1000, 100, "Song One");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");

  seedReleaseGroup({
    releaseGroupId: 11,
    selectedReleaseId: 101,
    title: "Song One",
    redundancyState: "redundant",
    redundantToReleaseGroupId: 10,
  });
  seedTrack(1001, 101, "Song One");
  seedProviderRelease("tidal", "tidal-single-11", 11, 101, "stereo");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].albumId, "10");
});

test("wanted list keeps stereo and atmos release targets separate", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100, libraryType: "stereo" });
  seedAlbumRelease(101, 10, "Album Atmos");
  seedReleaseMonitoring(10, 101, "atmos");
  seedTrack(1000, 100, "Song One");
  seedTrack(1001, 101, "Song One");
  seedProviderRelease("tidal", "tidal-album-stereo", 10, 100, "stereo");
  seedProviderRelease("tidal", "tidal-album-atmos", 10, 101, "atmos", "DOLBY_ATMOS");

  const result = wantedModule.WantedQueryService.listWanted({ libraryType: "atmos" });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "album:atmos:tidal-album-atmos");
  assert.equal(result.items[0].libraryType, "atmos");
  assert.equal(result.items[0].quality, "DOLBY_ATMOS");
});

test("wanted list reports queued status from active provider jobs", () => {
  seedArtist();
  seedReleaseGroup({ releaseGroupId: 10, selectedReleaseId: 100 });
  seedTrack(1000, 100, "Song One");
  seedProviderRelease("tidal", "tidal-album-10", 10, 100, "stereo");
  insertJob(5, "DownloadAlbum", "tidal-album-10", "pending");

  const result = wantedModule.WantedQueryService.listWanted();

  assert.equal(result.total, 1);
  assert.equal(result.items[0].queueStatus, "queued");
  assert.equal(result.items[0].activeJobId, 5);
});

test("wanted list supports artist, type, and video targets", () => {
  seedArtist();
  seedVideo(200, "Video One");
  seedProviderVideo("tidal", "tidal-video-200", 200);

  const result = wantedModule.WantedQueryService.listWanted({ artistId: "1", type: "video" });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "video:video:tidal-video-200");
  assert.equal(result.items[0].monitorScope, "video");
  assert.equal(result.items[0].libraryType, "video");
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

function seedReleaseGroup(input: {
  releaseGroupId: number;
  selectedReleaseId: number;
  title?: string;
  libraryType?: "stereo" | "atmos";
  redundancyState?: string;
  redundantToReleaseGroupId?: number | null;
}) {
  dbModule.db.prepare(`
    INSERT INTO release_groups (
      id, artist_metadata_id, foreign_release_group_id, title, album_type,
      monitored, clean_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.releaseGroupId,
    1,
    `mb-rg-${input.releaseGroupId}`,
    input.title || "Album One",
    "album",
    1,
    input.title || "album one",
  );

  seedAlbumRelease(input.selectedReleaseId, input.releaseGroupId, input.title || "Album One");
  seedReleaseMonitoring(
    input.releaseGroupId,
    input.selectedReleaseId,
    input.libraryType || "stereo",
    input.redundancyState,
    input.redundantToReleaseGroupId,
  );
}

function seedReleaseMonitoring(
  releaseGroupId: number,
  selectedReleaseId: number,
  libraryType: "stereo" | "atmos",
  redundancyState = "selected",
  redundantToReleaseGroupId: number | null = null,
) {
  dbModule.db.prepare(`
    INSERT INTO release_group_monitoring (
      release_group_id, library_type, monitored, selected_release_id,
      redundancy_state, redundant_to_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(releaseGroupId, libraryType, 1, selectedReleaseId, redundancyState, redundantToReleaseGroupId);
}

function seedAlbumRelease(id: number, releaseGroupId: number, title: string) {
  dbModule.db.prepare(`
    INSERT INTO album_releases (
      id, release_group_id, foreign_release_id, title, status,
      release_date, track_count, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, releaseGroupId, `mb-release-${id}`, title, "Official", "2024-01-01", 1, 1);
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

function seedTrackFile(
  trackId: number,
  albumReleaseId: number,
  releaseGroupId: number,
  libraryType: "stereo" | "atmos",
) {
  dbModule.db.prepare(`
    INSERT INTO track_files (
      artist_id, release_group_id, album_release_id, track_id, library_type,
      file_path, relative_path, library_root
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    releaseGroupId,
    albumReleaseId,
    trackId,
    libraryType,
    `/music/${libraryType}/${trackId}.flac`,
    `${trackId}.flac`,
    libraryType,
  );
}

function seedProviderRelease(
  provider: string,
  providerReleaseId: string,
  releaseGroupId: number,
  albumReleaseId: number,
  libraryType: "stereo" | "atmos",
  quality = "LOSSLESS",
) {
  dbModule.db.prepare(`
    INSERT INTO provider_releases (
      provider, provider_release_id, release_group_id, album_release_id,
      library_type, title, artist_name, quality, track_count, confidence, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(provider, providerReleaseId, releaseGroupId, albumReleaseId, libraryType, "Album One", "Artist One", quality, 1, 1, 100);
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
