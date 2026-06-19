import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-video-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let videoQueryModule: typeof import("./video-query-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  videoQueryModule = await import("./video-query-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("video list and detail use canonical video recordings with provider offers", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Video Artist')
    RETURNING id
  `).get() as { id: number };

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status, release_date, cover_image_id, monitored
    )
    VALUES (
      'provider-video-1', NULL, ?, 'artist-mbid',
      'Canonical Video', 215000, 1, 'provider_only', '2024-01-02', 'canonical-cover', 1
    )
    RETURNING id
  `).get(artist.id) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, release_date, provider_url, match_status, match_confidence
    )
    VALUES (
      'tidal', 'video', 'provider-video-1', 'artist-mbid', ?,
      'Canonical Video', 'FHD', 215, '2024-01-02',
      'https://tidal.com/browse/video/provider-video-1', 'verified', 0.99
    )
  `).run(recording.id);

  const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 1);
  assert.equal(list.items[0]?.id, String(recording.id));
  assert.equal(list.items[0]?.title, "Canonical Video");
  assert.equal(list.items[0]?.artist_name, "Video Artist");
  assert.equal(list.items[0]?.quality, "FHD");
  assert.equal(list.items[0]?.cover, "canonical-cover");
  assert.equal(list.items[0]?.is_monitored, true);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));

  assert.equal(detail?.id, String(recording.id));
  assert.equal(detail?.title, "Canonical Video");
  assert.equal(detail?.duration, 215);
});

test("video list and detail ignore legacy provider-media-only video rows", () => {
  dbModule.db.prepare("INSERT INTO Artists (id, name) VALUES (?, ?)")
    .run("artist-id", "Legacy Artist");
const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 0);
  assert.equal(list.items.length, 0);
  assert.equal(videoQueryModule.getVideoDetail("legacy-video-1"), null);
});
