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
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
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
      ('apple-music', 'video', 'apple-video-4k', 'artist-mbid', ?,
       'Canonical Video', 'MP4_2160P', 215, 1),
      ('apple-music', 'video', 'unavailable-video', 'artist-mbid', ?,
       'Canonical Video', '4K', 215, 0)
  `).run(recording.id, recording.id, recording.id);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'artist-mbid', ?, 'apple-music', 'video', 'apple-video-4k',
      'video', 'C:/library/Canonical Video.mp4', 'Canonical Video.mp4', 'C:/library',
      'Canonical Video.mp4', '.mp4', 'video'
    )
  `).run(recording.id);

  const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 1);
  assert.equal(list.items[0]?.id, String(recording.id));
  assert.equal(list.items[0]?.title, "Canonical Video");
  assert.equal(list.items[0]?.artist_id, "artist-mbid");
  assert.equal(list.items[0]?.artist_name, "Video Artist");
  assert.equal(list.items[0]?.quality, "MP4_2160P");
  assert.equal(list.items[0]?.provider, "apple-music");
  assert.equal(list.items[0]?.provider_id, "apple-video-4k");
  assert.deepEqual(list.items[0]?.providers, ["apple-music", "tidal", "youtube-music"]);
  assert.deepEqual(list.items[0]?.provider_offers, [{
    provider: "apple-music",
    provider_id: "apple-video-4k",
    quality: "MP4_2160P",
  }, {
    provider: "tidal",
    provider_id: "provider-video-1",
    quality: "FHD",
  }, {
    provider: "youtube-music",
    provider_id: "yt-video-01",
    quality: null,
  }]);
  assert.equal(list.items[0]?.cover, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.equal(list.items[0]?.cover_art_url, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.equal(list.items[0]?.is_monitored, true);
  assert.equal(list.items[0]?.is_downloaded, true);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));

  assert.equal(detail?.id, String(recording.id));
  assert.equal(detail?.title, "Canonical Video");
  assert.equal(detail?.artist_id, "artist-mbid");
  assert.equal(detail?.duration, 215);
  assert.equal(detail?.video_variant, "video");
  assert.equal(detail?.cover_art_url, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.deepEqual(detail?.offers, [{
    provider: "apple-music",
    provider_id: "apple-video-4k",
    quality: "MP4_2160P",
    url: null,
    available: true,
    can_preview: true,
    can_download: true,
  }, {
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

  const youtubeOnly = videoQueryModule.listVideos({ limit: 10, offset: 0, provider: "youtube-music" });
  assert.equal(youtubeOnly.total, 1);
  assert.equal(youtubeOnly.items[0]?.id, String(recording.id));
  assert.equal(youtubeOnly.items[0]?.provider, "youtube-music");
  assert.equal(youtubeOnly.items[0]?.provider_id, "yt-video-01");

  const appleOnly = videoQueryModule.listVideos({ limit: 10, offset: 0, provider: "apple-music" });
  assert.equal(appleOnly.total, 1);
  assert.equal(appleOnly.items[0]?.provider, "apple-music");
  assert.equal(appleOnly.items[0]?.provider_id, "apple-video-4k");
  assert.equal(appleOnly.items[0]?.quality, "MP4_2160P");

  const unavailableProvider = videoQueryModule.listVideos({ limit: 10, offset: 0, provider: "deezer" });
  assert.equal(unavailableProvider.total, 0);
});

test("video detail backfills null offer quality from TrackFiles", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('file-quality-artist', 'File Quality Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('file-quality-artist', 'file-quality-artist', 'File Quality Artist')
  `).run();

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status, monitored
    )
    VALUES (
      'file-quality-video', NULL, ?, 'file-quality-artist',
      'Pompeii', 233000, 1, 'provider_only', 1
    )
    RETURNING id
  `).get(artist.id) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, availability
    ) VALUES (
      'tidal', 'video', '25704375', 'file-quality-artist', ?,
      'Pompeii', NULL, 233, 'available'
    )
  `).run(recording.id);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension,
      file_type, quality, width, height
    ) VALUES (
      'file-quality-artist', ?, 'tidal', 'video', '25704375',
      'video', 'C:/library/Pompeii.mp4', 'Pompeii.mp4', 'C:/library',
      'Pompeii.mp4', '.mp4', 'video', 'FHD', 1920, 1080
    )
  `).run(recording.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));
  assert.equal(detail?.offers?.length, 1);
  assert.equal(detail?.offers?.[0]?.provider, "tidal");
  assert.equal(detail?.offers?.[0]?.quality, "FHD");
});

test("video list and detail ignore legacy provider-media-only video rows", () => {
  dbModule.db.prepare("INSERT INTO Artists (id, name) VALUES (?, ?)")
    .run("artist-id", "Legacy Artist");
const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });

  assert.equal(list.total, 0);
  assert.equal(list.items.length, 0);
  assert.equal(videoQueryModule.getVideoDetail("legacy-video-1"), null);
});

test("video downloaded state treats provider ids as provider-scoped", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('collision-artist', 'Collision Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('collision-artist', 'collision-artist', 'Collision Artist')
  `).run();
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('shared-42', ?, 'collision-artist', 'Apple Video', 1, 'provider_only')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id, title, quality
    ) VALUES ('apple-music', 'video', '42', 'collision-artist', ?, 'Apple Video', 'FHD')
  `).run(recording.id);

  // A legacy TIDAL file with the same service-local numeric id must not mark
  // Apple's canonical video as downloaded.
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'collision-artist', 'tidal', 'video', '42', 'video',
      'C:/library/Tidal 42.mp4', 'Tidal 42.mp4', 'C:/library',
      'Tidal 42.mp4', '.mp4', 'video'
    )
  `).run();

  const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });
  assert.equal(list.items[0]?.provider, 'apple-music');
  assert.equal(list.items[0]?.is_downloaded, false);
});

test("video detail appears-on follows related audio via provider_video_for, not provider album id stamps", () => {
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
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count)
    VALUES
      ('rel-apple', 'rg-apple', 'artist-mbid', 'Apple Album', '2024-01-01', 1),
      ('rel-tidal', 'rg-tidal', 'artist-mbid', 'TIDAL Album', '2024-01-01', 1)
  `).run();

  // Provider resource IDs are only stable within a provider. Both services can
  // legitimately expose album "42"; membership comes from the related audio
  // track on Apple's release, not from stamping provider_album_id on the video.
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-audio-99', ?, 'artist-mbid', 'Canonical Song', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES ('track-apple-1', 'rel-apple', 'rec-audio-99', ?, 1, 1, '1', 'Canonical Song')
  `).run(audio.id);

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
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'apple-music', 0.9)
  `).run(recording.id, audio.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));

  assert.deepEqual(detail?.albums, [{
    id: "rg-apple",
    title: "Apple Album",
    cover_id: "/media-cover/Albums/rg-apple/cover.jpg?source=canonical",
    cover_art_url: "/media-cover/Albums/rg-apple/cover.jpg?source=canonical",
    track_mbid: "track-apple-1",
    track_number: 1,
    volume_number: 1,
    track_count: 1,
    media_count: 1,
  }]);
});

test("video detail surfaces album track position when the video is on a release tracklist", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-track-pos', 'Track Pos Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-track-pos', 'artist-track-pos', 'Track Pos Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, cover_image_id)
    VALUES ('rg-track-pos', 'artist-track-pos', 'Video Album', 'album', 'cover-42')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count)
    VALUES ('rel-track-pos', 'rg-track-pos', 'artist-track-pos', 'Video Album', '2024-01-01', 2)
  `).run();

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-video-track', ?, 'artist-track-pos', 'Official Video', 1, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES (
      'track-video-3', 'rel-track-pos', 'rec-video-track', ?,
      2, 3, '3', 'Official Video'
    )
  `).run(recording.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));
  const expectedCover = `/media-cover/Albums/rg-track-pos/cover.jpg`;
  assert.equal(detail?.albums?.[0]?.id, "rg-track-pos");
  assert.equal(detail?.albums?.[0]?.title, "Video Album");
  assert.equal(detail?.albums?.[0]?.track_mbid, "track-video-3");
  assert.equal(detail?.albums?.[0]?.track_number, 3);
  assert.equal(detail?.albums?.[0]?.volume_number, 2);
  assert.equal(detail?.albums?.[0]?.track_count, 2);
  assert.equal(detail?.albums?.[0]?.media_count, 1);
  // Affiliation covers are local /media-cover URLs, not raw asset ids.
  assert.ok(
    detail?.albums?.[0]?.cover_id === expectedCover
      || detail?.albums?.[0]?.cover_art_url === expectedCover
      || String(detail?.albums?.[0]?.cover_id || "").startsWith("/media-cover/Albums/"),
    `expected local album cover URL, got ${detail?.albums?.[0]?.cover_id}`,
  );
});

test("video detail appears-on follows related audio recordings and prefers monitored albums", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-affil', 'Affil Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-affil', 'artist-affil', 'Affil Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, monitored)
    VALUES
      ('rg-affil-single', 'artist-affil', 'Part Two', 'single', 0),
      ('rg-affil-album', 'artist-affil', 'Ampersand', 'album', 0)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES
      ('rel-affil-single', 'rg-affil-single', 'artist-affil', 'Part Two', '2024-01-01', 3, 1),
      ('rel-affil-album', 'rg-affil-album', 'artist-affil', 'Ampersand', '2024-06-01', 12, 1)
  `).run();
  // Wanted state lives on ReleaseGroupSlots, not Albums.monitored.
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES
      ('artist-affil', 'rg-affil-album', 'stereo', 1, 'rel-affil-album'),
      ('artist-affil', 'rg-affil-single', 'stereo', 0, 'rel-affil-single')
  `).run();

  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-affil-audio', ?, 'artist-affil', 'Song', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES (?, 'artist-affil', 'Song', 1, 'provider_only')
    RETURNING id
  `).get(artist.id) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES
      ('track-affil-2', 'rel-affil-single', 'rec-affil-audio', ?, 1, 2, '2', 'Song'),
      ('track-affil-5', 'rel-affil-album', 'rec-affil-audio', ?, 1, 5, '5', 'Song')
  `).run(audio.id, audio.id);

  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'youtube-music', 0.98)
  `).run(video.id, audio.id);

  // Relation alone surfaces both albums; stamped release_group_mbid on the
  // video offer is not consulted for Appears On.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality
    ) VALUES (
      'youtube-music', 'video', 'yt-affil-omv', 'artist-affil', ?,
      'Song', 'UHD'
    )
  `).run(video.id);

  const detail = videoQueryModule.getVideoDetail(String(video.id));
  assert.equal(detail?.albums?.length, 2);
  assert.equal(detail?.albums?.[0]?.id, "rg-affil-album", "slot-monitored album sorts first");
  assert.equal(detail?.albums?.[0]?.track_number, 5);
  assert.equal(detail?.albums?.[0]?.track_count, 12);
  assert.equal(detail?.albums?.[1]?.id, "rg-affil-single");
  assert.equal(detail?.albums?.[1]?.track_number, 2);
});

test("video detail appears-on prefers selected multi-disc release over earliest single", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-multivol', 'Multivol Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-multivol', 'artist-multivol', 'Multivol Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-multivol', 'artist-multivol', 'Give Me The Future', 'album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count
    ) VALUES
      ('rel-multivol-single', 'rg-multivol', 'artist-multivol', 'GMTF Single', '2021-01-01', 13, 1),
      ('rel-multivol-full', 'rg-multivol', 'artist-multivol', 'GMTF 3CD', '2022-06-01', 27, 3)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES ('artist-multivol', 'rg-multivol', 'stereo', 1, 'rel-multivol-full')
  `).run();

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-multivol-video', ?, 'artist-multivol', 'Pompeii', 1, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES
      ('track-multivol-early', 'rel-multivol-single', 'rec-multivol-video', ?, 1, 1, '1', 'Pompeii'),
      ('track-multivol-full', 'rel-multivol-full', 'rec-multivol-video', ?, 1, 1, '1', 'Pompeii')
  `).run(recording.id, recording.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));
  assert.equal(detail?.albums?.[0]?.id, "rg-multivol");
  assert.equal(detail?.albums?.[0]?.track_mbid, "track-multivol-full");
  assert.equal(detail?.albums?.[0]?.track_number, 1);
  assert.equal(detail?.albums?.[0]?.volume_number, 1);
  assert.equal(detail?.albums?.[0]?.track_count, 27);
  assert.equal(detail?.albums?.[0]?.media_count, 3);
});

test("video detail prefers provider title when recording title is Unknown Video", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Video Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-mbid', 'artist-mbid', 'Video Artist')
  `).run();

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES (?, 'artist-mbid', 'Unknown Video', 307000, 1, 'provider_only')
    RETURNING id
  `).get(artist.id) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, availability
    ) VALUES (
      'tidal', 'video', 'prov-title-1', 'artist-mbid', ?,
      'Happy Endings', 'FHD', 307, 1
    )
  `).run(recording.id);

  const detail = videoQueryModule.getVideoDetail(String(recording.id));
  assert.equal(detail?.title, "Happy Endings");

  const list = videoQueryModule.listVideos({ limit: 10, offset: 0 });
  assert.equal(list.items[0]?.title, "Happy Endings");
});

test("album associated videos follow provider_video_for audio tracks on the RG", () => {
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
    VALUES ('rg-assoc', 'artist-mbid', 'Associated Album', 'album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES ('rel-assoc', 'rg-assoc', 'artist-mbid', 'Associated Album', '2024-01-01', 2, 1)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES ('artist-mbid', 'rg-assoc', 'stereo', 1, 'rel-assoc')
  `).run();

  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-audio-assoc', ?, 'artist-mbid', 'Oblivion', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES ('track-assoc-1', 'rel-assoc', 'rec-audio-assoc', ?, 1, 4, '4', 'Oblivion')
  `).run(audio.id);

  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_metadata_id, artist_mbid, title, is_video, video_variant, metadata_status, monitored
    ) VALUES (?, 'artist-mbid', 'Oblivion', 1, 'official', 'provider_only', 1)
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id, title, quality
    ) VALUES ('tidal', 'video', 'assoc-video-1', 'artist-mbid', ?, 'Oblivion', 'FHD')
  `).run(video.id);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'tidal', 0.95)
  `).run(video.id, audio.id);

  // Orphan video for another album — must not appear on this RG.
  const otherAudio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-other-audio', ?, 'artist-mbid', 'Other Song', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  const orphanVideo = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES (?, 'artist-mbid', 'Orphan Video', 1, 'provider_only')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'tidal', 0.9)
  `).run(orphanVideo.id, otherAudio.id);

  const associated = videoQueryModule.getAlbumAssociatedVideos("rg-assoc");
  assert.equal(associated.length, 1);
  assert.equal(associated[0]?.id, String(video.id));
  assert.equal(associated[0]?.title, "Oblivion");
  assert.equal(associated[0]?.track_mbid, "track-assoc-1");
  assert.equal(associated[0]?.track_title, "Oblivion");
  assert.equal(associated[0]?.track_number, 4);
  assert.equal(associated[0]?.volume_number, 1);
  assert.equal(associated[0]?.audio_recording_mbid, "rec-audio-assoc");
  assert.equal(associated[0]?.is_monitored, true);
});

test("album associated videos honor monitored state and music-video type filters", async () => {
  const configModule = await import("../config/config.js");
  const config = configModule.readConfig();
  config.filtering = { ...config.filtering, include_video_lyric: false };
  configModule.writeConfig(config);

  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Video Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name) VALUES ('artist-mbid', 'artist-mbid', 'Video Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-filter', 'artist-mbid', 'Filter Album', 'album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES ('rel-filter', 'rg-filter', 'artist-mbid', 'Filter Album', '2024-01-01', 1, 1)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid)
    VALUES ('artist-mbid', 'rg-filter', 'stereo', 1, 'rel-filter')
  `).run();
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status)
    VALUES ('rec-audio-filter', ?, 'artist-mbid', 'Anchor', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, recording_id, medium_position, position, number, title)
    VALUES ('track-filter-1', 'rel-filter', 'rec-audio-filter', ?, 1, 1, '1', 'Anchor')
  `).run(audio.id);

  const makeVideo = (title: string, variant: string, monitored: number): number => {
    const row = dbModule.db.prepare(`
      INSERT INTO Recordings (artist_metadata_id, artist_mbid, title, is_video, video_variant, metadata_status, monitored)
      VALUES (?, 'artist-mbid', ?, 1, ?, 'provider_only', ?)
      RETURNING id
    `).get(artist.id, title, variant, monitored) as { id: number };
    dbModule.db.prepare(`
      INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, source, confidence)
      VALUES (?, ?, 'provider_video_for', 'tidal', 0.95)
    `).run(row.id, audio.id);
    return row.id;
  };

  const monitoredOfficial = makeVideo("Monitored Official", "official", 1);
  makeVideo("Unmonitored Official", "official", 0); // hidden: unmonitored
  makeVideo("Monitored Lyric", "lyric", 1); // hidden: lyric type disabled
  const downloadedUnmonitored = makeVideo("Downloaded Lyric", "lyric", 0); // visible: on disk

  // A downloaded file keeps its video visible even when unmonitored / type-off.
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type, recording_id
    ) VALUES (
      'artist-mbid', 'video', '/library/music-videos/Downloaded Lyric.mp4', 'Downloaded Lyric.mp4',
      '/library/music-videos', 'Downloaded Lyric', '.mp4', 'video', ?
    )
  `).run(downloadedUnmonitored);

  const associated = videoQueryModule.getAlbumAssociatedVideos("rg-filter");
  const ids = associated.map((video) => video.id).sort();
  assert.deepEqual(
    ids,
    [String(monitoredOfficial), String(downloadedUnmonitored)].sort(),
    "only the monitored official video and the downloaded (on-disk) video should appear",
  );
});
