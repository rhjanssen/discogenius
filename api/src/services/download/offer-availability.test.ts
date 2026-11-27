import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-offer-availability-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.offer-availability.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_OFFER_FAILURE_THRESHOLD = "3";

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
const {
  assessOfferDownloadFailure,
  countDownloadBugOffers,
  releaseUnconfirmedDownloadUnavailability,
} = await import("./offer-availability.js");

function insertTrack(providerId: string, availability = "available", reason: string | null = null): void {
  db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability, availability_reason)
    VALUES ('apple-music', 'track', ?, 'Song', ?, ?)
  `).run(providerId, availability, reason);
}

function availabilityOf(providerId: string): { availability: string; availability_reason: string | null } {
  return db.prepare(`
    SELECT availability, availability_reason FROM ProviderItems
    WHERE provider = 'apple-music' AND entity_type = 'track' AND provider_id = ?
  `).get(providerId) as { availability: string; availability_reason: string | null };
}

test("a ripper Unavailable line stays retryable until a preview check fails", async () => {
  insertTrack("confirmed");
  insertTrack("bug");
  const error = new Error("Failed to dl aac-lc: Unavailable");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await assessOfferDownloadFailure(db, {
      provider: "apple-music",
      entityType: "track",
      providerId: "confirmed",
      error,
      probe: async () => "unavailable",
    });
    assert.equal(result.markedUnavailable, false);
    assert.equal(availabilityOf("confirmed").availability, "available");
  }

  const marked = await assessOfferDownloadFailure(db, {
    provider: "apple-music",
    entityType: "track",
    providerId: "confirmed",
    error,
    probe: async () => "unavailable",
  });
  assert.equal(marked.markedUnavailable, true);
  assert.match(availabilityOf("confirmed").availability_reason || "", /^Confirmed unavailable:/);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await assessOfferDownloadFailure(db, {
      provider: "apple-music",
      entityType: "track",
      providerId: "bug",
      error,
      probe: async () => "playable",
    });
    assert.equal(result.markedUnavailable, false);
    assert.equal(result.downloadBug, attempt === 2);
  }
  assert.equal(availabilityOf("bug").availability, "available");
  assert.equal(countDownloadBugOffers(db), 1);

  const released = await releaseUnconfirmedDownloadUnavailability(db);
  assert.equal(released.items, 0, "a preview-confirmed mark is not cleared");
  assert.equal(availabilityOf("confirmed").availability, "unavailable");
});

test("network failures never count toward an unavailable mark", async () => {
  insertTrack("net");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await assessOfferDownloadFailure(db, {
      provider: "apple-music",
      entityType: "track",
      providerId: "net",
      error: new Error("ECONNRESET"),
      probe: async () => "unavailable",
    });
    assert.equal(result.count, 0);
    assert.equal(result.markedUnavailable, false);
  }
  assert.equal(availabilityOf("net").availability, "available");
});

test("startup clear drops ripper unavailable marks and keeps catalog policy marks", async () => {
  insertTrack("ripper", "unavailable", "Failed to dl aac-lc: Unavailable");
  db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability, availability_reason)
    VALUES ('soundcloud', 'release', 'drm-1', 'DRM', 'unavailable', 'drm-only')
  `).run();
  db.prepare(`
    INSERT INTO config (key, value, description) VALUES ('download.offer_failure.apple-music.track.ripper', '{"count":2}', 'streak')
  `).run();

  const released = await releaseUnconfirmedDownloadUnavailability(db);
  assert.equal(released.items, 1);
  assert.equal(released.streaks, 1);
  assert.equal(availabilityOf("ripper").availability, "available");
  assert.equal(availabilityOf("ripper").availability_reason, null);
  const drm = db.prepare(`
    SELECT availability, availability_reason FROM ProviderItems
    WHERE provider = 'soundcloud' AND provider_id = 'drm-1'
  `).get() as { availability: string; availability_reason: string };
  assert.equal(drm.availability, "unavailable");
  assert.equal(drm.availability_reason, "drm-only");
});

test.after(() => {
  databaseModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
