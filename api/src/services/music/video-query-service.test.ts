import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { selectVideoInVideoLibraries } from "../../test-support/active-schema-fixture.js";

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
  dbModule.db.prepare("DELETE FROM ProviderVideoMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  // Candidate plans outlive the monitored rows now, so the reset has to
  // drop them explicitly instead of relying on a cascade.
  dbModule.db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlanSources").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlans").run();
  dbModule.db.prepare("DELETE FROM LibraryEditions").run();
  dbModule.db.prepare("DELETE FROM LibraryAlbums").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLibrarySelection(
  releaseGroupMbid: string,
  releaseMbid: string,
  monitored: boolean,
): void {
  const library = dbModule.db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  const releaseGroup = dbModule.db.prepare(`
    SELECT id FROM Albums WHERE mbid = ?
  `).get(releaseGroupMbid) as { id: number };
  const release = dbModule.db.prepare(`
    SELECT id FROM AlbumEditions WHERE mbid = ?
  `).get(releaseMbid) as { id: number };
  // Unmonitored means no row at all — there is no monitored column to set to 0.
  if (monitored) {
    dbModule.db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, selection_mode, locked, curation_version
      ) VALUES (?, ?, 'auto', 0, 1)
    `).run(library.id, releaseGroup.id);
  }
  dbModule.db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, curation_version
    ) VALUES (?, ?, 'auto', 1)
  `).run(library.id, release.id);
}

/**
 * A provider video offer plus its typed edge to a canonical recording.
 *
 * Under schema 41 `ProviderVideoMatches` is the ONLY link between a provider
 * video and a Recording — there is no `ProviderItems.recording_id` to stamp — so
 * an offer without a match row is invisible to every reader. `matchState` also
 * replaces the old `match_status` column: a rejected edge is a rejected match
 * row, not a rejected item.
 */
function seedVideoOffer(fixture: {
  provider: string;
  providerId: string;
  recordingId: number;
  title?: string | null;
  videoQuality?: string | null;
  durationMs?: number | null;
  releaseDate?: string | null;
  providerUrl?: string | null;
  availability?: string;
  matchState?: "accepted" | "rejected" | "candidate" | "ambiguous";
}): number {
  const item = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, video_quality, duration_ms,
      release_date, provider_url, availability
    ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    fixture.provider,
    fixture.providerId,
    fixture.title ?? null,
    fixture.videoQuality ?? null,
    fixture.durationMs ?? null,
    fixture.releaseDate ?? null,
    fixture.providerUrl ?? null,
    fixture.availability ?? "available",
  ) as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, ?, 'automatic', 0.99, 'test_fixture', 1)
  `).run(item.id, fixture.recordingId, fixture.matchState ?? "accepted");

  return item.id;
}

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
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status, release_date, cover_image_id
    ) VALUES ('mb-video-1', 'mb-video-1', ?, 'artist-mbid', 'Canonical Video', 215000, 1, 'musicbrainz', '2024-01-02', 'canonical-cover')
    RETURNING id
  `).get(artist.id) as { id: number };
  selectVideoInVideoLibraries(dbModule.db, recording.id);

  seedVideoOffer({
    provider: "tidal",
    providerId: "provider-video-1",
    recordingId: recording.id,
    title: "Canonical Video",
    videoQuality: "FHD",
    durationMs: 215_000,
    releaseDate: "2024-01-02",
    providerUrl: "https://tidal.com/browse/video/provider-video-1",
  });
  seedVideoOffer({
    provider: "youtube-music",
    providerId: "yt-video-01",
    recordingId: recording.id,
    title: "Canonical Video",
    durationMs: 215_000,
  });
  seedVideoOffer({
    provider: "apple-music",
    providerId: "apple-video-4k",
    recordingId: recording.id,
    title: "Canonical Video",
    videoQuality: "MP4_2160P",
    durationMs: 215_000,
  });
  // Accepted but unavailable — readers must drop it on availability, not on match.
  seedVideoOffer({
    provider: "apple-music",
    providerId: "unavailable-video",
    recordingId: recording.id,
    title: "Canonical Video",
    videoQuality: "4K",
    durationMs: 215_000,
    availability: "unavailable",
  });
  // A rejected typed edge, which is how schema 41 expresses the old
  // match_status = 'rejected'.
  seedVideoOffer({
    provider: "deezer",
    providerId: "rejected-video",
    recordingId: recording.id,
    title: "Canonical Video",
    videoQuality: "8K",
    durationMs: 215_000,
    matchState: "rejected",
  });

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
    url: null,
  }, {
    provider: "tidal",
    provider_id: "provider-video-1",
    quality: "FHD",
    url: "https://tidal.com/browse/video/provider-video-1",
  }, {
    provider: "youtube-music",
    provider_id: "yt-video-01",
    quality: null,
    url: null,
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
    available: false,
    can_preview: false,
    can_download: false,
  }, {
    provider: "tidal",
    provider_id: "provider-video-1",
    quality: "FHD",
    url: "https://tidal.com/browse/video/provider-video-1",
    available: false,
    can_preview: false,
    can_download: false,
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
  assert.equal(videoQueryModule.getVideoDetail("rejected-video"), null);
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
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES ('mb-file-quality-video', 'mb-file-quality-video', ?, 'file-quality-artist', 'Pompeii', 233000, 1, 'musicbrainz')
    RETURNING id
  `).get(artist.id) as { id: number };

  seedVideoOffer({
    provider: "tidal",
    providerId: "25704375",
    recordingId: recording.id,
    title: "Pompeii",
    durationMs: 233_000,
  });

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
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('mb-apple-video-42', 'mb-apple-video-42', ?, 'collision-artist', 'Apple Video', 1, 'musicbrainz')
    RETURNING id
  `).get(artist.id) as { id: number };
  seedVideoOffer({
    provider: "apple-music",
    providerId: "42",
    recordingId: recording.id,
    title: "Apple Video",
  });

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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count)
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
      provider, entity_type, provider_id, title
    ) VALUES ('apple-music', 'video', '99', 'Canonical Video')
  `).run();
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count)
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES
      ('rel-affil-single', 'rg-affil-single', 'artist-affil', 'Part Two', '2024-01-01', 3, 1),
      ('rel-affil-album', 'rg-affil-album', 'artist-affil', 'Ampersand', '2024-06-01', 12, 1)
  `).run();
  // Wanted state lives on library release-group selections, not Albums.monitored.
  seedLibrarySelection("rg-affil-album", "rel-affil-album", true);
  seedLibrarySelection("rg-affil-single", "rel-affil-single", false);

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
      provider, entity_type, provider_id, title
    ) VALUES ('youtube-music', 'video', 'yt-affil-omv', 'Song')
  `).run();

  const detail = videoQueryModule.getVideoDetail(String(video.id));
  assert.equal(detail?.albums?.length, 2);
  assert.equal(detail?.albums?.[0]?.id, "rg-affil-album", "slot-monitored album sorts first");
  assert.equal(detail?.albums?.[0]?.track_number, 5);
  assert.equal(detail?.albums?.[0]?.track_count, 12);
  assert.equal(detail?.albums?.[1]?.id, "rg-affil-single");
  assert.equal(detail?.albums?.[1]?.track_number, 2);
});

test("video detail appears-on prefers studio album over larger monitored live compilation", () => {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-studio-pref', 'Studio Pref Artist')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-studio-pref', 'artist-studio-pref', 'Studio Pref Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types)
    VALUES
      ('rg-studio-pref', 'artist-studio-pref', 'Back to Black', 'Album', '[]'),
      ('rg-live-comp', 'artist-studio-pref', 'At the BBC', 'Album', '["Compilation","Live"]')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES
      ('rel-studio-pref', 'rg-studio-pref', 'artist-studio-pref', 'Back to Black', '2006-01-01', 11, 1),
      ('rel-live-comp', 'rg-live-comp', 'artist-studio-pref', 'At the BBC', '2012-01-01', 52, 4)
  `).run();
  seedLibrarySelection("rg-studio-pref", "rel-studio-pref", false);
  seedLibrarySelection("rg-live-comp", "rel-live-comp", true);

  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, metadata_status
    ) VALUES ('rec-studio-pref-audio', ?, 'artist-studio-pref', 'Back to Black', 0, 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };
  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video, video_variant, metadata_status
    ) VALUES ('rec-studio-pref-video', ?, 'artist-studio-pref', 'Back to Black', 1, 'video', 'complete')
    RETURNING id
  `).get(artist.id) as { id: number };

  selectVideoInVideoLibraries(dbModule.db, video.id);
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    ) VALUES
      ('track-studio-pref', 'rel-studio-pref', 'rec-studio-pref-audio', ?, 1, 5, '5', 'Back to Black'),
      ('track-live-comp-video', 'rel-live-comp', 'rec-studio-pref-video', ?, 4, 8, '8', 'Back to Black')
  `).run(audio.id, video.id);

  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'tidal', 0.84)
  `).run(video.id, audio.id);

  const detail = videoQueryModule.getVideoDetail(String(video.id));
  assert.equal(detail?.albums?.length, 2);
  assert.equal(detail?.albums?.[0]?.id, "rg-studio-pref", "studio album outranks larger monitored live compilation");
  assert.equal(detail?.albums?.[1]?.id, "rg-live-comp");

  const onStudio = videoQueryModule.getAlbumAssociatedVideos("rg-studio-pref");
  assert.equal(onStudio.length, 1);
  assert.equal(onStudio[0]?.id, String(video.id));

  const onLiveComp = videoQueryModule.getAlbumAssociatedVideos("rg-live-comp");
  assert.equal(onLiveComp.length, 0, "live compilation strip must not list studio OMV that prefers the studio album");
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
    INSERT INTO AlbumEditions (
      mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count
    ) VALUES
      ('rel-multivol-single', 'rg-multivol', 'artist-multivol', 'GMTF Single', '2021-01-01', 13, 1),
      ('rel-multivol-full', 'rg-multivol', 'artist-multivol', 'GMTF 3CD', '2022-06-01', 27, 3)
  `).run();
  seedLibrarySelection("rg-multivol", "rel-multivol-full", true);

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
      mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES ('mb-video-provider-title', ?, 'artist-mbid', 'Unknown Video', 307000, 1, 'musicbrainz')
    RETURNING id
  `).get(artist.id) as { id: number };

  seedVideoOffer({
    provider: "tidal",
    providerId: "prov-title-1",
    recordingId: recording.id,
    title: "Happy Endings",
    durationMs: 307_000,
  });

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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES ('rel-assoc', 'rg-assoc', 'artist-mbid', 'Associated Album', '2024-01-01', 2, 1)
  `).run();
  seedLibrarySelection("rg-assoc", "rel-assoc", true);

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
      mbid, artist_metadata_id, artist_mbid, title, is_video, video_variant, metadata_status
    ) VALUES ('mb-video-assoc', ?, 'artist-mbid', 'Oblivion', 1, 'official', 'musicbrainz')
    RETURNING id
  `).get(artist.id) as { id: number };
  selectVideoInVideoLibraries(dbModule.db, video.id);
  seedVideoOffer({
    provider: "tidal",
    providerId: "assoc-video-1",
    recordingId: video.id,
    title: "Oblivion",
    providerUrl: "https://tidal.com/browse/video/assoc-video-1",
  });
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
  assert.equal(associated[0]?.provider_url, "https://tidal.com/browse/video/assoc-video-1");
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES ('rel-filter', 'rg-filter', 'artist-mbid', 'Filter Album', '2024-01-01', 1, 1)
  `).run();
  seedLibrarySelection("rg-filter", "rel-filter", true);
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
      INSERT INTO Recordings (artist_metadata_id, artist_mbid, title, is_video, video_variant, metadata_status)
      VALUES (?, 'artist-mbid', ?, 1, ?, 'provider_only')
      RETURNING id
    `).get(artist.id, title, variant) as { id: number };
    // Monitoring is a LibraryVideos row, not a column on the recording.
    if (monitored) selectVideoInVideoLibraries(dbModule.db, row.id);
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
