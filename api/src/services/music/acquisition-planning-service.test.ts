import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { buildAcquisitionDownloadCommand } from "./acquisition-plan-executor.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";

function seedStandardDeluxeFixture(db: Database.Database): number {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A')").run();
  db.prepare("INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Album A')").run();
  db.prepare("INSERT INTO AlbumReleases (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Album A')").run();
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title) VALUES
      (1, 'recording-1', 'One'),
      (2, 'recording-2', 'Two'),
      (3, 'recording-3', 'Three'),
      (4, 'recording-4', 'Four')
  `).run();
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_release_id, recording_id, medium_position, position, title
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
    INSERT INTO LibraryReleases (
      id, library_id, release_id, selection_mode, locked, reason, curation_version
    ) VALUES (1, 1, 1, 'auto', 0, 'fixture', 1)
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
      id, provider_edition_item_id, release_id, relation, match_state,
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
        id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 10, ?, ?, 'accepted', 'automatic', 1, 'fixture', 1)
    `).run(5000 + trackId, 1000 + trackId, trackId, trackId);
  }
  for (let trackId = 1; trackId <= 3; trackId += 1) {
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 20, ?, ?, 'accepted', 'automatic', 0.95, 'fixture', 1)
    `).run(6000 + trackId, 3000 + trackId, trackId, trackId);
  }
  return 1;
}

test("planning service materializes HIGH coherent and MAX justified composite plans", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-acquisition-planning-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    const libraryReleaseId = seedStandardDeluxeFixture(db);
    const service = new AcquisitionPlanningService(db);

    const highPlanId = service.compute({
      libraryReleaseId,
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
    assert.equal(highCommand?.body.trackOffers, undefined);

    db.prepare(`
      UPDATE quality_profiles
      SET cutoff = 'hires-lossless', continue_upgrades = 1
      WHERE id = 1
    `).run();
    const maxPlanId = service.compute({
      libraryReleaseId,
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
        library_id, album_release_id, track_id, recording_id, file_path,
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
