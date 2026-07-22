import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-offer-fallback-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;

const {
  listRankedAlbumOffers,
  listRankedTrackOffers,
  listRankedVideoOffers,
  nextOfferAfterTried,
  makeOfferAttemptKey,
} = await import("./download-offer-fallback.js");

const providersModule = await import("../providers/index.js");

function resetRows() {
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
}

beforeEach(resetRows);
afterEach(resetRows);

test("listRankedAlbumOffers respects provider preference and skips tried offers", () => {
  const original = providersModule.streamingProviderManager.getProviderPriority.bind(
    providersModule.streamingProviderManager,
  );
  providersModule.streamingProviderManager.getProviderPriority = () => ["tidal", "apple-music", "deezer"];

  try {
    db.prepare(`
      INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-1', 'Bastille')
    `).run();
    db.prepare(`
      INSERT INTO Albums (mbid, title, artist_mbid) VALUES ('rg-1', 'Wild Life', 'artist-1')
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, release_group_mbid, quality, availability, library_slot)
      VALUES
        ('deezer', 'album', 'dz-1', 'rg-1', 'HIGH', NULL, 'stereo'),
        ('tidal', 'album', 'td-1', 'rg-1', 'HI_RES', NULL, 'stereo'),
        ('apple-music', 'album', 'am-1', 'rg-1', 'LOSSLESS', NULL, 'stereo'),
        ('tidal', 'album', 'td-bad', 'rg-1', 'HIGH', 'unavailable', 'stereo')
    `).run();

    const ranked = listRankedAlbumOffers("rg-1", "stereo");
    assert.deepEqual(
      ranked.map((offer) => offer.provider),
      ["tidal", "apple-music", "deezer"],
    );

    const tried = new Set([makeOfferAttemptKey("tidal", "td-1")]);
    const next = nextOfferAfterTried(ranked, tried);
    assert.equal(next?.provider, "apple-music");
    assert.equal(next?.providerId, "am-1");
  } finally {
    providersModule.streamingProviderManager.getProviderPriority = original;
  }
});

test("listRankedTrackOffers returns provider-priority ordered alternates", () => {
  const original = providersModule.streamingProviderManager.getProviderPriority.bind(
    providersModule.streamingProviderManager,
  );
  providersModule.streamingProviderManager.getProviderPriority = () => ["apple-music", "tidal"];

  try {
    db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, track_mbid, recording_mbid, provider_album_id, quality, availability
      ) VALUES
        ('tidal', 'track', 't-1', 'track-mbid', 'rec-mbid', 'alb-t', 'HI_RES', NULL),
        ('apple-music', 'track', 'a-1', 'track-mbid', 'rec-mbid', 'alb-a', 'LOSSLESS', NULL)
    `).run();

    const ranked = listRankedTrackOffers({ trackMbid: "track-mbid", recordingMbid: "rec-mbid" });
    assert.deepEqual(
      ranked.map((offer) => `${offer.provider}:${offer.providerId}`),
      ["apple-music:a-1", "tidal:t-1"],
    );
  } finally {
    providersModule.streamingProviderManager.getProviderPriority = original;
  }
});

test("listRankedVideoOffers prefers higher resolution then provider priority", () => {
  const manager = providersModule.streamingProviderManager;
  const originalPriority = manager.getProviderPriority.bind(manager);
  manager.getProviderPriority = () => ["tidal", "youtube-music"];

  try {
    db.prepare(`
      INSERT INTO Recordings (mbid, title, is_video) VALUES ('rec-v', 'Pompeii', 1)
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, recording_mbid, quality, availability)
      VALUES
        ('tidal', 'video', 'tv-720', 'rec-v', '720', NULL),
        ('youtube-music', 'video', 'yt-1080', 'rec-v', '1080', NULL),
        ('tidal', 'video', 'tv-1080', 'rec-v', '1080', NULL)
    `).run();

    const ranked = listRankedVideoOffers("rec-v");
    assert.equal(ranked[0]?.providerId, "tv-1080");
    assert.equal(ranked[1]?.providerId, "yt-1080");
    assert.equal(ranked[2]?.providerId, "tv-720");
  } finally {
    manager.getProviderPriority = originalPriority;
  }
});
