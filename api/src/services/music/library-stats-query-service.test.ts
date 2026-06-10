import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-stats-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let libraryStatsModule: typeof import("./library-stats-query-service.js");
let downloadStateModule: typeof import("../download/download-state.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  libraryStatsModule = await import("./library-stats-query-service.js");
  downloadStateModule = await import("../download/download-state.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();

  downloadStateModule.invalidateAllDownloadState();
  libraryStatsModule.LibraryStatsQueryService.clearCache();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("library stats count videos from canonical recordings and ignore legacy provider media", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitored)
    VALUES ('artist-id', 'Video Artist', 'artist-mbid', 1)
  `).run();

  const artistMetadata = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Video Artist')
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, artist_metadata_id, artist_mbid,
      title, is_video, metadata_status, monitored
    )
    VALUES
      ('provider-video-1', ?, 'artist-mbid', 'Canonical Video', 1, 'provider_only', 1),
      ('provider-video-2', ?, 'artist-mbid', 'Unmonitored Video', 1, 'provider_only', 0),
      ('audio-recording-1', ?, 'artist-mbid', 'Audio Recording', 0, 'musicbrainz', 1)
  `).run(artistMetadata.id, artistMetadata.id, artistMetadata.id);

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, title, duration, type, explicit, quality, monitored
    )
    VALUES ('legacy-video-1', 'artist-id', 'Legacy provider Video', 200, 'Music Video', 0, 'FHD', 1)
  `).run();

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    )
    VALUES (
      'artist-id', 'artist-mbid', 'provider-video-1',
      'tidal', 'video', 'provider-video-1', 'video',
      ?, 'Video Artist/Canonical Video.mp4', ?, 'Canonical Video.mp4', 'mp4', 'video', 'FHD'
    )
  `).run(
    path.join(tempDir, "library", "videos", "Video Artist", "Canonical Video.mp4"),
    path.join(tempDir, "library", "videos"),
  );

  const snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();

  assert.equal(snapshot.videos.total, 2);
  assert.equal(snapshot.videos.monitored, 1);
  assert.equal(snapshot.videos.downloaded, 1);
});
