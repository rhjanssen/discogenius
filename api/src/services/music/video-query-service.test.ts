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
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
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
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name, picture, cover_image_url)
    VALUES ('artist-mbid', 'artist-mbid', 'Video Artist', '/media-cover/artist-mbid/poster.jpg', '/media-cover/artist-mbid/fanart.jpg')
  `).run();

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
      title, quality, duration, release_date, provider_url, match_status, match_confidence, availability
    )
    VALUES (
      'tidal', 'video', 'provider-video-1', 'artist-mbid', ?,
      'Canonical Video', 'FHD', 215, '2024-01-02',
      'https://tidal.com/browse/video/provider-video-1', 'verified', 0.99, 1
    )
  `).run(recording.id);

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, availability
    ) VALUES
      ('youtube-music', 'video', 'yt-video-01', 'artist-mbid', ?,
       'Canonical Video', NULL, 215, 1),
      ('apple-music', 'video', 'unavailable-video', 'artist-mbid', ?,
       'Canonical Video', '4K', 215, 0)
  `).run(recording.id, recording.id);

  const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 1);
  assert.equal(list.items[0]?.id, String(recording.id));
  assert.equal(list.items[0]?.title, "Canonical Video");
  assert.equal(list.items[0]?.artist_id, "artist-mbid");
  assert.equal(list.items[0]?.artist_name, "Video Artist");
  assert.equal(list.items[0]?.quality, "FHD");
  assert.equal(list.items[0]?.cover, "canonical-cover");
  assert.equal(list.items[0]?.cover_art_url, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.equal(list.items[0]?.is_monitored, true);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));

  assert.equal(detail?.id, String(recording.id));
  assert.equal(detail?.title, "Canonical Video");
  assert.equal(detail?.artist_id, "artist-mbid");
  assert.equal(detail?.duration, 215);
  assert.equal(detail?.cover_art_url, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.deepEqual(detail?.offers, [{
    provider: "tidal",
    provider_id: "provider-video-1",
    quality: "FHD",
    url: "https://tidal.com/browse/video/provider-video-1",
    available: true,
    can_preview: true,
    can_download: true,
  }, {
    provider: "youtube-music",
    provider_id: "yt-video-01",
    quality: null,
    url: null,
    available: true,
    can_preview: false,
    can_download: true,
  }]);
});

test("video list and detail ignore legacy provider-media-only video rows", () => {
  dbModule.db.prepare("INSERT INTO Artists (id, name) VALUES (?, ?)")
    .run("artist-id", "Legacy Artist");
const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 0);
  assert.equal(list.items.length, 0);
  assert.equal(videoQueryModule.getVideoDetail("legacy-video-1"), null);
});

test("video detail resolves its provider album by composite provider identity", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Video Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-mbid', 'artist-mbid', 'Video Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES
      ('rg-apple', 'artist-mbid', 'Apple Album', 'album'),
      ('rg-tidal', 'artist-mbid', 'TIDAL Album', 'album')
  `).run();

  // Provider resource IDs are only stable within a provider. Both services can
  // legitimately expose album "42"; the video belongs to Apple's offer.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, title
    ) VALUES
      ('apple-music', 'album', '42', 'artist-mbid', 'rg-apple', 'Apple Album'),
      ('tidal', 'album', '42', 'artist-mbid', 'rg-tidal', 'TIDAL Album')
  `).run();

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('apple-video-99', ?, 'artist-mbid', 'Canonical Video', 1, 'provider_only')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid,
      recording_id, title, quality
    ) VALUES ('apple-music', 'video', '99', '42', 'artist-mbid', ?, 'Canonical Video', 'FHD')
  `).run(recording.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));

  assert.deepEqual(detail?.albums, [{ id: "rg-apple", title: "Apple Album", cover_id: null }]);
});
