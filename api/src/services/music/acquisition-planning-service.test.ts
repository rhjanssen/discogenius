import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { buildAcquisitionDownloadCommand } from "./acquisition-plan-executor.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";

function seedStandardDeluxeFixture(db: Database.Database): number {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
  db.prepare("INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Album A')").run();
  db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Album A')").run();
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title) VALUES
      (1, 'recording-1', 'One'),
      (2, 'recording-2', 'Two'),
      (3, 'recording-3', 'Three'),
      (4, 'recording-4', 'Four')
  `).run();
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, medium_position, position, title
    ) VALUES (?, ?, 1, ?, 1, ?, ?)
  `);
  ["One", "Two", "Three", "Four"].forEach((title, index) =>
    insertTrack.run(index + 1, `track-${index + 1}`, index + 1, index + 1, title));

  db.prepare(`
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'Test', '["lossless","hires-lossless"]',
      '["hires-lossless","lossless","lossy","spatial"]',
      'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
    )
  `).run();
  db.prepare(`
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
    VALUES (1, 'Stereo', '/library/stereo', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO LibraryArtists (id, library_id, managed_artist_id, monitored)
    VALUES (1, 1, 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO LibraryEditions (
      id, library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (1, 1, 1, 'auto', 'fixture', 1)
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id, title, availability
    ) VALUES (10, 'tidal', 'release', 'standard', 'Album A', 'available'),
    (20, 'tidal', 'release', 'deluxe', 'Album A Deluxe', 'available')
  `).run();
  for (let trackId = 1; trackId <= 4; trackId += 1) {
    db.prepare(`
      INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id, title, availability
    ) VALUES (?, 'tidal', 'track', ?, ?, 'available')
    `).run(100 + trackId, `standard-${trackId}`, `Standard ${trackId}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, 10, ?, 1, ?)
    `).run(1000 + trackId, 100 + trackId, trackId);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(2000 + trackId, 100 + trackId);
  }
  for (let trackId = 1; trackId <= 3; trackId += 1) {
    db.prepare(`
      INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id, title, availability
    ) VALUES (?, 'tidal', 'track', ?, ?, 'available')
    `).run(200 + trackId, `deluxe-${trackId}`, `Deluxe ${trackId}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, 20, ?, 1, ?)
    `).run(3000 + trackId, 200 + trackId, trackId);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (?, ?, 'hires', 'hires-lossless', 'available')
    `).run(4000 + trackId, 200 + trackId);
  }

  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES
      (10, 10, 1, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, 4, 4, 4, 1, 1),
      (20, 20, 1, 'source_subset', 'accepted', 'automatic', 0.95, 'fixture', 1, 3, 3, 4, 1, 0.75)
  `).run();
  for (let trackId = 1; trackId <= 4; trackId += 1) {
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, 10, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(5000 + trackId, 100 + trackId, 1000 + trackId, trackId, trackId);
  }
  for (let trackId = 1; trackId <= 3; trackId += 1) {
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, 20, ?, ?, 'accepted', 'automatic', 0.95, 'fixture', 1)
    `).run(6000 + trackId, 200 + trackId, 3000 + trackId, trackId, trackId);
  }
  return 1;
}

test("planning service materializes HIGH coherent and MAX justified composite plans", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-acquisition-planning-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    seedStandardDeluxeFixture(db);
    const service = new AcquisitionPlanningService(db);

    const highPlanId = service.compute({
      libraryId: 1,
      editionId: 1,
      providerPriority: ["tidal"],
      plannerVersion: 1,
    });
    assert.ok(highPlanId);
    assert.deepEqual(db.prepare(`
      SELECT composition, download_mode FROM AcquisitionPlans WHERE id = ?
    `).get(highPlanId), { composition: "single_source", download_mode: "album" });
    assert.deepEqual(
      db.prepare(`
        SELECT provider_edition_match_id, role
        FROM AcquisitionPlanSources WHERE plan_id = ? ORDER BY sort_order
      `).all(highPlanId),
      [{ provider_edition_match_id: 10, role: "primary" }],
    );
    const highCommand = buildAcquisitionDownloadCommand(db, highPlanId!);
    assert.equal(highCommand?.body.acquisitionMode, "album");
    assert.equal(highCommand?.body.providerId, "standard");
    assert.equal(highCommand?.body.libraryId, 1);
    assert.equal(highCommand?.body.acquisitionPlanId, highPlanId);
    assert.deepEqual(
      highCommand?.body.trackOffers?.map((offer) => [
        offer.providerTrackItemId,
        offer.providerEditionItemId,
        offer.providerAudioVariantId,
        offer.acquisitionPlanSourceId,
      ]),
      [
        [101, 10, 2001, 1],
        [102, 10, 2002, 1],
        [103, 10, 2003, 1],
        [104, 10, 2004, 1],
      ],
      "Album-mode commands still carry exact per-track provenance for import",
    );

    db.prepare(`
      UPDATE quality_profiles
      SET cutoff = 'hires-lossless', continue_upgrades = 1
      WHERE id = 1
    `).run();
    const maxPlanId = service.compute({
      libraryId: 1,
      editionId: 1,
      providerPriority: ["tidal"],
      plannerVersion: 2,
    });
    assert.ok(maxPlanId);
    assert.deepEqual(db.prepare(`
      SELECT composition, download_mode FROM AcquisitionPlans WHERE id = ?
    `).get(maxPlanId), { composition: "composite", download_mode: "tracks" });
    assert.deepEqual(
      db.prepare(`
        SELECT track_id, provider_edition_match_id
        FROM AcquisitionPlanTracks track
        JOIN AcquisitionPlanSources source ON source.id = track.source_id
        WHERE track.plan_id = ?
        ORDER BY track.track_id
      `).all(maxPlanId),
      [
        { track_id: 1, provider_edition_match_id: 20 },
        { track_id: 2, provider_edition_match_id: 20 },
        { track_id: 3, provider_edition_match_id: 20 },
        { track_id: 4, provider_edition_match_id: 10 },
      ],
    );
    const maxCommand = buildAcquisitionDownloadCommand(db, maxPlanId!);
    assert.equal(maxCommand?.body.acquisitionMode, "trackOffers");
    assert.deepEqual(
      maxCommand?.body.trackOffers?.map((offer) => [
        offer.canonicalTrackMbid,
        offer.providerAlbumId,
        offer.providerTrackId,
      ]),
      [
        ["track-1", "deluxe", "deluxe-1"],
        ["track-2", "deluxe", "deluxe-2"],
        ["track-3", "deluxe", "deluxe-3"],
        ["track-4", "standard", "standard-4"],
      ],
      "Composite execution must use normalized source rows rather than a packed provider id",
    );

    db.prepare(`
      INSERT INTO TrackFiles (
        library_id, album_edition_id, track_id, recording_id, file_path,
        relative_path, filename, extension, file_class
      ) VALUES (1, 1, 1, 1, '/library/stereo/one.flac', 'one.flac', 'one.flac', 'flac', 'audio')
    `).run();
    const partialCommand = buildAcquisitionDownloadCommand(db, maxPlanId!);
    assert.deepEqual(
      partialCommand?.body.trackOffers?.map((offer) => offer.canonicalTrackMbid),
      ["track-2", "track-3", "track-4"],
      "Only incomplete assigned tracks should be queued",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Two Editions of one Release Group whose Recordings MusicBrainz never joined:
 * the target Edition's Tracks point at recordings 1-2, a sibling Edition's at
 * recordings 11-12, and nothing canonical connects them. The provider does:
 * both provider releases carry the same two ISRCs, and only the sibling's
 * tracks are Hi-Res.
 *
 * This is Amy Winehouse's Frank in miniature. Its UK Super Deluxe and Japanese
 * CD editions share zero Recordings, and the Japanese Recordings carry no
 * canonical ISRC at all, yet 12 of 13 core tracks share a TIDAL ISRC and agree
 * on duration to the second. Without the provider-ISRC tier the target is stuck
 * at the lossless tier while identical audio sits unusable in the sibling.
 */
function seedSplitRecordingIsrcFixture(db: Database.Database): void {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
  db.prepare("INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Album A')").run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES
      (1, 'release-target', 1, 'Album A'),
      (2, 'release-sibling', 1, 'Album A (Japan)')
  `).run();
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title) VALUES
      (1, 'recording-1', 'One'), (2, 'recording-2', 'Two'),
      (11, 'recording-11', 'One'), (12, 'recording-12', 'Two')
  `).run();
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  insertTrack.run(1, "track-1", 1, 1, 1, "One");
  insertTrack.run(2, "track-2", 1, 2, 2, "Two");
  insertTrack.run(11, "track-11", 2, 11, 1, "One");
  insertTrack.run(12, "track-12", 2, 12, 2, "Two");

  db.prepare(`
    INSERT INTO MetadataProfiles (id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled)
    VALUES (1, 'Default', '{}', 'allow', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'Test', '["lossless","hires-lossless"]',
      '["hires-lossless","lossless","lossy","spatial"]',
      'hires-lossless', 1, 'best_allowed', '{"codec":"flac"}', 'preserve'
    )
  `).run();
  db.prepare(`
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
    VALUES (1, 'Stereo', '/library/stereo', 1, 1)
  `).run();
  db.prepare("INSERT INTO LibraryArtists (id, library_id, managed_artist_id, monitored) VALUES (1, 1, 1, 1)").run();
  db.prepare(`
    INSERT INTO LibraryEditions (id, library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (1, 1, 1, 'auto', 'fixture', 1)
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, availability) VALUES
      (10, 'tidal', 'release', 'target-release', 'Album A', 'available'),
      (20, 'tidal', 'release', 'sibling-release', 'Album A (Japan)', 'available')
  `).run();

  // Same two ISRCs on both sides; only the sibling's tracks are Hi-Res.
  ["GBAAA0000001", "GBAAA0000002"].forEach((isrc, index) => {
    const position = index + 1;
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, isrc, availability)
      VALUES (?, 'tidal', 'track', ?, ?, ?, 'available')
    `).run(100 + position, `target-${position}`, `Track ${position}`, isrc);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, medium_position, position)
      VALUES (?, 10, ?, 1, ?)
    `).run(1000 + position, 100 + position, position);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
      VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(2000 + position, 100 + position);

    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, isrc, availability)
      VALUES (?, 'tidal', 'track', ?, ?, ?, 'available')
    `).run(200 + position, `sibling-${position}`, `Track ${position}`, isrc);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, medium_position, position)
      VALUES (?, 20, ?, 1, ?)
    `).run(3000 + position, 200 + position, position);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
      VALUES (?, ?, 'hires', 'hires-lossless', 'available')
    `).run(4000 + position, 200 + position);
  });

  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count, source_coverage, target_coverage
    ) VALUES
      (10, 10, 1, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, 2, 2, 2, 1, 1),
      (20, 20, 2, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, 2, 2, 2, 1, 1)
  `).run();
  for (const position of [1, 2]) {
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, 10, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(5000 + position, 100 + position, 1000 + position, position, position);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, 20, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(6000 + position, 200 + position, 3000 + position, 10 + position, 10 + position);
  }
}

test("a sibling edition's provider tracks source this one when they share an ISRC", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-isrc-source-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    seedSplitRecordingIsrcFixture(db);

    const planId = new AcquisitionPlanningService(db).compute({
      libraryId: 1,
      editionId: 1,
      providerPriority: ["tidal"],
      plannerVersion: 1,
    });
    assert.ok(planId, "the target edition must still get a plan");

    assert.equal(
      (db.prepare("SELECT quality_tier FROM AcquisitionPlans WHERE id = ?").get(planId) as any).quality_tier,
      "hires-lossless",
      "the Hi-Res sibling sources must be reachable across the Recording split",
    );
    assert.deepEqual(
      db.prepare(`
        SELECT plan_track.track_id, source.provider_edition_match_id
        FROM AcquisitionPlanTracks plan_track
        JOIN AcquisitionPlanSources source ON source.id = plan_track.source_id
        WHERE plan_track.plan_id = ?
        ORDER BY plan_track.track_id
      `).all(planId),
      [
        { track_id: 1, provider_edition_match_id: 20 },
        { track_id: 2, provider_edition_match_id: 20 },
      ],
      "both target tracks source from the sibling provider release",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a shared ISRC outside the release group is not a source", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-isrc-scope-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    seedSplitRecordingIsrcFixture(db);
    // Move the sibling edition into a different release group. Same ISRCs, same
    // provider, same everything else - a compilation appearance is a different
    // product decision, so it must stop being a source.
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (2, 'group-b', 1, 'Greatest Hits')").run();
    db.prepare("UPDATE AlbumEditions SET release_group_id = 2 WHERE id = 2").run();

    const planId = new AcquisitionPlanningService(db).compute({
      libraryId: 1,
      editionId: 1,
      providerPriority: ["tidal"],
      plannerVersion: 1,
    });
    assert.ok(planId);
    assert.equal(
      (db.prepare("SELECT quality_tier FROM AcquisitionPlans WHERE id = ?").get(planId) as any).quality_tier,
      "lossless",
      "out-of-release-group ISRC matches must not raise the attainable tier",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
