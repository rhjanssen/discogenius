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

function seedVideoOffer(input: {
  provider: string;
  providerId: string;
  recordingId: number;
  quality: string;
  availability?: string;
  matchState?: "accepted" | "rejected";
}) {
  const item = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability, video_quality
    ) VALUES (?, 'video', ?, 'Provider video', ?, ?)
    RETURNING id
  `).get(
    input.provider,
    input.providerId,
    input.availability ?? "available",
    input.quality,
  ) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, ?, 'automatic', 1, 'test', 1)
  `).run(item.id, input.recordingId, input.matchState ?? "accepted");
}

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
  seedVideoOffer({
    provider: "apple-music", providerId: "42", recordingId: 7, quality: "MP4_2160P",
  });
  seedVideoOffer({
    provider: "tidal", providerId: "tidal-canonical-offer", recordingId: 42, quality: "MP4_1080P",
  });

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
  seedVideoOffer({
    provider: "tidal", providerId: "z-unavailable", recordingId: 11,
    quality: "MP4_2160P", availability: "unavailable",
  });
  seedVideoOffer({
    provider: "tidal", providerId: "rejected-4k", recordingId: 11,
    quality: "MP4_2160P", matchState: "rejected",
  });
  seedVideoOffer({
    provider: "tidal", providerId: "b-available", recordingId: 11, quality: "MP4_1080P",
  });
  seedVideoOffer({
    provider: "tidal", providerId: "a-available", recordingId: 11, quality: "MP4_720P",
  });

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
  seedVideoOffer({
    provider: "tidal", providerId: "tidal-1080", recordingId: 21, quality: "MP4_1080P",
  });
  seedVideoOffer({
    provider: "apple-music", providerId: "apple-4k", recordingId: 21, quality: "MP4_2160P",
  });

  assert.deepEqual(resolver.resolvePreferredVideoOffer("21"), {
    provider: "apple-music",
    providerId: "apple-4k",
    quality: "MP4_2160P",
    recordingId: "21",
    recordingMbid: "shared-recording",
  });
});

test("same-resolution ranking uses TrackFiles-backed provider×tier codec defaults", () => {
  // FHD Apple and TIDAL are both assumed h.264 → codec tie; provider preference decides.
  assert.equal(resolver.videoOfferCodecRank("apple-music", "FHD"), 100);
  assert.equal(resolver.videoOfferCodecRank("tidal", "FHD"), 100);
  // YouTube FHD/HD/UHD assumed AV1 → beats Apple/TIDAL FHD h.264.
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "youtube-music", quality: "FHD", provider_id: "y" },
      { provider: "apple-music", quality: "FHD", provider_id: "a" },
    ) < 0,
  );
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "youtube-music", quality: "HD", provider_id: "y" },
      { provider: "tidal", quality: "HD", provider_id: "t" },
    ) < 0,
  );
  // Apple UHD/QHD assumed HEVC (not AV1) → beats TIDAL UHD h.264 at same res.
  assert.equal(resolver.videoOfferCodecRank("apple-music", "UHD"), 200);
  assert.equal(resolver.videoOfferCodecRank("apple-music", "QHD"), 200);
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "apple-music", quality: "UHD", provider_id: "a" },
      { provider: "tidal", quality: "UHD", provider_id: "t" },
    ) < 0,
  );
  // YouTube UHD AV1 still beats Apple UHD HEVC at the same resolution.
  assert.ok(
    resolver.compareVideoOffersByQualityThenProvider(
      { provider: "youtube-music", quality: "UHD", provider_id: "y" },
      { provider: "apple-music", quality: "UHD", provider_id: "a" },
    ) < 0,
  );

  assert.equal(resolver.videoOfferCodecRank("youtube-music", "UHD"), 400);
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "FHD"), 400);
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "HD"), 400);
  // SD sample too thin — no assumed codec preference.
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "SD"), 0);
  assert.equal(resolver.videoOfferCodecRank("youtube-music", null), 400);
  assert.equal(resolver.videoOfferCodecRank("tidal", "FHD"), 100);
  // Explicit codec still overrides provider defaults.
  assert.equal(resolver.videoOfferCodecRank("youtube-music", "SD", "h264"), 100);
  assert.equal(resolver.videoOfferCodecRank("apple-music", "FHD", "hevc"), 200);
});
