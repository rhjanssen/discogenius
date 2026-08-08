import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { LibraryCurationService } from "./library-curation-service.js";

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
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(trackMatchId, providerTrackItemId, memberId, releaseMatchId, trackId, recordingId);
  });
}

test("library curation uses canonical scope and recording coverage without changing ownership", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-curation-live-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name)
        VALUES (1, 'bastille', 'Bastille'), (2, 'collaborator', 'Collaborator');
      INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1);
      INSERT INTO Albums (id, mbid, artist_metadata_id, title, primary_type)
        VALUES
          (1, 'bad-blood', 1, 'Bad Blood', 'Album'),
          (2, 'laura-palmer', 1, 'Laura Palmer EP', 'EP'),
          (3, 'collaboration', 2, 'Collaboration', 'Single'),
          (4, 'unrelated', 2, 'Unrelated', 'Album');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title, status, media_count)
        VALUES
          (101, 'bad-blood-release', 1, 'Bad Blood', 'Official', 1),
          (201, 'laura-palmer-release', 2, 'Laura Palmer EP', 'Official', 1),
          (301, 'collaboration-release', 3, 'Collaboration', 'Official', 1),
          (401, 'unrelated-release', 4, 'Unrelated', 'Official', 1);
      INSERT INTO Recordings (id, mbid, title)
        VALUES
          (1, 'recording-1', 'Laura Palmer'),
          (2, 'recording-2', 'Pompeii'),
          (3, 'recording-3', 'Flaws'),
          (4, 'recording-4', 'Bad Blood'),
          (5, 'recording-5', 'Collaboration'),
          (6, 'recording-6', 'Unrelated');
      INSERT INTO Tracks (
        id, mbid, album_edition_id, recording_id, medium_position, position, title
      ) VALUES
        (1, 'bb-track-1', 101, 1, 1, 1, 'Laura Palmer'),
        (2, 'bb-track-2', 101, 2, 1, 2, 'Pompeii'),
        (3, 'bb-track-3', 101, 3, 1, 3, 'Flaws'),
        (4, 'bb-track-4', 101, 4, 1, 4, 'Bad Blood'),
        (5, 'lp-track-1', 201, 1, 1, 1, 'Laura Palmer'),
        (6, 'collab-track-1', 301, 5, 1, 1, 'Collaboration'),
        (7, 'unrelated-track-1', 401, 6, 1, 1, 'Unrelated');
      INSERT INTO ReleaseArtistCredits (
        edition_id, artist_id, ordinal, credited_name, join_phrase
      ) VALUES (301, 1, 1, 'Bastille', '');
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'High', '["lossless","hires-lossless"]',
        '["hires-lossless","lossless","lossy","spatial"]',
        'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id
      ) VALUES (1, 'Stereo', '/library/stereo', 1, 1);
      INSERT INTO LibraryArtists (
        id, library_id, managed_artist_id, monitored, credited_scope
      ) VALUES (1, 1, 1, 1, 'release_and_track_credit');
    `);
    seedProviderExactMatch(db, 101, [1, 2, 3, 4]);
    seedProviderExactMatch(db, 201, [5]);
    seedProviderExactMatch(db, 301, [6]);
    seedProviderExactMatch(db, 401, [7]);

    const service = new LibraryCurationService(db);
    // filtering.enable_redundancy_filter defaults to true, so a Laura Palmer EP
    // whose only recording is already on Bad Blood must not stay monitored —
    // the Ampersand-Part-One-inside-& case.
    const curated = service.curateLibrary({
      libraryId: 1,
      curationVersion: 1,
      acquisitionPlannerVersion: 1,
      providerPriority: ["tidal"],
    });
    assert.deepEqual(curated.selectedEditionIds, [101, 301]);
    assert.deepEqual(
      db.prepare(`
        SELECT release.edition_id, scope.scope_type
        FROM LibraryEditionScopes scope
        JOIN LibraryEditions release ON release.id = scope.library_edition_id
        ORDER BY release.edition_id
      `).all(),
      [
        { edition_id: 101, scope_type: "primary" },
        { edition_id: 301, scope_type: "release_credit" },
      ],
      "Covered EP drops while the credited collaboration remains in scope",
    );
    assert.equal(
      (db.prepare("SELECT artist_metadata_id FROM Albums WHERE id = 3").get() as {
        artist_metadata_id: number;
      }).artist_metadata_id,
      2,
      "Credited scope must not rewrite canonical release ownership",
    );
    // Plans are computed for every evaluated edition *before* curation picks
    // which ones to monitor, so the covered EP still has a plan row even though
    // it is not monitored.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlans").get() as { count: number }).count,
      3,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM LibraryEditions").get() as { count: number }).count,
      2,
      "only non-redundant editions stay monitored",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * A Release Group with a 1-track Edition and a 3-track Edition, where the
 * 3-track Edition can only be filled by a *composite* plan: no single provider
 * release covers it, but two of them together do.
 *
 * This is the Killing Me Softly With His Song (MTV Unplugged) case. Curation
 * used to measure attainability from the provider releases matched directly to
 * an Edition, which reports zero for a composite target — so the richer Edition
 * looked like it could deliver nothing and the 1-track sibling was picked as
 * the representative. Attainability now comes from the acquisition plans, which
 * is what acquisition will actually deliver.
 */
function seedCompositeOnlyEdition(db: Database.Database): void {
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
    INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1);
    INSERT INTO Albums (id, mbid, artist_metadata_id, title, primary_type)
      VALUES (1, 'group-a', 1, 'Unplugged Single', 'Single');
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, status, media_count)
      VALUES
        (101, 'one-track', 1, 'Unplugged Single', 'Official', 1),
        (103, 'three-track', 1, 'Unplugged Single', 'Official', 1);
    INSERT INTO Recordings (id, mbid, title) VALUES
      (1, 'recording-1', 'Killing Me Softly'),
      (2, 'recording-2', 'Second'),
      (3, 'recording-3', 'Third');
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
      VALUES
        (1, 'one-track-1', 101, 1, 1, 1, 'Killing Me Softly'),
        (11, 'three-track-1', 103, 1, 1, 1, 'Killing Me Softly'),
        (12, 'three-track-2', 103, 2, 1, 2, 'Second'),
        (13, 'three-track-3', 103, 3, 1, 3, 'Third');
    INSERT INTO MetadataProfiles (id, name, release_type_policy, redundancy_enabled)
      VALUES (1, 'Default', '{}', 0);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'High', '["lossless","hires-lossless"]',
      '["hires-lossless","lossless","lossy","spatial"]',
      'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
    );
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
      VALUES (1, 'Stereo', '/library/stereo', 1, 1);
    INSERT INTO LibraryArtists (id, library_id, managed_artist_id, monitored)
      VALUES (1, 1, 1, 1);
  `);

  // The only provider release matched to the 1-track edition covers recording 1.
  seedProviderExactMatch(db, 101, [1]);
  // Recordings 2 and 3 exist only on a provider release matched elsewhere in
  // the release group, so the 3-track edition is reachable by composite only.
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
    VALUES (11000, 'tidal', 'release', 'other-two-track', 'available')
  `).run();
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count, source_coverage, target_coverage
    ) VALUES (21000, 11000, 101, 'source_superset', 'accepted', 'automatic', 0.9, 'fixture', 1, 2, 2, 1, 1, 1)
  `).run();
  [2, 3].forEach((recordingId, index) => {
    const itemId = 31000 + index;
    const memberId = 41000 + index;
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
      VALUES (?, 'tidal', 'track', ?, 'available')
    `).run(itemId, `other-track-${recordingId}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, medium_position, position)
      VALUES (?, 11000, ?, 1, ?)
    `).run(memberId, itemId, index + 1);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
      VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(61000 + index, itemId);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, 21000, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(51000 + index, itemId, memberId, 11 + index + 1, recordingId);
  });
}

test("a composite-only edition is preferred over a sibling it strictly covers", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-composite-representative-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    seedCompositeOnlyEdition(db);

    const curated = new LibraryCurationService(db).curateLibrary({
      libraryId: 1,
      curationVersion: 1,
      acquisitionPlannerVersion: 1,
      providerPriority: ["tidal"],
    });

    assert.equal(
      (db.prepare("SELECT coverage FROM AcquisitionPlans WHERE edition_id = 103 AND rank = 0")
        .get() as { coverage: number } | undefined)?.coverage,
      3,
      "the 3-track edition must have a full composite plan for the case to mean anything",
    );
    assert.deepEqual(
      curated.selectedEditionIds,
      [103],
      "the edition that covers all three recordings is the one to monitor",
    );
    assert.equal(
      curated.representativeEditionIdByReleaseGroup.get(1),
      103,
      "attainability must reflect what the acquisition plan delivers, not just directly matched provider releases",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
