import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
const { tempDir } = prepareActiveSchemaEnv("library-release-selection");

const { ProviderReleaseIngestionService } = await import("../providers/provider-release-ingestion-service.js");
const { AcquisitionPlanningService } = await import("./acquisition-planning-service.js");
const { AlbumCommandService } = await import("./album-command-service.js");
const { LibraryReleaseSelectionService } = await import("./library-release-selection-service.js");

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
    // Every canonical Edition is listed; none is monitored yet.
    assert.deepEqual(
      before.libraries[0].selections.map((selection) => selection.monitored),
      before.libraries[0].selections.map(() => false),
    );
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
    const monitored = after.libraries[0].selections.filter((selection) => selection.monitored);
    assert.deepEqual(monitored.map((selection) => ({
      editionId: selection.editionId,
      selectionMode: selection.selectionMode,
      // Manual selection is a preference, not a lock: Lock is its own action.
      locked: selection.locked,
      representative: selection.representative,
      composition: selection.plan?.composition,
      downloadMode: selection.plan?.downloadMode,
      primaryProviderEditionMatchId: selection.plan?.primaryProviderEditionMatchId,
    })), [{
      editionId: 1,
      selectionMode: "manual",
      locked: false,
      representative: true,
      composition: "single_source",
      downloadMode: "album",
      primaryProviderEditionMatchId: hiresOffer.providerEditionMatchId,
    }]);
    assert.deepEqual(db.prepare(`
      SELECT selection_mode, locked
      FROM LibraryAlbums
      WHERE library_id = 1 AND release_group_id = 1
    `).get(), { selection_mode: "manual", locked: 0 });
    assert.deepEqual(db.prepare(`
      SELECT source.provider_edition_match_id, source.role
      FROM AcquisitionPlanSources source
      JOIN SelectedAcquisitionPlans plan ON plan.id = source.plan_id
      WHERE plan.library_edition_id = ?
    `).get(monitored[0].libraryEditionId), {
      provider_edition_match_id: hiresOffer.providerEditionMatchId,
      role: "primary",
    });
    new AcquisitionPlanningService(db).compute({
      libraryId: after.libraries[0].id,
      editionId: monitored[0].editionId,
      providerPriority: ["tidal"],
      plannerVersion: 2,
    });
    assert.equal((db.prepare(`
      SELECT source.provider_edition_match_id
      FROM AcquisitionPlanSources source
      JOIN SelectedAcquisitionPlans plan ON plan.id = source.plan_id
      WHERE plan.library_edition_id = ? AND source.role = 'primary'
    `).get(monitored[0].libraryEditionId) as {
      provider_edition_match_id: number;
    }).provider_edition_match_id, hiresOffer.providerEditionMatchId);
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("an additive selection keeps the editions the album already monitors", () => {
  const artistMbid = "aaaaaaaa-1111-4111-8111-111111111111";
  const albumMbid = "aaaaaaaa-2222-4222-8222-222222222222";
  const deluxeMbid = "aaaaaaaa-3333-4333-8333-333333333333";
  const standardMbid = "aaaaaaaa-4444-4444-8444-444444444444";
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
      ) VALUES
        (1, '${standardMbid}', 1, '${albumMbid}', 1, '${artistMbid}',
         'Doom Days', 'Official', 'GB', '2019-06-14', 1, 2),
        (2, '${deluxeMbid}', 1, '${albumMbid}', 1, '${artistMbid}',
         'Doom Days (Deluxe)', 'Official', 'GB', '2019-11-01', 1, 4);
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
      ) VALUES (1, 'Lossless', '/library/lossless', 1, 1, 1);
      -- The user deliberately selected the deluxe edition by hand (manual, but
      -- not locked — Lock is a separate action).
      INSERT INTO LibraryEditions (
        id, library_id, edition_id, selection_mode, reason, curation_version
      ) VALUES (99, 1, 2, 'manual', 'user', 1);
    `);

    const service = new LibraryReleaseSelectionService(db);
    service.selectRelease({
      releaseGroupMbid: albumMbid,
      libraryId: 1,
      editionId: 1,
      mode: "additive",
    });

    const selected = db.prepare(`
      SELECT edition_id, selection_mode FROM LibraryEditions
      WHERE library_id = 1 ORDER BY edition_id
    `).all() as Array<{ edition_id: number; selection_mode: string }>;
    assert.deepEqual(selected, [
      { edition_id: 1, selection_mode: "manual" },
      { edition_id: 2, selection_mode: "manual" },
    ]);

    // The default — a normal click — reduces the album back to a single
    // monitored edition. "Use only this" is what an ordinary selection means.
    service.selectRelease({
      releaseGroupMbid: albumMbid,
      libraryId: 1,
      editionId: 1,
    });
    assert.deepEqual(
      (db.prepare(`
        SELECT edition_id FROM LibraryEditions WHERE library_id = 1 ORDER BY edition_id
      `).all() as Array<{ edition_id: number }>).map((row) => row.edition_id),
      [1],
    );
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("an auto-curated edition is replaced by a manual selection", () => {
  const artistMbid = "bbbbbbbb-1111-4111-8111-111111111111";
  const albumMbid = "bbbbbbbb-2222-4222-8222-222222222222";
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  try {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name)
      VALUES (1, '${artistMbid}', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id,
        artist_mbid, title
      ) VALUES
        (1, 'bbbbbbbb-3333-4333-8333-333333333333', 1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days'),
        (2, 'bbbbbbbb-4444-4444-8444-444444444444', 1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days (Deluxe)');
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
      ) VALUES (1, 'Lossless', '/library/lossless', 1, 1, 1);
      INSERT INTO LibraryEditions (
        id, library_id, edition_id, selection_mode, reason, curation_version
      ) VALUES (99, 1, 2, 'auto', 'curation', 1);
    `);

    new LibraryReleaseSelectionService(db).selectRelease({
      releaseGroupMbid: albumMbid,
      libraryId: 1,
      editionId: 1,
    });

    assert.deepEqual(
      (db.prepare(`
        SELECT edition_id FROM LibraryEditions WHERE library_id = 1 ORDER BY edition_id
      `).all() as Array<{ edition_id: number }>).map((row) => row.edition_id),
      [1],
    );
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("the album lock reaches the edition rows planning actually consults", () => {
  const artistMbid = "cccccccc-1111-4111-8111-111111111111";
  const albumMbid = "cccccccc-2222-4222-8222-222222222222";
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  try {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, '${artistMbid}', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title
      ) VALUES
        (1, 'cccccccc-3333-4333-8333-333333333333', 1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days'),
        (2, 'cccccccc-4444-4444-8444-444444444444', 1, '${albumMbid}', 1, '${artistMbid}', 'Deluxe');
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'High Quality', '["lossless","hires-lossless"]',
        '["hires-lossless","lossless"]', 'lossless', 0, 'best_allowed',
        '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id, enabled
      ) VALUES (1, 'Lossless', '/library/lossless', 1, 1, 1);
    `);

    const service = new LibraryReleaseSelectionService(db);
    service.selectRelease({ releaseGroupMbid: albumMbid, libraryId: 1, editionId: 1 });

    // Manual selection records a preference without silently locking.
    assert.deepEqual(
      db.prepare("SELECT selection_mode FROM LibraryEditions WHERE edition_id = 1").get(),
      { selection_mode: "manual" },
    );
    assert.equal(
      (db.prepare("SELECT locked FROM LibraryAlbums WHERE release_group_id = 1")
        .get() as { locked: number }).locked,
      0,
      "an ordinary selection must not press Lock",
    );

    AlbumCommandService.updateAlbum(albumMbid, true, true, { kind: "library", libraryId: 1 });

    // There is exactly one lock, on the Album, and every consumer reads it from
    // there. A second per-edition lock could disagree with this one; that is the
    // drift the column's removal makes unrepresentable.
    assert.equal(
      (db.prepare("SELECT locked FROM LibraryAlbums WHERE release_group_id = 1")
        .get() as { locked: number }).locked,
      1,
    );
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('LibraryEditions') WHERE name = 'locked'").all(),
      [],
    );
    // Planning reads the Album lock for this Edition, monitored or not.
    assert.equal(service.getAvailability(albumMbid).libraries[0].selections
      .every((selection) => selection.locked), true);

    AlbumCommandService.updateAlbum(albumMbid, true, false, { kind: "library", libraryId: 1 });
    assert.equal(
      (db.prepare("SELECT locked FROM LibraryAlbums WHERE release_group_id = 1")
        .get() as { locked: number }).locked,
      0,
      "unlocking lets curation reconsider the preference again",
    );
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("a locked album takes an exclusive selection from its owner and stays locked", () => {
  const artistMbid = "dddddddd-1111-4111-8111-111111111111";
  const albumMbid = "dddddddd-2222-4222-8222-222222222222";
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  try {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, '${artistMbid}', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title
      ) VALUES
        (1, 'dddddddd-3333-4333-8333-333333333333', 1, '${albumMbid}', 1, '${artistMbid}', 'Doom Days'),
        (2, 'dddddddd-4444-4444-8444-444444444444', 1, '${albumMbid}', 1, '${artistMbid}', 'Deluxe');
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'High Quality', '["lossless","hires-lossless"]',
        '["hires-lossless","lossless"]', 'lossless', 0, 'best_allowed',
        '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id, enabled
      ) VALUES (1, 'Lossless', '/library/lossless', 1, 1, 1);
      INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (1, 1, 'manual', 1, 'user', 1);
      INSERT INTO LibraryEditions (
        id, library_id, edition_id, selection_mode, reason, curation_version
      ) VALUES (99, 1, 2, 'manual', 'user', 1);
    `);

    // The lock holds this album against automatic curation and replanning. It
    // was never a barrier against the user, so an exclusive selection means the
    // same thing it always does: use only this edition.
    new LibraryReleaseSelectionService(db).selectRelease({
      releaseGroupMbid: albumMbid,
      libraryId: 1,
      editionId: 1,
    });

    assert.deepEqual(
      (db.prepare("SELECT edition_id FROM LibraryEditions WHERE library_id = 1 ORDER BY edition_id")
        .all() as Array<{ edition_id: number }>).map((row) => row.edition_id),
      [1],
    );
    assert.equal(
      (db.prepare("SELECT locked FROM LibraryAlbums WHERE library_id = 1 AND release_group_id = 1")
        .get() as { locked: number }).locked,
      1,
      "a manual change never clears the lock",
    );
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});

test("getAvailability returns authoritative displayQuality for Atmos selected variant", () => {
  const artistMbid = "eeeeeeee-1111-4111-8111-111111111111";
  const albumMbid = "eeeeeeee-2222-4222-8222-222222222222";
  const editionMbid = "eeeeeeee-3333-4333-8333-333333333333";
  const recordingMbid = "eeeeeeee-4444-4444-8444-444444444444";
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  try {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, '${artistMbid}', 'Spatial Artist');
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title) VALUES (1, '${albumMbid}', 1, '${artistMbid}', 'Spatial Album');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title, status, country, date, media_count, track_count
      ) VALUES (
        1, '${editionMbid}', 1, '${albumMbid}', 1, '${artistMbid}', 'Spatial Album', 'Official', 'US', '2024-01-01', 1, 1
      );
      INSERT INTO Recordings (id, mbid, artist_metadata_id, artist_mbid, title, length_ms, isrcs)
      VALUES (1, '${recordingMbid}', 1, '${artistMbid}', 'Track 1', 180000, '["US1111111111"]');
      INSERT INTO Tracks (
        id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title, length_ms
      ) VALUES (1, 'tr-1', 1, '${editionMbid}', 1, '${recordingMbid}', 1, 1, 'Track 1', 180000);
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'Spatial Profile', '["spatial","lossless"]',
        '["spatial","lossless"]', 'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id, enabled
      ) VALUES (1, 'Spatial Library', '/music/spatial', 1, 1, 1);
      INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
      VALUES (1, 1, 'auto', 0, 'curated', 1);
      INSERT INTO LibraryEditions (id, library_id, edition_id, selection_mode, representative, reason, curation_version)
      VALUES (1, 1, 1, 'auto', 1, 'curated', 1);
    `);

    new ProviderReleaseIngestionService(db).ingest({
      release: {
        provider: "apple",
        entityType: "release",
        providerId: "app-alb-1",
        title: "Spatial Album",
        availability: "available",
      },
      canonicalReleaseId: 1,
      matcherVersion: 1,
      releaseAudioVariants: [{
        variantKey: "atmos-key",
        qualityClass: "spatial",
        spatialFormat: "atmos",
        providerQualityLabel: "Dolby Atmos",
        availability: "available",
      }],
      members: [{
        item: {
          provider: "apple",
          entityType: "track",
          providerId: "app-tr-1",
          title: "Track 1",
          isrc: "US1111111111",
          durationMs: 180000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 1,
      }],
    });

    db.prepare("UPDATE ProviderEditionMatches SET match_state = 'accepted' WHERE edition_id = 1").run();
    db.prepare("UPDATE ProviderTrackMatches SET match_state = 'accepted', track_id = 1 WHERE recording_id = 1").run();

    const planId = new AcquisitionPlanningService(db).compute({
      libraryId: 1,
      editionId: 1,
      providerPriority: ["apple"],
      plannerVersion: 1,
    });
    assert.ok(planId != null, "planning must create a plan");

    const service = new LibraryReleaseSelectionService(db);
    const availability = service.getAvailability(albumMbid);
    const plans = availability.libraries[0]?.selections[0]?.plans || [];
    assert.equal(plans[0]?.displayQuality, "DOLBY_ATMOS");
  } finally {
    resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  }
});
