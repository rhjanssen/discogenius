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

test("automatic curation keeps an edition that already has library files", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-curation-owned-"));
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
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-owned', 1, 'Owned')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (2, 'release-next', 1, 'Next')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (3, 'release-empty', 1, 'Empty')").run();
    const libraryArtistId = repository.upsertLibraryArtist({
      libraryId: libraries.stereoId,
      managedArtistId: 1,
      monitored: true,
      creditedScope: "release_and_track_credit",
    });
    const pass = (
      selected: number[],
      representative: number,
    ) => repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        representativeEditionIdByReleaseGroup: new Map([[1, representative]]),
        supplementalEditionIds: selected.filter((id) => id !== representative),
        selectedEditionIds: selected,
        selectedReleaseGroupIds: [1],
        attainableUnitIds: new Set(),
        decisions: [],
      },
      releaseGroupIdByReleaseId: new Map(selected.map((id) => [id, 1])),
      scopes: selected.map((editionId) => ({ editionId, libraryArtistId, scopeType: "primary" as const })),
      curationVersion: 1,
    });

    pass([1, 3], 1);
    db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (1, 'rec-1', 'Song')").run();
    db.prepare(`
      INSERT INTO TrackFiles (
        library_id, album_edition_id, recording_id,
        file_path, relative_path, filename, extension, file_class
      ) VALUES (?, 1, 1, '/library/owned.flac', 'owned.flac', 'owned.flac', 'flac', 'audio')
    `).run(libraries.stereoId);
    pass([2], 2);

    assert.deepEqual(db.prepare(`
      SELECT edition_id, representative
      FROM LibraryEditions
      WHERE library_id = ?
      ORDER BY edition_id
    `).all(libraries.stereoId), [
      { edition_id: 1, representative: 0 },
      { edition_id: 2, representative: 1 },
    ]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("automatic curation releases a file-owning edition whose recordings the selection covers", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-curation-owned-"));
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
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-owned', 1, 'Owned')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (2, 'release-next', 1, 'Next')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (3, 'release-empty', 1, 'Empty')").run();
    const libraryArtistId = repository.upsertLibraryArtist({
      libraryId: libraries.stereoId,
      managedArtistId: 1,
      monitored: true,
      creditedScope: "release_and_track_credit",
    });
    const pass = (
      selected: number[],
      representative: number,
      releasable: number[] = [],
    ) => repository.replaceAutomaticCuration({
      libraryId: libraries.stereoId,
      result: {
        representativeEditionIdByReleaseGroup: new Map([[1, representative]]),
        supplementalEditionIds: selected.filter((id) => id !== representative),
        selectedEditionIds: selected,
        selectedReleaseGroupIds: [1],
        attainableUnitIds: new Set(),
        decisions: [],
      },
      releaseGroupIdByReleaseId: new Map(selected.map((id) => [id, 1])),
      scopes: selected.map((editionId) => ({ editionId, libraryArtistId, scopeType: "primary" as const })),
      curationVersion: 1,
      releasableFileEditionIds: new Set(releasable),
    });

    pass([1, 3], 1);
    db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (1, 'rec-1', 'Song')").run();
    db.prepare(`
      INSERT INTO TrackFiles (
        library_id, album_edition_id, recording_id,
        file_path, relative_path, filename, extension, file_class
      ) VALUES (?, 1, 1, '/library/owned.flac', 'owned.flac', 'owned.flac', 'flac', 'audio')
    `).run(libraries.stereoId);
    pass([2], 2, [1]);

    assert.deepEqual(db.prepare(`
      SELECT edition_id, representative
      FROM LibraryEditions
      WHERE library_id = ?
      ORDER BY edition_id
    `).all(libraries.stereoId), [
      { edition_id: 2, representative: 1 },
    ]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
