import { after } from "node:test";
/**
 * Files on disk and automatic curation: a compilation the discography fully
 * covers is unmonitored, and so is a redundant edition of a kept album.
 * Whether the files are deleted is the coverage policy, not this selection.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";
const { tempDir: activeTempDir } = prepareActiveSchemaEnv("curation-files-active");
const activeDbModule = await import("../../database.js");
const { createBaselineSchemaV41 } = activeDbModule;
after(() => closeActiveSchemaDb(activeDbModule, activeTempDir));
import { releaseStatusPreferenceRank } from "../metadata/musicbrainz-release-group-filter.js";
const { LibraryCurationService } = await import("./library-curation-service.js");
type LibraryCurationService = InstanceType<typeof LibraryCurationService>;

/**
 * One accepted provider offer per canonical track, so every Edition has a
 * plan and status is the only thing deciding candidacy. Same shape as the
 * curation-service fixture.
 */
function seedProviderExactMatch(
  db: Database.Database,
  editionId: number,
  trackIds: readonly number[],
): void {
  const providerEditionItemId = 10_000 + editionId;
  const releaseMatchId = 20_000 + editionId;
  db.prepare(`
    INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id, availability
    ) VALUES (?, 'tidal', 'release', ?, 'available')
  `).run(providerEditionItemId, `release-${editionId}`);
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, ?, ?, ?, 1, 1)
  `).run(
    releaseMatchId,
    providerEditionItemId,
    editionId,
    trackIds.length,
    trackIds.length,
    trackIds.length,
  );
  trackIds.forEach((trackId, index) => {
    const providerTrackItemId = 30_000 + editionId * 10 + index;
    const memberId = 40_000 + editionId * 10 + index;
    const trackMatchId = 50_000 + editionId * 10 + index;
    const recordingId = (db.prepare("SELECT recording_id FROM Tracks WHERE id = ?")
      .get(trackId) as { recording_id: number }).recording_id;
    db.prepare(`
      INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id, availability
    ) VALUES (?, 'tidal', 'track', ?, 'available')
    `).run(providerTrackItemId, `track-${editionId}-${index + 1}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, ?, 1, ?)
    `).run(memberId, providerEditionItemId, providerTrackItemId, index + 1);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(60_000 + editionId * 10 + index, providerTrackItemId);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', ${PROVIDER_TRACK_MATCHER_VERSION})
    `).run(trackMatchId, providerTrackItemId, memberId, releaseMatchId, trackId, recordingId);
  });
}

function seed(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  createBaselineSchemaV41(db);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'supremes', 'The Supremes');
    WITH fixture(id,mbid,title,primary_type,secondary_types) AS (VALUES
        (1, 'studio', 'Where Did Our Love Go', 'Album', NULL),
        (2, 'gold', 'Gold', 'Album', '["Compilation"]'))
      INSERT INTO Albums (id,mbid,artist_metadata_id,title,primary_type,secondary_types,artist_mbid)
      SELECT id,mbid,1,title,primary_type,secondary_types,'supremes' FROM fixture;
    WITH fixture(id,mbid,release_group_id,title) AS (VALUES
        (101, 'studio-a', 1, 'Where Did Our Love Go'),
        (102, 'studio-b', 1, 'Where Did Our Love Go'),
        (201, 'gold-a', 2, 'Gold'))
      INSERT INTO AlbumEditions (id,mbid,release_group_id,title,status,media_count,release_group_mbid,artist_mbid)
      SELECT id,mbid,release_group_id,title,'Official',1,(SELECT mbid FROM Albums WHERE id=release_group_id),'supremes' FROM fixture;
    INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (1, 'rec-1', 'Baby Love', 158000);
    WITH fixture(id,mbid,album_edition_id) AS (VALUES (1,'t-101',101),(2,'t-102',102),(3,'t-201',201))
      INSERT INTO Tracks (id,mbid,album_edition_id,recording_id,medium_position,position,title,release_mbid,recording_mbid)
      SELECT id,mbid,album_edition_id,1,1,1,'Baby Love',(SELECT mbid FROM AlbumEditions WHERE id=album_edition_id),'rec-1' FROM fixture;
    INSERT INTO MetadataProfiles (id, name, release_type_policy, redundancy_enabled) VALUES (1, 'Default', '{}', 1);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'High', '["lossless","hires-lossless"]', '["hires-lossless","lossless","lossy","spatial"]',
      'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve');
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id) VALUES (1, 'Stereo', '/library/stereo', 1, 1);
    INSERT INTO LibraryArtists (id, library_id, artist_metadata_id, policy, credited_scope) VALUES (1, 1, 1, 'all', 'release_and_track_credit');
  `);
  for (const [editionId, trackId] of [[101, 1], [102, 2], [201, 3]]) seedProviderExactMatch(db, editionId, [trackId]);
}

function withLibrary(run: (db: Database.Database, service: LibraryCurationService) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-curation-files-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    seed(db);
    run(db, new LibraryCurationService(db));
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

const curate = (service: LibraryCurationService) => service.curateLibrary({
  libraryId: 1, curationVersion: 1, acquisitionPlannerVersion: 1, providerPriority: ["tidal"],
});

const monitored = (db: Database.Database) => (db.prepare(
  "SELECT edition_id FROM LibraryEditions WHERE library_id = 1 ORDER BY edition_id",
).all() as Array<{ edition_id: number }>).map((row) => row.edition_id);

function giveFilesAndMonitor(db: Database.Database, editionIds: number[]): void {
  for (const editionId of editionIds) {
    db.prepare(`INSERT OR IGNORE INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
      VALUES (1, ?, 'auto', 0, 'fixture', 1)`).run(editionId);
    db.prepare(`INSERT INTO TrackFiles (library_id, library_root, album_edition_id, recording_id, file_path, relative_path, filename, extension, file_class, file_type)
      VALUES (1, '/library/stereo', ?, 1, ?, ?, ?, 'flac', 'audio', 'track')`).run(editionId, `/library/stereo/${editionId}.flac`, `${editionId}.flac`, `${editionId}.flac`);
  }
}

test("a covered compilation and a redundant studio edition are unmonitored even with files", () => {
  withLibrary((db, service) => {
    curate(service);
    const chosen = monitored(db).filter((id) => id === 101 || id === 102);
    assert.equal(chosen.length, 1, "one studio edition is the representative");
    const other = chosen[0] === 101 ? 102 : 101;
    giveFilesAndMonitor(db, [other, 201]);

    curate(service);

    const after = monitored(db);
    assert.ok(!after.includes(201), "the compilation the studio album covers is unmonitored");
    assert.ok(!after.includes(other), "the redundant studio edition is unmonitored even though it has files");
    assert.ok(after.includes(chosen[0]), "the representative stays monitored");
  });
});
