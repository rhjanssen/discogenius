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

test("provider videos create canonical recordings and link to matching audio recordings", () => {
  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms, is_video, metadata_status, isrcs
    )
    VALUES ('audio-recording-1', 'audio-recording-1', 'artist-mbid', 'Pompeii', 214000, 0, 'musicbrainz', '["GBUM71300354"]')
    RETURNING id
  `).get() as { id: number };

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
    SELECT id, title, is_video, metadata_status, release_date, cover_image_id
    FROM Recordings
    WHERE is_video = 1
  `).get() as {
    id: number;
    title: string;
    is_video: number;
    metadata_status: string;
    release_date: string;
    cover_image_id: string;
  };
  assert.equal(video.title, "Pompeii (Official Music Video)");
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
    SELECT source_recording_id, target_recording_id, relation_type, source, confidence
    FROM RecordingRelations
    WHERE relation_type = 'provider_video_for'
  `).get() as {
    source_recording_id: number;
    target_recording_id: number;
    relation_type: string;
    source: string;
    confidence: number;
  };
  assert.equal(relation.source_recording_id, video.id);
  assert.equal(relation.target_recording_id, audio.id);
  assert.equal(relation.source, "tidal");
  assert.equal(relation.confidence, 0.95);

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
    // Equal duration must not override an explicit performance variant.
    duration: 232,
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
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, recording_id)
    VALUES ('tidal', 'video', 'tidal-video-sms', 'artist-mbid', 'SAVE MY SOUL', ?)
  `).run(tidalRec.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, recording_id)
    VALUES ('apple-music', 'video', 'apple-video-sms', 'artist-mbid', 'SAVE MY SOUL ("FROM ALL SIDES" Tour)', ?)
  `).run(appleRec.id);

  // Any video refresh for the artist sweeps and heals the duplicates.
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
  assert.equal(videos[0].id, tidalRec.id);

  const offers = dbModule.db.prepare(`
    SELECT provider, recording_id AS recordingId FROM ProviderItems WHERE entity_type = 'video' ORDER BY provider
  `).all() as Array<{ provider: string; recordingId: number }>;
  assert.equal(offers.length, 2);
  assert.ok(offers.every((offer) => offer.recordingId === tidalRec.id));
});
