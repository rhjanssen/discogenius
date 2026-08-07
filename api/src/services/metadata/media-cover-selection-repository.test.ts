import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import {
  MediaCoverSelectionRepository,
  mediaCoverSelectionRevision,
} from "./media-cover-selection-repository.js";

test("media-cover provenance preserves manual authority and rejects supplemental replacement", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-cover-selection-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
    db.prepare(`
      INSERT INTO Albums (id, mbid, artist_metadata_id, title)
      VALUES (1, 'group-a', 1, 'Group A')
    `).run();

    const repository = new MediaCoverSelectionRepository(db);
    const canonical = repository.select({
      releaseGroupId: 1,
      sourceKind: "canonical",
      contentHash: "canonical-hash",
      sourceIdentity: "https://coverartarchive.org/release-group/group-a/front",
    });
    assert.equal(canonical.applied, true);
    assert.equal(canonical.selection.selectionRevision, mediaCoverSelectionRevision({
      sourceKind: "canonical",
      contentHash: "canonical-hash",
      sourceIdentity: "https://coverartarchive.org/release-group/group-a/front",
    }));

    const supplemental = repository.select({
      releaseGroupId: 1,
      sourceKind: "provider",
      contentHash: "single-cover-hash",
      sourceIdentity: "tidal:single-1",
      supplemental: true,
    });
    assert.deepEqual(
      { applied: supplemental.applied, reason: supplemental.applied ? null : supplemental.reason },
      { applied: false, reason: "supplemental-source" },
    );
    assert.equal(repository.get(1)?.sourceKind, "canonical");

    repository.select({
      releaseGroupId: 1,
      sourceKind: "manual",
      contentHash: "manual-hash",
      sourceIdentity: "manual-upload:cover.jpg",
    });
    const providerRefresh = repository.select({
      releaseGroupId: 1,
      sourceKind: "provider",
      contentHash: "provider-hash",
      sourceIdentity: "tidal:album-1",
    });
    assert.deepEqual(
      { applied: providerRefresh.applied, reason: providerRefresh.applied ? null : providerRefresh.reason },
      { applied: false, reason: "manual-authority" },
    );
    assert.equal(repository.get(1)?.sourceKind, "manual");

    assert.equal(repository.clearManual(1), true);
    assert.equal(repository.get(1), null);
    assert.equal(repository.clearManual(1), false);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
