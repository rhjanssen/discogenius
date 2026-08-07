import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { ProviderCatalogRepository } from "./provider-catalog-repository.js";

function fixture(run: (db: Database.Database, repository: ProviderCatalogRepository) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-catalog-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    run(db, new ProviderCatalogRepository(db));
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

test("provider track identity is reused across distinct release memberships", () => {
  fixture((db, repository) => {
    const releaseA = repository.upsertItem({ provider: "tidal", entityType: "release", providerId: "a" });
    const releaseB = repository.upsertItem({ provider: "tidal", entityType: "release", providerId: "b" });
    const track = repository.upsertItem({ provider: "tidal", entityType: "track", providerId: "t1" });
    repository.replaceReleaseMembers(releaseA, [{ memberItemId: track, mediumPosition: 1, position: 1 }]);
    repository.replaceReleaseMembers(releaseB, [{ memberItemId: track, mediumPosition: 1, position: 3 }]);
    repository.replaceReleaseMembers(releaseA, [{ memberItemId: track, mediumPosition: 1, position: 2 }]);

    const rows = db.prepare(`
      SELECT provider_edition_item_id, member_item_id, position
      FROM ProviderEditionMembers
      ORDER BY provider_edition_item_id
    `).all();
    assert.deepEqual(rows, [
      { provider_edition_item_id: releaseA, member_item_id: track, position: 2 },
      { provider_edition_item_id: releaseB, member_item_id: track, position: 3 },
    ]);
  });
});

test("refreshing unchanged membership preserves row identity regardless of input order", () => {
  fixture((db, repository) => {
    const release = repository.upsertItem({
      provider: "tidal",
      entityType: "release",
      providerId: "release",
    });
    const first = repository.upsertItem({
      provider: "tidal",
      entityType: "track",
      providerId: "first",
    });
    const second = repository.upsertItem({
      provider: "tidal",
      entityType: "track",
      providerId: "second",
    });
    const original = repository.replaceReleaseMembers(release, [
      { memberItemId: first, mediumPosition: 1, position: 1 },
      { memberItemId: second, mediumPosition: 1, position: 2 },
    ]);
    const refreshed = repository.replaceReleaseMembers(release, [
      { memberItemId: second, mediumPosition: 1, position: 2 },
      { memberItemId: first, mediumPosition: 1, position: 1 },
    ]);

    assert.deepEqual(refreshed, [original[1], original[0]]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ProviderEditionMembers")
        .get() as { count: number }).count,
      2,
    );
  });
});

test("ordered provider credits preserve supplied role and join phrase without inference", () => {
  fixture((db, repository) => {
    const release = repository.upsertItem({ provider: "apple-music", entityType: "release", providerId: "r" });
    const first = repository.upsertItem({ provider: "apple-music", entityType: "artist", providerId: "a1" });
    const second = repository.upsertItem({ provider: "apple-music", entityType: "artist", providerId: "a2" });
    repository.replaceCredits(release, [
      { artistItemId: first, ordinal: 0, creditedName: "First", normalizedRole: "primary" },
      {
        artistItemId: second,
        ordinal: 1,
        creditedName: "Second",
        joinPhrase: " feat. ",
        normalizedRole: "featured",
        providerRole: "featured-artist",
      },
    ]);
    assert.deepEqual(db.prepare(`
      SELECT ordinal, credited_name, join_phrase, normalized_role, provider_role
      FROM ProviderItemCredits WHERE item_id = ? ORDER BY ordinal
    `).all(release), [
      { ordinal: 0, credited_name: "First", join_phrase: "", normalized_role: "primary", provider_role: null },
      {
        ordinal: 1,
        credited_name: "Second",
        join_phrase: " feat. ",
        normalized_role: "featured",
        provider_role: "featured-artist",
      },
    ]);
  });
});

test("one Apple item stores several library-selectable audio variants", () => {
  fixture((db, repository) => {
    const track = repository.upsertItem({ provider: "apple-music", entityType: "track", providerId: "song" });
    repository.replaceAudioVariants(track, [
      { variantKey: "stereo-lossless", qualityClass: "lossless", lossless: true },
      { variantKey: "stereo-hires", qualityClass: "hires-lossless", lossless: true, bitDepth: 24 },
      { variantKey: "atmos", qualityClass: "spatial", spatialFormat: "dolby-atmos" },
    ]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ProviderItems").get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ProviderItemAudioVariants WHERE provider_item_id = ?")
        .get(track) as { count: number }).count,
      3,
    );
  });
});
