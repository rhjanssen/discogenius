import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-cross-provider-quality-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let trackQuery: typeof import("./track-query-service.js");
let configModule: typeof import("../config/config.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  trackQuery = await import("./track-query-service.js");
});

beforeEach(() => {
  for (const table of [
    "TrackFiles",
    "AcquisitionPlanTracks",
    "AcquisitionPlanSources",
    "AcquisitionPlans",
    "LibraryReleases",
    "LibraryReleaseGroups",
    "ProviderTrackMatches",
    "ProviderReleaseMatches",
    "ProviderReleaseMembers",
    "ProviderItemAudioVariants",
    "ProviderItems",
    "Tracks",
    "Recordings",
    "AlbumReleases",
    "Albums",
    "Artists",
    "ArtistMetadata",
  ]) {
    try {
      dbModule.db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // ignore missing tables in fresh schemas
    }
  }
  const config = configModule.readConfig();
  config.filtering = {
    ...config.filtering,
    include_spatial: true,
  };
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tracklist remoteOffers include stereo and spatial from different providers/releases", () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-1", "Artist");
  db.prepare(`INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)`).run("1", "Artist", "artist-1");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'Album')`)
    .run("rg-1", "artist-1", "Album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, 'Official', '2020-01-01', 1, 1)
  `).run("rel-stereo", "rg-1", "artist-1", "Stereo");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, 'Official', '2020-01-01', 1, 1)
  `).run("rel-atmos", "rg-1", "artist-1", "Atmos");
  db.prepare(`INSERT INTO Recordings (mbid, title) VALUES (?, ?)`).run("rec-1", "Song");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 180000)
  `).run("track-1", "rel-stereo", "rec-1", "Song");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 180000)
  `).run("track-atmos", "rel-atmos", "rec-1", "Song");

  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Cross Provider Track', '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO quality_profiles (
      name, upgrade_allowed, cutoff, items, allowed_source_formats,
      preference_order, continue_upgrades, fallback_policy,
      output_format, transcode_policy
    ) VALUES (
      'Cross Provider Spatial', 0, 'DOLBY_ATMOS', '["DOLBY_ATMOS"]',
      '["spatial"]', '["spatial"]', 0, 'best_allowed',
      '{"codec":"preserve"}', 'preserve'
    )
  `).run();
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = 'Cross Provider Track'
  `).get() as { id: number };
  const stereoProfile = db.prepare(`
    SELECT id
    FROM quality_profiles
    WHERE NOT EXISTS (
      SELECT 1
      FROM json_each(COALESCE(quality_profiles.allowed_source_formats, '[]')) allowed
      WHERE allowed.value = 'spatial'
    )
    ORDER BY id
    LIMIT 1
  `).get() as { id: number };
  const spatialProfile = db.prepare(`
    SELECT id FROM quality_profiles WHERE name = 'Cross Provider Spatial'
  `).get() as { id: number };
  const insertLibrary = db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    ) VALUES (?, ?, ?, ?, 1)
    RETURNING id
  `);
  const stereoLibrary = insertLibrary.get(
    "Cross Provider Stereo",
    path.join(tempDir, "stereo"),
    metadataProfile.id,
    stereoProfile.id,
  ) as { id: number };
  const spatialLibrary = insertLibrary.get(
    "Cross Provider Spatial",
    path.join(tempDir, "spatial"),
    metadataProfile.id,
    spatialProfile.id,
  ) as { id: number };
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-1'").get() as { id: number };

  const seedSelection = (options: {
    libraryId: number;
    releaseMbid: string;
    trackMbid: string;
    provider: string;
    providerReleaseId: string;
    providerTrackId: string;
    qualityClass: "hires-lossless" | "spatial";
    quality: string;
  }) => {
    const release = db.prepare("SELECT id FROM AlbumReleases WHERE mbid = ?")
      .get(options.releaseMbid) as { id: number };
    const track = db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = ?")
      .get(options.trackMbid) as { id: number; recording_id: number };
    const providerRelease = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'release', ?, 'Album')
      RETURNING id
    `).get(options.provider, options.providerReleaseId) as { id: number };
    const providerTrack = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'track', ?, 'Song')
      RETURNING id
    `).get(options.provider, options.providerTrackId) as { id: number };
    const member = db.prepare(`
      INSERT INTO ProviderReleaseMembers (
        provider_release_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, 1, 1)
      RETURNING id
    `).get(providerRelease.id, providerTrack.id) as { id: number };
    const releaseMatch = db.prepare(`
      INSERT INTO ProviderReleaseMatches (
        provider_release_item_id, release_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
      RETURNING id
    `).get(providerRelease.id, release.id) as { id: number };
    const trackMatch = db.prepare(`
      INSERT INTO ProviderTrackMatches (
        provider_release_member_id, provider_release_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method,
        matcher_version
      ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
      RETURNING id
    `).get(member.id, releaseMatch.id, track.id, track.recording_id) as { id: number };
    const variant = db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label,
        availability
      ) VALUES (?, ?, ?, ?, 'available')
      RETURNING id
    `).get(providerTrack.id, options.qualityClass, options.qualityClass, options.quality) as { id: number };
    db.prepare(`
      INSERT INTO LibraryReleaseGroups (
        library_id, release_group_id, monitored, selection_mode, locked,
        curation_version
      ) VALUES (?, ?, 1, 'auto', 0, 1)
    `).run(options.libraryId, releaseGroup.id);
    const libraryRelease = db.prepare(`
      INSERT INTO LibraryReleases (
        library_id, release_id, selection_mode, locked, curation_version
      ) VALUES (?, ?, 'auto', 0, 1)
      RETURNING id
    `).get(options.libraryId, release.id) as { id: number };
    const plan = db.prepare(`
      INSERT INTO AcquisitionPlans (
        library_release_id, provider, composition, download_mode, state,
        planner_version, policy_hash, computed_at
      ) VALUES (?, ?, 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
      RETURNING id
    `).get(libraryRelease.id, options.provider) as { id: number };
    const source = db.prepare(`
      INSERT INTO AcquisitionPlanSources (
        plan_id, provider_release_match_id, role, sort_order
      ) VALUES (?, ?, 'primary', 0)
      RETURNING id
    `).get(plan.id, releaseMatch.id) as { id: number };
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id,
        provider_audio_variant_id, source_quality_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      track.id,
      source.id,
      trackMatch.id,
      variant.id,
      JSON.stringify({ quality: options.quality }),
    );
  };

  seedSelection({
    libraryId: stereoLibrary.id,
    releaseMbid: "rel-stereo",
    trackMbid: "track-1",
    provider: "tidal",
    providerReleaseId: "tidal-album",
    providerTrackId: "tidal-track",
    qualityClass: "hires-lossless",
    quality: "HIRES_LOSSLESS",
  });
  seedSelection({
    libraryId: spatialLibrary.id,
    releaseMbid: "rel-atmos",
    trackMbid: "track-atmos",
    provider: "apple-music",
    providerReleaseId: "apple-atmos",
    providerTrackId: "apple-track",
    qualityClass: "spatial",
    quality: "DOLBY_ATMOS",
  });

  const stereoTrack = db.prepare(`
    SELECT id, recording_id FROM Tracks WHERE mbid = 'track-1'
  `).get() as { id: number; recording_id: number };
  const stereoRelease = db.prepare(`
    SELECT id, release_group_id FROM AlbumReleases WHERE mbid = 'rel-stereo'
  `).get() as { id: number; release_group_id: number };
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id, album_release_id, track_id,
      recording_id, provider, provider_entity_type, provider_id,
      file_path, relative_path, library_root, filename, extension, file_type,
      file_class, quality, source_quality, imported_quality
    ) VALUES (
      '1', ?, ?, ?, ?, ?, 'tidal', 'track', 'tidal-track',
      'C:/library/Song.flac', 'Song.flac', 'C:/library', 'Song.flac',
      'flac', 'track', 'audio', 'HIRES_LOSSLESS', 'HIRES_LOSSLESS',
      'HIRES_LOSSLESS'
    )
  `).run(
    stereoLibrary.id,
    stereoRelease.release_group_id,
    stereoRelease.id,
    stereoTrack.id,
    stereoTrack.recording_id,
  );

  const detail = trackQuery.getTrackDetail("track-1");
  assert.ok(detail);
  assert.deepEqual(
    (detail.remoteOffers || []).map((offer) => `${offer.slot}:${offer.provider}:${offer.quality}:${offer.matchStatus}`).sort(),
    ["spatial:apple-music:DOLBY_ATMOS:accepted", "stereo:tidal:HIRES_LOSSLESS:accepted"],
  );
  assert.ok(detail.qualityTags?.includes("HIRES_LOSSLESS"));
  assert.ok(detail.qualityTags?.includes("DOLBY_ATMOS"));
  assert.equal(detail.files.length, 1);
  assert.equal(detail.files[0]?.library_slot, "stereo");

  const stereo = trackQuery.listTracks({
    limit: 20,
    offset: 0,
    monitored: true,
    libraryFilter: "stereo",
    provider: "tidal",
    qualityTier: "MAX",
  });
  assert.deepEqual(stereo.items.map((track) => track.id), ["track-1"]);

  const spatial = trackQuery.listTracks({
    limit: 20,
    offset: 0,
    monitored: true,
    libraryFilter: "spatial",
    provider: "apple-music",
  });
  assert.deepEqual(spatial.items.map((track) => track.id), ["track-atmos"]);

  const files = trackQuery.getTrackFiles("track-1");
  assert.equal(files.length, 1);
  assert.equal(files[0]?.canonical_track_mbid, "track-1");
  assert.equal(files[0]?.library_slot, "stereo");
});
