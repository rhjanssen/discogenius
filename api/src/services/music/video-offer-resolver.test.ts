import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-video-offer-resolver-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let resolver: typeof import("./video-offer-resolver.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  resolver = await import("./video-offer-resolver.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("an explicit provider offer wins over a colliding canonical recording id", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (id, mbid, title, is_video, metadata_status)
    VALUES
      (7, 'apple-recording', 'Apple asset', 1, 'musicbrainz'),
      (42, 'canonical-recording', 'Canonical asset', 1, 'musicbrainz')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_mbid, recording_id,
      title, quality, availability, library_slot
    ) VALUES
      ('apple-music', 'video', '42', 'apple-recording', 7,
       'Apple asset', 'MP4_2160P', 'available', 'video'),
      ('tidal', 'video', 'tidal-canonical-offer', 'canonical-recording', 42,
       'Canonical asset', 'MP4_1080P', 'available', 'video')
  `).run();

  assert.deepEqual(resolver.resolveRequestedVideoOffer("apple-music", "42"), {
    provider: "apple-music",
    providerId: "42",
    quality: "MP4_2160P",
    recordingId: "7",
    recordingMbid: "apple-recording",
  });
});

test("canonical resolution prefers higher resolution within a provider", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (id, mbid, title, is_video, metadata_status)
    VALUES (11, 'canonical-recording', 'Canonical asset', 1, 'musicbrainz')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_mbid, recording_id,
      title, quality, availability, library_slot, match_status
    ) VALUES
      ('tidal', 'video', 'z-unavailable', 'canonical-recording', 11,
       'Canonical asset', 'MP4_2160P', 'unavailable', 'video', NULL),
      ('tidal', 'video', 'rejected-4k', 'canonical-recording', 11,
       'Canonical asset', 'MP4_2160P', 'available', 'video', 'rejected'),
      ('tidal', 'video', 'b-available', 'canonical-recording', 11,
       'Canonical asset', 'MP4_1080P', 'available', 'video', NULL),
      ('tidal', 'video', 'a-available', 'canonical-recording', 11,
       'Canonical asset', 'MP4_720P', 'available', 'video', NULL)
  `).run();

  assert.deepEqual(resolver.resolveVideoOfferForProvider("tidal", "11"), {
    provider: "tidal",
    providerId: "b-available",
    quality: "MP4_1080P",
    recordingId: "11",
    recordingMbid: "canonical-recording",
  });
  assert.equal(resolver.isKnownProviderVideoOffer("tidal", "rejected-4k"), false);
  assert.equal(resolver.resolveRequestedVideoOffer("tidal", "rejected-4k"), null);
});

test("preferred offer chooses Apple 4K over a preferred-provider TIDAL 1080p offer", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (id, mbid, title, is_video, metadata_status)
    VALUES (21, 'shared-recording', 'Shared asset', 1, 'musicbrainz')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_mbid, recording_id,
      title, quality, availability, library_slot
    ) VALUES
      ('tidal', 'video', 'tidal-1080', 'shared-recording', 21,
       'Shared asset', 'MP4_1080P', 'available', 'video'),
      ('apple-music', 'video', 'apple-4k', 'shared-recording', 21,
       'Shared asset', 'MP4_2160P', 'available', 'video')
  `).run();

  assert.deepEqual(resolver.resolvePreferredVideoOffer("21"), {
    provider: "apple-music",
    providerId: "apple-4k",
    quality: "MP4_2160P",
    recordingId: "21",
    recordingMbid: "shared-recording",
  });
});

test("same-resolution ranking prefers HEVC Apple Music over h.264 TIDAL", () => {
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "apple-music", quality: "FHD", provider_id: "a" },
      { provider: "tidal", quality: "FHD", provider_id: "t" },
    ) < 0,
  );
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "youtube-music", quality: "FHD", provider_id: "y" },
      { provider: "apple-music", quality: "FHD", provider_id: "a" },
    ) < 0,
  );
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "UHD"), 400);
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "FHD"), 400);
  assert.equal(resolver.videoOfferCodecRank("apple-music", "FHD"), 200);
  assert.equal(resolver.videoOfferCodecRank("tidal", "FHD"), 100);
});
