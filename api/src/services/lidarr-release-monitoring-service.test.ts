import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-lidarr-monitoring-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.lidarr-monitoring.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let monitoringModule: typeof import("./lidarr-release-monitoring-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  monitoringModule = await import("./lidarr-release-monitoring-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
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

test("applyMonitoringDecisions selects the largest exact release in a MusicBrainz release group", () => {
  seedArtist();
  seedReleaseGroup(10, "Album", "album");
  seedRelease(100, 10, "Standard", ["rec-1", "rec-2"]);
  seedRelease(101, 10, "Deluxe", ["rec-1", "rec-2", "rec-3"]);

  const result = monitoringModule.LidarrReleaseMonitoringService.applyMonitoringDecisions({
    database: dbModule.db,
    libraryTypes: ["stereo"],
  });

  assert.deepEqual(result, { releaseGroups: 1, decisions: 1, monitored: 1, redundant: 0 });

  const monitoring = dbModule.db.prepare(`
    SELECT release_group_id, library_type, monitored, selected_release_id, redundancy_state
    FROM release_group_monitoring
  `).get() as any;
  assert.deepEqual(monitoring, {
    release_group_id: 10,
    library_type: "stereo",
    monitored: 1,
    selected_release_id: 101,
    redundancy_state: "selected",
  });
});

test("applyMonitoringDecisions marks singles redundant when an album covers their recording set", () => {
  seedArtist();
  seedReleaseGroup(10, "Album", "album");
  seedRelease(100, 10, "Album", ["rec-hit", "rec-deep-cut"]);

  seedReleaseGroup(11, "Hit Song", "single");
  seedRelease(101, 11, "Hit Song", ["rec-hit"]);

  const result = monitoringModule.LidarrReleaseMonitoringService.applyMonitoringDecisions({
    database: dbModule.db,
    libraryTypes: ["stereo"],
  });

  assert.equal(result.releaseGroups, 2);
  assert.equal(result.redundant, 1);

  const rows = dbModule.db.prepare(`
    SELECT release_group_id, monitored, selected_release_id, redundancy_state, redundant_to_release_group_id
    FROM release_group_monitoring
    ORDER BY release_group_id
  `).all() as any[];

  assert.deepEqual(rows, [
    {
      release_group_id: 10,
      monitored: 1,
      selected_release_id: 100,
      redundancy_state: "selected",
      redundant_to_release_group_id: null,
    },
    {
      release_group_id: 11,
      monitored: 0,
      selected_release_id: 101,
      redundancy_state: "redundant",
      redundant_to_release_group_id: 10,
    },
  ]);
});

test("applyMonitoringDecisions writes separate stereo and atmos monitoring rows", () => {
  seedArtist();
  seedReleaseGroup(10, "Album", "album");
  seedRelease(100, 10, "Stereo", ["rec-1"], { stereo: true });
  seedRelease(101, 10, "Atmos", ["rec-1"], { atmos: true });

  const result = monitoringModule.LidarrReleaseMonitoringService.applyMonitoringDecisions({
    database: dbModule.db,
    libraryTypes: ["stereo", "atmos"],
    redundancyEnabled: false,
  });

  assert.equal(result.decisions, 2);

  const rows = dbModule.db.prepare(`
    SELECT library_type, selected_release_id
    FROM release_group_monitoring
    ORDER BY library_type DESC
  `).all() as any[];

  assert.deepEqual(rows, [
    { library_type: "stereo", selected_release_id: 100 },
    { library_type: "atmos", selected_release_id: 101 },
  ]);
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

function seedRelease(
  id: number,
  releaseGroupId: number,
  title: string,
  recordingIds: string[],
  providerAvailability: Partial<Record<"stereo" | "atmos", boolean>> = {},
) {
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

  for (const libraryType of ["stereo", "atmos"] as const) {
    if (!providerAvailability[libraryType]) {
      continue;
    }

    dbModule.db.prepare(`
      INSERT INTO provider_releases (
        provider, provider_release_id, release_group_id, album_release_id,
        library_type, title, artist_name, quality, track_count, confidence, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "tidal",
      `tidal-${libraryType}-${id}`,
      releaseGroupId,
      id,
      libraryType,
      title,
      "Artist One",
      libraryType === "atmos" ? "DOLBY_ATMOS" : "LOSSLESS",
      recordingIds.length,
      1,
      100,
    );
  }
}
