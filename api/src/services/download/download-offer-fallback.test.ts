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
  listRankedAlbumTrackOffers,
  listRankedAlbumOffers,
  listRankedTrackOffers,
  listRankedVideoOffers,
  nextOfferAfterTried,
  makeOfferAttemptKey,
} = await import("./download-offer-fallback.js");

const providersModule = await import("../providers/index.js");

const {
  seedAcceptedProviderTrackMatch,
  seedAcceptedProviderVideoMatch,
  seedCanonicalAlbum,
  seedProviderAudioVariant,
} = await import("../../test-support/normalized-provider-fixtures.js");
const { resetActiveSchemaRows } = await import("../../test-support/active-schema-fixture.js");
const { ProviderMatchRepository } = await import("../music/provider-match-repository.js");

function resetRows() {
  resetActiveSchemaRows(db);
}

/**
 * A provider album offer: the release resource, its accepted canonical match,
 * one member track, and the SOURCE CAPABILITY variants that give it a quality.
 * Quality lives on ProviderItemAudioVariants now, so a bare ProviderItems row
 * produces no offer at all.
 */
function seedAlbumOffer(fixture: {
  provider: string;
  providerEditionId: string;
  providerTrackId: string;
  releaseMbid: string;
  trackMbid: string;
  variants: Array<{
    qualityClass: "lossy" | "lossless" | "hires-lossless" | "spatial";
    providerQualityLabel?: string | null;
    spatialFormat?: string | null;
    variantKey?: string;
  }>;
  availability?: string;
}) {
  const ids = seedAcceptedProviderTrackMatch(db, {
    provider: fixture.provider,
    providerEditionId: fixture.providerEditionId,
    providerTrackId: fixture.providerTrackId,
    releaseMbid: fixture.releaseMbid,
    trackMbid: fixture.trackMbid,
  });
  if (fixture.availability) {
    db.prepare("UPDATE ProviderItems SET availability = ? WHERE id IN (?, ?)")
      .run(fixture.availability, ids.providerEditionItemId, ids.providerTrackItemId);
  }
  for (const variant of fixture.variants) {
    // Album-level offers read the release item's own variants; track-level
    // offers read the track item's. Seed both so one fixture serves either.
    seedProviderAudioVariant(db, { ...variant, providerItemId: ids.providerEditionItemId });
    seedProviderAudioVariant(db, { ...variant, providerItemId: ids.providerTrackItemId });
  }
  return ids;
}

beforeEach(resetRows);
afterEach(resetRows);

test("listRankedAlbumOffers prefers neutral fidelity, then provider order, and skips tried offers", () => {
  const original = providersModule.streamingProviderManager.getProviderPriority.bind(
    providersModule.streamingProviderManager,
  );
  providersModule.streamingProviderManager.getProviderPriority = () => ["deezer", "apple-music", "tidal"];

  try {
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-1",
      releaseMbid: "rel-1",
      artistMbid: "artist-1",
      artistName: "Bastille",
      title: "Wild Life",
      tracks: [{ trackMbid: "t-wild", recordingMbid: "r-wild", title: "Wild World" }],
    });
    // TIDAL is hi-res, so it outranks the two lossless offers regardless of the
    // configured provider order; deezer then apple-music settle by that order.
    seedAlbumOffer({
      provider: "tidal", providerEditionId: "td-1", providerTrackId: "td-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "hires-lossless", providerQualityLabel: "HIRES_LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerEditionId: "dz-1", providerTrackId: "dz-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerEditionId: "am-1", providerTrackId: "am-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });
    // Unavailable offers are dropped on availability, not on match state.
    seedAlbumOffer({
      provider: "tidal", providerEditionId: "td-bad", providerTrackId: "td-bad-t",
      releaseMbid: "rel-1", trackMbid: "t-wild", availability: "unavailable",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });

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
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-hires", releaseMbid: "rel-hires",
      tracks: [{ trackMbid: "track-mbid", recordingMbid: "rec-mbid" }],
    });
    seedAlbumOffer({
      provider: "tidal", providerEditionId: "td-hires", providerTrackId: "t-1",
      releaseMbid: "rel-hires", trackMbid: "track-mbid",
      variants: [{ qualityClass: "hires-lossless", providerQualityLabel: "HIRES_LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerEditionId: "am-hires", providerTrackId: "a-1",
      releaseMbid: "rel-hires", trackMbid: "track-mbid",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });

    const ranked = listRankedTrackOffers({ trackMbid: "track-mbid", recordingMbid: "rec-mbid" });
    assert.deepEqual(
      ranked.map((offer) => `${offer.provider}:${offer.providerId}`),
      ["tidal:t-1", "apple-music:a-1"],
    );
  } finally {
    providersModule.streamingProviderManager.getProviderPriority = original;
  }
});

test("a track whose parent release is unavailable is excluded, its available siblings are not", () => {
  seedCanonicalAlbum(db, {
    releaseGroupMbid: "rg-parent-gate", releaseMbid: "rel-parent-gate",
    tracks: [{ trackMbid: "track-parent-gate", recordingMbid: "recording-parent-gate" }],
  });
  // Contextual offers still inherit the availability gate from their parent.
  seedAlbumOffer({
    provider: "soundcloud", providerEditionId: "rejected-playlist",
    providerTrackId: "legacy-live-child",
    releaseMbid: "rel-parent-gate", trackMbid: "track-parent-gate",
    availability: "unavailable",
    variants: [{ qualityClass: "lossy", providerQualityLabel: "LOW" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerEditionId: "live-album", providerTrackId: "live-child",
    releaseMbid: "rel-parent-gate", trackMbid: "track-parent-gate",
    variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
  });
  seedAlbumOffer({
    provider: "deezer", providerEditionId: "deezer-album", providerTrackId: "sibling-track",
    releaseMbid: "rel-parent-gate", trackMbid: "track-parent-gate",
    variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
  });

  const ranked = listRankedTrackOffers({
    trackMbid: "track-parent-gate",
    recordingMbid: "recording-parent-gate",
    librarySlot: "stereo",
  });
  const ids = ranked.map((offer) => offer.providerId);
  assert.equal(ids.includes("legacy-live-child"), false, "unavailable parent excludes its child");
  assert.equal(ids.includes("live-child"), true);
  assert.equal(ids.includes("sibling-track"), true);
});

test("listRankedTrackOffers accepts an exact parentless provider track match", () => {
  seedCanonicalAlbum(db, {
    releaseGroupMbid: "rg-standalone",
    releaseMbid: "rel-standalone",
    tracks: [{ trackMbid: "track-standalone", recordingMbid: "recording-standalone" }],
  });
  const canonical = db.prepare(`
    SELECT track.id AS track_id, track.recording_id
    FROM Tracks track
    WHERE track.mbid = 'track-standalone'
  `).get() as { track_id: number; recording_id: number };
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('spotify', 'track', 'standalone-offer', 'Standalone Offer', 'available')
    RETURNING id
  `).get() as { id: number };
  const variant = seedProviderAudioVariant(db, {
    providerItemId: providerTrack.id,
    qualityClass: "lossy",
    providerQualityLabel: "OGG_320",
  });

  new ProviderMatchRepository(db).upsertStandaloneTrackMatch({
    providerTrackItemId: providerTrack.id,
    trackId: canonical.track_id,
    recordingId: canonical.recording_id,
    decision: {
      matchState: "accepted",
      decisionSource: "automatic",
      confidence: 0.99,
      method: "isrc",
      matcherVersion: 1,
    },
  });

  assert.deepEqual(
    listRankedTrackOffers({
      trackMbid: "track-standalone",
      recordingMbid: "recording-standalone",
      librarySlot: "stereo",
    }),
    [{
      provider: "spotify",
      providerId: "standalone-offer",
      quality: "OGG_320",
      providerAlbumId: null,
      providerItemId: providerTrack.id,
      providerAlbumItemId: null,
      providerAudioVariantId: variant,
    }],
  );
});

test("album fallback keeps the requested edition occurrence when one provider track is reused", () => {
  seedCanonicalAlbum(db, {
    releaseGroupMbid: "rg-shared-occurrence",
    releaseMbid: "rel-shared-occurrence",
    tracks: [{ trackMbid: "track-shared", recordingMbid: "recording-shared" }],
  });
  const first = seedAcceptedProviderTrackMatch(db, {
    provider: "tidal",
    providerEditionId: "tidal-first-edition",
    providerTrackId: "tidal-shared-track",
    releaseMbid: "rel-shared-occurrence",
    trackMbid: "track-shared",
  });
  const second = seedAcceptedProviderTrackMatch(db, {
    provider: "tidal",
    providerEditionId: "tidal-second-edition",
    providerTrackId: "tidal-shared-track",
    releaseMbid: "rel-shared-occurrence",
    trackMbid: "track-shared",
  });
  const variant = seedProviderAudioVariant(db, {
    providerItemId: first.providerTrackItemId,
    qualityClass: "lossless",
    providerQualityLabel: "LOSSLESS",
  });

  assert.deepEqual(listRankedAlbumTrackOffers({
    provider: "tidal",
    providerAlbumId: "tidal-second-edition",
    trackMbid: "track-shared",
    recordingMbid: "recording-shared",
    librarySlot: "stereo",
  }), [{
    provider: "tidal",
    providerId: "tidal-shared-track",
    quality: "LOSSLESS",
    providerAlbumId: "tidal-second-edition",
    providerItemId: first.providerTrackItemId,
    providerAlbumItemId: second.providerEditionItemId,
    providerAudioVariantId: variant,
  }]);
});

test("listRankedTrackOffers keeps stereo and spatial fallbacks in their requested slot", () => {
  seedCanonicalAlbum(db, {
    releaseGroupMbid: "rg-slot", releaseMbid: "rel-slot",
    tracks: [{ trackMbid: "track-slot", recordingMbid: "rec-slot" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerEditionId: "td-slot", providerTrackId: "stereo-track",
    releaseMbid: "rel-slot", trackMbid: "track-slot",
    variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerEditionId: "td-slot-atmos", providerTrackId: "spatial-track",
    releaseMbid: "rel-slot", trackMbid: "track-slot",
    variants: [{ qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS" }],
  });
  seedAlbumOffer({
    provider: "youtube-music", providerEditionId: "yt-slot", providerTrackId: "yt-track",
    releaseMbid: "rel-slot", trackMbid: "track-slot",
    variants: [{ qualityClass: "lossy", providerQualityLabel: "YOUTUBE_LOSSY" }],
  });

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
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-dual", releaseMbid: "rel-dual",
      tracks: [{ trackMbid: "track-dual", recordingMbid: "rec-dual" }],
    });
    // Apple carries BOTH a stereo and an Atmos variant; TIDAL is Atmos-only.
    seedAlbumOffer({
      provider: "apple-music", providerEditionId: "apple-dual-album",
      providerTrackId: "apple-dual-track",
      releaseMbid: "rel-dual", trackMbid: "track-dual",
      variants: [
        { qualityClass: "lossless", providerQualityLabel: "LOSSLESS", variantKey: "stereo" },
        { qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS", variantKey: "atmos" },
      ],
    });
    seedAlbumOffer({
      provider: "tidal", providerEditionId: "tidal-atmos-album",
      providerTrackId: "tidal-atmos-track",
      releaseMbid: "rel-dual", trackMbid: "track-dual",
      variants: [{ qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerEditionId: "deezer-stereo-album",
      providerTrackId: "deezer-stereo-track",
      releaseMbid: "rel-dual", trackMbid: "track-dual",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });

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
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-spatial", releaseMbid: "rel-spatial",
      artistMbid: "artist-spatial", artistName: "Bakermat", title: "The Spirit",
      tracks: [{ trackMbid: "track-spirit", recordingMbid: "rec-spirit" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerEditionId: "apple-dual", providerTrackId: "apple-dual-t",
      releaseMbid: "rel-spatial", trackMbid: "track-spirit",
      variants: [
        { qualityClass: "lossless", providerQualityLabel: "LOSSLESS", variantKey: "stereo" },
        { qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS", variantKey: "atmos" },
      ],
    });
    seedAlbumOffer({
      provider: "tidal", providerEditionId: "tidal-360", providerTrackId: "tidal-360-t",
      releaseMbid: "rel-spatial", trackMbid: "track-spirit",
      variants: [{ qualityClass: "spatial", providerQualityLabel: "SONY_360RA", spatialFormat: "SONY_360RA" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerEditionId: "deezer-stereo", providerTrackId: "deezer-stereo-t",
      releaseMbid: "rel-spatial", trackMbid: "track-spirit",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });

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
    const recording = db.prepare(`
      INSERT INTO Recordings (mbid, title, is_video, metadata_status)
      VALUES ('rec-v', 'Pompeii', 1, 'musicbrainz')
      RETURNING id
    `).get() as { id: number };
    // ProviderVideoMatches is the only video -> recording link, and video quality
    // lives on the item itself rather than in audio variants.
    for (const [provider, providerVideoId, quality] of [
      ["tidal", "tv-720", "MP4_720P"],
      ["youtube-music", "yt-1080", "MP4_1080P"],
      ["tidal", "tv-1080", "MP4_1080P"],
    ] as const) {
      const ids = seedAcceptedProviderVideoMatch(db, {
        provider, providerVideoId, recordingId: recording.id,
        title: "Pompeii", availability: "available",
      });
      db.prepare("UPDATE ProviderItems SET video_quality = ? WHERE id = ?")
        .run(quality, ids.providerVideoItemId);
    }

    const ranked = listRankedVideoOffers("rec-v");
    // Same 1080p: YouTube VP9 beats preferred TIDAL h.264.
    assert.equal(ranked[0]?.providerId, "yt-1080");
    assert.equal(ranked[1]?.providerId, "tv-1080");
    assert.equal(ranked[2]?.providerId, "tv-720");
  } finally {
    manager.getProviderPriority = originalPriority;
  }
});
