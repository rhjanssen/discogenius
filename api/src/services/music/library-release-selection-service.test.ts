import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import { ProviderReleaseIngestionService } from "../providers/provider-release-ingestion-service.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import { LibraryReleaseSelectionService } from "./library-release-selection-service.js";

const { tempDir } = prepareActiveSchemaEnv("library-release-selection");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("manual library selection pins the exact provider edition on the active schema", () => {
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const albumMbid = "22222222-2222-4222-8222-222222222222";
  const editionMbid = "33333333-3333-4333-8333-333333333333";
  const recordingOneMbid = "44444444-4444-4444-8444-444444444444";
  const recordingTwoMbid = "55555555-5555-4555-8555-555555555555";
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  try {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name)
      VALUES (1, '${artistMbid}', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id,
        artist_mbid, title, status, country, date, media_count, track_count
      ) VALUES (
        1, '${editionMbid}', 1, '${albumMbid}', 1, '${artistMbid}',
        'Doom Days', 'Official', 'GB', '2019-06-14', 1, 2
      );
      INSERT INTO Recordings (id, mbid, artist_metadata_id, artist_mbid, title, length_ms, isrcs)
      VALUES
        (1, '${recordingOneMbid}', 1, '${artistMbid}', 'Quarter Past Midnight', 199000, '["GBUM71801770"]'),
        (2, '${recordingTwoMbid}', 1, '${artistMbid}', 'Bad Decisions', 190000, '["GBUM71901234"]');
      INSERT INTO Tracks (
        id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
        medium_position, position, title, length_ms
      ) VALUES
        (1, 'track-quarter-past-midnight', 1, '${editionMbid}', 1, '${recordingOneMbid}', 1, 1, 'Quarter Past Midnight', 199000),
        (2, 'track-bad-decisions', 1, '${editionMbid}', 2, '${recordingTwoMbid}', 1, 2, 'Bad Decisions', 190000);
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'High Quality', '["lossless","hires-lossless"]',
        '["hires-lossless","lossless"]', 'lossless',
        0, 'best_allowed', '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id, enabled
      ) VALUES (1, 'Stereo', '/music/stereo', 1, 1, 1);
    `);

    new ProviderReleaseIngestionService(db).ingest({
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "tidal-doom-days",
        title: "Doom Days",
        availability: "available",
      },
      canonicalReleaseId: 1,
      matcherVersion: 1,
      releaseAudioVariants: [{
        variantKey: "lossless",
        qualityClass: "lossless",
        codec: "flac",
        availability: "available",
      }],
      members: [{
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-quarter-past-midnight",
          title: "Quarter Past Midnight",
          isrc: "GBUM71801770",
          durationMs: 199000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 1,
      }, {
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-bad-decisions",
          title: "Bad Decisions",
          isrc: "GBUM71901234",
          durationMs: 190000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 2,
      }],
    });
    new ProviderReleaseIngestionService(db).ingest({
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "tidal-doom-days-hires",
        title: "Doom Days",
        availability: "available",
      },
      canonicalReleaseId: 1,
      matcherVersion: 1,
      releaseAudioVariants: [{
        variantKey: "hires",
        qualityClass: "hires-lossless",
        codec: "flac",
        availability: "available",
      }],
      members: [{
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-quarter-past-midnight-hires",
          title: "Quarter Past Midnight",
          isrc: "GBUM71801770",
          durationMs: 199000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 1,
      }, {
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-bad-decisions-hires",
          title: "Bad Decisions",
          isrc: "GBUM71901234",
          durationMs: 190000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 2,
      }],
    });

    const service = new LibraryReleaseSelectionService(db);
    const before = service.getAvailability(albumMbid);
    assert.equal(before.libraries.length, 1);
    assert.deepEqual(before.libraries[0].allowedSourceFormats, ["lossless", "hires-lossless"]);
    assert.deepEqual(before.libraries[0].selections, []);
    assert.equal(before.releases[0].offers[0].relation, "exact");
    assert.deepEqual(
      before.releases[0].offers.flatMap((offer) =>
        offer.variants.map((variant) => variant.qualityClass)).sort(),
      ["hires-lossless", "lossless"],
    );
    const hiresOffer = before.releases[0].offers.find((offer) =>
      offer.variants.some((variant) => variant.qualityClass === "hires-lossless"));
    assert.ok(hiresOffer);

    const after = service.selectRelease({
      releaseGroupMbid: albumMbid,
      libraryId: 1,
      editionId: 1,
      providerEditionMatchId: hiresOffer.providerEditionMatchId,
    });
    assert.deepEqual(after.libraries[0].selections.map((selection) => ({
      editionId: selection.editionId,
      selectionMode: selection.selectionMode,
      locked: selection.locked,
      composition: selection.plan?.composition,
      downloadMode: selection.plan?.downloadMode,
      primaryProviderEditionMatchId: selection.plan?.primaryProviderEditionMatchId,
    })), [{
      editionId: 1,
      selectionMode: "manual",
      locked: true,
      composition: "single_source",
      downloadMode: "album",
      primaryProviderEditionMatchId: hiresOffer.providerEditionMatchId,
    }]);
    assert.deepEqual(db.prepare(`
      SELECT selection_mode, locked, monitored
      FROM LibraryAlbums
      WHERE library_id = 1 AND release_group_id = 1
    `).get(), { selection_mode: "manual", locked: 1, monitored: 1 });
    assert.deepEqual(db.prepare(`
      SELECT source.provider_edition_match_id, source.role
      FROM AcquisitionPlanSources source
      JOIN AcquisitionPlans plan ON plan.id = source.plan_id
      WHERE plan.library_edition_id = ?
    `).get(after.libraries[0].selections[0].libraryEditionId), {
      provider_edition_match_id: hiresOffer.providerEditionMatchId,
      role: "primary",
    });
    new AcquisitionPlanningService(db).compute({
      libraryEditionId: after.libraries[0].selections[0].libraryEditionId,
      providerPriority: ["tidal"],
      plannerVersion: 2,
    });
    assert.equal((db.prepare(`
      SELECT source.provider_edition_match_id
      FROM AcquisitionPlanSources source
      JOIN AcquisitionPlans plan ON plan.id = source.plan_id
      WHERE plan.library_edition_id = ? AND source.role = 'primary'
    `).get(after.libraries[0].selections[0].libraryEditionId) as {
      provider_edition_match_id: number;
    }).provider_edition_match_id, hiresOffer.providerEditionMatchId);
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});
