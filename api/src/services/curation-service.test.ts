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
  db.prepare("DELETE FROM video_files").run();
  db.prepare("DELETE FROM provider_videos").run();
  db.prepare("DELETE FROM videos").run();
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

test("curation selects one exact release per MusicBrainz release group", async () => {
  seedArtist();
  seedReleaseGroup(10, "Album", "album");
  seedRelease(100, 10, "Standard", ["rec-1", "rec-2"]);
  seedRelease(101, 10, "Deluxe", ["rec-1", "rec-2", "rec-3"]);

  const result = await curationModule.CurationService.processRedundancy("1", "music");

  assert.deepEqual(result, { newAlbums: 1, upgradedAlbums: 0 });

  const row = dbModule.db.prepare(`
    SELECT selected_release_id, monitored, redundancy_state
    FROM release_group_monitoring
    WHERE release_group_id = 10 AND library_type = 'stereo'
  `).get() as any;

  assert.deepEqual(row, {
    selected_release_id: 101,
    monitored: 1,
    redundancy_state: "selected",
  });
});

test("curation applies redundancy by suppressing singles covered by albums", async () => {
  seedArtist();
  seedReleaseGroup(10, "Album", "album");
  seedRelease(100, 10, "Album", ["rec-hit", "rec-deep-cut"]);

  seedReleaseGroup(11, "Hit Song", "single");
  seedRelease(101, 11, "Hit Song", ["rec-hit"]);

  const result = await curationModule.CurationService.processAll("1", { skipDownloadQueue: true });

  assert.equal(result.newAlbums, 1);

  const rows = dbModule.db.prepare(`
    SELECT release_group_id, monitored, redundancy_state, redundant_to_release_group_id
    FROM release_group_monitoring
    WHERE library_type = 'stereo'
    ORDER BY release_group_id
  `).all() as any[];

  assert.deepEqual(rows, [
    {
      release_group_id: 10,
      monitored: 1,
      redundancy_state: "selected",
      redundant_to_release_group_id: null,
    },
    {
      release_group_id: 11,
      monitored: 0,
      redundancy_state: "redundant",
      redundant_to_release_group_id: 10,
    },
  ]);
});

test("curation manages videos as the Discogenius-specific target type", async () => {
  seedArtist();
  dbModule.db.prepare(`
    INSERT INTO videos (id, artist_metadata_id, title, monitored)
    VALUES (?, ?, ?, ?)
  `).run(200, 1, "Video One", 0);

  const result = await curationModule.CurationService.processRedundancy("1", "video");

  assert.deepEqual(result, { newAlbums: 1, upgradedAlbums: 0 });

  const row = dbModule.db.prepare("SELECT monitored FROM videos WHERE id = 200").get() as any;
  assert.equal(row.monitored, 1);
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

function seedReleaseGroup(id: number, title: string, albumType: string) {
  dbModule.db.prepare(`
    INSERT INTO release_groups (
      id, artist_metadata_id, foreign_release_group_id, title, album_type,
      monitored, clean_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, 1, `mb-rg-${id}`, title, albumType, 1, title.toLowerCase());
}

function seedRelease(id: number, releaseGroupId: number, title: string, recordingIds: string[]) {
  dbModule.db.prepare(`
    INSERT INTO album_releases (
      id, release_group_id, foreign_release_id, title, status,
      release_date, media, track_count, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    releaseGroupId,
    `mb-release-${id}`,
    title,
    "Official",
    "2024-01-01",
    JSON.stringify([{ format: "Digital Media" }]),
    recordingIds.length,
    0,
  );

  recordingIds.forEach((recordingId, index) => {
    dbModule.db.prepare(`
      INSERT INTO tracks (
        foreign_track_id, foreign_recording_id, album_release_id,
        artist_metadata_id, track_number, absolute_track_number, title, isrcs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `mb-track-${id}-${index}`,
      recordingId,
      id,
      1,
      String(index + 1),
      index + 1,
      `Song ${index + 1}`,
      JSON.stringify([`USABC${id}${index}`]),
    );
  });
}
