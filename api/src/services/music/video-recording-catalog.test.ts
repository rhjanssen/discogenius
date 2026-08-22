import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";
import { seedAcceptedProviderVideoMatch } from "../../test-support/normalized-provider-fixtures.js";

const { tempDir } = prepareActiveSchemaEnv("video-recording-catalog");

let dbModule: typeof import("../../database.js");
let catalog: typeof import("./video-recording-catalog.js");
let refreshVideo: typeof import("./refresh-video-service.js");

before(async () => {
  const opened = await openActiveSchemaDb();
  dbModule = opened.dbModule;
  catalog = await import("./video-recording-catalog.js");
  refreshVideo = await import("./refresh-video-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderVideoMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-1", "Bastille", "artist-mbid");
});

after(() => {
  closeActiveSchemaDb(dbModule, tempDir);
});

test("active schema carries youtube_video_id and user_version 44", () => {
  const columns = (dbModule.db.prepare("PRAGMA table_info(Recordings)").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.ok(columns.includes("youtube_video_id"));
  assert.equal(dbModule.db.pragma("user_version", { simple: true }), 44);
});

test("watch id is taken from provider_id when _provider marks YouTube Music", () => {
  assert.equal(
    catalog.youtubeWatchIdFromVideoOffer({
      _provider: "youtube-music",
      provider_id: "a1xFsoRYrds",
    }),
    "a1xFsoRYrds",
  );
});

test("YouTube-only video recording is a valid ProviderVideoMatches target", () => {
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, is_video, youtube_video_id, metadata_status)
    VALUES ('artist-mbid', 'Pompeii', 1, 'dQw4w9WgXcQ', 'youtube')
    RETURNING id
  `).get() as { id: number };
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "dQw4w9WgXcQ",
    recordingId: recording.id,
    title: "Pompeii",
  });
  const match = dbModule.db.prepare(`
    SELECT recording_id AS recordingId FROM ProviderVideoMatches WHERE recording_id = ?
  `).get(recording.id) as { recordingId: number };
  assert.equal(match.recordingId, recording.id);
});

test("MusicBrainz video can also carry a YouTube watch id", () => {
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video, youtube_video_id, metadata_status)
    VALUES ('mb-video-1', 'artist-mbid', 'Pompeii', 1, 'a1xFsoRYrds', 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  assert.equal(
    catalog.findVideoRecordingByYouTubeWatchId("a1xFsoRYrds"),
    recording.id,
  );
  assert.equal(catalog.findVideoRecordingByMbid("mb-video-1"), recording.id);
});

test("Apple/TIDAL mint creates a provider_catalog recording and an accepted match", () => {
  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-1",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 225,
  }]);
  const recording = dbModule.db.prepare(`
    SELECT id, mbid, youtube_video_id, metadata_status AS status
    FROM Recordings WHERE is_video = 1
  `).get() as { id: number; mbid: string | null; youtube_video_id: string | null; status: string };
  assert.equal(recording.mbid, null);
  assert.equal(recording.youtube_video_id, null);
  assert.equal(recording.status, "provider_catalog");
  const match = dbModule.db.prepare(`
    SELECT video_match.recording_id AS recordingId
    FROM ProviderItems item
    JOIN ProviderVideoMatches video_match ON video_match.provider_video_item_id = item.id
    WHERE item.provider = 'tidal' AND item.provider_id = 'tidal-video-1'
  `).get() as { recordingId: number };
  assert.equal(match.recordingId, recording.id);
});

test("later YouTube attach merges onto a TIDAL mint instead of duplicating", () => {
  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-1", [{
    provider: "tidal",
    provider_id: "tidal-pompeii",
    title: "Pompeii",
    duration: 232,
  }]);
  const tidalId = Number((dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).get() as { id: number }).id);

  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-1", [{
    provider: "youtube-music",
    provider_id: "a1xFsoRYrds",
    title: "Pompeii",
    duration: 232,
    url: "https://www.youtube.com/watch?v=a1xFsoRYrds",
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, youtube_video_id AS yt, metadata_status AS status
    FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; yt: string | null; status: string }>;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, tidalId);
  assert.equal(videos[0].yt, "a1xFsoRYrds");
});

test("later MusicBrainz attach merges onto a YouTube-only row", () => {
  const ytOnly = catalog.mintVideoRecording({
    artistMbid: "artist-mbid",
    title: "Pompeii",
    lengthMs: 232000,
    youtubeVideoId: "a1xFsoRYrds",
  });
  const survivor = catalog.claimRecordingMbid(ytOnly, "mb-video-later");
  const row = dbModule.db.prepare(`
    SELECT id, mbid, youtube_video_id AS yt, metadata_status AS status
    FROM Recordings WHERE is_video = 1
  `).get() as { id: number; mbid: string; yt: string; status: string };
  assert.equal(row.id, survivor);
  assert.equal(row.mbid, "mb-video-later");
  assert.equal(row.yt, "a1xFsoRYrds");
  assert.equal(row.status, "musicbrainz");
  assert.equal(
    Number((dbModule.db.prepare("SELECT COUNT(*) AS n FROM Recordings WHERE is_video = 1").get() as { n: number }).n),
    1,
  );
});

test("related-audio matching works for a video recording without mbid", () => {
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-pompeii', 'artist-mbid', 'Bad Blood', 'Album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES ('rel-pompeii', 'rg-pompeii', 'artist-mbid', 'Bad Blood', 1)
  `).run();
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video)
    VALUES ('audio-pompeii', 'artist-mbid', 'Pompeii', 214000, 0)
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, recording_id, title, position, medium_position, length_ms)
    VALUES ('track-pompeii', 'rel-pompeii', 'audio-pompeii', ?, 'Pompeii', 1, 1, 214000)
  `).run(audio.id);

  const video = catalog.mintVideoRecording({
    artistMbid: "artist-mbid",
    title: "Pompeii",
    lengthMs: 223000,
    videoVariant: "official",
  });
  const linked = refreshVideo.RefreshVideoService.linkCatalogVideoAudioRelations("artist-mbid");
  assert.equal(linked, 1);
  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(video) as { audioId: number };
  assert.equal(relation.audioId, audio.id);
});

test("audio recordings still require mbid and cannot carry a YouTube watch id", () => {
  assert.throws(() => {
    dbModule.db.prepare(`
      INSERT INTO Recordings (title, is_video) VALUES ('No identity', 0)
    `).run();
  });
  assert.throws(() => {
    dbModule.db.prepare(`
      INSERT INTO Recordings (mbid, title, is_video, youtube_video_id)
      VALUES ('audio-1', 'Track', 0, 'a1xFsoRYrds')
    `).run();
  });
});
