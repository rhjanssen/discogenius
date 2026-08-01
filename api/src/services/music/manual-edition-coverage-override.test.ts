/**
 * When curation may overrule a manual edition choice — and when it may not.
 *
 * A manual edition choice is a preference, not a lock. The user picks the
 * standard over the deluxe and that stands, because the deluxe-only recordings
 * are usually obtainable some other way: as singles, on another edition, from
 * another provider. Curation should go and monitor those instead.
 *
 * It stops standing in exactly one case — the declined edition is the *only*
 * place those canonical recordings exist — and even then only while the album is
 * unlocked. A locked album keeps the user's choice and shows the gap.
 *
 * Scenario throughout:
 *
 *   Doom Days (standard)   tracks 1-2            ← what the user picked
 *   Doom Days (deluxe)     tracks 1-2 + 3-4      ← what curation would pick
 *   Quarter Past Midnight  a single carrying recording 3
 *   Another Place          a single carrying recording 4
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import { findUnreachableManualEditionChoices } from "./artist-coverage-optimizer.js";
import { LibraryCurationService } from "./library-curation-service.js";

const { tempDir } = prepareActiveSchemaEnv("manual-edition-coverage");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

const LIBRARY_ID = 1;
const ALBUM_ID = 1;
const STANDARD_EDITION_ID = 101;
const DELUXE_EDITION_ID = 102;
const SINGLE_THREE_EDITION_ID = 201;
const SINGLE_FOUR_EDITION_ID = 301;

/**
 * Canonical catalogue plus a provider offer for every edition, so provider
 * availability never decides these tests — only recording coverage does.
 *
 * Redundancy is on, which is the mode where curation picks one edition per album
 * rather than every eligible one. With it off there is nothing to overrule: the
 * deluxe would be monitored alongside the standard regardless.
 */
function seedCatalog(options: { withSingles: boolean }): void {
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-bastille', 'Bastille');
    INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1);
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (${ALBUM_ID}, 'rg-doom-days', 1, 'artist-bastille', 'Doom Days', 'Album');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid,
      title, status, country, date, media_count, track_count
    ) VALUES
      (${STANDARD_EDITION_ID}, 'edition-standard', ${ALBUM_ID}, 'rg-doom-days', 1,
       'artist-bastille', 'Doom Days', 'Official', 'XW', '2019-06-14', 1, 2),
      (${DELUXE_EDITION_ID}, 'edition-deluxe', ${ALBUM_ID}, 'rg-doom-days', 1,
       'artist-bastille', 'Doom Days (Deluxe)', 'Official', 'XW', '2019-11-01', 1, 4);
    INSERT INTO Recordings (id, mbid, title) VALUES
      (1, 'recording-1', 'Quarter Past Midnight'),
      (2, 'recording-2', 'Bad Decisions'),
      (3, 'recording-3', 'Doom Days'),
      (4, 'recording-4', 'Another Place');
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES
      (1, 'track-std-1', ${STANDARD_EDITION_ID}, 1, 'edition-standard', 'recording-1', 1, 1, 'Quarter Past Midnight'),
      (2, 'track-std-2', ${STANDARD_EDITION_ID}, 2, 'edition-standard', 'recording-2', 1, 2, 'Bad Decisions'),
      (3, 'track-dlx-1', ${DELUXE_EDITION_ID}, 1, 'edition-deluxe', 'recording-1', 1, 1, 'Quarter Past Midnight'),
      (4, 'track-dlx-2', ${DELUXE_EDITION_ID}, 2, 'edition-deluxe', 'recording-2', 1, 2, 'Bad Decisions'),
      (5, 'track-dlx-3', ${DELUXE_EDITION_ID}, 3, 'edition-deluxe', 'recording-3', 1, 3, 'Doom Days'),
      (6, 'track-dlx-4', ${DELUXE_EDITION_ID}, 4, 'edition-deluxe', 'recording-4', 1, 4, 'Another Place');
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 1);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'High Quality', '["lossless","hires-lossless"]', '["hires-lossless","lossless"]',
      'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
    );
    INSERT INTO Libraries (
      id, name, root_path, metadata_profile_id, quality_profile_id, enabled
    ) VALUES (${LIBRARY_ID}, 'Stereo', '/library/stereo', 1, 1, 1);
    INSERT INTO LibraryArtists (
      id, library_id, managed_artist_id, monitored, credited_scope
    ) VALUES (1, ${LIBRARY_ID}, 1, 1, 'primary_only');
  `);

  if (options.withSingles) {
    // Two singles carrying exactly the deluxe-only recordings.
    db.exec(`
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
      VALUES
        (2, 'rg-single-three', 1, 'artist-bastille', 'Doom Days (single)', 'Single'),
        (3, 'rg-single-four', 1, 'artist-bastille', 'Another Place (single)', 'Single');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid,
        title, status, country, date, media_count, track_count
      ) VALUES
        (${SINGLE_THREE_EDITION_ID}, 'edition-single-three', 2, 'rg-single-three', 1,
         'artist-bastille', 'Doom Days', 'Official', 'XW', '2019-05-01', 1, 1),
        (${SINGLE_FOUR_EDITION_ID}, 'edition-single-four', 3, 'rg-single-four', 1,
         'artist-bastille', 'Another Place', 'Official', 'XW', '2019-05-02', 1, 1);
      INSERT INTO Tracks (
        id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
        medium_position, position, title
      ) VALUES
        (7, 'track-single-3', ${SINGLE_THREE_EDITION_ID}, 3, 'edition-single-three', 'recording-3', 1, 1, 'Doom Days'),
        (8, 'track-single-4', ${SINGLE_FOUR_EDITION_ID}, 4, 'edition-single-four', 'recording-4', 1, 1, 'Another Place');
    `);
  }

  const editions: Array<[number, number[]]> = options.withSingles
    ? [
      [STANDARD_EDITION_ID, [1, 2]],
      [DELUXE_EDITION_ID, [3, 4, 5, 6]],
      [SINGLE_THREE_EDITION_ID, [7]],
      [SINGLE_FOUR_EDITION_ID, [8]],
    ]
    : [[STANDARD_EDITION_ID, [1, 2]], [DELUXE_EDITION_ID, [3, 4, 5, 6]]];
  for (const [editionId, trackIds] of editions) seedProviderOffer(editionId, trackIds);
}

/** One accepted, available, exact provider offer for an edition. */
function seedProviderOffer(editionId: number, trackIds: readonly number[]): void {
  const editionItemId = 10_000 + editionId;
  const editionMatchId = 20_000 + editionId;
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
    VALUES (?, 'tidal', 'release', ?, 'available')
  `).run(editionItemId, `provider-release-${editionId}`);
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, ?, ?, ?, 1, 1)
  `).run(editionMatchId, editionItemId, editionId,
    trackIds.length, trackIds.length, trackIds.length);

  trackIds.forEach((trackId, index) => {
    const trackItemId = 30_000 + editionId * 10 + index;
    const memberId = 40_000 + editionId * 10 + index;
    const recordingId = (db.prepare("SELECT recording_id FROM Tracks WHERE id = ?")
      .get(trackId) as { recording_id: number }).recording_id;
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
      VALUES (?, 'tidal', 'track', ?, 'available')
    `).run(trackItemId, `provider-track-${editionId}-${index}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, ?, 1, ?)
    `).run(memberId, editionItemId, trackItemId, index + 1);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(60_000 + editionId * 10 + index, trackItemId);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(50_000 + editionId * 10 + index, trackItemId, memberId, editionMatchId,
      trackId, recordingId);
  });
}

/** The user picks the standard edition, optionally locking the album. */
function chooseStandardManually(options: { locked: boolean }): void {
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'manual', ?, 'user', 1)
  `).run(LIBRARY_ID, ALBUM_ID, options.locked ? 1 : 0);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, reason, curation_version
    ) VALUES (?, ?, 'manual', 1, 'user', 1)
  `).run(LIBRARY_ID, STANDARD_EDITION_ID);
}

function curate(curationVersion = 2): void {
  new LibraryCurationService(db).curateLibrary({
    libraryId: LIBRARY_ID,
    curationVersion,
    acquisitionPlannerVersion: 1,
    providerPriority: ["tidal"],
  });
}

function monitoredEditionIds(): number[] {
  return (db.prepare(`
    SELECT edition_id FROM LibraryEditions WHERE library_id = ? ORDER BY edition_id
  `).all(LIBRARY_ID) as Array<{ edition_id: number }>).map(({ edition_id }) => edition_id);
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("recording identity decides, never track counts", () => {
  // Two editions, two tracks each, entirely different recordings. A numeric
  // test would call these interchangeable; they are not.
  const overrules = findUnreachableManualEditionChoices({
    albums: [{
      releaseGroupId: 1,
      chosenRecordingIds: new Set([1, 2]),
      alternativeRecordingIds: new Set([3, 4]),
    }],
    reachableRecordingIds: new Set(),
  });
  assert.deepEqual(overrules, [
    { releaseGroupId: 1, unreachableRecordingIds: [3, 4] },
  ]);
});

test("a choice that loses nothing is never overruled", () => {
  assert.deepEqual(
    findUnreachableManualEditionChoices({
      albums: [{
        releaseGroupId: 1,
        chosenRecordingIds: new Set([1, 2, 3]),
        alternativeRecordingIds: new Set([1, 2]),
      }],
      reachableRecordingIds: new Set(),
    }),
    [],
  );
});

test("recordings reachable elsewhere in the discography keep the choice", () => {
  assert.deepEqual(
    findUnreachableManualEditionChoices({
      albums: [{
        releaseGroupId: 1,
        chosenRecordingIds: new Set([1, 2]),
        alternativeRecordingIds: new Set([1, 2, 3, 4]),
      }],
      reachableRecordingIds: new Set([3, 4]),
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Through curation
// ---------------------------------------------------------------------------

test("the standard edition is retained when singles supply the deluxe-only recordings", () => {
  seedCatalog({ withSingles: true });
  chooseStandardManually({ locked: false });

  curate();

  assert.ok(monitoredEditionIds().includes(STANDARD_EDITION_ID),
    "the user's edition survives");
  assert.ok(!monitoredEditionIds().includes(DELUXE_EDITION_ID),
    "curation did not overrule it");
  // And the recordings it lacks are monitored some other way.
  assert.ok(monitoredEditionIds().includes(SINGLE_THREE_EDITION_ID));
  assert.ok(monitoredEditionIds().includes(SINGLE_FOUR_EDITION_ID));
  assert.equal(
    (db.prepare(`
      SELECT selection_mode FROM LibraryEditions
      WHERE library_id = ? AND edition_id = ?
    `).get(LIBRARY_ID, STANDARD_EDITION_ID) as { selection_mode: string }).selection_mode,
    "manual",
  );
});

test("the standard edition is overruled when only the deluxe carries the recordings", () => {
  seedCatalog({ withSingles: false });
  chooseStandardManually({ locked: false });

  curate();

  assert.ok(monitoredEditionIds().includes(DELUXE_EDITION_ID),
    "recordings 3 and 4 exist nowhere else, so the deluxe is restored");
});

test("overruling a manual choice is recorded, not silent", () => {
  seedCatalog({ withSingles: false });
  chooseStandardManually({ locked: false });

  curate();

  assert.equal(
    (db.prepare(`
      SELECT reason FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?
    `).get(LIBRARY_ID, ALBUM_ID) as { reason: string }).reason,
    "curation_override_unreachable_recordings",
  );
  assert.equal(
    (db.prepare(`
      SELECT reason FROM LibraryEditions WHERE library_id = ? AND edition_id = ?
    `).get(LIBRARY_ID, DELUXE_EDITION_ID) as { reason: string }).reason,
    "curation_override_unreachable_recordings",
  );
});

test("a locked album keeps the user's edition and shows the gap", () => {
  seedCatalog({ withSingles: false });
  chooseStandardManually({ locked: true });

  curate();

  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID],
    "a lock is unconditional; coverage does not argue with it");
  // The gap is real and visible: two canonical recordings of this album are
  // monitored nowhere.
  const monitoredRecordingIds = new Set(
    (db.prepare(`
      SELECT DISTINCT track.recording_id
      FROM LibraryEditions monitored_edition
      JOIN Tracks track ON track.album_edition_id = monitored_edition.edition_id
      WHERE monitored_edition.library_id = ?
    `).all(LIBRARY_ID) as Array<{ recording_id: number }>).map((row) => row.recording_id),
  );
  assert.deepEqual([...monitoredRecordingIds].sort((a, b) => a - b), [1, 2]);
});

test("an unrelated manual choice is not disturbed by another album's override", () => {
  seedCatalog({ withSingles: true });
  chooseStandardManually({ locked: false });
  // The user also pins one of the singles.
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, 2, 'manual', 0, 'user', 1)
  `).run(LIBRARY_ID);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, reason, curation_version
    ) VALUES (?, ?, 'manual', 1, 'user', 1)
  `).run(LIBRARY_ID, SINGLE_THREE_EDITION_ID);

  curate();

  assert.equal(
    (db.prepare(`
      SELECT selection_mode FROM LibraryEditions
      WHERE library_id = ? AND edition_id = ?
    `).get(LIBRARY_ID, SINGLE_THREE_EDITION_ID) as { selection_mode: string }).selection_mode,
    "manual",
  );
});
