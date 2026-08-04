/**
 * A plan badge names the quality the plan will actually acquire.
 *
 * That is the quality of the variant each planned track selected — not the best
 * variant the provider happens to publish for the same album. TIDAL ships a
 * separate Atmos stream alongside the stereo one on the same provider release,
 * so reading "any Atmos variant exists here" would badge the Stereo library's
 * lossless plan as Dolby Atmos.
 *
 * These tests run the real ingestion → planning → availability path and then
 * push the result through the API contract parser, because the display quality
 * being computed correctly server-side is worthless if it is dropped on the way
 * to the badge.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("selected-plan-display-quality");

const { ProviderReleaseIngestionService } = await import("../providers/provider-release-ingestion-service.js");
const { AcquisitionPlanningService } = await import("./acquisition-planning-service.js");
const { LibraryReleaseSelectionService } = await import("./library-release-selection-service.js");
const { parseLibraryReleaseGroupAvailabilityContract } = await import("../../contracts/media.js");

const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

const ARTIST_MBID = "c1c1c1c1-1111-4111-8111-111111111111";
const ALBUM_MBID = "c1c1c1c1-2222-4222-8222-222222222222";
const EDITION_MBID = "c1c1c1c1-3333-4333-8333-333333333333";
const RECORDING_MBID = "c1c1c1c1-4444-4444-8444-444444444444";

/**
 * One Album, one Edition, one Recording, and two Libraries: a Stereo library
 * that may take lossless, and a Spatial library that may only take spatial.
 */
function seedCatalog() {
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  db.exec(`
    DELETE FROM ProviderItems;
    INSERT INTO ArtistMetadata (id, mbid, name)
    VALUES (1, '${ARTIST_MBID}', 'Bastille');
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
    VALUES (1, '${ALBUM_MBID}', 1, '${ARTIST_MBID}', 'Doom Days');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (
      1, '${EDITION_MBID}', 1, '${ALBUM_MBID}', 1, '${ARTIST_MBID}',
      'Doom Days', 'Official', 'GB', '2019-06-14', 1, 1
    );
    INSERT INTO Recordings (id, mbid, artist_metadata_id, artist_mbid, title, length_ms, isrcs)
    VALUES (1, '${RECORDING_MBID}', 1, '${ARTIST_MBID}', 'Quarter Past Midnight', 199000, '["GBUM71801770"]');
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title, length_ms
    ) VALUES (1, 'track-qpm', 1, '${EDITION_MBID}', 1, '${RECORDING_MBID}', 1, 1, 'Quarter Past Midnight', 199000);
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES
      (1, 'Stereo', '["lossless"]', '["lossless"]', 'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'),
      (2, 'Spatial', '["spatial"]', '["spatial"]', 'spatial', 0, 'best_allowed', '{"codec":"eac3"}', 'preserve');
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
    VALUES (1, 'Stereo', '/music/stereo', 1, 1, 1),
           (2, 'Spatial', '/music/spatial', 1, 2, 1);
  `);
}

/**
 * One provider release carrying both streams, which is how TIDAL and Apple
 * Music actually publish an Atmos album.
 */
function ingestDualStreamRelease(provider: string, spatialFormat: string) {
  new ProviderReleaseIngestionService(db).ingest({
    release: {
      provider,
      entityType: "release",
      providerId: `${provider}-doom-days`,
      title: "Doom Days",
      availability: "available",
    },
    canonicalReleaseId: 1,
    matcherVersion: 1,
    releaseAudioVariants: [
      {
        variantKey: "lossless",
        qualityClass: "lossless",
        codec: "flac",
        availability: "available",
      },
      {
        variantKey: "spatial",
        qualityClass: "spatial",
        codec: "eac3",
        spatialFormat,
        availability: "available",
      },
    ],
    members: [{
      item: {
        provider,
        entityType: "track",
        providerId: `${provider}-qpm`,
        title: "Quarter Past Midnight",
        isrc: "GBUM71801770",
        durationMs: 199000,
        availability: "available",
      },
      mediumPosition: 1,
      position: 1,
      audioVariants: [
        {
          variantKey: "lossless",
          qualityClass: "lossless",
          codec: "flac",
          availability: "available",
        },
        {
          variantKey: "spatial",
          qualityClass: "spatial",
          codec: "eac3",
          spatialFormat,
          availability: "available",
        },
      ],
    }],
  });
}

/** Monitor the Edition in both libraries and compute their plans. */
function monitorAndPlan(provider: string) {
  const service = new LibraryReleaseSelectionService(db);
  const before = service.getAvailability(ALBUM_MBID);
  const offer = before.releases[0].offers[0];
  assert.ok(offer, "provider offer should be matched to the canonical edition");

  for (const libraryId of [1, 2]) {
    service.selectRelease({
      releaseGroupMbid: ALBUM_MBID,
      libraryId,
      editionId: 1,
      providerEditionMatchId: offer.providerEditionMatchId,
    });
    new AcquisitionPlanningService(db).compute({
      libraryId,
      editionId: 1,
      providerPriority: [provider],
      plannerVersion: 2,
    });
  }

  // Read through the wire contract: a value the parser drops never reaches a badge.
  return parseLibraryReleaseGroupAvailabilityContract(
    JSON.parse(JSON.stringify(service.getAvailability(ALBUM_MBID))),
  );
}

function chosenPlanFor(
  availability: ReturnType<typeof parseLibraryReleaseGroupAvailabilityContract>,
  libraryId: number,
) {
  const library = availability.libraries.find((candidate) => candidate.id === libraryId);
  assert.ok(library, `library ${libraryId} should be present`);
  const selection = library.selections.find((candidate) => candidate.monitored && candidate.plan);
  assert.ok(selection?.plan, `library ${libraryId} should have executed a plan`);
  return selection.plan;
}

test("an unrelated Atmos variant on the same provider release does not badge the stereo plan", () => {
  seedCatalog();
  try {
    ingestDualStreamRelease("tidal", "atmos");
    const availability = monitorAndPlan("tidal");

    const stereoPlan = chosenPlanFor(availability, 1);
    assert.equal(stereoPlan.qualityTier, "lossless");
    assert.equal(
      stereoPlan.displayQuality?.toUpperCase().includes("ATMOS"),
      false,
      "the stereo plan selected the lossless variant and must not read as Atmos",
    );

    const spatialPlan = chosenPlanFor(availability, 2);
    assert.equal(spatialPlan.qualityTier, "spatial");
    assert.equal(spatialPlan.displayQuality, "DOLBY_ATMOS");
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("a selected Sony 360RA variant stays distinct from Atmos across the contract", () => {
  seedCatalog();
  try {
    ingestDualStreamRelease("tidal", "sony_360ra");
    const availability = monitorAndPlan("tidal");

    assert.equal(chosenPlanFor(availability, 2).displayQuality, "SONY_360RA");
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("display quality survives the availability contract parser", () => {
  seedCatalog();
  try {
    ingestDualStreamRelease("tidal", "atmos");
    const availability = monitorAndPlan("tidal");

    const plans = availability.libraries
      .flatMap((library) => library.selections)
      .flatMap((selection) => selection.plans);
    assert.ok(plans.length > 0, "the fixture should produce plans");
    assert.equal(
      plans.every((plan) => typeof plan.displayQuality === "string" || plan.displayQuality === null),
      true,
      "every parsed plan must carry the display quality the server computed",
    );
    assert.ok(
      plans.some((plan) => plan.displayQuality === "DOLBY_ATMOS"),
      "the spatial plan's Atmos display quality must reach the client",
    );
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});
