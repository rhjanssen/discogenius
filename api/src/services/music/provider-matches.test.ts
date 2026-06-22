import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-matches-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let providerMatches: typeof import("./provider-matches.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  providerMatches = await import("./provider-matches.js");
});

function seedReleaseGroup() {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-mbid-1", "Queen");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run("rg-1", "artist-mbid-1", "A Night at the Opera", "album");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, country, media_count, track_count, disambiguation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("rel-stereo", "rg-1", "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", "GB", 1, 12, "deluxe edition");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, country) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("rel-atmos", "rg-1", "artist-mbid-1", "A Night at the Opera (Dolby Atmos)", "2022-01-01", "US");
  db.prepare(`INSERT INTO AlbumReleaseMedia (release_mbid, position, format, track_count) VALUES (?, 1, 'Digital Media', 12)`)
    .run("rel-stereo");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, length_ms) VALUES (?, ?, ?, ?)`)
    .run("rec-1", "artist-mbid-1", "Bohemian Rhapsody", 354000);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms) VALUES (?, ?, ?, ?, 1, 1, ?)`)
    .run("track-1", "rel-stereo", "rec-1", "Bohemian Rhapsody", 354000);
  // Provider album offers (ProviderItems) backing the two releases.
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-stereo', 'LOSSLESS', 'stereo', 'rg-1', 'rel-stereo')`).run();
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-atmos', 'DOLBY_ATMOS', 'spatial', 'rg-1', 'rel-atmos')`).run();
}

beforeEach(() => {
  const { db } = dbModule;
  for (const t of ["ProviderItemMatches", "ProviderItems", "ReleaseGroupSlots", "Tracks", "Recordings", "AlbumReleaseMedia", "AlbumReleases", "Albums", "ArtistMetadata"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

test("fresh database has the ProviderItemMatches table", () => {
  const row = dbModule.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderItemMatches'`,
  ).get() as { name?: string } | undefined;
  assert.equal(row?.name, "ProviderItemMatches");
});

test("upsert persists candidate matches and dedupes per (source,target)", () => {
  const { db } = dbModule;
  seedReleaseGroup();
  providerMatches.upsertProviderReleaseMatch({
    provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo",
    status: "probable", confidence: 0.8, method: "title", evidence: JSON.stringify({ titleScore: 0.8 }),
  });
  // Re-upsert same source/target updates in place (no duplicate row).
  providerMatches.upsertProviderReleaseMatch({
    provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo",
    status: "verified", confidence: 0.99, method: "upc",
  });
  const rows = db.prepare(
    `SELECT status, confidence FROM ProviderItemMatches WHERE provider='tidal' AND provider_item_id='prov-stereo' AND musicbrainz_release_mbid='rel-stereo'`,
  ).all() as Array<{ status: string; confidence: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "verified");
  assert.equal(rows[0].confidence, 0.99);
});

test("a single provider album can hold multiple candidate release matches", () => {
  const { db } = dbModule;
  seedReleaseGroup();
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo", status: "verified", confidence: 0.95 });
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-atmos", status: "candidate", confidence: 0.4 });
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM ProviderItemMatches WHERE provider_item_id='prov-stereo'`).get() as { n: number }).n;
  assert.equal(count, 2);
});

test("getReleaseGroupAvailability reports per-release provider availability and current selection", () => {
  const { db } = dbModule;
  seedReleaseGroup();
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo", status: "verified", confidence: 0.95 });
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-atmos", releaseMbid: "rel-atmos", status: "verified", confidence: 0.9 });
  db.prepare(`INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid)
              VALUES ('artist-mbid-1', 'rg-1', 'stereo', 1, 'rel-stereo')`).run();

  const result = providerMatches.getReleaseGroupAvailability("rg-1");

  assert.equal(result.releaseGroupMbid, "rg-1");
  assert.equal(result.releases.length, 2);
  assert.equal(result.selectedReleaseBySlot.stereo, "rel-stereo");

  const stereo = result.releases.find((r) => r.releaseMbid === "rel-stereo");
  assert.ok(stereo);
  assert.equal(stereo.availability.length, 1);
  assert.equal(stereo.disambiguation, "deluxe edition");
  assert.equal(stereo.status, "Official");
  assert.equal(stereo.format, "Digital Media");
  assert.equal(stereo.mediumCount, 1);
  assert.equal(stereo.trackCount, 12);
  assert.equal(stereo.duration, 354);
  assert.equal(stereo.availability[0].provider, "tidal");
  assert.equal(stereo.availability[0].providerAlbumId, "prov-stereo");
  assert.equal(stereo.availability[0].quality, "LOSSLESS");

  const atmos = result.releases.find((r) => r.releaseMbid === "rel-atmos");
  assert.ok(atmos);
  assert.equal(atmos.availability[0].quality, "DOLBY_ATMOS");

  // A release in the group with no provider match still appears, with empty availability.
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title) VALUES ('rel-vinyl', 'rg-1', 'artist-mbid-1', 'Vinyl')`).run();
  const withVinyl = providerMatches.getReleaseGroupAvailability("rg-1");
  const vinyl = withVinyl.releases.find((r) => r.releaseMbid === "rel-vinyl");
  assert.ok(vinyl);
  assert.equal(vinyl.availability.length, 0);
});

test("getReleaseGroupAvailability returns a stable slot and quality order for offers", () => {
  const { db } = dbModule;
  seedReleaseGroup();
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-stereo-hires', 'HIRES_LOSSLESS', 'stereo', 'rg-1', 'rel-stereo')`).run();
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-stereo-low', 'HIGH', 'stereo', 'rg-1', 'rel-stereo')`).run();
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-atmos-same-release', 'DOLBY_ATMOS', 'spatial', 'rg-1', 'rel-stereo')`).run();

  for (const [providerId, confidence] of [
    ["prov-atmos-same-release", 1],
    ["prov-stereo", 1],
    ["prov-stereo-hires", 1],
    ["prov-stereo-low", 1],
  ] as const) {
    providerMatches.upsertProviderReleaseMatch({
      provider: "tidal",
      providerId,
      releaseMbid: "rel-stereo",
      status: "verified",
      confidence,
    });
  }

  const result = providerMatches.getReleaseGroupAvailability("rg-1");
  const stereo = result.releases.find((r) => r.releaseMbid === "rel-stereo");

  assert.ok(stereo);
  assert.deepEqual(
    stereo.availability.map((offer) => `${offer.librarySlot}:${offer.quality}:${offer.providerAlbumId}`),
    [
      "stereo:HIRES_LOSSLESS:prov-stereo-hires",
      "stereo:LOSSLESS:prov-stereo",
      "stereo:HIGH:prov-stereo-low",
      "spatial:DOLBY_ATMOS:prov-atmos-same-release",
    ],
  );
});

test("getReleaseGroupAvailability derives strict hybrid coverage from multiple provider albums", () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-bastille", "Bastille");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run("rg-unplugged", "artist-bastille", "Killing Me Softly With His Song (MTV Unplugged)", "single");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, country, media_count, track_count)
              VALUES (?, ?, ?, ?, 'Official', '2023-04-26', 'XW', 1, 3)`)
    .run("rel-three-track", "rg-unplugged", "artist-bastille", "Killing Me Softly With His Song (MTV Unplugged)");

  for (const [recording, track, title, position, length] of [
    ["rec-softly", "track-softly", "Killing Me Softly With His Song (edit)", 1, 298540],
    ["rec-pompeii", "track-pompeii", "Pompeii (edit)", 2, 268690],
    ["rec-nirvana", "track-nirvana", "Come as You Are (edit)", 3, 231490],
  ] as const) {
    db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, length_ms) VALUES (?, 'artist-bastille', ?, ?)`)
      .run(recording, title, length);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
                VALUES (?, 'rel-three-track', ?, ?, ?, 1, ?)`)
      .run(track, recording, title, position, length);
  }

  const albumData = (tracks: Array<{ title: string; isrc: string; duration: number }>) => JSON.stringify({
    quality: "HIRES_LOSSLESS",
    tracks: tracks.map((track, index) => ({
      ...track,
      track_number: index + 1,
      volume_number: 1,
    })),
  });

  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, quality, data)
              VALUES ('tidal', 'album', ?, 'artist-bastille', ?, 'HIRES_LOSSLESS', ?)`)
    .run("290132977", "Killing Me Softly With His Song (MTV Unplugged / Edit)", albumData([
      { title: "Killing Me Softly With His Song", isrc: "GBUM72302334", duration: 299 },
    ]));
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, quality, data)
              VALUES ('tidal', 'album', ?, 'artist-bastille', ?, 'HIRES_LOSSLESS', ?)`)
    .run("287367980", "Pompeii / Come As You Are (MTV Unplugged)", albumData([
      { title: "Pompeii", isrc: "GBUM72302279", duration: 269 },
      { title: "Come As You Are", isrc: "GBUM72302277", duration: 231 },
    ]));
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, title, quality, data)
              VALUES ('tidal', 'album', ?, 'artist-bastille', ?, 'HIRES_LOSSLESS', ?)`)
    .run("extra-provider-album", "Pompeii / Come As You Are / Extra", albumData([
      { title: "Pompeii", isrc: "GBUM72302279", duration: 269 },
      { title: "Come As You Are", isrc: "GBUM72302277", duration: 231 },
      { title: "Extra Track", isrc: "GBUM70000000", duration: 180 },
    ]));

  const result = providerMatches.getReleaseGroupAvailability("rg-unplugged");
  const release = result.releases.find((item) => item.releaseMbid === "rel-three-track");

  assert.ok(release);
  assert.equal(release.availability.length, 1);
  assert.equal(release.availability[0].matchKind, "composite");
  assert.equal(release.availability[0].provider, "tidal");
  assert.deepEqual(release.availability[0].providerAlbumIds, ["290132977", "287367980"]);
  assert.equal(release.availability[0].providerAlbumId, "290132977;287367980");
  assert.equal(release.availability[0].coverageSummary, "3/3 tracks from 2 provider albums");

  const after = providerMatches.setSlotSelection({
    releaseGroupMbid: "rg-unplugged",
    slot: "stereo",
    releaseMbid: "rel-three-track",
    provider: "tidal",
    // Accept the previous API delimiter but normalize storage to the canonical
    // semicolon format used by download and metadata queries.
    providerAlbumId: "290132977+287367980",
  });
  assert.equal(after.selectedReleaseBySlot.stereo, "rel-three-track");
  const slot = db.prepare(`SELECT selected_provider_id, match_method FROM ReleaseGroupSlots WHERE release_group_mbid='rg-unplugged' AND slot='stereo'`).get() as any;
  assert.equal(slot.selected_provider_id, "290132977;287367980");
  assert.equal(slot.match_method, "strict_composite_track_coverage");
});

test("setSlotSelection switches the selected release and derives the best provider", () => {
  const { db } = dbModule;
  seedReleaseGroup();
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo", status: "verified", confidence: 0.95 });
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-atmos", releaseMbid: "rel-atmos", status: "verified", confidence: 0.9 });

  // No slot row yet -> setSlotSelection inserts one selecting rel-atmos for the stereo slot.
  const after = providerMatches.setSlotSelection({ releaseGroupMbid: "rg-1", slot: "stereo", releaseMbid: "rel-atmos" });
  assert.equal(after.selectedReleaseBySlot.stereo, "rel-atmos");

  const slot = db.prepare(`SELECT selected_release_mbid, selected_provider, selected_provider_id, monitored FROM ReleaseGroupSlots WHERE release_group_mbid='rg-1' AND slot='stereo'`).get() as any;
  assert.equal(slot.selected_release_mbid, "rel-atmos");
  assert.equal(slot.selected_provider, "tidal");
  assert.equal(slot.selected_provider_id, "prov-atmos"); // derived best match for rel-atmos
  assert.equal(slot.monitored, 0); // selection does not change monitoring

  // Switching again updates the existing row.
  providerMatches.setSlotSelection({ releaseGroupMbid: "rg-1", slot: "stereo", releaseMbid: "rel-stereo", provider: "tidal", providerAlbumId: "prov-stereo" });
  const slot2 = db.prepare(`SELECT selected_release_mbid, selected_provider_id FROM ReleaseGroupSlots WHERE release_group_mbid='rg-1' AND slot='stereo'`).get() as any;
  assert.equal(slot2.selected_release_mbid, "rel-stereo");
  assert.equal(slot2.selected_provider_id, "prov-stereo");
});

test("setSlotSelection rejects an explicit provider offer that does not match the chosen release", () => {
  seedReleaseGroup();
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-stereo", releaseMbid: "rel-stereo", status: "verified", confidence: 0.95 });
  providerMatches.upsertProviderReleaseMatch({ provider: "tidal", providerId: "prov-atmos", releaseMbid: "rel-atmos", status: "verified", confidence: 0.9 });

  assert.throws(
    () => providerMatches.setSlotSelection({
      releaseGroupMbid: "rg-1",
      slot: "stereo",
      releaseMbid: "rel-stereo",
      provider: "tidal",
      providerAlbumId: "prov-atmos",
    }),
    /does not match release/,
  );
});

test("setSlotSelection rejects an unknown slot and a release outside the group", () => {
  seedReleaseGroup();
  assert.throws(() => providerMatches.setSlotSelection({ releaseGroupMbid: "rg-1", slot: "bogus", releaseMbid: "rel-stereo" }), /unknown slot/);
  assert.throws(() => providerMatches.setSlotSelection({ releaseGroupMbid: "rg-1", slot: "stereo", releaseMbid: "rel-not-in-group" }), /not in release group/);
});
