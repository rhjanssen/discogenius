/**
 * Job 16. These assertions fail on 95475504:
 * - curation off unmonitors a second monitored edition (the planner keeps one);
 * - user unmonitor leaves no marker, so the next pass monitors the album again;
 * - prune deletes an unmonitored file that no monitored edition covers;
 * - a stale file-owning edition is the one curation keeps, and the current
 *   edition of the same recording is dropped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
  seedLibraryArtistMonitoring,
} from "../../test-support/active-schema-fixture.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";

const { tempDir } = prepareActiveSchemaEnv("library-curation-decisions");
const { db, dbModule } = await openActiveSchemaDb();
const { LibraryCurationService } = await import("./library-curation-service.js");
const { LibraryFilesService } = await import("../mediafiles/library-files.js");
const { unmonitorAlbumInLibraries } = await import("./library-album-monitoring.js");
const { updateConfig } = await import("../config/config.js");
const { ACQUISITION_PLANNER_VERSION } = await import("./acquisition-planning-service.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

function libraryId(): number {
  return (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo' AND enabled = 1").get() as { id: number }).id;
}

function reset() {
  resetActiveSchemaRows(db);
  for (const table of ["TrackFiles", "LibraryUserExclusions", "LibraryCurationOutcomes", "ProviderTrackMatches"]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* optional */ }
  }
  updateConfig("filtering", { enable_redundancy_filter: true });
  updateConfig("monitoring", { remove_unmonitored_files: false });
}

function seedArtist(mbid: string, name: string): number {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(mbid, name);
  seedLibraryArtistMonitoring(db, mbid);
  return (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(mbid) as { id: number }).id;
}

function seedAlbum(input: {
  id: number;
  mbid: string;
  artistId: number;
  artistMbid: string;
  title: string;
  secondary?: string;
}): void {
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, title, artist_mbid, primary_type, secondary_types)
    VALUES (?, ?, ?, ?, ?, 'Album', ?)
  `).run(input.id, input.mbid, input.artistId, input.title, input.artistMbid, input.secondary ?? null);
}

function seedEdition(input: {
  id: number;
  mbid: string;
  albumId: number;
  albumMbid: string;
  artistMbid: string;
  title: string;
  monitored?: boolean;
  representative?: boolean;
}): void {
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Official')
  `).run(input.id, input.mbid, input.albumId, input.title, input.albumMbid, input.artistMbid);
  if (input.monitored) {
    db.prepare(`
      INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, curation_version)
      VALUES (?, ?, 'auto', 0, 1)
      ON CONFLICT(library_id, release_group_id) DO NOTHING
    `).run(libraryId(), input.albumId);
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
      VALUES (?, ?, 'auto', ?, 'fixture', 1)
    `).run(libraryId(), input.id, input.representative ? 1 : 0);
  }
}

function seedTrack(editionId: number, trackId: number, recordingId: number, title: string): void {
  const edition = db.prepare("SELECT mbid FROM AlbumEditions WHERE id = ?").get(editionId) as { mbid: string };
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (?, ?, ?, 180000)
    ON CONFLICT(id) DO NOTHING
  `).run(recordingId, `rec-${recordingId}`, title);
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms,
      release_mbid, recording_mbid
    ) VALUES (?, ?, ?, ?, 1, 1, ?, 180000, ?, ?)
  `).run(trackId, `track-${trackId}`, editionId, recordingId, title, edition.mbid, `rec-${recordingId}`);
}

function seedMatch(editionId: number, trackId: number, recordingId: number, matcherVersion: number): void {
  const itemId = 100000 + trackId;
  const releaseItemId = 200000 + editionId;
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
    VALUES (?, 'tidal', 'release', ?, 'Release', 'available')
    ON CONFLICT(id) DO NOTHING
  `).run(releaseItemId, `release-${editionId}`);
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', ?, 1, 1, 1, 1, 1)
    ON CONFLICT(id) DO NOTHING
  `).run(releaseItemId, releaseItemId, editionId, matcherVersion);
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, duration_ms, availability)
    VALUES (?, 'tidal', 'track', ?, 'Track', 180000, 'available')
    ON CONFLICT(id) DO NOTHING
  `).run(itemId, `track-item-${trackId}`);
  db.prepare(`
    INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, ?, 1, 1)
    ON CONFLICT(id) DO NOTHING
  `).run(itemId, releaseItemId, itemId);
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
    VALUES (?, ?, 'lossless', 'lossless', 'available')
    ON CONFLICT(id) DO NOTHING
  `).run(itemId, itemId);
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
      track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', ?)
  `).run(itemId, itemId, itemId, releaseItemId, trackId, recordingId, matcherVersion);
}

function seedFile(input: {
  artistId: number;
  albumId: number;
  editionId: number;
  recordingId: number;
  name: string;
}): string {
  const filePath = `${tempDir}/${input.name}.flac`;
  fs.writeFileSync(filePath, input.name);
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, album_edition_id, recording_id,
      library_id, library_slot, library_root, file_path, relative_path, filename, extension,
      file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'audio')
  `).run(
    input.artistId, input.albumId, input.editionId, input.recordingId, libraryId(),
    tempDir, filePath, `${input.name}.flac`, `${input.name}.flac`,
  );
  return filePath;
}

function monitoredEditions(): number[] {
  return (db.prepare("SELECT edition_id FROM LibraryEditions WHERE library_id = ? ORDER BY edition_id")
    .all(libraryId()) as Array<{ edition_id: number }>).map((row) => row.edition_id);
}

function curate(): void {
  new LibraryCurationService(db).curateLibrary({
    libraryId: libraryId(),
    providerPriority: ["tidal"],
    acquisitionPlannerVersion: ACQUISITION_PLANNER_VERSION,
    curationVersion: 2,
  });
}

beforeEach(reset);

test("automatic curation off keeps every edition the library already monitors", () => {
  updateConfig("filtering", { enable_redundancy_filter: false });
  const artistId = seedArtist("artist-plain", "Plain");
  seedAlbum({ id: 1, mbid: "rg-plain", artistId, artistMbid: "artist-plain", title: "Plain" });
  seedEdition({ id: 11, mbid: "ed-a", albumId: 1, albumMbid: "rg-plain", artistMbid: "artist-plain", title: "A", monitored: true, representative: true });
  seedEdition({ id: 12, mbid: "ed-b", albumId: 1, albumMbid: "rg-plain", artistMbid: "artist-plain", title: "B", monitored: true });
  seedTrack(11, 111, 501, "Song");
  seedTrack(12, 112, 501, "Song");
  seedMatch(11, 111, 501, PROVIDER_TRACK_MATCHER_VERSION);
  seedMatch(12, 112, 501, PROVIDER_TRACK_MATCHER_VERSION);

  curate();

  assert.deepEqual(monitoredEditions(), [11, 12]);
});

test("a user unmonitor is skipped by the next curation pass", () => {
  const artistId = seedArtist("artist-exclude", "Exclude");
  seedAlbum({ id: 2, mbid: "rg-exclude", artistId, artistMbid: "artist-exclude", title: "Exclude" });
  seedEdition({ id: 21, mbid: "ed-exclude", albumId: 2, albumMbid: "rg-exclude", artistMbid: "artist-exclude", title: "Exclude", monitored: true, representative: true });
  seedTrack(21, 211, 502, "Song");
  seedMatch(21, 211, 502, PROVIDER_TRACK_MATCHER_VERSION);
  curate();
  assert.deepEqual(monitoredEditions(), [21]);

  unmonitorAlbumInLibraries(db, 2, [libraryId()], { actor: "user" });
  curate();

  assert.deepEqual(monitoredEditions(), []);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM LibraryUserExclusions
    WHERE release_group_id = 2 AND edition_id IS NULL
  `).get() as { n: number }).n, 1);
});

test("coverage deletes only a file whose recording is already on a monitored edition", () => {
  updateConfig("monitoring", { remove_unmonitored_files: true });
  const artistId = seedArtist("artist-files", "Files");
  seedAlbum({ id: 3, mbid: "rg-files", artistId, artistMbid: "artist-files", title: "Files" });
  seedEdition({ id: 31, mbid: "ed-kept", albumId: 3, albumMbid: "rg-files", artistMbid: "artist-files", title: "Kept", monitored: true, representative: true });
  seedEdition({ id: 32, mbid: "ed-extra", albumId: 3, albumMbid: "rg-files", artistMbid: "artist-files", title: "Extra" });
  db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (601, 'rec-601', 'Same'), (602, 'rec-602', 'Other')").run();
  const covered = seedFile({ artistId, albumId: 3, editionId: 31, recordingId: 601, name: "covered-kept" });
  const same = seedFile({ artistId, albumId: 3, editionId: 32, recordingId: 601, name: "covered-extra" });
  const other = seedFile({ artistId, albumId: 3, editionId: 32, recordingId: 602, name: "other-extra" });

  const pruned = LibraryFilesService.pruneUnmonitoredFiles("artist-files");
  assert.equal(fs.existsSync(covered), true);
  assert.equal(fs.existsSync(same), false);
  assert.equal(fs.existsSync(other), true);
  assert.equal(pruned.deleted, 1);

  LibraryFilesService.pruneUnmonitoredForReleaseGroup("rg-files", { immediate: true, editionIds: [32] });
  assert.equal(fs.existsSync(other), false, "a user unmonitor deletes that edition without waiting for coverage");
  assert.equal(fs.existsSync(covered), true);
});

test("Private Investigations keeps a stale edition and drops a current redundant one", () => {
  updateConfig("monitoring", { remove_unmonitored_files: true });
  const artistId = seedArtist("artist-pi", "Dire Straits");
  seedAlbum({
    id: 4,
    mbid: "220dac35-0000-4000-8000-000000000001",
    artistId,
    artistMbid: "artist-pi",
    title: "Private Investigations",
    secondary: JSON.stringify(["Compilation"]),
  });
  seedEdition({
    id: 41, mbid: "ff43340e-0000-4000-8000-000000000001", albumId: 4,
    albumMbid: "220dac35-0000-4000-8000-000000000001", artistMbid: "artist-pi",
    title: "Stale", monitored: true,
  });
  seedEdition({
    id: 42, mbid: "bbb594a7-0000-4000-8000-000000000001", albumId: 4,
    albumMbid: "220dac35-0000-4000-8000-000000000001", artistMbid: "artist-pi",
    title: "Selected", monitored: true, representative: true,
  });
  seedEdition({
    id: 43, mbid: "fe7f3a34-0000-4000-8000-000000000001", albumId: 4,
    albumMbid: "220dac35-0000-4000-8000-000000000001", artistMbid: "artist-pi",
    title: "Redundant", monitored: true,
  });
  seedTrack(41, 411, 701, "Private Investigations");
  seedTrack(42, 412, 701, "Private Investigations");
  seedTrack(43, 413, 701, "Private Investigations");
  seedMatch(41, 411, 701, PROVIDER_TRACK_MATCHER_VERSION - 1);
  seedMatch(42, 412, 701, PROVIDER_TRACK_MATCHER_VERSION);
  seedMatch(43, 413, 701, PROVIDER_TRACK_MATCHER_VERSION);
  const staleFile = seedFile({ artistId, albumId: 4, editionId: 41, recordingId: 701, name: "pi-stale" });
  const keptFile = seedFile({ artistId, albumId: 4, editionId: 42, recordingId: 701, name: "pi-kept" });
  const redundantFile = seedFile({ artistId, albumId: 4, editionId: 43, recordingId: 701, name: "pi-redundant" });

  curate();
  const after = monitoredEditions();
  assert.ok(after.includes(41), "a stale automatic match keeps the edition monitored");
  assert.ok(after.includes(42) || after.includes(43));
  assert.equal(after.includes(42) && after.includes(43), false, "one current edition covers the recording");

  LibraryFilesService.pruneUnmonitoredFiles("artist-pi");
  assert.equal(fs.existsSync(staleFile), true, "stale-match files are not deleted");
  assert.equal(fs.existsSync(keptFile) || fs.existsSync(redundantFile), true);
  const dropped = after.includes(42) ? redundantFile : keptFile;
  assert.equal(fs.existsSync(dropped), false, "the current redundant file goes once the recording is covered");
});
