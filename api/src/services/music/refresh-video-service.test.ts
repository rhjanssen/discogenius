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
    SELECT pi.provider, pi.entity_type AS entityType, pi.provider_id AS providerId, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.provider = 'tidal' AND pi.entity_type = 'video'
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
    SELECT pi.provider, pi.provider_id AS providerId, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
    ORDER BY pi.provider, pi.provider_id
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
    SELECT pi.provider_id AS providerId, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
    ORDER BY pi.provider_id
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

  // In schema 41 ProviderVideoMatches is the ONLY link from a provider video to
  // its recording — the ProviderItems.recording_id shadow column is gone — so a
  // provider-only video carries a match row too (otherwise it would be invisible
  // to every video query). What separates the two is the RECORDING's
  // metadata_status, not the presence of a match.
  const matches = dbModule.db.prepare(`
    SELECT item.provider_id AS providerId, match.recording_id AS recordingId,
           match.match_state AS matchState, match.method,
           recording.metadata_status AS metadataStatus
    FROM ProviderVideoMatches match
    JOIN ProviderItems item ON item.id = match.provider_video_item_id
    JOIN Recordings recording ON recording.id = match.recording_id
    ORDER BY item.provider_id
  `).all() as Array<{
    providerId: string; recordingId: number; matchState: string;
    method: string; metadataStatus: string;
  }>;
  assert.equal(matches.length, 4, "every provider video resolves through a typed match");
  assert.ok(matches.every((match) => match.matchState === "accepted"));

  const canonicalMatches = matches.filter((match) => match.metadataStatus === "musicbrainz");
  assert.deepEqual(
    canonicalMatches.map((match) => ({ providerId: match.providerId, recordingId: match.recordingId })),
    [{ providerId: "tidal-pompeii-official", recordingId: canonical.id }],
    "only the MusicBrainz-backed cut matches the canonical recording",
  );
  assert.deepEqual(
    matches.filter((match) => match.metadataStatus !== "musicbrainz")
      .map((match) => match.providerId)
      .sort(),
    ["apple-pompeii-lyric", "apple-pompeii-performance", "tidal-pompeii-lyric"],
    "the remaining cuts stay provider-only recordings, not canonical claims",
  );
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

    // The pre-existing unlabeled offer is already linked to the canonical MB
    // video through the typed match (schema 41 has no recording_id shadow).
    seedAcceptedProviderVideoMatch(dbModule.db, {
      provider: "tidal",
      providerVideoId: sample.tidalId,
      recordingId: canonical.id,
      title: sample.title,
      durationMs: sample.duration * 1000,
    });
    dbModule.db.prepare(`
      UPDATE ProviderItems SET release_date = ?
      WHERE provider = 'tidal' AND entity_type = 'video' AND provider_id = ?
    `).run(sample.date, sample.tidalId);

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
      SELECT pi.provider, pi.provider_id AS providerId, vm.recording_id AS recordingId, pi.title
      FROM ProviderItems pi
      LEFT JOIN ProviderVideoMatches vm
        ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
      WHERE pi.entity_type = 'video' ORDER BY pi.provider
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

  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal", providerVideoId: "tidal-mej", recordingId: canonical.id,
    title: "Me & Mr. Jones", durationMs: 203000,
  });
  // The Apple live offer is still glued to the legacy provider-only recording;
  // refresh must promote it onto the MusicBrainz twin.
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music", providerVideoId: "apple-mej-live", recordingId: legacyLive.id,
    title: "Me & Mr. Jones (Live at Other Voices, 2006)", durationMs: 203000,
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems SET release_date = '2024-09-02'
    WHERE entity_type = 'video' AND provider_id IN ('tidal-mej', 'apple-mej-live')
  `).run();
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
    SELECT vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.provider = 'apple-music' AND pi.entity_type = 'video' AND pi.provider_id = 'apple-mej-live'
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

  const insertOffer = (provider: string, providerVideoId: string, title: string, durationSec: number) =>
    seedAcceptedProviderVideoMatch(dbModule.db, {
      provider,
      providerVideoId,
      recordingId: canonical.id,
      title,
      durationMs: durationSec * 1000,
      availability: "available",
    });
  insertOffer("tidal", "tidal-pompeii-official", "Pompeii (Official Music Video)", 232);
  insertOffer("tidal", "tidal-pompeii-lyric", "Pompeii (Lyric Video)", 214);
  insertOffer("apple-music", "apple-pompeii-lyric", "Pompeii (Official Lyric Video)", 214);
  insertOffer("apple-music", "apple-pompeii-performance", "Pompeii (Good Morning America Performance)", 228);
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
    SELECT pi.provider_id AS providerId, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
  `).all() as Array<{ providerId: string; recordingId: number }>;
  const byId = new Map(offers.map((offer) => [offer.providerId, offer.recordingId]));

  assert.equal(byId.get("tidal-pompeii-official"), canonical.id);
  assert.equal(byId.get("tidal-pompeii-lyric"), byId.get("apple-pompeii-lyric"));
  assert.notEqual(byId.get("tidal-pompeii-lyric"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), canonical.id);
  assert.notEqual(byId.get("apple-pompeii-performance"), byId.get("apple-pompeii-lyric"));

  const canonicalOfferCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' AND vm.recording_id = ?
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

test("a repaired video match is justified by provider facts, never the recording it was split from", () => {
  const canonical = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, length_ms,
      is_video, metadata_status, monitored
    ) VALUES (
      'mb-video-things', 'mb-video-things', 'artist-mbid', 'Things We Lost In The Fire', 245000,
      1, 'musicbrainz', 1
    )
    RETURNING id
  `).get() as { id: number };

  // Overmerged: a lyric cut 30s short of the official one shares the canonical
  // MusicBrainz recording, and carries a real provider URL.
  const { providerVideoItemId: lyricItemId } = seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music",
    providerVideoId: "apple-things-lyric",
    recordingId: canonical.id,
    title: "Things We Lost In The Fire (Lyric Video)",
    durationMs: 215_000,
    availability: "available",
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems SET provider_url = ?, video_quality = ? WHERE id = ?
  `).run("https://music.apple.com/video/things-lyric", "1080p", lyricItemId);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-things-official",
    title: "Things We Lost In The Fire",
    artist_name: "Bastille",
    duration: 245,
  }]);

  const repaired = dbModule.db.prepare(`
    SELECT vm.recording_id AS recordingId, vm.method, vm.confidence, vm.evidence
    FROM ProviderVideoMatches vm
    JOIN ProviderItems pi ON pi.id = vm.provider_video_item_id
    WHERE pi.provider = 'apple-music'
      AND pi.provider_id = 'apple-things-lyric'
      AND vm.match_state = 'accepted'
  `).get() as { recordingId: number; method: string; confidence: number; evidence: string | null };

  // It was split off the canonical recording...
  assert.notEqual(repaired.recordingId, canonical.id);

  // ...so nothing about the new edge may cite that recording as its own claim.
  const evidence = JSON.parse(repaired.evidence || "{}") as Record<string, unknown>;
  assert.notEqual(repaired.method, "external_id");
  assert.notEqual(evidence.identityMethod, "musicbrainz-recording");
  assert.equal(evidence.recordingMbid, undefined);
  assert.ok(
    !String(evidence.identityKey || "").startsWith("mb-recording:"),
    `identityKey must not claim a MusicBrainz recording, got ${String(evidence.identityKey)}`,
  );
  assert.ok(
    !JSON.stringify(evidence).includes("mb-video-things"),
    "the split-from recording's MBID must not appear anywhere in the repaired evidence",
  );

  // The identity that IS recorded comes from the offer's own provider facts.
  assert.equal(evidence.identityKey, "url:music.apple.com/video/things-lyric");
  assert.equal(evidence.identityMethod, "provider-url");
  assert.equal(repaired.confidence, 0.9);
  assert.equal(evidence.providerVideoVariant, "lyric");
  assert.equal(evidence.providerVideoQuality, "1080p");
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
    SELECT DISTINCT vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
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
    SELECT COUNT(DISTINCT vm.recording_id) AS c
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
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
    SELECT COUNT(DISTINCT vm.recording_id) AS c
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' AND pi.provider_id LIKE 'tidal-pompeii-%'
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
    SELECT COUNT(DISTINCT vm.recording_id) AS c
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' AND pi.provider_id LIKE 'tidal-oblivion-%'
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
    SELECT pi.provider, CAST(pi.provider_id AS TEXT) AS provider_id, vm.recording_id
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' ORDER BY pi.provider, pi.provider_id
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
    SELECT video_quality AS quality FROM ProviderItems
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
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal", providerVideoId: "tidal-video-sms", recordingId: tidalRec.id,
    title: "SAVE MY SOUL", durationMs: 256000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music", providerVideoId: "apple-video-sms", recordingId: appleRec.id,
    title: 'SAVE MY SOUL ("FROM ALL SIDES" Tour)', durationMs: 256000,
  });

  // Any video refresh for the artist sweeps and heals the duplicates.
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-video-sms",
    title: "SAVE MY SOUL (\"FROM ALL SIDES\" Tour)",
    artist_name: "Bastille",
    duration: 256,
  }]);

  const offers = dbModule.db.prepare(`
    SELECT pi.provider, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' ORDER BY pi.provider
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
    SELECT pi.provider, vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
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
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music", providerVideoId: "yt-oblivion-studio", recordingId: studio.id,
    title: "Oblivion", durationMs: 197000,
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music", providerVideoId: "yt-oblivion-live", recordingId: studio.id,
    title: "Oblivion (Live From Capitol Studios, USA / 2013)", durationMs: 187000,
  });

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "youtube-music",
    provider_id: "yt-oblivion-studio",
    title: "Oblivion",
    artist_name: "Bastille",
    duration: 197,
  }]);

  const liveOffer = dbModule.db.prepare(`
    SELECT vm.recording_id AS recordingId
    FROM ProviderItems pi
    LEFT JOIN ProviderVideoMatches vm
      ON vm.provider_video_item_id = pi.id AND vm.match_state = 'accepted'
    WHERE pi.entity_type = 'video' AND pi.provider_id = 'yt-oblivion-live'
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

  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "apple-music", providerReleaseId: "apple-album-1", providerTrackId: "apple-song-1",
    recordingId: audio.id, title: "Pompeii", durationMs: 214000,
  });

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
    SELECT CAST(release_item.provider_id AS TEXT) AS albumId
    FROM ProviderItems pi
    JOIN ProviderReleaseMembers member ON member.member_item_id = pi.id
    JOIN ProviderItems release_item ON release_item.id = member.provider_release_item_id
    WHERE pi.provider = 'apple-music' AND pi.entity_type = 'video'
      AND pi.provider_id = 'apple-video-related'
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

  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "tidal", providerReleaseId: "tidal-album-42", providerTrackId: "tidal-track-on",
    recordingId: onAlbum.id, title: "Romeo & Juliet (Live At The Hammersmith Odeon)", durationMs: 457000,
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "tidal", providerReleaseId: "tidal-album-99", providerTrackId: "tidal-track-off",
    recordingId: offAlbum.id, title: "Romeo & Juliet (Live At The Hammersmith Odeon)", durationMs: 457000,
  });

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

  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "tidal", providerReleaseId: "tidal-album-miss", providerTrackId: "tidal-track-miss",
    recordingId: onAlbum.id, title: "Other Song", durationMs: 200000,
  });
  seedAcceptedProviderRecordingTrack(dbModule.db, {
    provider: "tidal", providerReleaseId: "tidal-album-other", providerTrackId: "tidal-track-wide",
    recordingId: artistWide.id, title: "Romeo & Juliet", durationMs: 457000,
  });

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
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music", providerVideoId: "H5uf6fhbRek",
    recordingId: nullQualityVideo.id, title: "Pompeii",
  });
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music", providerVideoId: "alreadyTagged",
    recordingId: taggedVideo.id, title: "Things We Lost",
  });
  // Only the second offer already carries a probed quality tag.
  dbModule.db.prepare(`
    UPDATE ProviderItems SET video_quality = 'HD'
    WHERE entity_type = 'video' AND provider_id = 'alreadyTagged'
  `).run();

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

    const filled = dbModule.db.prepare("SELECT video_quality AS quality FROM ProviderItems WHERE entity_type = 'video' AND provider_id = 'H5uf6fhbRek'").get() as { quality: string };
    assert.equal(filled.quality, "FHD");
    const untouched = dbModule.db.prepare("SELECT video_quality AS quality FROM ProviderItems WHERE entity_type = 'video' AND provider_id = 'alreadyTagged'").get() as { quality: string };
    assert.equal(untouched.quality, "HD", "an existing quality tag is never overwritten");
  } finally {
    manager.getStreamingProvider = original;
  }
});
