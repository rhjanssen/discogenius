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
      INSERT INTO ProviderItems (provider, entity_type, provider_id, release_group_mbid, quality, availability, library_slot)
      VALUES
        ('deezer', 'album', 'dz-1', 'rg-1', 'FLAC', NULL, 'stereo'),
        ('tidal', 'album', 'td-1', 'rg-1', 'HI_RES', NULL, 'stereo'),
        ('apple-music', 'album', 'am-1', 'rg-1', 'LOSSLESS', NULL, 'stereo'),
        ('tidal', 'album', 'td-bad', 'rg-1', 'HIGH', 'unavailable', 'stereo')
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
        provider, entity_type, provider_id, track_mbid, recording_mbid, provider_album_id, quality, availability
      ) VALUES
        ('tidal', 'track', 't-1', 'track-mbid', 'rec-mbid', 'alb-t', 'HI_RES', NULL),
        ('apple-music', 'track', 'a-1', 'track-mbid', 'rec-mbid', 'alb-a', 'LOSSLESS', NULL)
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
      provider, entity_type, provider_id, quality, match_status, availability
    ) VALUES
      ('soundcloud', 'album', 'rejected-playlist', 'SOUNDCLOUD_LOSSY', 'rejected', 'available'),
      ('tidal', 'album', 'live-album', 'LOSSLESS', 'probable', 'available')
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, track_mbid, recording_mbid,
      provider_album_id, quality, match_status, availability, library_slot
    ) VALUES
      (
        'soundcloud', 'track', 'legacy-live-child', 'track-parent-gate', 'recording-parent-gate',
        'rejected-playlist', 'SOUNDCLOUD_LOSSY', 'matched', 'available', 'stereo'
      ),
      (
        'tidal', 'track', 'live-child', 'track-parent-gate', 'recording-parent-gate',
        'live-album', 'LOSSLESS', 'matched', 'available', 'stereo'
      ),
      (
        'deezer', 'track', 'parentless-track', 'track-parent-gate', 'recording-parent-gate',
        NULL, 'FLAC', 'matched', 'available', 'stereo'
      ),
      (
        'youtube-music', 'track', 'unresolved-parent-track', 'track-parent-gate', 'recording-parent-gate',
        'missing-parent', 'YOUTUBE_LOSSY', 'matched', 'available', 'stereo'
      )
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
      provider, entity_type, provider_id, track_mbid, recording_mbid,
      provider_album_id, quality, availability, library_slot
    ) VALUES
      ('tidal', 'track', 'stereo-track', 'track-slot', 'rec-slot', 'tidal-stereo', 'LOSSLESS', NULL, 'stereo'),
      ('tidal', 'track', 'spatial-track', 'track-slot', 'rec-slot', 'tidal-atmos', 'DOLBY_ATMOS', NULL, 'spatial'),
      ('youtube-music', 'track', 'yt-track', 'track-slot', 'rec-slot', 'yt-album', 'YOUTUBE_LOSSY', NULL, 'stereo')
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
        provider, entity_type, provider_id, quality, library_slot, match_evidence
      ) VALUES
        (
          'apple-music', 'album', 'apple-dual-album', 'HIRES_LOSSLESS', 'stereo',
          '{"providerQualityTags":["hi-res-lossless","atmos"]}'
        ),
        ('tidal', 'album', 'tidal-atmos-album', 'DOLBY_ATMOS', 'spatial', NULL),
        (
          'deezer', 'album', 'deezer-stereo-album', 'FLAC', 'stereo',
          '{"providerQualityTags":["FLAC"]}'
        )
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, track_mbid, recording_mbid,
        provider_album_id, quality, availability, library_slot
      ) VALUES
        (
          'apple-music', 'track', 'apple-dual-track', 'track-dual', 'rec-dual',
          'apple-dual-album', 'HIRES_LOSSLESS', NULL, 'stereo'
        ),
        (
          'tidal', 'track', 'tidal-atmos-track', 'track-dual', 'rec-dual',
          'tidal-atmos-album', 'DOLBY_ATMOS', NULL, 'spatial'
        ),
        (
          'deezer', 'track', 'deezer-stereo-track', 'track-dual', 'rec-dual',
          'deezer-stereo-album', 'FLAC', NULL, 'stereo'
        )
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
        provider, entity_type, provider_id, release_group_mbid, quality,
        availability, library_slot, match_evidence
      ) VALUES
        (
          'apple-music', 'album', 'apple-dual', 'rg-spatial', 'HIRES_LOSSLESS',
          NULL, 'stereo', '{"providerQualityTags":["hi-res-lossless","atmos"]}'
        ),
        (
          'tidal', 'album', 'tidal-360', 'rg-spatial', 'SONY_360RA',
          NULL, 'spatial', '{"providerQualityTags":["SONY_360RA"]}'
        ),
        (
          'deezer', 'album', 'deezer-stereo', 'rg-spatial', 'FLAC',
          NULL, 'stereo', '{"providerQualityTags":["FLAC"]}'
        )
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
      INSERT INTO ProviderItems (provider, entity_type, provider_id, recording_mbid, quality, availability)
      VALUES
        ('tidal', 'video', 'tv-720', 'rec-v', '720', NULL),
        ('youtube-music', 'video', 'yt-1080', 'rec-v', '1080', NULL),
        ('tidal', 'video', 'tv-1080', 'rec-v', '1080', NULL)
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
