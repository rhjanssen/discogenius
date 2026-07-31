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
  dbModule.db.exec(`
    DROP TRIGGER provider_video_matches_validate_insert;
    DROP TRIGGER provider_video_matches_validate_update;
  `);
  try {
    seedAcceptedProviderVideoMatch(dbModule.db, input);
  } finally {
    dbModule.db.exec(`
      CREATE TRIGGER provider_video_matches_validate_insert
      BEFORE INSERT ON ProviderVideoMatches
      BEGIN
        SELECT CASE
          WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_video_item_id) != 'video'
            THEN RAISE(ABORT, 'provider video match source must be a video item')
          WHEN NEW.match_state != 'rejected' AND NOT EXISTS (
            SELECT 1 FROM Recordings
            WHERE id = NEW.recording_id AND is_video = 1 AND mbid IS NOT NULL
          )
            THEN RAISE(ABORT, 'provider video match target must be a canonical video recording')
        END;
      END;
      CREATE TRIGGER provider_video_matches_validate_update
      BEFORE UPDATE OF provider_video_item_id, recording_id, match_state ON ProviderVideoMatches
      BEGIN
        SELECT CASE
          WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_video_item_id) != 'video'
            THEN RAISE(ABORT, 'provider video match source must be a video item')
          WHEN NEW.match_state != 'rejected' AND NOT EXISTS (
            SELECT 1 FROM Recordings
            WHERE id = NEW.recording_id AND is_video = 1 AND mbid IS NOT NULL
          )
            THEN RAISE(ABORT, 'provider video match target must be a canonical video recording')
        END;
      END;
    `);
  }
}

test("unmatched provider videos remain offers without inventing canonical recordings", () => {
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 0);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM ProviderVideoMatches"), 0);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM RecordingRelations"), 0);
});

test("a provider-supplied recording MBID is evidence and cannot mint a catalog row", () => {
  const providerVideo = {
    provider: "tidal",
    provider_id: "tidal-video-mbid",
    recording_mbid: "mb-video-1",
    title: "Pompeii",
    artist_name: "Bastille",
    duration: 232,
  };

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [providerVideo]);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings"), 0);
  assert.equal(acceptedVideoMatch("tidal", "tidal-video-mbid"), undefined);

  const canonicalId = insertCanonicalVideo({
    mbid: "mb-video-1",
    title: "Pompeii",
    lengthMs: 232000,
    variant: "official",
  });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [providerVideo]);
  assert.equal(acceptedVideoMatch("tidal", "tidal-video-mbid")?.recordingId, canonicalId);
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

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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
  assert.equal(acceptedVideoMatch("tidal", "tidal-pompeii-lyric"), undefined);
  assert.equal(acceptedVideoMatch("apple-music", "apple-pompeii-performance"), undefined);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 1);

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

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "apple-music",
    provider_id: "apple-glory",
    title: "Glory",
    artist_name: "Bastille",
    duration: 240,
  }]);

  assert.equal(acceptedVideoMatch("apple-music", "apple-glory"), undefined);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM Recordings WHERE is_video = 1"), 2);
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

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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

test("the active schema rejects identity-bearing matches to noncanonical videos", () => {
  const providerOnly = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, is_video, metadata_status)
    VALUES ('artist-mbid', 'Provider-only video', 1, 'provider_only')
    RETURNING id
  `).get() as { id: number };
  const providerItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'video', 'tidal-invalid-target', 'Provider-only video')
    RETURNING id
  `).get() as { id: number };

  assert.throws(
    () => dbModule.db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'accepted', 'automatic', 1, 'invalid', 1)
    `).run(providerItem.id, providerOnly.id),
    /canonical video recording/,
  );
});

test("legacy provider-only identity is removed while its file and provider provenance survive", () => {
  const legacy = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('artist-mbid', 'Orphan Provider Video', 180000, 1, 'provider_only')
    RETURNING id
  `).get() as { id: number };
  seedLegacyNoncanonicalVideoMatch({
    provider: "tidal",
    providerVideoId: "tidal-orphan",
    recordingId: legacy.id,
    title: "Orphan Provider Video",
    durationMs: 180000,
  });
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'provider-artist-1', ?, 'tidal', 'video', 'tidal-orphan',
      'video', 'C:/library/orphan.mp4', 'orphan.mp4', 'C:/library',
      'orphan.mp4', '.mp4', 'video'
    )
  `).run(legacy.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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
    recordingId: null,
    recordingMbid: null,
    provider: "tidal",
    entityType: "video",
    providerId: "tidal-orphan",
  });
  assert.equal(dbModule.db.prepare("SELECT id FROM Recordings WHERE id = ?").get(legacy.id), undefined);
  assert.equal(acceptedVideoMatch("tidal", "tidal-orphan"), undefined);
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
      'live', 1, 'provider_only', '2024-09-02'
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
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      'provider-artist-1', ?, 'apple-music', 'video', 'apple-mej-live',
      'video', 'C:/library/mej-live.mp4', 'mej-live.mp4', 'C:/library',
      'mej-live.mp4', '.mp4', 'video'
    )
  `).run(legacy.id);

  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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

test("provider audio evidence creates a relation only after the video has canonical identity", () => {
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
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [offer]);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM RecordingRelations"), 0);

  const videoId = insertCanonicalVideo({
    mbid: "mb-video-pompeii",
    title: "Pompeii",
    lengthMs: 225000,
  });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [offer]);
  const relation = dbModule.db.prepare(`
    SELECT source_recording_id AS videoId, target_recording_id AS audioId, confidence, data
    FROM RecordingRelations WHERE relation_type = 'provider_video_for'
  `).get() as { videoId: number; audioId: number; confidence: number; data: string };
  assert.equal(relation.videoId, videoId);
  assert.equal(relation.audioId, audio.id);
  assert.equal(relation.confidence, 0.96);
  assert.match(relation.data, /provider-video-related-track/);
});

test("provider refresh preserves previously probed video quality", () => {
  insertCanonicalVideo({ mbid: "mb-video-quality", title: "Pompeii", lengthMs: 232000 });
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "youtube-music",
    provider_id: "youtube-pompeii",
    title: "Pompeii",
    duration: 232,
    quality: "FHD",
  }]);
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
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

test("missing quality backfill probes only accepted canonical video offers", async () => {
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
  refreshVideoModule.RefreshVideoService.upsertArtistVideos("provider-artist-1", [{
    provider: "youtube-music",
    provider_id: "youtube-unmatched",
    title: "Unknown Provider Cut",
  }]);

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
