import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-video-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let refreshVideoModule: typeof import("./refresh-video-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  refreshVideoModule = await import("./refresh-video-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ProviderMedia").run();
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
      ForeignRecordingId, mbid, artist_mbid, title, length_ms, IsVideo, MetadataStatus, isrcs
    )
    VALUES ('audio-recording-1', 'audio-recording-1', 'artist-mbid', 'Pompeii', 214000, 0, 'musicbrainz', '["GBUM71300354"]')
    RETURNING Id
  `).get() as { Id: number };

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
    SELECT Id, title, IsVideo, MetadataStatus, ReleaseDate, CoverImageId
    FROM Recordings
    WHERE IsVideo = 1
  `).get() as {
    Id: number;
    title: string;
    IsVideo: number;
    MetadataStatus: string;
    ReleaseDate: string;
    CoverImageId: string;
  };
  assert.equal(video.title, "Pompeii (Official Music Video)");
  assert.equal(video.MetadataStatus, "provider_only");
  assert.equal(video.ReleaseDate, "2013-02-24");
  assert.equal(video.CoverImageId, "cover-id");

  const providerOffer = dbModule.db.prepare(`
    SELECT provider, entity_type AS entityType, provider_id AS providerId, recording_id AS recordingId
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'video'
  `).get() as { provider: string; entityType: string; providerId: string; recordingId: number };
  assert.deepEqual(providerOffer, {
    provider: "tidal",
    entityType: "video",
    providerId: "tidal-video-1",
    recordingId: video.Id,
  });

  const relation = dbModule.db.prepare(`
    SELECT SourceRecordingId, TargetRecordingId, RelationType, Source, Confidence
    FROM RecordingRelations
    WHERE RelationType = 'provider_video_for'
  `).get() as {
    SourceRecordingId: number;
    TargetRecordingId: number;
    RelationType: string;
    Source: string;
    Confidence: number;
  };
  assert.equal(relation.SourceRecordingId, video.Id);
  assert.equal(relation.TargetRecordingId, audio.Id);
  assert.equal(relation.Source, "tidal");
  assert.equal(relation.Confidence, 0.95);

  const legacyCount = dbModule.db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia")
    .get() as { count: number };
  assert.equal(legacyCount.count, 0);
});
