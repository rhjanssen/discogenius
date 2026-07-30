import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";

test("plan replacement is atomic and partial completion counts only imported assigned tracks", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-acquisition-plan-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist', 'Artist');
      INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1);
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group', 1, 'Group');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release', 1, 'Release');
      INSERT INTO Recordings (id, mbid, title) VALUES (1, 'recording-1', 'One'), (2, 'recording-2', 'Two');
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
        VALUES (1, 'track-1', 1, 1, 1, 1, 'One'), (2, 'track-2', 1, 2, 1, 2, 'Two');
      INSERT INTO MetadataProfiles (id, name, release_type_policy) VALUES (1, 'Default', '{}');
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        fallback_policy, output_format, transcode_policy
      ) VALUES (1, 'High', '[]', '[]', 'lossless', 'best', '{}', 'preserve');
      INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
        VALUES (1, 'Stereo', '/library/stereo', 1, 1);
      INSERT INTO LibraryReleases (
        id, library_id, edition_id, selection_mode, curation_version
      ) VALUES (1, 1, 1, 'auto', 1);
      INSERT INTO ProviderItems (
      id, provider, entity_type, provider_id
    ) VALUES (1, 'tidal', 'release', 'provider-release'),
    (2, 'tidal', 'track', 'provider-track-1'),
    (3, 'tidal', 'track', 'provider-track-2');
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (1, 1, 2, 1, 1), (2, 1, 3, 1, 2);
      INSERT INTO ProviderEditionMatches (
        id, provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version,
        matched_track_count, source_track_count, target_track_count,
        source_coverage, target_coverage
      ) VALUES (1, 1, 1, 'exact', 'accepted', 'automatic', 1, 'external_id', 1, 2, 2, 2, 1, 1);
      INSERT INTO ProviderTrackMatches (
        id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (1, 1, 1, 1, 1, 'accepted', 'automatic', 1, 'external_id', 1),
               (2, 2, 1, 2, 2, 'accepted', 'automatic', 1, 'external_id', 1);
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (1, 2, 'lossless', 'lossless', 'available'),
               (2, 3, 'lossless', 'lossless', 'available');
    `);
    const repository = new AcquisitionPlanRepository(db);
    repository.replaceCurrentPlan({
      libraryReleaseId: 1,
      plannerVersion: 1,
      policyHash: "policy",
      computedAt: "2026-07-29T00:00:00.000Z",
      plan: {
        provider: "tidal",
        composition: "single_source",
        downloadMode: "album",
        sourceIds: [1],
        tracks: [
          {
            trackId: 1,
            providerReleaseMatchId: 1,
            providerTrackMatchId: 1,
            providerReleaseMemberId: 1,
            providerAudioVariantId: 1,
            sourceQuality: "lossless",
          },
          {
            trackId: 2,
            providerReleaseMatchId: 1,
            providerTrackMatchId: 2,
            providerReleaseMemberId: 2,
            providerAudioVariantId: 2,
            sourceQuality: "lossless",
          },
        ],
      },
    });
    db.prepare(`
      INSERT INTO TrackFiles (
        library_id, album_edition_id, track_id, recording_id, file_path, relative_path,
        filename, extension, file_class, source_quality, imported_quality
      ) VALUES (1, 1, 1, 1, '/library/stereo/one.flac', 'one.flac', 'one.flac',
                'flac', 'audio', 'lossless', 'lossless')
    `).run();
    assert.deepEqual(repository.getCompletion(1), {
      trackCount: 2,
      assignedCount: 2,
      completeCount: 1,
    });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
