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
  });
});

test("canonical resolution ignores unavailable offers and is deterministic within a provider", () => {
  dbModule.db.prepare(`
    INSERT INTO Recordings (id, mbid, title, is_video, metadata_status)
    VALUES (11, 'canonical-recording', 'Canonical asset', 1, 'musicbrainz')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_mbid, recording_id,
      title, quality, availability, library_slot
    ) VALUES
      ('tidal', 'video', 'z-unavailable', 'canonical-recording', 11,
       'Canonical asset', 'MP4_2160P', 'unavailable', 'video'),
      ('tidal', 'video', 'b-available', 'canonical-recording', 11,
       'Canonical asset', 'MP4_1080P', 'available', 'video'),
      ('tidal', 'video', 'a-available', 'canonical-recording', 11,
       'Canonical asset', 'MP4_720P', 'available', 'video')
  `).run();

  assert.deepEqual(resolver.resolveVideoOfferForProvider("tidal", "11"), {
    provider: "tidal",
    providerId: "a-available",
    quality: "MP4_720P",
  });
});
