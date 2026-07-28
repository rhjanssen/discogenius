import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { LibraryCurationRepository } from "./library-curation-repository.js";

test("default Stereo and Spatial libraries are rows and curation preserves locks", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-curation-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    const repository = new LibraryCurationRepository(db);
    const libraries = repository.bootstrapDefaultLibraries({
      stereoRoot: "/library/stereo-music",
      spatialRoot: "/library/spatial-music",
    });
    assert.notEqual(libraries.stereoId, libraries.spatialId);

    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
    db.prepare("INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1)").run();
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A')").run();
    db.prepare("INSERT INTO AlbumReleases (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A')").run();
    const libraryArtistId = repository.upsertLibraryArtist({
      libraryId: libraries.stereoId,
      managedArtistId: 1,
      monitored: true,
      creditedScope: "release_and_track_credit",
    });
    repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        baselineReleaseIds: [1],
        selectedReleaseIds: [1],
        attainableRecordingIds: new Set(),
      },
      releaseGroupIdByReleaseId: new Map([[1, 1]]),
      scopes: [{ releaseId: 1, libraryArtistId, scopeType: "primary" }],
      curationVersion: 1,
    });
    db.prepare(`
      UPDATE LibraryReleases SET locked = 1, selection_mode = 'manual', reason = 'user'
      WHERE library_id = ? AND release_id = 1
    `).run(libraries.stereoId);
    repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        baselineReleaseIds: [],
        selectedReleaseIds: [],
        attainableRecordingIds: new Set(),
      },
      releaseGroupIdByReleaseId: new Map(),
      scopes: [],
      curationVersion: 2,
    });
    assert.deepEqual(db.prepare(`
      SELECT release_id, selection_mode, locked, reason
      FROM LibraryReleases WHERE library_id = ?
    `).all(libraries.stereoId), [{
      release_id: 1,
      selection_mode: "manual",
      locked: 1,
      reason: "user",
    }]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
