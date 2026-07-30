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

const {
  seedAcceptedProviderTrackMatch,
  seedAcceptedProviderVideoMatch,
  seedCanonicalAlbum,
  seedProviderAudioVariant,
} = await import("../../test-support/normalized-provider-fixtures.js");
const { resetActiveSchemaRows } = await import("../../test-support/active-schema-fixture.js");

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
  providerReleaseId: string;
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
    providerReleaseId: fixture.providerReleaseId,
    providerTrackId: fixture.providerTrackId,
    releaseMbid: fixture.releaseMbid,
    trackMbid: fixture.trackMbid,
  });
  if (fixture.availability) {
    db.prepare("UPDATE ProviderItems SET availability = ? WHERE id IN (?, ?)")
      .run(fixture.availability, ids.providerReleaseItemId, ids.providerTrackItemId);
  }
  for (const variant of fixture.variants) {
    // Album-level offers read the release item's own variants; track-level
    // offers read the track item's. Seed both so one fixture serves either.
    seedProviderAudioVariant(db, { ...variant, providerItemId: ids.providerReleaseItemId });
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
      provider: "tidal", providerReleaseId: "td-1", providerTrackId: "td-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "hires-lossless", providerQualityLabel: "HIRES_LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerReleaseId: "dz-1", providerTrackId: "dz-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerReleaseId: "am-1", providerTrackId: "am-t1",
      releaseMbid: "rel-1", trackMbid: "t-wild",
      variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
    });
    // Unavailable offers are dropped on availability, not on match state.
    seedAlbumOffer({
      provider: "tidal", providerReleaseId: "td-bad", providerTrackId: "td-bad-t",
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
      provider: "tidal", providerReleaseId: "td-hires", providerTrackId: "t-1",
      releaseMbid: "rel-hires", trackMbid: "track-mbid",
      variants: [{ qualityClass: "hires-lossless", providerQualityLabel: "HIRES_LOSSLESS" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerReleaseId: "am-hires", providerTrackId: "a-1",
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
  // Schema 41 has no parentless provider track: membership on a provider release
  // is what a ProviderTrackMatches edge hangs off, so the old "keeps parentless
  // offers" case is no longer expressible. The surviving rule is the parent
  // availability gate.
  seedAlbumOffer({
    provider: "soundcloud", providerReleaseId: "rejected-playlist",
    providerTrackId: "legacy-live-child",
    releaseMbid: "rel-parent-gate", trackMbid: "track-parent-gate",
    availability: "unavailable",
    variants: [{ qualityClass: "lossy", providerQualityLabel: "LOW" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerReleaseId: "live-album", providerTrackId: "live-child",
    releaseMbid: "rel-parent-gate", trackMbid: "track-parent-gate",
    variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
  });
  seedAlbumOffer({
    provider: "deezer", providerReleaseId: "deezer-album", providerTrackId: "sibling-track",
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

test("listRankedTrackOffers keeps stereo and spatial fallbacks in their requested slot", () => {
  seedCanonicalAlbum(db, {
    releaseGroupMbid: "rg-slot", releaseMbid: "rel-slot",
    tracks: [{ trackMbid: "track-slot", recordingMbid: "rec-slot" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerReleaseId: "td-slot", providerTrackId: "stereo-track",
    releaseMbid: "rel-slot", trackMbid: "track-slot",
    variants: [{ qualityClass: "lossless", providerQualityLabel: "LOSSLESS" }],
  });
  seedAlbumOffer({
    provider: "tidal", providerReleaseId: "td-slot-atmos", providerTrackId: "spatial-track",
    releaseMbid: "rel-slot", trackMbid: "track-slot",
    variants: [{ qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS" }],
  });
  seedAlbumOffer({
    provider: "youtube-music", providerReleaseId: "yt-slot", providerTrackId: "yt-track",
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
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-dual", releaseMbid: "rel-dual",
      tracks: [{ trackMbid: "track-dual", recordingMbid: "rec-dual" }],
    });
    // Apple carries BOTH a stereo and an Atmos variant; TIDAL is Atmos-only.
    seedAlbumOffer({
      provider: "apple-music", providerReleaseId: "apple-dual-album",
      providerTrackId: "apple-dual-track",
      releaseMbid: "rel-dual", trackMbid: "track-dual",
      variants: [
        { qualityClass: "lossless", providerQualityLabel: "LOSSLESS", variantKey: "stereo" },
        { qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS", variantKey: "atmos" },
      ],
    });
    seedAlbumOffer({
      provider: "tidal", providerReleaseId: "tidal-atmos-album",
      providerTrackId: "tidal-atmos-track",
      releaseMbid: "rel-dual", trackMbid: "track-dual",
      variants: [{ qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerReleaseId: "deezer-stereo-album",
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
    seedCanonicalAlbum(db, {
      releaseGroupMbid: "rg-spatial", releaseMbid: "rel-spatial",
      artistMbid: "artist-spatial", artistName: "Bakermat", title: "The Spirit",
      tracks: [{ trackMbid: "track-spirit", recordingMbid: "rec-spirit" }],
    });
    seedAlbumOffer({
      provider: "apple-music", providerReleaseId: "apple-dual", providerTrackId: "apple-dual-t",
      releaseMbid: "rel-spatial", trackMbid: "track-spirit",
      variants: [
        { qualityClass: "lossless", providerQualityLabel: "LOSSLESS", variantKey: "stereo" },
        { qualityClass: "spatial", providerQualityLabel: "DOLBY_ATMOS", spatialFormat: "DOLBY_ATMOS", variantKey: "atmos" },
      ],
    });
    seedAlbumOffer({
      provider: "tidal", providerReleaseId: "tidal-360", providerTrackId: "tidal-360-t",
      releaseMbid: "rel-spatial", trackMbid: "track-spirit",
      variants: [{ qualityClass: "spatial", providerQualityLabel: "SONY_360RA", spatialFormat: "SONY_360RA" }],
    });
    seedAlbumOffer({
      provider: "deezer", providerReleaseId: "deezer-stereo", providerTrackId: "deezer-stereo-t",
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
