import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

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
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("provider-artist-1", "Bastille", "artist-mbid");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider videos create canonical recordings without artist-wide audio linking", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status, isrcs
    )
    VALUES ('audio-recording-1', 'audio-recording-1', 'artist-mbid', 'Pompeii', 214000, 0, 'musicbrainz', '["GBUM71300354"]')
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-1",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 225,
    release_date: "2013-02-24",
    image_id: "cover-id",
    isrc: "GBUM71300354",
    url: "https://tidal.com/browse/video/tidal-video-1",
  }]);

  const video = dbModule.db.prepare(`
    SELECT id, title, video_variant, is_video, metadata_status, release_date, cover_image_id
    FROM Recordings
    WHERE is_video = 1
  `).get() as {
    id: number;
    title: string;
    video_variant: string | null;
    is_video: number;
    metadata_status: string;
    release_date: string;
    cover_image_id: string;
  };
  assert.equal(video.title, "Pompeii");
  assert.equal(video.video_variant, "official");
  assert.equal(video.metadata_status, "provider_only");
  assert.equal(video.release_date, "2013-02-24");
  assert.equal(video.cover_image_id, "cover-id");

  const providerOffer = dbModule.db.prepare(`
    SELECT provider, entity_type AS entityType, provider_id AS providerId, recording_id AS recordingId
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'video'
  `).get() as { provider: string; entityType: string; providerId: string; recordingId: number };
  assert.deepEqual(providerOffer, {
    provider: "tidal",
    entityType: "video",
    providerId: "tidal-video-1",
    recordingId: video.id,
  });

  const relation = dbModule.db.prepare(`
    SELECT source_recording_id
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get();
  assert.equal(relation, undefined, "orphan videos must not artist-wide match on title/ISRC/duration");

  const retiredTables = dbModule.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ProviderAlbums', 'ProviderMedia', 'ProviderAlbumArtists', 'ProviderMediaArtists')
  `).all() as Array<{ name: string }>;
  assert.deepEqual(retiredTables, []);
});

test("the same video from two providers dedupes onto one recording; different variants stay separate", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-dwyb",
    title: "Don't Want You Back (feat. Kiesza)",
    artist_name: "Bastille",
    duration: 208,
  }, {
    provider: "tidal",
    provider_id: "tidal-video-dwyb-audio",
    title: "Don't Want You Back (Audio)",
    artist_name: "Bastille",
    duration: 209,
  }]);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-video-dwyb",
    title: "Don't Want You Back (feat. Kiesza) (Official Video)",
    artist_name: "Bastille",
    duration: 208,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, title FROM Recordings WHERE is_video = 1 ORDER BY id
  `).all() as Array<{ id: number; title: string }>;
  // One shared recording for the video proper, one for the audio upload.
  assert.equal(videos.length, 2);

  const offers = dbModule.db.prepare(`
    SELECT provider, provider_id AS providerId, recording_id AS recordingId
    FROM ProviderItems
    WHERE entity_type = 'video'
    ORDER BY provider, provider_id
  `).all() as Array<{ provider: string; providerId: string; recordingId: number }>;

  const tidalMain = offers.find((offer) => offer.providerId === "tidal-video-dwyb");
  const appleMain = offers.find((offer) => offer.providerId === "apple-video-dwyb");
  const tidalAudio = offers.find((offer) => offer.providerId === "tidal-video-dwyb-audio");
  assert.ok(tidalMain && appleMain && tidalAudio);
  assert.equal(appleMain?.recordingId, tidalMain?.recordingId);
  assert.notEqual(tidalAudio?.recordingId, tidalMain?.recordingId);
});

test("canonical MusicBrainz video matching keeps official, lyric, and live assets separate", () => {
  const canonical = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms,
      is_video, metadata_status, monitored
    ) VALUES (
      'mb-video-pompeii', 'mb-video-pompeii', 'artist-mbid', 'Pompeii', 232000,
      1, 'musicbrainz', 1
    )
    RETURNING id
  `).get() as { id: number };

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-pompeii-official",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 232,
  }, {
    provider: "tidal",
    provider_id: "tidal-pompeii-lyric",
    title: "Pompeii (Lyric Video)",
    artist_name: "Bastille",
    duration: 214,
  }, {
    provider: "apple-music",
    provider_id: "apple-pompeii-lyric",
    title: "Pompeii (Official Lyric Video)",
    artist_name: "Bastille",
    duration: 214,
  }, {
    provider: "apple-music",
    provider_id: "apple-pompeii-performance",
    title: "Pompeii (Good Morning America Performance)",
    artist_name: "Bastille",
    // Off by 4s from the MB cut — stays its own recording.
    duration: 228,
  }]);

  const offers = dbModule.db.prepare(`
    SELECT provider_id AS providerId, recording_id AS recordingId
    FROM ProviderItems
    WHERE entity_type = 'video'
    ORDER BY provider_id
  `).all() as Array<{ providerId: string; recordingId: number }>;
  const byId = new Map(offers.map((offer) => [offer.providerId, offer.recordingId]));

  assert.equal(byId.get("tidal-pompeii-official"), canonical.id);
  assert.equal(byId.get("tidal-pompeii-lyric"), byId.get("apple-pompeii-lyric"));
  assert.notEqual(byId.get("tidal-pompeii-lyric"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), byId.get("apple-pompeii-lyric"));

  const recordings = dbModule.db.prepare("SELECT id FROM Recordings WHERE is_video = 1").all();
  assert.equal(recordings.length, 3);

  const normalizedOffers = dbModule.db.prepare(`
    SELECT provider_id AS providerId, duration_ms AS durationMs, availability
    FROM ProviderItems
    WHERE entity_type = 'video'
    ORDER BY provider_id
  `).all() as Array<{ providerId: string; durationMs: number | null; availability: string }>;
  assert.equal(
    normalizedOffers.find((offer) => offer.providerId === "tidal-pompeii-official")?.durationMs,
    232000,
  );
  assert.ok(normalizedOffers.every((offer) => offer.availability === "available"));

  assert.deepEqual(dbModule.db.prepare(`
    SELECT item.provider_id AS providerId, match.recording_id AS recordingId,
           match.match_state AS matchState, match.method
    FROM ProviderVideoMatches match
    JOIN ProviderItems item ON item.id = match.provider_video_item_id
    ORDER BY item.provider_id
  `).all(), [{
    providerId: "tidal-pompeii-official",
    recordingId: canonical.id,
    matchState: "accepted",
    method: "title_artist_duration",
  }], "provider-only identities must remain unmatched provider facts");
});

test("named venue live attaches to unlabeled MusicBrainz video at exact duration", () => {
  // Me & Mr. Jones / Back to Black shape: TIDAL unlabeled on MB, Apple
  // "Live at Other Voices" at the same second — same upload, different titles.
  for (const sample of [{
    mbid: "mb-video-mej",
    title: "Me & Mr. Jones",
    liveTitle: "Me & Mr. Jones (Live at Other Voices, 2006)",
    tidalId: "tidal-mej",
    appleId: "apple-mej-live",
    duration: 203,
    date: "2024-09-02",
  }, {
    mbid: "mb-video-btb",
    title: "Back to Black",
    liveTitle: "Back To Black (Live at Other Voices, 2006)",
    tidalId: "tidal-btb",
    appleId: "apple-btb-live",
    duration: 253,
    date: "2024-08-05",
  }]) {
    dbModule.db.prepare("DELETE FROM RecordingRelations").run();
    dbModule.db.prepare("DELETE FROM TrackFiles").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();

    const canonical = dbModule.db.prepare(`
      INSERT INTO Recordings (
        foreign_recording_id, mbid, artist_mbid, title, length_ms, video_variant,
        is_video, metadata_status, monitored, release_date
      ) VALUES (
        ?, ?, 'artist-mbid', ?, ?, 'video',
        1, 'musicbrainz', 1, ?
      )
      RETURNING id
    `).get(sample.mbid, sample.mbid, sample.title, sample.duration * 1000, sample.date) as { id: number };

    dbModule.db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, artist_mbid, title, duration, release_date, recording_id
      ) VALUES ('tidal', 'video', ?, 'artist-mbid', ?, ?, ?, ?)
    `).run(sample.tidalId, sample.title, sample.duration, sample.date, canonical.id);

    refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
      provider: "apple-music",
      provider_id: sample.appleId,
      title: sample.liveTitle,
      artist_name: "Bastille",
      artist_mbid: "artist-mbid",
      duration: sample.duration,
      release_date: sample.date,
    }]);

    const offers = dbModule.db.prepare(`
      SELECT provider, provider_id AS providerId, recording_id AS recordingId, title
      FROM ProviderItems
      WHERE entity_type = 'video' ORDER BY provider
    `).all() as Array<{ provider: string; providerId: string; recordingId: number; title: string }>;
    const videos = dbModule.db.prepare(`
      SELECT id, title, mbid, video_variant, length_ms FROM Recordings WHERE is_video = 1 ORDER BY id
    `).all();
    assert.equal(
      offers.length,
      2,
      `${sample.title}: offers=${JSON.stringify(offers)} videos=${JSON.stringify(videos)}`,
    );
    assert.equal(
      offers[0].recordingId,
      offers[1].recordingId,
      `${sample.title}: offers=${JSON.stringify(offers)} videos=${JSON.stringify(videos)}`,
    );
    assert.equal(offers[0].recordingId, canonical.id, sample.title);

    assert.equal(videos.length, 1, `${sample.title}: ${JSON.stringify(videos)}`);
    assert.equal(
      (videos[0] as { title: string }).title,
      sample.title,
      `${sample.title}: catalog title must stay bare; venue text stays on ProviderItems`,
    );
  }
});

test("refresh promotes legacy provider-only venue live onto MusicBrainz twin", () => {
  const canonical = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, video_variant,
      is_video, metadata_status, monitored, release_date
    ) VALUES (
      'mb-video-mej', 'mb-video-mej', 'artist-mbid', 'Me & Mr. Jones', 203000, 'video',
      1, 'musicbrainz', 1, '2024-09-02'
    )
    RETURNING id
  `).get() as { id: number };
  const legacyLive = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, video_variant, is_video, metadata_status, release_date
    ) VALUES (
      'artist-mbid', 'Me & Mr. Jones (Live at Other Voices, 2006)', 203000, 'live',
      1, 'provider_only', '2024-09-02'
    )
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, title, duration, release_date, recording_id
    ) VALUES ('tidal', 'video', 'tidal-mej', 'artist-mbid', 'Me & Mr. Jones', 203, '2024-09-02', ?)
  `).run(canonical.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, title, duration, release_date, recording_id
    ) VALUES (
      'apple-music', 'video', 'apple-mej-live', 'artist-mbid',
      'Me & Mr. Jones (Live at Other Voices, 2006)', 203, '2024-09-02', ?
    )
  `).run(legacyLive.id);
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'provider-artist-1', ?, 'apple-music', 'video', 'apple-mej-live',
      'video', 'C:/library/mej-live.mp4', 'mej-live.mp4', 'C:/library',
      'mej-live.mp4', '.mp4', 'video'
    )
  `).run(legacyLive.id);

  // Any video refresh sweeps and promotes the Apple offer onto the MB twin.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-mej",
    title: "Me & Mr. Jones",
    artist_name: "Bastille",
    duration: 203,
    release_date: "2024-09-02",
  }]);

  const apple = dbModule.db.prepare(`
    SELECT recording_id AS recordingId FROM ProviderItems
    WHERE provider = 'apple-music' AND provider_id = 'apple-mej-live'
  `).get() as { recordingId: number };
  assert.equal(apple.recordingId, canonical.id);

  const file = dbModule.db.prepare(`
    SELECT recording_id AS recordingId FROM TrackFiles WHERE provider_id = 'apple-mej-live'
  `).get() as { recordingId: number };
  assert.equal(file.recordingId, canonical.id);

  const orphan = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE id = ?
  `).get(legacyLive.id);
  assert.equal(orphan, undefined);
});

test("refresh repairs legacy canonical overmerges across providers", () => {
  const canonical = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms,
      is_video, metadata_status, monitored
    ) VALUES (
      'mb-video-pompeii', 'mb-video-pompeii', 'artist-mbid', 'Pompeii', 232000,
      1, 'musicbrainz', 1
    )
    RETURNING id
  `).get() as { id: number };

  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, title, duration, availability, recording_id
    ) VALUES (?, 'video', ?, 'artist-mbid', ?, ?, 'available', ?)
  `);
  insertOffer.run("tidal", "tidal-pompeii-official", "Pompeii (Official Music Video)", 232, canonical.id);
  insertOffer.run("tidal", "tidal-pompeii-lyric", "Pompeii (Lyric Video)", 214, canonical.id);
  insertOffer.run("apple-music", "apple-pompeii-lyric", "Pompeii (Official Lyric Video)", 214, canonical.id);
  insertOffer.run("apple-music", "apple-pompeii-performance", "Pompeii (Good Morning America Performance)", 228, canonical.id);
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_recording_mbid, recording_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'provider-artist-1', 'mb-video-pompeii', ?,
      'apple-music', 'video', 'apple-pompeii-lyric', 'video',
      'C:/library/Pompeii lyric.mp4', 'Pompeii lyric.mp4', 'C:/library',
      'Pompeii lyric.mp4', '.mp4', 'video'
    )
  `).run(canonical.id);

  // A one-provider refresh must also repair stale offers from the other provider.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-pompeii-official",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 232,
  }]);

  const offers = dbModule.db.prepare(`
    SELECT provider_id AS providerId, recording_id AS recordingId
    FROM ProviderItems
    WHERE entity_type = 'video'
  `).all() as Array<{ providerId: string; recordingId: number }>;
  const byId = new Map(offers.map((offer) => [offer.providerId, offer.recordingId]));

  assert.equal(byId.get("tidal-pompeii-official"), canonical.id);
  assert.equal(byId.get("tidal-pompeii-lyric"), byId.get("apple-pompeii-lyric"));
  assert.notEqual(byId.get("tidal-pompeii-lyric"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), byId.get("apple-pompeii-lyric"));

  const canonicalOfferCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count FROM ProviderItems WHERE entity_type = 'video' AND recording_id = ?
  `).get(canonical.id) as { count: number };
  assert.equal(canonicalOfferCount.count, 1);

  const repairedFile = dbModule.db.prepare(`
    SELECT recording_id AS recordingId, canonical_recording_mbid AS recordingMbid
    FROM TrackFiles
    WHERE provider = 'apple-music' AND provider_id = 'apple-pompeii-lyric'
  `).get() as { recordingId: number; recordingMbid: string | null };
  assert.equal(repairedFile.recordingId, byId.get("apple-pompeii-lyric"));
  assert.equal(repairedFile.recordingMbid, null);

  const repairedVariants = dbModule.db.prepare(`
    SELECT id, monitored FROM Recordings WHERE id <> ? AND is_video = 1
  `).all(canonical.id) as Array<{ id: number; monitored: number }>;
  assert.ok(repairedVariants.length >= 2);
  assert.ok(repairedVariants.every((recording) => recording.monitored === 1));
});

test("a parenthetical qualifier one provider omits still dedupes when durations agree", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-sms",
    title: "SAVE MY SOUL",
    artist_name: "Bastille",
    duration: 256,
  }]);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-video-sms",
    title: "SAVE MY SOUL (\"FROM ALL SIDES\" Tour)",
    artist_name: "Bastille",
    duration: 256,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 1);

  const offers = dbModule.db.prepare(`
    SELECT DISTINCT recording_id AS recordingId FROM ProviderItems WHERE entity_type = 'video'
  `).all() as Array<{ recordingId: number }>;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].recordingId, videos[0].id);
});

test("two exact same-provider offers merge; near-duration same-provider offers stay split", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-tears-a",
    title: "Tears Dry On Their Own",
    artist_name: "Amy Winehouse",
    duration: 187,
  }, {
    provider: "tidal",
    provider_id: "tidal-tears-b",
    title: "Tears Dry On Their Own",
    artist_name: "Amy Winehouse",
    duration: 187,
  }]);

  const exact = dbModule.db.prepare(`
    SELECT COUNT(DISTINCT recording_id) AS c FROM ProviderItems WHERE entity_type = 'video'
  `).get() as { c: number };
  assert.equal(exact.c, 1);

  // 1s catalog rounding (Pompeii-shaped TIDAL twins) must still merge.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-pompeii-a",
    title: "Pompeii",
    artist_name: "Bastille",
    duration: 232,
  }, {
    provider: "tidal",
    provider_id: "tidal-pompeii-b",
    title: "Pompeii",
    artist_name: "Bastille",
    duration: 233,
  }]);

  const oneSecond = dbModule.db.prepare(`
    SELECT COUNT(DISTINCT recording_id) AS c
    FROM ProviderItems
    WHERE entity_type = 'video' AND provider_id LIKE 'tidal-pompeii-%'
  `).get() as { c: number };
  assert.equal(oneSecond.c, 1, "±1s same-provider twins share one recording");

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-oblivion-official",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 233,
  }, {
    provider: "tidal",
    provider_id: "tidal-oblivion-gma",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 228,
  }]);

  const near = dbModule.db.prepare(`
    SELECT COUNT(DISTINCT recording_id) AS c
    FROM ProviderItems
    WHERE entity_type = 'video' AND provider_id LIKE 'tidal-oblivion-%'
  `).get() as { c: number };
  assert.equal(near.c, 2, "5s duration gap keeps same-provider cuts separate");
});

test("same-provider TIDAL twin attaches to MusicBrainz video within 2s", () => {
  const artistMbid = "artist-mbid";
  const recordingMbid = "9d31439c-9505-4e66-b130-fd3db4b41351";
  dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, video_variant,
      is_video, metadata_status, release_date
    ) VALUES (?, ?, ?, 'Pompeii', 232000, 'official', 1, 'musicbrainz', '2013-01-01')
  `).run(recordingMbid, recordingMbid, artistMbid);

  // First TIDAL listing already on the MB row.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "93155190",
    title: "Pompeii",
    artist_name: "Bastille",
    artist_mbid: artistMbid,
    duration: 232,
    release_date: "2013-01-01",
  }]);

  // Second TIDAL id (±1s) plus YouTube must land on the same MB recording.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "25704375",
    title: "Pompeii",
    artist_name: "Bastille",
    artist_mbid: artistMbid,
    duration: 233,
    release_date: "2013-03-01",
  }, {
    provider: "youtube-music",
    provider_id: "F90Cw4l-8NY",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    artist_mbid: artistMbid,
    duration: 233,
    release_date: "2013-01-20",
    quality: "FHD",
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, mbid FROM Recordings WHERE is_video = 1 ORDER BY id
  `).all() as Array<{ id: number; mbid: string | null }>;
  assert.equal(videos.length, 1, "no provider-only duplicate beside the MB video");
  assert.equal(videos[0].mbid, recordingMbid);

  const offers = dbModule.db.prepare(`
    SELECT provider, CAST(provider_id AS TEXT) AS provider_id, recording_id
    FROM ProviderItems WHERE entity_type = 'video' ORDER BY provider, provider_id
  `).all() as Array<{ provider: string; provider_id: string; recording_id: number }>;
  assert.equal(offers.length, 3);
  assert.ok(offers.every((o) => o.recording_id === videos[0].id));
});

test("video refresh preserves probed quality when list payload sends null", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-probed",
    title: "Good Grief",
    artist_name: "Bastille",
    duration: 221,
    quality: "FHD",
  }]);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-probed",
    title: "Good Grief",
    artist_name: "Bastille",
    duration: 221,
    quality: null,
  }]);

  const row = dbModule.db.prepare(`
    SELECT quality FROM ProviderItems
    WHERE provider = 'tidal' AND CAST(provider_id AS TEXT) = 'tidal-probed'
  `).get() as { quality: string | null };
  assert.equal(row.quality, "FHD");
});

test("unlabeled live cuts merge with an explicitly Live-at-titled peer at exact duration", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-good-grief-live",
    title: "Good Grief",
    artist_name: "Bastille",
    duration: 278,
  }]);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-good-grief-live",
    title: "Good Grief (Bastille Presents “&” / Live From O2 Shepherd's Bush Empire)",
    artist_name: "Bastille",
    duration: 278,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, title FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string }>;
  assert.equal(videos.length, 1, "Live From/At + bare title merge at exact duration");
});

test("qualifier-tolerant dedup does NOT merge when durations differ beyond tolerance", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-pompeii",
    title: "Pompeii",
    artist_name: "Bastille",
    duration: 214,
  }, {
    provider: "apple-music",
    provider_id: "apple-video-pompeii-live",
    title: "Pompeii (MTV Unplugged)",
    artist_name: "Bastille",
    duration: 305,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 2);
});

test("refresh retro-merges pre-existing duplicate provider-only video recordings", () => {
  // Simulate the legacy state: each provider minted its own recording before
  // the qualifier-tolerant rule existed, and both items are already linked
  // (the existing-recording short-circuit keeps them split forever without
  // the sweep).
  const tidalRec = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('artist-mbid', 'SAVE MY SOUL', 256000, 1, 'provider_only')
    RETURNING id
  `).get() as { id: number };
  const appleRec = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('artist-mbid', 'SAVE MY SOUL ("FROM ALL SIDES" Tour)', 256000, 1, 'provider_only')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, duration, recording_id)
    VALUES ('tidal', 'video', 'tidal-video-sms', 'artist-mbid', 'SAVE MY SOUL', 256, ?)
  `).run(tidalRec.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, duration, recording_id)
    VALUES ('apple-music', 'video', 'apple-video-sms', 'artist-mbid', 'SAVE MY SOUL ("FROM ALL SIDES" Tour)', 256, ?)
  `).run(appleRec.id);

  // Any video refresh for the artist sweeps and heals the duplicates.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-video-sms",
    title: "SAVE MY SOUL (\"FROM ALL SIDES\" Tour)",
    artist_name: "Bastille",
    duration: 256,
  }]);

  const offers = dbModule.db.prepare(`
    SELECT provider, recording_id AS recordingId FROM ProviderItems WHERE entity_type = 'video' ORDER BY provider
  `).all() as Array<{ provider: string; recordingId: number }>;
  assert.equal(offers.length, 2);
  assert.equal(offers[0].recordingId, offers[1].recordingId);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, offers[0].recordingId);
});

test("lyric and unlabeled merge when durations agree within 2s", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-oblivion",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 201,
  }]);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-oblivion-lyric",
    title: "Oblivion (Lyric Video)",
    artist_name: "Bastille",
    duration: 201,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, title, video_variant FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string; video_variant: string | null }>;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].title, "Oblivion (Lyric Video)");
  assert.equal(videos[0].video_variant, "lyric");

  const offers = dbModule.db.prepare(`
    SELECT provider, recording_id AS recordingId FROM ProviderItems WHERE entity_type = 'video'
  `).all() as Array<{ provider: string; recordingId: number }>;
  assert.equal(offers.length, 2);
  assert.equal(offers[0].recordingId, offers[1].recordingId);
});

test("lyric and unlabeled stay separate when duration delta exceeds 2s", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-oblivion",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 201,
  }, {
    provider: "apple-music",
    provider_id: "apple-oblivion-lyric",
    title: "Oblivion (Lyric Video)",
    artist_name: "Bastille",
    duration: 208,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 2);
});

test("live and unlabeled studio stay separate beyond the soft duration gate", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "youtube-music",
    provider_id: "yt-oblivion-studio",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 197,
  }, {
    provider: "youtube-music",
    provider_id: "yt-oblivion-live-capitol",
    title: "Oblivion (Live From Capitol Studios, USA / 2013)",
    artist_name: "Bastille",
    duration: 187,
  }]);

  const atTenSeconds = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(atTenSeconds.length, 2, "10s live delta must stay separate");

  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();

  // Named Live From + unlabeled main merge inside the soft ±2s gate (catalog rounding).
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-good-grief",
    title: "Good Grief",
    artist_name: "Bastille",
    duration: 278,
  }, {
    provider: "apple-music",
    provider_id: "apple-good-grief-live",
    title: "Good Grief (Live From O2)",
    artist_name: "Bastille",
    duration: 280,
  }]);

  const withinTwo = dbModule.db.prepare(`
    SELECT id, title, video_variant FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string; video_variant: string | null }>;
  assert.equal(withinTwo.length, 1, "Live From + unlabeled merge within ±2s");
  assert.equal(withinTwo[0].video_variant, "live");
});

test("official music video still does not absorb a same-duration live cut", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-pompeii-omv",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 214,
  }, {
    provider: "apple-music",
    provider_id: "apple-pompeii-live",
    title: "Pompeii (Live)",
    artist_name: "Bastille",
    duration: 214,
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 2);
});

test("cross-provider bare live twin merges with unlabeled main within ±2s", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-friday-night",
    title: "You Know I'm No Good",
    artist_name: "Amy Winehouse",
    duration: 179,
    release_date: "2026-07-10",
  }, {
    provider: "apple-music",
    provider_id: "apple-friday-night",
    title: "You Know I'm No Good (Live From Friday Night Project / 2007)",
    artist_name: "Amy Winehouse",
    duration: 180,
    release_date: "2026-07-10",
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, title, video_variant FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string; video_variant: string | null }>;
  assert.equal(videos.length, 1, "Apple 180s + TIDAL 179s Friday Night Project twin");
  assert.equal(videos[0].video_variant, "live");
  assert.match(videos[0].title, /Friday Night Project/i);
});

test("cross-provider bare live twin merges with unlabeled main at exact duration", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-seasons",
    title: "Seasons & Narcissus",
    artist_name: "Bastille",
    duration: 206,
    release_date: "2023-06-09",
  }, {
    provider: "apple-music",
    provider_id: "apple-seasons-live",
    title: "Seasons & Narcissus (Live)",
    artist_name: "Bastille",
    duration: 206,
    release_date: "2023-06-09",
  }]);

  const videos = dbModule.db.prepare(`
    SELECT id, title, video_variant FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string; video_variant: string | null }>;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].title, "Seasons & Narcissus");
});

test("refresh splits a live offer wrongly glued onto a studio recording", () => {
  const studio = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('artist-mbid', 'Oblivion', 197000, 1, 'provider_only')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, duration, recording_id)
    VALUES ('youtube-music', 'video', 'yt-oblivion-studio', 'artist-mbid', 'Oblivion', 197, ?)
  `).run(studio.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, duration, recording_id)
    VALUES ('youtube-music', 'video', 'yt-oblivion-live', 'artist-mbid', 'Oblivion (Live From Capitol Studios, USA / 2013)', 187, ?)
  `).run(studio.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "youtube-music",
    provider_id: "yt-oblivion-studio",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 197,
  }]);

  const liveOffer = dbModule.db.prepare(`
    SELECT recording_id AS recordingId FROM ProviderItems
    WHERE provider_id = 'yt-oblivion-live'
  `).get() as { recordingId: number };
  assert.notEqual(liveOffer.recordingId, studio.id);

  const videos = dbModule.db.prepare(`
    SELECT id FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number }>;
  assert.equal(videos.length, 2);
});

test("provider video related_track_id links directly to the matched audio recording", () => {
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-related-1', 'audio-related-1', 'artist-mbid', 'Pompeii', 214000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_id, title, duration
    ) VALUES ('apple-music', 'track', 'apple-song-1', 'apple-album-1', 'artist-mbid', ?, 'Pompeii', 214)
  `).run(audio.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-video-related",
    title: "Pompeii (Official Music Video)",
    artist_name: "Bastille",
    duration: 225,
    album_id: "apple-album-1",
    related_track_id: "apple-song-1",
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId, confidence, data
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get() as { audioId: number; confidence: number; data: string };
  assert.equal(relation.audioId, audio.id);
  assert.equal(relation.confidence, 0.96);
  assert.match(relation.data, /provider-video-related-track/);

  const offer = dbModule.db.prepare(`
    SELECT provider_album_id AS albumId FROM ProviderItems
    WHERE provider = 'apple-music' AND provider_id = 'apple-video-related'
  `).get() as { albumId: string };
  assert.equal(offer.albumId, "apple-album-1");
});

test("provider video album_id scopes title matching to that album's tracks", () => {
  const onAlbum = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-on-album', 'audio-on-album', 'artist-mbid', 'Romeo & Juliet (Live At The Hammersmith Odeon)', 457000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const offAlbum = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-off-album', 'audio-off-album', 'artist-mbid', 'Romeo & Juliet (Live At The Hammersmith Odeon)', 457000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_id, title, duration
    ) VALUES
      ('tidal', 'track', 'tidal-track-on', 'tidal-album-42', 'artist-mbid', ?, 'Romeo & Juliet (Live At The Hammersmith Odeon)', 457),
      ('tidal', 'track', 'tidal-track-off', 'tidal-album-99', 'artist-mbid', ?, 'Romeo & Juliet (Live At The Hammersmith Odeon)', 457)
  `).run(onAlbum.id, offAlbum.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-album",
    title: "Romeo & Juliet (Live At The Hammersmith Odeon)",
    artist_name: "Bastille",
    duration: 457,
    album_id: "tidal-album-42",
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId, data
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get() as { audioId: number; data: string };
  assert.equal(relation.audioId, onAlbum.id);
  assert.match(relation.data, /provider-video-album-/);
  assert.match(relation.data, /tidal-album-42/);
});

test("album-linked video does not fall back to artist-wide audio when in-album title misses", () => {
  const onAlbum = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-album-hit', 'audio-album-hit', 'artist-mbid', 'Other Song', 200000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const artistWide = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-artist-wide', 'audio-artist-wide', 'artist-mbid', 'Romeo & Juliet', 457000, 0, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_id, title, duration
    ) VALUES
      ('tidal', 'track', 'tidal-track-miss', 'tidal-album-miss', 'artist-mbid', ?, 'Other Song', 200),
      ('tidal', 'track', 'tidal-track-wide', 'tidal-album-other', 'artist-mbid', ?, 'Romeo & Juliet', 457)
  `).run(onAlbum.id, artistWide.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "tidal",
    provider_id: "tidal-video-miss",
    title: "Romeo & Juliet (Live At The Hammersmith Odeon)",
    artist_name: "Bastille",
    duration: 457,
    album_id: "tidal-album-miss",
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get() as { audioId: number } | undefined;
  assert.equal(relation, undefined, "must not artist-wide match when album association is present");
});

test("orphan artist video does not link via title+duration even within 5s", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status
    )
    VALUES ('audio-studio-yk', 'audio-studio-yk', 'artist-mbid', 'You Know I''m No Good', 216000, 0, 'musicbrainz')
  `).run();

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-live-yk",
    title: "You Know I'm No Good (Live)",
    artist_name: "Amy Winehouse",
    duration: 218,
  }]);

  const relation = dbModule.db.prepare(`
    SELECT target_recording_id AS audioId
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get();
  assert.equal(relation, undefined, "must not artist-wide match live MV to studio audio");
});

test("backfillMissingVideoOfferQuality fills null quality from the provider getVideo probe without overwriting a tag", async () => {
  const providerModule = await import("../providers/index.js");
  const manager = providerModule.streamingProviderManager as unknown as {
    getStreamingProvider: (id: string) => unknown;
  };
  const original = manager.getStreamingProvider;

  const nullQualityVideo = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, is_video, video_variant, metadata_status, monitored)
    VALUES ('artist-mbid', 'Pompeii', 1, 'video', 'provider_only', 1)
    RETURNING id
  `).get() as { id: number };
  const taggedVideo = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, is_video, video_variant, metadata_status, monitored)
    VALUES ('artist-mbid', 'Things We Lost', 1, 'video', 'provider_only', 1)
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, recording_id, title, quality)
    VALUES ('youtube-music', 'video', 'H5uf6fhbRek', 'artist-mbid', ?, 'Pompeii', NULL)
  `).run(nullQualityVideo.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, recording_id, title, quality)
    VALUES ('youtube-music', 'video', 'alreadyTagged', 'artist-mbid', ?, 'Things We Lost', 'HD')
  `).run(taggedVideo.id);

  const probed: string[] = [];
  manager.getStreamingProvider = (id: string) => {
    if (id === "youtube-music") {
      return {
        getVideo: async (providerId: string) => {
          probed.push(providerId);
          return { quality: "FHD" };
        },
      };
    }
    throw new Error(`unknown provider ${id}`);
  };

  try {
    const updated = await refreshVideoModule.RefreshVideoService.backfillMissingVideoOfferQuality("artist-mbid");
    assert.equal(updated, 1);
    assert.deepEqual(probed, ["H5uf6fhbRek"], "only the null-quality offer is probed");

    const filled = dbModule.db.prepare("SELECT quality FROM ProviderItems WHERE provider_id = 'H5uf6fhbRek'").get() as { quality: string };
    assert.equal(filled.quality, "FHD");
    const untouched = dbModule.db.prepare("SELECT quality FROM ProviderItems WHERE provider_id = 'alreadyTagged'").get() as { quality: string };
    assert.equal(untouched.quality, "HD", "an existing quality tag is never overwritten");
  } finally {
    manager.getStreamingProvider = original;
  }
});
