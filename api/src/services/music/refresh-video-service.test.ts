import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  seedAcceptedProviderRecordingTrack,
  seedAcceptedProviderVideoMatch,
} from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-video-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshVideoModule: typeof import("./refresh-video-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshVideoModule = await import("./refresh-video-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertCanonicalVideo(input: {
  mbid: string;
  title: string;
  lengthMs?: number;
  variant?: string;
  releaseDate?: string;
  coverId?: string;
}): number {
  const row = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, video_variant,
      release_date, cover_image_id, is_video, metadata_status
    ) VALUES (?, ?, 'artist-mbid', ?, ?, ?, ?, ?, 1, 'musicbrainz')
    RETURNING id
  `).get(
    input.mbid,
    input.mbid,
    input.title,
    input.lengthMs ?? null,
    input.variant ?? "video",
    input.releaseDate ?? null,
    input.coverId ?? null,
  ) as { id: number };
  return row.id;
}

function acceptedVideoMatch(provider: string, providerId: string): {
  recordingId: number;
  decisionSource: string;
  method: string;
} | undefined {
  return dbModule.db.prepare(`
    SELECT
      video_match.recording_id AS recordingId,
      video_match.decision_source AS decisionSource,
      video_match.method
    FROM ProviderItems item
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = item.id
     AND video_match.match_state = 'accepted'
    WHERE item.provider = ?
      AND item.entity_type = 'video'
      AND item.provider_id = ?
  `).get(provider, providerId) as {
    recordingId: number;
    decisionSource: string;
    method: string;
  } | undefined;
}

function countRows(sql: string): number {
  return Number((dbModule.db.prepare(sql).get() as { count: number }).count);
}

function seedLegacyNoncanonicalVideoMatch(input: {
  provider: string;
  providerVideoId: string;
  recordingId: number;
  title: string;
  durationMs: number;
}): void {
  seedAcceptedProviderVideoMatch(dbModule.db, input);
}

test("unmatched provider videos mint a provider_catalog recording", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "tidal-video-1",
    album_id: "tidal-release-1",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 225,
    release_date: "2013-02-24",
    image_id: "provider-cover",
    quality: "FHD",
    url: "https://tidal.com/browse/video/tidal-video-1",
  }]);

  const offer = dbModule.db.prepare(`
    SELECT provider, entity_type AS entityType, provider_id AS providerId,
           title, duration_ms AS durationMs, video_quality AS quality
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'video'
  `).get() as Record<string, unknown>;
  assert.deepEqual(offer, {
    provider: "tidal",
    entityType: "video",
    providerId: "tidal-video-1",
    title: "Pompeii (Official Music Video)",
    durationMs: 225000,
    quality: "FHD",
  });

  const membership = dbModule.db.prepare(`
    SELECT release_item.provider_id AS releaseId
    FROM ProviderEditionMembers member
    JOIN ProviderItems release_item ON release_item.id = member.provider_edition_item_id
    JOIN ProviderItems video_item ON video_item.id = member.member_item_id
    WHERE video_item.provider = 'tidal'
      AND video_item.entity_type = 'video'
      AND video_item.provider_id = 'tidal-video-1'
  `).get() as { releaseId: string };
  assert.equal(membership.releaseId, "tidal-release-1");
  const recording = dbModule.db.prepare(`
    SELECT id, mbid, youtube_video_id AS yt, metadata_status AS status
    FROM Recordings WHERE is_video = 1
  `).get() as { id: number; mbid: string | null; yt: string | null; status: string };
  assert.equal(recording.mbid, null);
  assert.equal(recording.yt, null);
  assert.equal(recording.status, "provider_catalog");
  assert.equal(acceptedVideoMatch("tidal", "tidal-video-1")?.recordingId, recording.id);
});

test("a provider-supplied recording MBID is evidence and cannot mint with that MBID", () => {
  const providerVideo = {
    provider: "tidal",
    provider_id: "tidal-video-mbid",
    recording_mbid: "mb-video-1",
    title: "Pompeii",
    artist_name: "Bastille",
    duration: 232,
  };

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [providerVideo]);
  const minted = dbModule.db.prepare(`
    SELECT id, mbid, metadata_status AS status FROM Recordings WHERE is_video = 1
  `).get() as { id: number; mbid: string | null; status: string };
  assert.equal(minted.mbid, null);
  assert.equal(minted.status, "provider_catalog");
  assert.equal(acceptedVideoMatch("tidal", "tidal-video-mbid")?.recordingId, minted.id);

  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-1",
    title: "Pompeii",
    lengthMs: 232000,
    variant: "official",
  });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [providerVideo]);
  assert.equal(acceptedVideoMatch("tidal", "tidal-video-mbid")?.recordingId, canonicalId);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 1);
});

test("Apple and TIDAL Distorted Light Beam attach to the YouTube catalog row even when yt duration is 4s short", () => {
  const youtubeId = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status, youtube_video_id
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 178000, 1, 'video', 'youtube', '08AUS7lfXCU')
    RETURNING id
  `).get() as { id: number };

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "1573569906",
    title: "Distorted Light Beam",
    artist_name: "Bastille",
    duration: 182,
  }, {
    provider: "tidal",
    provider_id: "188763691",
    title: "Distorted Light Beam",
    artist_name: "Bastille",
    duration: 182,
  }]);

  assert.equal(acceptedVideoMatch("apple-music", "1573569906")?.recordingId, youtubeId.id);
  assert.equal(acceptedVideoMatch("tidal", "188763691")?.recordingId, youtubeId.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 1);
});

test("provider offers coalesce by current offer duration when the YouTube recording summary is stale", () => {
  const youtube = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status, youtube_video_id
    ) VALUES ('artist-mbid', 'Quarter Past Midnight', 200000, 1, 'video', 'youtube', 'X1VzzNbfPaM')
    RETURNING id
  `).get() as { id: number };
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "X1VzzNbfPaM",
    recordingId: youtube.id,
    title: "Quarter Past Midnight (Official Video)",
    durationMs: 205000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "89522194",
    title: "Quarter Past Midnight",
    artist_name: "Bastille",
    duration: 205,
  }]);

  assert.equal(acceptedVideoMatch("tidal", "89522194")?.recordingId, youtube.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 1);
});

test("repair coalesces legacy Apple and TIDAL twins onto YouTube while preserving the second TIDAL cut", () => {
  const apple = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 182000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  const tidalTwin = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 182000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  const tidalCut = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 181000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  const youtube = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status, youtube_video_id
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 178000, 1, 'video', 'youtube', '08AUS7lfXCU')
    RETURNING id
  `).get() as { id: number };
  seedLegacyNoncanonicalVideoMatch({
    provider: "apple-music",
    providerVideoId: "1573569906",
    recordingId: apple.id,
    title: "Distorted Light Beam",
    durationMs: 182000,
  });
  seedLegacyNoncanonicalVideoMatch({
    provider: "tidal",
    providerVideoId: "188763691",
    recordingId: tidalTwin.id,
    title: "Distorted Light Beam",
    durationMs: 182000,
  });
  seedLegacyNoncanonicalVideoMatch({
    provider: "tidal",
    providerVideoId: "192184461",
    recordingId: tidalCut.id,
    title: "Distorted Light Beam",
    durationMs: 181000,
  });
  seedLegacyNoncanonicalVideoMatch({
    provider: "youtube-music",
    providerVideoId: "08AUS7lfXCU",
    recordingId: youtube.id,
    title: "Distorted Light Beam",
    durationMs: 178000,
  });

  // An artist refresh invokes the same stored-assignment repair pass used by
  // Refresh & Scan, even when this provider response contains no new videos.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);

  assert.equal(acceptedVideoMatch("apple-music", "1573569906")?.recordingId, youtube.id);
  assert.equal(acceptedVideoMatch("tidal", "188763691")?.recordingId, youtube.id);
  assert.equal(acceptedVideoMatch("youtube-music", "08AUS7lfXCU")?.recordingId, youtube.id);
  assert.equal(acceptedVideoMatch("tidal", "192184461")?.recordingId, tidalCut.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
});

test("repair moves Apple live offer off the YouTube official video onto the provider live cut", () => {
  const official = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, youtube_video_id, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 178000, 1, 'video',
      'youtube', '08AUS7lfXCU', '2021-06-23'
    )
    RETURNING id
  `).get() as { id: number };
  const live = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 181000, 1, 'video',
      'provider_catalog', '2021-06-23'
    )
    RETURNING id
  `).get() as { id: number };

  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "08AUS7lfXCU",
    recordingId: official.id,
    title: "Distorted Light Beam",
    durationMs: 178000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "192184461",
    recordingId: live.id,
    title: "Distorted Light Beam",
    durationMs: 181000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music",
    providerVideoId: "1578311154",
    recordingId: official.id,
    title: "Distorted Light Beam (Live)",
    durationMs: 181000,
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems
    SET release_date = '2021-06-23'
    WHERE entity_type = 'video'
      AND provider_id IN ('192184461', '1578311154')
  `).run();

  // Refresh re-evaluates every stored automatic edge. The explicit Apple Live
  // title can pair with the same-date, same-duration bare TIDAL performance,
  // but not the three-second-short YouTube official cut.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);

  assert.equal(acceptedVideoMatch("apple-music", "1578311154")?.recordingId, live.id);
  assert.equal(acceptedVideoMatch("tidal", "192184461")?.recordingId, live.id);
  assert.equal(acceptedVideoMatch("youtube-music", "08AUS7lfXCU")?.recordingId, official.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
  const repairedLive = dbModule.db.prepare(`
    SELECT title, video_variant AS variant
    FROM Recordings
    WHERE id = ?
  `).get(live.id) as { title: string; variant: string };
  assert.deepEqual(repairedLive, {
    title: "Distorted Light Beam (Live)",
    variant: "live",
  });
});

test("one repair pass untangles displaced official and live provider video offers", () => {
  const official = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, youtube_video_id, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 178000, 1, 'video',
      'youtube', '08AUS7lfXCU', '2022-01-01'
    )
    RETURNING id
  `).get() as { id: number };
  const bareLive = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 181000, 1, 'video',
      'provider_catalog', '2021-06-23'
    )
    RETURNING id
  `).get() as { id: number };
  const explicitLive = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam (Live)', 181000, 1, 'live',
      'provider_catalog', '2021-06-23'
    )
    RETURNING id
  `).get() as { id: number };

  const offers = [
    ["youtube-music", "08AUS7lfXCU", official.id, "Distorted Light Beam", 178000],
    ["tidal", "188763691", official.id, "Distorted Light Beam", 182000],
    ["tidal", "192184461", bareLive.id, "Distorted Light Beam", 181000],
    // This is the final wrong live state observed in production: Apple official
    // is stranded with the bare TIDAL performance and Apple Live is separate.
    ["apple-music", "1573569906", bareLive.id, "Distorted Light Beam", 182000],
    ["apple-music", "1578311154", explicitLive.id, "Distorted Light Beam (Live)", 181000],
  ] as const;
  for (const [provider, providerVideoId, recordingId, title, durationMs] of offers) {
    seedAcceptedProviderVideoMatch(dbModule.db, {
      provider,
      providerVideoId,
      recordingId,
      title,
      durationMs,
    });
  }
  dbModule.db.prepare(`
    UPDATE ProviderItems
    SET release_date = '2021-06-23'
    WHERE entity_type = 'video'
      AND provider != 'youtube-music'
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);

  assert.equal(acceptedVideoMatch("apple-music", "1573569906")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("tidal", "188763691")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("youtube-music", "08AUS7lfXCU")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("apple-music", "1578311154")?.recordingId, bareLive.id);
  assert.equal(acceptedVideoMatch("tidal", "192184461")?.recordingId, bareLive.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
  const repairedLive = dbModule.db.prepare(`
    SELECT title, video_variant AS variant
    FROM Recordings
    WHERE id = ?
  `).get(bareLive.id) as { title: string; variant: string };
  assert.deepEqual(repairedLive, {
    title: "Distorted Light Beam (Live)",
    variant: "live",
  });

  const matchRowsAfterRepair = countRows("SELECT COUNT(*) AS count FROM ProviderVideoMatches");
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM ProviderVideoMatches"), matchRowsAfterRepair);
  assert.equal(acceptedVideoMatch("apple-music", "1573569906")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("apple-music", "1578311154")?.recordingId, bareLive.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
});

test("repair separates two Apple cuts initially attached to the official video", () => {
  const official = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, youtube_video_id, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 178000, 1, 'video',
      'youtube', '08AUS7lfXCU', '2022-01-01'
    )
    RETURNING id
  `).get() as { id: number };
  const live = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant,
      metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Distorted Light Beam', 181000, 1, 'video',
      'provider_catalog', '2021-06-23'
    )
    RETURNING id
  `).get() as { id: number };

  // Deliberately insert in the reverse of provider-id order. Repair ordering is
  // based on catalog authority and explicit variant evidence, not insertion or
  // provider-item timestamps.
  const offers = [
    ["apple-music", "1578311154", official.id, "Distorted Light Beam (Live)", 181000],
    ["youtube-music", "08AUS7lfXCU", official.id, "Distorted Light Beam", 178000],
    ["tidal", "192184461", live.id, "Distorted Light Beam", 181000],
    ["tidal", "188763691", official.id, "Distorted Light Beam", 182000],
    ["apple-music", "1573569906", official.id, "Distorted Light Beam", 182000],
  ] as const;
  for (const [provider, providerVideoId, recordingId, title, durationMs] of offers) {
    seedAcceptedProviderVideoMatch(dbModule.db, {
      provider,
      providerVideoId,
      recordingId,
      title,
      durationMs,
    });
  }
  dbModule.db.prepare(`
    UPDATE ProviderItems
    SET release_date = CASE provider
      WHEN 'youtube-music' THEN '2022-01-01'
      ELSE '2021-06-23'
    END
    WHERE entity_type = 'video'
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);

  assert.equal(acceptedVideoMatch("apple-music", "1573569906")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("tidal", "188763691")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("youtube-music", "08AUS7lfXCU")?.recordingId, official.id);
  assert.equal(acceptedVideoMatch("apple-music", "1578311154")?.recordingId, live.id);
  assert.equal(acceptedVideoMatch("tidal", "192184461")?.recordingId, live.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
});

test("repair splits a later-dated same-provider alternate from its canonical video", () => {
  const canonicalId = insertCanonicalVideo({
    mbid: "mb-send-them-off",
    title: "Send Them Off!",
    lengthMs: 225000,
    releaseDate: "2016-09-07",
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "65489061",
    recordingId: canonicalId,
    title: "Send Them Off!",
    durationMs: 224000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "65933630",
    recordingId: canonicalId,
    title: "Send Them Off!",
    durationMs: 226000,
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems
    SET release_date = CASE provider_id
      WHEN '65489061' THEN '2016-09-07'
      WHEN '65933630' THEN '2016-10-14'
    END
    WHERE provider = 'tidal'
      AND entity_type = 'video'
      AND provider_id IN ('65489061', '65933630')
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", []);

  assert.equal(acceptedVideoMatch("tidal", "65489061")?.recordingId, canonicalId);
  assert.notEqual(acceptedVideoMatch("tidal", "65933630")?.recordingId, canonicalId);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
});

test("same-title 181s and 182s provider cuts do not mint a third recording for a 182s offer", () => {
  const first = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 182000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  const second = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES ('artist-mbid', 'Distorted Light Beam', 181000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  seedLegacyNoncanonicalVideoMatch({
    provider: "tidal",
    providerVideoId: "tidal-dlb-181",
    recordingId: second.id,
    title: "Distorted Light Beam",
    durationMs: 181000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-dlb",
    title: "Distorted Light Beam",
    artist_name: "Bastille",
    duration: 182,
  }]);

  assert.equal(acceptedVideoMatch("apple-music", "apple-dlb")?.recordingId, first.id);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
});

test("title matching links only the compatible cut and preserves canonical facts", () => {
  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-pompeii",
    title: "Pompeii",
    lengthMs: 232000,
    variant: "official",
    releaseDate: "2013-01-01",
    coverId: "catalog-cover",
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "tidal-pompeii-official",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 233,
    release_date: "2013-03-01",
    image_id: "provider-cover",
  }, {
    provider: "tidal",
    provider_id: "tidal-pompeii-lyric",
    title: "Pompeii (Lyric Video)",
    artist_name: "Bastille",
    duration: 214,
  }, {
    provider: "apple-music",
    provider_id: "apple-pompeii-performance",
    title: "Pompeii (Good Morning America Performance)",
    artist_name: "Bastille",
    duration: 228,
  }]);

  assert.equal(acceptedVideoMatch("tidal", "tidal-pompeii-official")?.recordingId, canonicalId);
  const lyricMatch = acceptedVideoMatch("tidal", "tidal-pompeii-lyric");
  const performanceMatch = acceptedVideoMatch("apple-music", "apple-pompeii-performance");
  assert.ok(lyricMatch);
  assert.ok(performanceMatch);
  assert.notEqual(lyricMatch.recordingId, canonicalId);
  assert.notEqual(performanceMatch.recordingId, canonicalId);
  assert.notEqual(lyricMatch.recordingId, performanceMatch.recordingId);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 3);

  const canonical = dbModule.db.prepare(`
    SELECT title, length_ms AS lengthMs, release_date AS releaseDate,
           cover_image_id AS coverId, video_variant AS variant, metadata_status AS status
    FROM Recordings WHERE id = ?
  `).get(canonicalId);
  assert.deepEqual(canonical, {
    title: "Pompeii",
    lengthMs: 232000,
    releaseDate: "2013-01-01",
    coverId: "catalog-cover",
    variant: "official",
    status: "musicbrainz",
  });
});

test("equally strong canonical candidates fail closed instead of selecting by row order", () => {
  insertCanonicalVideo({ mbid: "mb-video-a", title: "Glory", lengthMs: 240000 });
  insertCanonicalVideo({ mbid: "mb-video-b", title: "Glory", lengthMs: 240000 });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-glory",
    title: "Glory",
    artist_name: "Bastille",
    duration: 240,
  }]);

  const gloryMatch = acceptedVideoMatch("apple-music", "apple-glory");
  assert.ok(gloryMatch);
  const canonicalIds = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1 AND mbid IS NOT NULL
  `).all() as Array<{ id: number }>;
  assert.equal(canonicalIds.length, 2);
  assert.ok(!canonicalIds.some((row) => row.id === gloryMatch.recordingId));
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 3);
});

test("a manual accepted match to a MusicBrainz recording survives automatic revalidation", () => {
  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-manual",
    title: "Canonical Cut",
    lengthMs: 200000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "tidal-manual",
    recordingId: canonicalId,
    title: "Completely Different Provider Title",
    durationMs: 250000,
  });
  dbModule.db.prepare(`
    UPDATE ProviderVideoMatches
    SET decision_source = 'manual', method = 'manual-selection', confidence = 1
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "tidal-manual",
    title: "Completely Different Provider Title",
    artist_name: "Bastille",
    duration: 250,
  }]);

  assert.deepEqual(acceptedVideoMatch("tidal", "tidal-manual"), {
    recordingId: canonicalId,
    decisionSource: "manual",
    method: "manual-selection",
  });
});

test("the active schema rejects identity-bearing matches to audio recordings", () => {
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
    VALUES ('audio-1', 'artist-mbid', 'Pompeii', 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const providerItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'video', 'tidal-invalid-target', 'Provider video')
    RETURNING id
  `).get() as { id: number };

  assert.throws(
    () => dbModule.db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'accepted', 'automatic', 1, 'invalid', 1)
    `).run(providerItem.id, audio.id),
    /canonical video recording/,
  );
});

test("a provider-catalog mint keeps its file and match when no MusicBrainz twin exists", () => {
  const minted = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('artist-mbid', 'Orphan Provider Video', 180000, 1, 'provider_catalog')
    RETURNING id
  `).get() as { id: number };
  seedLegacyNoncanonicalVideoMatch({
    provider: "tidal",
    providerVideoId: "tidal-orphan",
    recordingId: minted.id,
    title: "Orphan Provider Video",
    durationMs: 180000,
  });
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, 'tidal', 'video', 'tidal-orphan',
      'video', 'C:/library/orphan.mp4', 'orphan.mp4', 'C:/library',
      'orphan.mp4', '.mp4', 'video'
    )
  `).run(minted.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "tidal",
    provider_id: "tidal-orphan",
    title: "Orphan Provider Video",
    artist_name: "Bastille",
    duration: 180,
  }]);

  const file = dbModule.db.prepare(`
    SELECT recording_id AS recordingId, canonical_recording_mbid AS recordingMbid,
           provider, provider_entity_type AS entityType, provider_id AS providerId
    FROM TrackFiles WHERE file_path = 'C:/library/orphan.mp4'
  `).get();
  assert.deepEqual(file, {
    recordingId: minted.id,
    recordingMbid: null,
    provider: "tidal",
    entityType: "video",
    providerId: "tidal-orphan",
  });
  assert.equal(acceptedVideoMatch("tidal", "tidal-orphan")?.recordingId, minted.id);
});

test("legacy provider-only files are re-homed when a canonical video becomes available", () => {
  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-live",
    title: "Me & Mr. Jones",
    lengthMs: 203000,
    releaseDate: "2024-09-02",
  });
  const legacy = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, video_variant, is_video, metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Me & Mr. Jones (Live at Other Voices, 2006)', 203000,
      'live', 1, 'provider_catalog', '2024-09-02'
    )
    RETURNING id
  `).get() as { id: number };
  seedLegacyNoncanonicalVideoMatch({
    provider: "apple-music",
    providerVideoId: "apple-mej-live",
    recordingId: legacy.id,
    title: "Me & Mr. Jones (Live at Other Voices, 2006)",
    durationMs: 203000,
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems SET release_date = '2024-09-02'
    WHERE provider = 'apple-music' AND entity_type = 'video' AND provider_id = 'apple-mej-live'
  `).run();
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, 'apple-music', 'video', 'apple-mej-live',
      'video', 'C:/library/mej-live.mp4', 'mej-live.mp4', 'C:/library',
      'mej-live.mp4', '.mp4', 'video'
    )
  `).run(legacy.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-mej-live",
    title: "Me & Mr. Jones (Live at Other Voices, 2006)",
    artist_name: "Bastille",
    duration: 203,
    release_date: "2024-09-02",
  }]);

  assert.equal(acceptedVideoMatch("apple-music", "apple-mej-live")?.recordingId, canonicalId);
  const file = dbModule.db.prepare(`
    SELECT recording_id AS recordingId, canonical_recording_mbid AS recordingMbid
    FROM TrackFiles WHERE provider_id = 'apple-mej-live'
  `).get();
  assert.deepEqual(file, { recordingId: canonicalId, recordingMbid: "mb-video-live" });
  assert.equal(dbModule.db.prepare("SELECT id FROM Recordings WHERE id = ?").get(legacy.id), undefined);
});

test("provider audio evidence links a minted video, then follows a later MusicBrainz merge", () => {
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES (
      'audio-pompeii', 'audio-pompeii', 'artist-mbid', 'Pompeii', 214000, 0, 'musicbrainz'
    )
    RETURNING id
  `).get() as { id: number };
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-album-1",
    providerTrackId: "apple-song-1",
    recordingId: audio.id,
    title: "Pompeii",
    durationMs: 214000,
  });

  const offer = {
    provider: "apple-music",
    provider_id: "apple-video-related",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 225,
    album_id: "apple-album-1",
    related_track_id: "apple-song-1",
  };
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [offer]);
  const minted = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1 AND mbid IS NULL
  `).get() as { id: number };
  const mintedRelation = dbModule.db.prepare(`
    SELECT source_recording_id AS videoId, target_recording_id AS audioId, confidence, data
    FROM RecordingRelations WHERE relation_type = 'provider_video_for'
  `).get() as { videoId: number; audioId: number; confidence: number; data: string };
  assert.equal(mintedRelation.videoId, minted.id);
  assert.equal(mintedRelation.audioId, audio.id);
  assert.equal(mintedRelation.confidence, 0.96);
  assert.match(mintedRelation.data, /provider-video-related-track/);

  const videoId = insertCanonicalVideo({
    mbid: "mb-video-pompeii",
    title: "Pompeii",
    lengthMs: 225000,
  });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [offer]);
  const relation = dbModule.db.prepare(`
    SELECT source_recording_id AS videoId, target_recording_id AS audioId, confidence, data
    FROM RecordingRelations WHERE relation_type = 'provider_video_for'
  `).get() as { videoId: number; audioId: number; confidence: number; data: string };
  assert.equal(relation.videoId, videoId);
  assert.equal(relation.audioId, audio.id);
  assert.equal(relation.confidence, 0.96);
  assert.match(relation.data, /provider-video-related-track/);
  assert.equal(dbModule.db.prepare("SELECT id FROM Recordings WHERE id = ?").get(minted.id), undefined);
});

test("provider related-track evidence cannot attach a live video to studio or reprise audio", () => {
  const audioId = seedStudioAudio({
    recordingMbid: "audio-distorted-reprise",
    title: "Distorted Light Beam (reprise)",
    lengthMs: 181000,
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-dlb-album",
    providerTrackId: "apple-dlb-reprise",
    recordingId: audioId,
    title: "Distorted Light Beam (reprise)",
    durationMs: 181000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-dlb-live",
    title: "Distorted Light Beam (Live)",
    lengthMs: 181000,
    variant: "live",
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music",
    providerVideoId: "apple-dlb-live",
    providerEditionId: "apple-dlb-album",
    recordingId: videoId,
    title: "Distorted Light Beam (Live)",
    durationMs: 181000,
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence, data
    ) VALUES (?, ?, 'provider_video_for', 'provider', 0.96, ?)
  `).run(videoId, audioId, JSON.stringify({ method: "provider-video-related-track" }));

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-dlb-live",
    album_id: "apple-dlb-album",
    related_track_id: "apple-dlb-reprise",
    title: "Distorted Light Beam (Live)",
    duration: 181,
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoId) as { audioId: number } | undefined;
  assert.equal(relation, undefined);
});

test("provider related-track evidence can attach a live video to a track on a live album", () => {
  const audioId = seedStudioAudio({
    recordingMbid: "audio-royal-albert-hall",
    title: "Pompeii",
    lengthMs: 220000,
    albumMbid: "rg-royal-albert-hall",
    editionMbid: "rel-royal-albert-hall",
  });
  dbModule.db.prepare(`
    UPDATE Albums SET title = 'Live at the Royal Albert Hall', secondary_types = '["Live"]'
    WHERE mbid = 'rg-royal-albert-hall'
  `).run();
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-royal-albert-hall",
    providerTrackId: "apple-pompeii-live",
    recordingId: audioId,
    title: "Pompeii",
    durationMs: 220000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-pompeii-live",
    album_id: "apple-royal-albert-hall",
    related_track_id: "apple-pompeii-live",
    title: "Pompeii (Live)",
    duration: 220,
  }]);

  const video = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1 AND title = 'Pompeii (Live)'
  `).get() as { id: number };
  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId, data
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(video.id) as { audioId: number; data: string };
  assert.equal(relation.audioId, audioId);
  assert.equal(JSON.parse(relation.data).method, "provider-video-related-track");
});

test("provider related-track evidence fails closed when edition occurrences disagree", () => {
  const firstAudioId = seedStudioAudio({
    recordingMbid: "audio-shared-track-first",
    title: "Shared song",
    lengthMs: 180000,
    albumMbid: "rg-shared-first",
    editionMbid: "rel-shared-first",
  });
  const secondAudioId = seedStudioAudio({
    recordingMbid: "audio-shared-track-second",
    title: "Shared song",
    lengthMs: 180000,
    albumMbid: "rg-shared-second",
    editionMbid: "rel-shared-second",
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-shared-first",
    providerTrackId: "apple-reused-track",
    recordingId: firstAudioId,
    title: "Shared song",
    durationMs: 180000,
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-shared-second",
    providerTrackId: "apple-reused-track",
    recordingId: secondAudioId,
    title: "Shared song",
    durationMs: 180000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-shared-video",
    related_track_id: "apple-reused-track",
    title: "Shared song (Official Music Video)",
    duration: 180,
  }]);

  assert.equal(
    dbModule.db.prepare("SELECT 1 FROM RecordingRelations WHERE relation_type = 'provider_video_for'").get(),
    undefined,
  );
});

test("stored provider album evidence is aggregated instead of first-provider-wins", () => {
  const firstAudioId = seedStudioAudio({
    recordingMbid: "audio-provider-first",
    title: "Provider conflict",
    lengthMs: 180000,
    albumMbid: "rg-provider-first",
    editionMbid: "rel-provider-first",
  });
  const secondAudioId = seedStudioAudio({
    recordingMbid: "audio-provider-second",
    title: "Provider conflict",
    lengthMs: 180000,
    albumMbid: "rg-provider-second",
    editionMbid: "rel-provider-second",
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music",
    providerEditionId: "apple-provider-first",
    providerTrackId: "apple-provider-track",
    recordingId: firstAudioId,
    title: "Provider conflict",
    durationMs: 180000,
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "tidal",
    providerEditionId: "tidal-provider-second",
    providerTrackId: "tidal-provider-track",
    recordingId: secondAudioId,
    title: "Provider conflict",
    durationMs: 180000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-provider-conflict",
    title: "Provider conflict",
    lengthMs: 180000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music",
    providerVideoId: "apple-provider-video",
    providerEditionId: "apple-provider-first",
    recordingId: videoId,
    title: "Provider conflict",
    durationMs: 180000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "tidal-provider-video",
    providerEditionId: "tidal-provider-second",
    recordingId: videoId,
    title: "Provider conflict",
    durationMs: 180000,
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence, data
    ) VALUES (?, ?, 'provider_video_for', 'apple-music', 0.9, '{}')
  `).run(videoId, firstAudioId);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "apple-music",
    provider_id: "apple-provider-video",
    album_id: "apple-provider-first",
    title: "Provider conflict",
    duration: 180,
  }, {
    provider: "tidal",
    provider_id: "tidal-provider-video",
    album_id: "tidal-provider-second",
    title: "Provider conflict",
    duration: 180,
  }]);

  assert.equal(
    dbModule.db.prepare(`
      SELECT 1 FROM RecordingRelations
      WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
    `).get(videoId),
    undefined,
  );
});

test("partial catalog hydration does not erase a compatible provider counterpart", () => {
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('audio-partial', 'artist-mbid', 'Partial song', 180000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-partial",
    title: "Partial song",
    lengthMs: 180000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "youtube-partial-video",
    recordingId: videoId,
    title: "Partial song",
    durationMs: 180000,
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence, data
    ) VALUES (?, ?, 'provider_video_for', 'youtube-music', 0.98, ?)
  `).run(videoId, audio.id, JSON.stringify({ method: "yt-atv-omv-counterpart" }));

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "youtube-music",
    provider_id: "youtube-partial-video",
    title: "Partial song",
    duration: 180,
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoId) as { audioId: number } | undefined;
  assert.equal(relation?.audioId, audio.id);
});

test("a YouTube self-OMV relation is removed when detailed metadata identifies a live cut", () => {
  const audioId = seedStudioAudio({
    recordingMbid: "audio-million-pieces-studio",
    title: "Million Pieces",
    lengthMs: 283000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-million-pieces-live",
    title: "Million Pieces ft. The Chamber Orchestra Of London (Live)",
    lengthMs: 285000,
    variant: "live",
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "6OLp72eLLc4",
    recordingId: videoId,
    title: "Million Pieces ft. The Chamber Orchestra Of London (Live)",
    durationMs: 285000,
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence, data
    ) VALUES (?, ?, 'provider_video_for', 'youtube-music', 0.98, ?)
  `).run(videoId, audioId, JSON.stringify({
    method: "yt-atv-omv-counterpart",
    evidence: { counterpartKind: "yt-self-omv" },
  }));

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "youtube-music",
    provider_id: "6OLp72eLLc4",
    title: "Million Pieces ft. The Chamber Orchestra Of London (Live)",
    duration: 285,
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoId);
  assert.equal(relation, undefined);
});

test("provider refresh preserves previously probed video quality", () => {
  insertCanonicalVideo({ mbid: "mb-video-quality", title: "Pompeii", lengthMs: 232000 });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "youtube-music",
    provider_id: "youtube-pompeii",
    title: "Pompeii",
    duration: 232,
    quality: "FHD",
  }]);
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "youtube-music",
    provider_id: "youtube-pompeii",
    title: "Pompeii",
    duration: 232,
    quality: null,
  }]);

  const row = dbModule.db.prepare(`
    SELECT video_quality AS quality
    FROM ProviderItems
    WHERE provider = 'youtube-music' AND entity_type = 'video' AND provider_id = 'youtube-pompeii'
  `).get() as { quality: string };
  assert.equal(row.quality, "FHD");
});

test("missing quality backfill probes only accepted video offers", async () => {
  const providerModule = await import("../providers/index.js");
  const manager = providerModule.streamingProviderManager as unknown as {
    getStreamingProvider: (id: string) => unknown;
  };
  const original = manager.getStreamingProvider;

  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-backfill",
    title: "Pompeii",
    lengthMs: 232000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "youtube-backfill",
    recordingId: canonicalId,
    title: "Pompeii",
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems
    SET video_quality = 'YOUTUBE_LOSSY'
    WHERE provider = 'youtube-music'
      AND entity_type = 'video'
      AND provider_id = 'youtube-backfill'
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('youtube-music', 'video', 'youtube-unmatched', 'Unknown Provider Cut')
  `).run();

  const probed: string[] = [];
  manager.getStreamingProvider = (id: string) => {
    if (id !== "youtube-music") throw new Error(`unknown provider ${id}`);
    return {
      getVideo: async (providerId: string) => {
        probed.push(providerId);
        return { quality: "FHD" };
      },
    };
  };

  try {
    const updated = await refreshVideoModule.RefreshVideoService
      .backfillMissingVideoOfferQuality("artist-mbid");
    assert.equal(updated, 1);
    assert.deepEqual(probed, ["youtube-backfill"]);
    const filled = dbModule.db.prepare(`
      SELECT video_quality AS quality FROM ProviderItems
      WHERE provider = 'youtube-music' AND entity_type = 'video'
        AND provider_id = 'youtube-backfill'
    `).get() as { quality: string };
    assert.equal(filled.quality, "FHD");
  } finally {
    manager.getStreamingProvider = original;
  }
});

test("Watch Listen Tell session video does not attach to studio Overjoyed audio", () => {
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-overjoyed', 'artist-mbid', 'Bad Blood', 'Album')
  `).run();
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES ('rel-overjoyed', 'rg-overjoyed', 'artist-mbid', 'Bad Blood', 1)
  `).run();
  const audio = db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES (
      'audio-overjoyed', 'audio-overjoyed', 'artist-mbid', 'Overjoyed', 206000, 0, 'musicbrainz'
    )
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, recording_id, title, position, medium_position, length_ms)
    VALUES ('track-overjoyed', 'rel-overjoyed', 'audio-overjoyed', ?, 'Overjoyed', 1, 1, 206000)
  `).run(audio.id);

  const videoId = insertCanonicalVideo({
    mbid: "mb-wlt-overjoyed",
    title: "Overjoyed",
    lengthMs: 195000,
  });
  db.prepare(`UPDATE Recordings SET disambiguation = ? WHERE id = ?`)
    .run("Watch Listen Tell session", videoId);
  seedAcceptedProviderVideoMatch(db, {
    provider: "youtube-music",
    providerVideoId: "hm92KOlB7NE",
    recordingId: videoId,
    title: "Overjoyed",
    durationMs: 195000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("artist-mbid", [{
    provider: "youtube-music",
    provider_id: "hm92KOlB7NE",
    title: "Overjoyed",
    duration: 195,
  }]);

  const relation = db.prepare(`
    SELECT target_recording_id AS audioId
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoId) as { audioId: number } | undefined;
  assert.equal(relation, undefined);
});

function seedStudioAudio(input: {
  recordingMbid: string;
  title: string;
  lengthMs: number;
  albumMbid?: string;
  editionMbid?: string;
}): number {
  const { db } = dbModule;
  const albumMbid = input.albumMbid ?? `rg-${input.recordingMbid}`;
  const editionMbid = input.editionMbid ?? `rel-${input.recordingMbid}`;
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, 'artist-mbid', ?, 'Album')
  `).run(albumMbid, input.title);
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, 'artist-mbid', ?, 1)
  `).run(editionMbid, albumMbid, input.title);
  const audio = db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    ) VALUES (?, ?, 'artist-mbid', ?, ?, 0, 'musicbrainz')
    RETURNING id
  `).get(input.recordingMbid, input.recordingMbid, input.title, input.lengthMs) as { id: number };
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, recording_id, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run(`track-${input.recordingMbid}`, editionMbid, input.recordingMbid, audio.id, input.title, input.lengthMs);
  return audio.id;
}

test("catalog ingest links a standalone OMV to studio audio with no provider offers", () => {
  const audioId = seedStudioAudio({
    recordingMbid: "audio-pompeii",
    title: "Pompeii",
    lengthMs: 214000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-pompeii-omv",
    title: "Pompeii",
    lengthMs: 223000,
    variant: "official",
  });

  const linked = refreshVideoModule.RefreshVideoService.linkCatalogVideoAudioRelations("artist-mbid");
  assert.equal(linked, 1);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId, source, data
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoId) as { audioId: number; source: string; data: string };
  assert.equal(relation.audioId, audioId);
  assert.equal(relation.source, "canonical");
  assert.equal(JSON.parse(relation.data).method, "canonical-title-duration");
  assert.equal(countRows("SELECT COUNT(*) AS count FROM ProviderItems"), 0);
});

test("catalog ingest does not attach a session video to studio audio", () => {
  seedStudioAudio({
    recordingMbid: "audio-overjoyed-catalog",
    title: "Overjoyed",
    lengthMs: 206000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-wlt-catalog",
    title: "Overjoyed",
    lengthMs: 195000,
  });
  dbModule.db.prepare(`UPDATE Recordings SET disambiguation = ? WHERE id = ?`)
    .run("Watch Listen Tell session", videoId);

  assert.equal(
    refreshVideoModule.RefreshVideoService.linkCatalogVideoAudioRelations("artist-mbid"),
    0,
  );
  assert.equal(
    Number((dbModule.db.prepare(`
      SELECT COUNT(*) AS count FROM RecordingRelations WHERE source_recording_id = ?
    `).get(videoId) as { count: number }).count),
    0,
  );
});

test("catalog ingest does not attach a live video to studio-only audio", () => {
  seedStudioAudio({
    recordingMbid: "audio-oblivion",
    title: "Oblivion",
    lengthMs: 200000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-oblivion-live",
    title: "Oblivion (Live)",
    lengthMs: 200000,
    variant: "live",
  });

  assert.equal(
    refreshVideoModule.RefreshVideoService.linkCatalogVideoAudioRelations("artist-mbid"),
    0,
  );
  assert.equal(
    Number((dbModule.db.prepare(`
      SELECT COUNT(*) AS count FROM RecordingRelations WHERE source_recording_id = ?
    `).get(videoId) as { count: number }).count),
    0,
  );
});

test("catalog ingest leaves an existing music_video_for relation alone", () => {
  const audioId = seedStudioAudio({
    recordingMbid: "audio-flaws",
    title: "Flaws",
    lengthMs: 220000,
  });
  const videoId = insertCanonicalVideo({
    mbid: "mb-video-flaws",
    title: "Flaws",
    lengthMs: 220000,
    variant: "official",
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'music_video_for', 'musicbrainz', 1)
  `).run(videoId, audioId);

  assert.equal(
    refreshVideoModule.RefreshVideoService.linkCatalogVideoAudioRelations("artist-mbid"),
    0,
  );
  const rows = dbModule.db.prepare(`
    SELECT relation_type AS type FROM RecordingRelations WHERE source_recording_id = ?
  `).all(videoId) as Array<{ type: string }>;
  assert.deepEqual(rows.map((row) => row.type), ["music_video_for"]);
});
