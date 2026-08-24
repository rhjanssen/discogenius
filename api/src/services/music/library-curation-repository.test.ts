import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { LibraryCurationRepository } from "./library-curation-repository.js";

test("default Stereo and Spatial libraries are rows and curation preserves locks", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-curation-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    const repository = new LibraryCurationRepository(db);
    const libraries = repository.bootstrapDefaultLibraries({
      stereoRoot: "/library/stereo-music",
      spatialRoot: "/library/spatial-music",
      videoRoot: "/library/music-videos",
    });
    assert.notEqual(libraries.stereoId, libraries.spatialId);
    assert.notEqual(libraries.videoId, libraries.stereoId);
    assert.notEqual(libraries.videoId, libraries.spatialId);

    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A')").run();
    const libraryArtistId = repository.upsertLibraryArtist({
      libraryId: libraries.stereoId,
      managedArtistId: 1,
      monitored: true,
      creditedScope: "release_and_track_credit",
    });
    repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        representativeEditionIdByReleaseGroup: new Map([[1, 1]]),
        supplementalEditionIds: [],
        selectedEditionIds: [1],
        selectedReleaseGroupIds: [1],
        attainableUnitIds: new Set(),
        decisions: [],
      },
      releaseGroupIdByReleaseId: new Map([[1, 1]]),
      scopes: [{ editionId: 1, libraryArtistId, scopeType: "primary" }],
      curationVersion: 1,
    });
    db.prepare(`
      UPDATE LibraryEditions SET selection_mode = 'manual', reason = 'user'
      WHERE library_id = ? AND edition_id = 1
    `).run(libraries.stereoId);
    db.prepare(`
      UPDATE LibraryAlbums SET locked = 1 WHERE library_id = ? AND release_group_id = 1
    `).run(libraries.stereoId);
    repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        representativeEditionIdByReleaseGroup: new Map(),
        supplementalEditionIds: [],
        selectedEditionIds: [],
        selectedReleaseGroupIds: [],
        attainableUnitIds: new Set(),
        decisions: [],
      },
      releaseGroupIdByReleaseId: new Map(),
      scopes: [],
      curationVersion: 2,
    });
    assert.deepEqual(db.prepare(`
      SELECT edition_id, selection_mode, reason
      FROM LibraryEditions WHERE library_id = ?
    `).all(libraries.stereoId), [{
      edition_id: 1,
      selection_mode: "manual",
      reason: "user",
    }]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
