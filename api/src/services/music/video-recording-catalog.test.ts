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
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");
});

after(() => {
  closeActiveSchemaDb(dbModule, tempDir);
});

test("active schema carries youtube_video_id and user_version 46", () => {
  const columns = (dbModule.db.prepare("PRAGMA table_info(Recordings)").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.ok(columns.includes("youtube_video_id"));
  assert.equal(dbModule.db.pragma("user_version", { simple: true }), 46);
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
  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
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
  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "tidal-pompeii",
    title: "Pompeii",
    duration: 232,
  }]);
  const tidalId = Number((dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).get() as { id: number }).id);

  refreshVideo.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
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

test("coalescing recordings preserves an accepted edge over a rejected survivor edge", () => {
  const canonical = dbModule.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('mb-video-merge', 'artist-mbid', 'Pompeii', 232000, 1, 'video', 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const duplicate = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Pompeii', 232000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "tidal-merge",
    recordingId: duplicate.id,
    title: "Pompeii",
    durationMs: 232000,
  });
  const providerItem = dbModule.db.prepare(`
    SELECT id FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'video' AND provider_id = 'tidal-merge'
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'rejected', 'automatic', 0, 'superseded', 1)
  `).run(providerItem.id, canonical.id);

  assert.equal(catalog.coalesceVideoRecordings(canonical.id, duplicate.id), canonical.id);
  const match = dbModule.db.prepare(`
    SELECT recording_id AS recordingId, match_state AS matchState
    FROM ProviderVideoMatches
    WHERE provider_video_item_id = ? AND match_state = 'accepted'
  `).get(providerItem.id);
  assert.deepEqual(match, { recordingId: canonical.id, matchState: "accepted" });
  assert.equal(dbModule.db.prepare("SELECT id FROM Recordings WHERE id = ?").get(duplicate.id), undefined);
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


test('a video offer carrying both catalogue keys joins existing YouTube and MusicBrainz rows before linking the provider', () => {
  const yt = catalog.mintVideoRecording({ artistMbid: 'artist-mbid', title: 'Pompeii', youtubeVideoId: 'a1xFsoRYrds' });
  const mb = dbModule.db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
    VALUES ('mb-pompeii-joined', 'artist-mbid', 'Pompeii', 1, 'musicbrainz') RETURNING id`).get() as { id: number };
  seedAcceptedProviderVideoMatch(dbModule.db, { provider: 'tidal', providerVideoId: 'tidal-before-mb', recordingId: yt, title: 'Pompeii' });
  refreshVideo.RefreshVideoService.upsertArtistVideos('artist-mbid', [{
    provider: 'youtube-music', provider_id: 'a1xFsoRYrds', mbid: 'mb-pompeii-joined', title: 'Pompeii',
  }], { deferRepair: true });
  assert.deepEqual(dbModule.db.prepare('SELECT id, mbid, youtube_video_id FROM Recordings WHERE is_video = 1').all(), [
    { id: mb.id, mbid: 'mb-pompeii-joined', youtube_video_id: 'a1xFsoRYrds' },
  ]);
  assert.deepEqual(dbModule.db.prepare("SELECT DISTINCT recording_id FROM ProviderVideoMatches WHERE match_state = 'accepted'").all(), [{ recording_id: mb.id }]);
  assert.deepEqual(dbModule.db.pragma('foreign_key_check'), []);
});


test('contradictory provider MBID evidence cannot redirect an exact YouTube match', () => {
  const other = catalog.mintVideoRecording({ artistMbid: 'artist-mbid', title: 'Pompeii', youtubeVideoId: 'dQw4w9WgXcQ' });
  catalog.claimRecordingMbid(other, 'mb-other-cut');
  const exact = catalog.mintVideoRecording({ artistMbid: 'artist-mbid', title: 'Pompeii', youtubeVideoId: 'a1xFsoRYrds' });
  refreshVideo.RefreshVideoService.upsertArtistVideos('artist-mbid', [{
    provider: 'youtube-music', provider_id: 'a1xFsoRYrds', mbid: 'mb-other-cut', title: 'Pompeii',
  }], { deferRepair: true });
  assert.deepEqual(dbModule.db.prepare(`SELECT match.recording_id FROM ProviderVideoMatches match
    JOIN ProviderItems item ON item.id = match.provider_video_item_id
    WHERE item.provider = 'youtube-music' AND item.entity_type = 'video'
      AND item.provider_id = 'a1xFsoRYrds' AND match.match_state = 'accepted'`).all(), [{ recording_id: exact }]);
  assert.equal(catalog.findVideoRecordingByYouTubeWatchId('dQw4w9WgXcQ'), other);
  assert.equal(catalog.findVideoRecordingByYouTubeWatchId('a1xFsoRYrds'), exact);
});

test('catalogue merge preserves manual selection identity and rolls back all changes if a dependent write fails', () => {
  const yt = catalog.mintVideoRecording({ artistMbid: 'artist-mbid', title: 'Pompeii', youtubeVideoId: 'a1xFsoRYrds' });
  const mb = dbModule.db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
    VALUES ('mb-atomic-merge', 'artist-mbid', 'Pompeii', 1, 'musicbrainz') RETURNING id`).get() as { id: number };
  const library = dbModule.db.prepare("SELECT id FROM Libraries WHERE name = 'Video'").get() as { id: number };
  dbModule.db.prepare(`INSERT INTO LibraryVideos (library_id, video_recording_id, selection_mode, placement_selection_mode, reason)
    VALUES (?, ?, 'manual', 'manual', 'operator choice')`).run(library.id, yt);
  const beforeSelection = dbModule.db.prepare('SELECT * FROM LibraryVideos WHERE video_recording_id = ?').get(yt) as Record<string, unknown>;
  const audio = dbModule.db.prepare(`INSERT INTO Recordings (mbid, title, is_video)
    VALUES ('audio-atomic-merge', 'Pompeii', 0) RETURNING id`).get() as { id: number };
  dbModule.db.prepare(`INSERT INTO RecordingRelations
    (source_recording_id, target_recording_id, source_foreign_recording_id, target_foreign_recording_id, relation_type)
    VALUES (?, ?, 'mb-atomic-merge', 'audio-atomic-merge', 'music video')`).run(yt, audio.id);
  const beforeRecordings = dbModule.db.prepare('SELECT * FROM Recordings ORDER BY id').all();
  dbModule.db.exec(`CREATE TRIGGER reject_test_merge BEFORE DELETE ON Recordings
    BEGIN SELECT RAISE(ABORT, 'fixture dependency failure'); END`);
  try {
    assert.throws(() => catalog.coalesceVideoRecordings(mb.id, yt), /fixture dependency failure/);
    assert.deepEqual(dbModule.db.prepare('SELECT * FROM Recordings ORDER BY id').all(), beforeRecordings);
    assert.deepEqual(dbModule.db.prepare('SELECT * FROM LibraryVideos WHERE video_recording_id = ?').get(yt), beforeSelection);
  } finally { dbModule.db.exec('DROP TRIGGER reject_test_merge'); }
  assert.equal(catalog.coalesceVideoRecordings(mb.id, yt), mb.id);
  const selection = dbModule.db.prepare('SELECT * FROM LibraryVideos WHERE video_recording_id = ?').get(mb.id) as Record<string, unknown>;
  assert.equal(selection.id, beforeSelection.id);
  assert.equal(selection.selection_mode, 'manual');
  assert.equal(selection.placement_selection_mode, 'manual');
  assert.equal(selection.reason, 'operator choice');
  assert.deepEqual(dbModule.db.prepare('SELECT source_recording_id, target_recording_id FROM RecordingRelations').all(),
    [{ source_recording_id: mb.id, target_recording_id: audio.id }]);
  assert.deepEqual(dbModule.db.pragma('foreign_key_check'), []);
});
