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
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, country) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("rel-stereo", "rg-1", "artist-mbid-1", "A Night at the Opera", "1975-11-21", "GB");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, country) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("rel-atmos", "rg-1", "artist-mbid-1", "A Night at the Opera (Dolby Atmos)", "2022-01-01", "US");
  // Provider album offers (ProviderItems) backing the two releases.
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-stereo', 'LOSSLESS', 'stereo', 'rg-1', 'rel-stereo')`).run();
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, quality, library_slot, release_group_mbid, release_mbid)
              VALUES ('tidal', 'album', 'prov-atmos', 'DOLBY_ATMOS', 'spatial', 'rg-1', 'rel-atmos')`).run();
}

beforeEach(() => {
  const { db } = dbModule;
  for (const t of ["ProviderMatches", "ProviderItems", "ReleaseGroupSlots", "AlbumReleases", "Albums", "ArtistMetadata"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

test("fresh database has the additive ProviderMatches table", () => {
  const row = dbModule.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMatches'`,
  ).get() as { name?: string } | undefined;
  assert.equal(row?.name, "ProviderMatches");
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
    `SELECT status, confidence FROM ProviderMatches WHERE provider='tidal' AND provider_id='prov-stereo' AND target_mbid='rel-stereo'`,
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
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM ProviderMatches WHERE provider_id='prov-stereo'`).get() as { n: number }).n;
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
