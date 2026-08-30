import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-missing-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.download-missing.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let serviceModule: typeof import("./download-missing-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  // The video branch only builds its query when video downloads are enabled,
  // which is exactly why the retired-column read went unnoticed.
  const configModule = await import("../config/config.js");
  configModule.updateConfig("filtering", { include_videos: true });
  serviceModule = await import("./download-missing-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Regression: the video branch filtered on r.monitored, which the active schema
// does not have. SQLite failed at prepare time, so every DownloadMissing run
// errored out and nothing was ever queued — and because the branch only
// prepares when video downloads are enabled, no test covered it. A video is
// monitored by being selected into an enabled Video library.
test("queueMonitoredItems runs its video branch on the active schema", async () => {
  const { db } = dbModule;

  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Video Artist')`).run();
  seedLibraryArtistMonitoring(db, "artist-mbid");
  const artist = db.prepare(`SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'`).get() as { id: number };
  const album = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('album-mbid', ?, 'artist-mbid', 'Album Without a Plan')
    RETURNING id
  `).get(artist.id) as { id: number };
  const edition = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid,
      artist_metadata_id, artist_mbid, title
    ) VALUES ('edition-mbid', ?, 'album-mbid', ?, 'artist-mbid', 'Album Without a Plan')
    RETURNING id
  `).get(album.id, artist.id) as { id: number };
  const stereoLibrary = db.prepare(`SELECT id FROM Libraries WHERE name = 'Stereo'`).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, curation_version)
    VALUES (?, ?, 'auto', 1)
  `).run(stereoLibrary.id, album.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version)
    VALUES (?, ?, 'auto', 1)
  `).run(stereoLibrary.id, edition.id);

  const video = db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('video-mbid', 'artist-mbid', 'A Music Video', 210000, 1, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const providerVideo = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, video_quality)
    VALUES ('tidal', 'video', 'provider-video-1', 'A Music Video', 'FHD')
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerVideo.id, video.id);

  // Not yet selected into any Video library, so nothing is monitored.
  const before = await serviceModule.DownloadMissingService.queueMonitoredItems();
  assert.equal(before.videos, 0);
  assert.equal(before.missingPlans, 1);
  const acquisitionPlans = db.prepare(`SELECT COUNT(*) AS count FROM AcquisitionPlans`).get() as { count: number };
  assert.equal(acquisitionPlans.count, 0, "Download Missing must not repair acquisition plans");

  const videoLibrary = db.prepare(`SELECT id FROM Libraries WHERE name = 'Video'`).get() as
    | { id: number }
    | undefined;
  assert.ok(videoLibrary, "expected a Video library");
  db.prepare(`
    INSERT INTO LibraryVideos (library_id, video_recording_id, selection_mode)
    VALUES (?, ?, 'auto')
  `).run(videoLibrary.id, video.id);

  const after = await serviceModule.DownloadMissingService.queueMonitoredItems();
  assert.equal(after.videos, 1, "a selected video should be queued");

  const waitRows = db.prepare(`SELECT COUNT(*) AS count FROM DownloadQueue`).get() as { count: number };
  const downloadCommands = db.prepare(`
    SELECT COUNT(*) AS count FROM commands
    WHERE name IN ('DownloadVideo', 'DownloadAlbum', 'DownloadTrack')
      AND status IN ('queued', 'started', 'failed')
  `).get() as { count: number };
  assert.equal(waitRows.count, 1, "Download Missing should write a wait-queue row");
  assert.equal(downloadCommands.count, 0, "waiting videos must not be commands yet");
});
