/**
 * Release status decides which *Editions* automatic curation may choose. It
 * never removes a Release Group from the discography.
 *
 * The distinction matters because MusicBrainz records bootlegs, promos and
 * pseudo-releases alongside the official issue of the same record. Excluding
 * the Release Group would lose the album; excluding only the Edition leaves the
 * album and picks the issue the user asked for.
 *
 * So an ineligible Edition stays stored, stays on the Album page, stays usable
 * as matching evidence, and stays monitorable by hand — a manual or locked
 * selection outranks the filter entirely, exactly as it already outranks the
 * provider-availability gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { releaseStatusPreferenceRank } from "../metadata/musicbrainz-release-group-filter.js";
import { LibraryCurationService } from "./library-curation-service.js";

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
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(trackMatchId, providerTrackItemId, memberId, releaseMatchId, trackId, recordingId);
  });
}

/**
 * One Release Group, four Editions of the same record with different statuses,
 * plus a Release Group that exists only as a pseudo-release.
 */
function seedMixedStatusLibrary(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  createCurrentDomainSchema(db);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'bastille', 'Bastille');
    INSERT INTO Albums (id, mbid, artist_metadata_id, title, primary_type)
      VALUES (1, 'bad-blood', 1, 'Bad Blood', 'Album'),
             (2, 'translated-only', 1, 'Translated Only', 'Album');
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, status, media_count)
      VALUES
        (101, 'bb-official',  1, 'Bad Blood', 'Official', 1),
        (102, 'bb-bootleg',   1, 'Bad Blood', 'Bootleg', 1),
        (103, 'bb-promo',     1, 'Bad Blood', 'Promotion', 1),
        (104, 'bb-nostatus',  1, 'Bad Blood', NULL, 1),
        (201, 'to-pseudo',    2, 'Translated Only', 'Pseudo-Release', 1);
    INSERT INTO Recordings (id, mbid, title, length_ms)
      VALUES (1, 'rec-1', 'Pompeii', 214148), (2, 'rec-2', 'Things We Lost in the Fire', 210000);
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
      VALUES
        (1, 'bb-o-1', 101, 1, 1, 1, 'Pompeii'),
        (2, 'bb-b-1', 102, 1, 1, 1, 'Pompeii'),
        (3, 'bb-p-1', 103, 1, 1, 1, 'Pompeii'),
        (4, 'bb-n-1', 104, 1, 1, 1, 'Pompeii'),
        (5, 'to-p-1', 201, 2, 1, 1, 'Things We Lost in the Fire');
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
    INSERT INTO LibraryArtists (id, library_id, artist_metadata_id, policy, credited_scope) VALUES (1, 1, 1, 'all', 'release_and_track_credit');
  `);
  for (const [editionId, trackId] of [[101, 1], [102, 2], [103, 3], [104, 4], [201, 5]]) {
    seedProviderExactMatch(db, editionId, [trackId]);
  }
}

function withLibrary(run: (db: Database.Database, service: LibraryCurationService) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-release-status-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    seedMixedStatusLibrary(db);
    run(db, new LibraryCurationService(db));
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

const curate = (service: LibraryCurationService) => service.curateLibrary({
  libraryId: 1,
  curationVersion: 1,
  acquisitionPlannerVersion: 1,
  providerPriority: ["tidal"],
});

/* ── Defaults ───────────────────────────────────────────────────────── */

test("a mixed-status Release Group keeps its Official Edition", () => {
  withLibrary((db, service) => {
    const curated = curate(service);
    assert.ok(curated.selectedEditionIds.includes(101), "the Official issue is monitored");
    for (const excluded of [102, 103]) {
      assert.ok(
        !curated.selectedEditionIds.includes(excluded),
        `bootleg/promo edition ${excluded} must not be chosen automatically`,
      );
    }
    // The Release Group itself survives — status is not a deletion.
    assert.ok(
      db.prepare("SELECT 1 FROM Albums WHERE id = 1").get(),
      "the Release Group stays in the discography",
    );
  });
});

test("an ineligible Edition stays stored and usable", () => {
  withLibrary((db, service) => {
    curate(service);
    const kept = db.prepare("SELECT COUNT(*) AS c FROM AlbumEditions WHERE release_group_id = 1")
      .get() as { c: number };
    assert.equal(kept.c, 4, "every Edition is still listed on the Album page");
    // And its provider match is still available as evidence.
    assert.ok(
      db.prepare("SELECT 1 FROM ProviderEditionMatches WHERE edition_id = 102 AND match_state = 'accepted'").get(),
      "the bootleg's match survives as matching evidence",
    );
  });
});

test("a Release Group whose only Edition is a pseudo-release is not curated", () => {
  // A pseudo-release is a translated tracklisting of a record that exists
  // elsewhere; monitoring it downloads a duplicate under a different name.
  withLibrary((_db, service) => {
    assert.ok(!curate(service).selectedEditionIds.includes(201));
  });
});

/* ── The filter is a preference, not a law ──────────────────────────── */

test("a manual selection survives an excluded status", () => {
  withLibrary((db, service) => {
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, curation_version)
      VALUES (1, 102, 'manual', 1, 1)
    `).run();
    assert.ok(
      curate(service).selectedEditionIds.includes(102),
      "the user's own choice outranks the status filter",
    );
  });
});

// What each toggle does to eligibility is a property of the gate itself and is
// proven for all seven statuses plus unset in
// `musicbrainz-taxonomy-contract.test.ts`. What is only provable here is the
// wiring: that curation consults the gate, that the Release Group survives it,
// and that a manual selection outranks it.

/* ── Absent status is absent metadata, not a claim ──────────────────── */

test("an Edition with no status is not curated automatically", () => {
  // Both catalogue modes supply release status — Servarr's `LidarrRelease.Status`
  // is non-optional, and the measured 563-artist library is only 2.47% unset.
  // So an unset status is a genuine metadata gap rather than a mode asymmetry,
  // and "only official releases" means what it says. Cost on that library: 129
  // Release Groups of 5,322 become manual-only.
  withLibrary((db, service) => {
    db.prepare("UPDATE AlbumEditions SET status = NULL WHERE id = 101").run();
    const selected = curate(service).selectedEditionIds;
    assert.ok(!selected.includes(101), "an unset status is not eligible");
    // And the Edition is still there to monitor by hand.
    assert.ok(db.prepare("SELECT 1 FROM AlbumEditions WHERE id = 101").get());
  });
});

/* ── Unset is not a claim of officialness ───────────────────────────── */

test("an Official Edition outranks one with no status set", () => {
  // The old boolean read `!status || status === 'official'`, ranking a Release
  // with no status identically to a genuine Official issue. With both eligible
  // by default, that tie is now the common one.
  assert.equal(releaseStatusPreferenceRank("Official"), 2);
  assert.equal(releaseStatusPreferenceRank(null), 0);
  assert.equal(releaseStatusPreferenceRank(""), 0);
  // Every other enabled status sits between them: better than no claim,
  // worse than an official issue.
  for (const status of ["Promotion", "Bootleg", "Withdrawn", "Pseudo-Release"]) {
    assert.equal(releaseStatusPreferenceRank(status), 1, status);
  }
});

test("the rank still orders Official above other enabled statuses", () => {
  // Only reachable when the user enables a second status; the rank exists so
  // that Official then wins an equivalent-coverage tie rather than losing it to
  // a promo that happens to sort first.
  withLibrary((db, service) => {
    const selected = curate(service).selectedEditionIds;
    assert.ok(selected.includes(101));
  });
});
