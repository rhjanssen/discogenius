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

test("listRankedAlbumOffers prefers neutral fidelity, then provider order, and skips tried offers", () => {
  const original = providersModule.streamingProviderManager.getProviderPriority.bind(
    providersModule.streamingProviderManager,
  );
  providersModule.streamingProviderManager.getProviderPriority = () => ["deezer", "apple-music", "tidal"];

  try {
    db.prepare(`
      INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-1', 'Bastille')
    `).run();
    db.prepare(`
      INSERT INTO Albums (mbid, title, artist_mbid) VALUES ('rg-1', 'Wild Life', 'artist-1')
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('deezer', 'release', 'dz-1', NULL),
    ('tidal', 'release', 'td-1', NULL),
    ('apple-music', 'release', 'am-1', NULL),
    ('tidal', 'release', 'td-bad', 'unavailable')
    `).run();

    const ranked = listRankedAlbumOffers("rg-1", "stereo");
    assert.deepEqual(
      ranked.map((offer) => offer.provider),
      ["tidal", "deezer", "apple-music"],
    );

    const tried = new Set([makeOfferAttemptKey("tidal", "td-1")]);
    const next = nextOfferAfterTried(ranked, tried);
    assert.equal(next?.provider, "deezer");
    assert.equal(next?.providerId, "dz-1");
  } finally {
    providersModule.streamingProviderManager.getProviderPriority = original;
  }
});

test("listRankedTrackOffers keeps hi-res ahead of a preferred lossless provider", () => {
  const original = providersModule.streamingProviderManager.getProviderPriority.bind(
    providersModule.streamingProviderManager,
  );
  providersModule.streamingProviderManager.getProviderPriority = () => ["apple-music", "tidal"];

  try {
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('tidal', 'track', 't-1', NULL),
    ('apple-music', 'track', 'a-1', NULL)
    `).run();

    const ranked = listRankedTrackOffers({ trackMbid: "track-mbid", recordingMbid: "rec-mbid" });
    assert.deepEqual(
      ranked.map((offer) => `${offer.provider}:${offer.providerId}`),
      ["tidal:t-1", "apple-music:a-1"],
    );
  } finally {
    providersModule.streamingProviderManager.getProviderPriority = original;
  }
});

test("listRankedTrackOffers rejects live children of rejected parents but keeps parentless offers", () => {
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('soundcloud', 'release', 'rejected-playlist', 'available'),
    ('tidal', 'release', 'live-album', 'available')
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('soundcloud', 'track', 'legacy-live-child', 'available'),
    ('tidal', 'track', 'live-child', 'available'),
    ('deezer', 'track', 'parentless-track', 'available'),
    ('youtube-music', 'track', 'unresolved-parent-track', 'available')
  `).run();

  const ranked = listRankedTrackOffers({
    trackMbid: "track-parent-gate",
    recordingMbid: "recording-parent-gate",
    librarySlot: "stereo",
  });
  const ids = ranked.map((offer) => offer.providerId);
  assert.equal(ids.includes("legacy-live-child"), false);
  assert.equal(ids.includes("live-child"), true);
  assert.equal(ids.includes("parentless-track"), true);
  assert.equal(ids.includes("unresolved-parent-track"), true);
});

test("listRankedTrackOffers keeps stereo and spatial fallbacks in their requested slot", () => {
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('tidal', 'track', 'stereo-track', NULL),
    ('tidal', 'track', 'spatial-track', NULL),
    ('youtube-music', 'track', 'yt-track', NULL)
  `).run();

  const stereo = listRankedTrackOffers({
    trackMbid: "track-slot",
    recordingMbid: "rec-slot",
    librarySlot: "stereo",
  });
  assert.deepEqual(
    stereo.map((offer) => `${offer.provider}:${offer.providerId}:${offer.quality}`),
    [
      "tidal:stereo-track:LOSSLESS",
      "youtube-music:yt-track:YOUTUBE_LOSSY",
      "tidal:spatial-track:DOLBY_ATMOS",
    ],
  );

  const spatial = listRankedTrackOffers({
    trackMbid: "track-slot",
    recordingMbid: "rec-slot",
    librarySlot: "spatial",
  });
  assert.deepEqual(
    spatial.map((offer) => `${offer.provider}:${offer.providerId}:${offer.quality}`),
    ["tidal:spatial-track:DOLBY_ATMOS"],
  );
});

test("listRankedTrackOffers derives spatial capability from the parent album and projects the request quality", () => {
  const manager = providersModule.streamingProviderManager;
  const originalPriority = manager.getProviderPriority.bind(manager);
  manager.getProviderPriority = () => ["tidal", "apple-music", "deezer"];

  try {
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id
    ) VALUES ('apple-music', 'release', 'apple-dual-album'),
    ('tidal', 'release', 'tidal-atmos-album'),
    ('deezer', 'release', 'deezer-stereo-album')
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('apple-music', 'track', 'apple-dual-track', NULL),
    ('tidal', 'track', 'tidal-atmos-track', NULL),
    ('deezer', 'track', 'deezer-stereo-track', NULL)
    `).run();

    const spatial = listRankedTrackOffers({
      trackMbid: "track-dual",
      recordingMbid: "rec-dual",
      librarySlot: "spatial",
    });
    assert.deepEqual(
      spatial.map((offer) => `${offer.provider}:${offer.providerId}:${offer.quality}`),
      [
        "tidal:tidal-atmos-track:DOLBY_ATMOS",
        "apple-music:apple-dual-track:DOLBY_ATMOS",
      ],
    );

    const stereo = listRankedTrackOffers({
      trackMbid: "track-dual",
      recordingMbid: "rec-dual",
      librarySlot: "stereo",
    });
    assert.deepEqual(
      stereo.map((offer) => `${offer.provider}:${offer.providerId}`),
      [
        "apple-music:apple-dual-track",
        "deezer:deezer-stereo-track",
        "tidal:tidal-atmos-track",
      ],
    );
  } finally {
    manager.getProviderPriority = originalPriority;
  }
});

test("listRankedAlbumOffers derives spatial variants and ranks Atmos ahead of 360", () => {
  const manager = providersModule.streamingProviderManager;
  const originalPriority = manager.getProviderPriority.bind(manager);
  manager.getProviderPriority = () => ["tidal", "apple-music", "deezer"];

  try {
    db.prepare(`
      INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-spatial', 'Bakermat')
    `).run();
    db.prepare(`
      INSERT INTO Albums (mbid, title, artist_mbid)
      VALUES ('rg-spatial', 'The Spirit', 'artist-spatial')
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('apple-music', 'release', 'apple-dual', NULL),
    ('tidal', 'release', 'tidal-360', NULL),
    ('deezer', 'release', 'deezer-stereo', NULL)
    `).run();

    const spatial = listRankedAlbumOffers("rg-spatial", "spatial");
    assert.deepEqual(
      spatial.map((offer) => `${offer.provider}:${offer.providerId}:${offer.quality}`),
      [
        "apple-music:apple-dual:DOLBY_ATMOS",
        "tidal:tidal-360:SONY_360RA",
      ],
    );

    const stereo = listRankedAlbumOffers("rg-spatial", "stereo");
    assert.deepEqual(
      stereo.map((offer) => `${offer.provider}:${offer.providerId}`),
      [
        "apple-music:apple-dual",
        "deezer:deezer-stereo",
        "tidal:tidal-360",
      ],
    );
  } finally {
    manager.getProviderPriority = originalPriority;
  }
});

test("listRankedVideoOffers prefers resolution, then codec, then provider priority", () => {
  const manager = providersModule.streamingProviderManager;
  const originalPriority = manager.getProviderPriority.bind(manager);
  manager.getProviderPriority = () => ["tidal", "youtube-music"];

  try {
    db.prepare(`
      INSERT INTO Recordings (mbid, title, is_video) VALUES ('rec-v', 'Pompeii', 1)
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (
      provider, entity_type, provider_id, availability
    ) VALUES ('tidal', 'video', 'tv-720', NULL),
    ('youtube-music', 'video', 'yt-1080', NULL),
    ('tidal', 'video', 'tv-1080', NULL)
    `).run();

    const ranked = listRankedVideoOffers("rec-v");
    // Same 1080p: YouTube VP9 beats preferred TIDAL h.264.
    assert.equal(ranked[0]?.providerId, "yt-1080");
    assert.equal(ranked[1]?.providerId, "tv-1080");
    assert.equal(ranked[2]?.providerId, "tv-720");
  } finally {
    manager.getProviderPriority = originalPriority;
  }
});
