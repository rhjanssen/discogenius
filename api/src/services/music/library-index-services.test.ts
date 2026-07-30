import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-index-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let AlbumLibraryIndexService: typeof import("./album-library-index-service.js").AlbumLibraryIndexService;
let TrackLibraryIndexService: typeof import("./track-library-index-service.js").TrackLibraryIndexService;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  ({ AlbumLibraryIndexService } = await import("./album-library-index-service.js"));
  ({ TrackLibraryIndexService } = await import("./track-library-index-service.js"));
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("library indexes derive monitoring, selected tracks, and quality from normalized authorities", () => {
  const { db } = dbModule;

  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-1', 'Index Artist')
    RETURNING id
  `).get() as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('group-1', ?, 'artist-1', 'Index Album')
    RETURNING id
  `).get(artist.id) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title
    ) VALUES ('release-1', ?, 'group-1', ?, 'artist-1', 'Index Album')
    RETURNING id
  `).get(releaseGroup.id, artist.id) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, artist_metadata_id, artist_mbid, title, popularity)
    VALUES ('recording-1', ?, 'artist-1', 'Index Track', 42)
    RETURNING id
  `).get(artist.id) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title
    ) VALUES ('track-1', ?, 'release-1', ?, 'recording-1', 1, 1, 'Index Track')
    RETURNING id
  `).get(release.id, recording.id) as { id: number };

  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', 'provider-release-1', 'Index Album')
    RETURNING id
  `).get() as { id: number };
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', 'provider-track-1', 'Index Track')
    RETURNING id
  `).get() as { id: number };
  const member = db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, release.id) as { id: number };
  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(member.id, releaseMatch.id, track.id, recording.id) as { id: number };
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, availability
    ) VALUES (?, 'lossless', 'lossless', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };

  const library = db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked,
      reason, curation_version
    ) VALUES (?, ?, 1, 'auto', 1, 'test', 1)
  `).run(library.id, releaseGroup.id);
  const libraryRelease = db.prepare(`
    INSERT INTO LibraryReleases (
      library_id, edition_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number };
  const plan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_release_id, provider, composition, download_mode, state,
      planner_version, policy_hash, computed_at
    ) VALUES (?, 'tidal', 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
    RETURNING id
  `).get(libraryRelease.id) as { id: number };
  const source = db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.id) as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(plan.id, track.id, source.id, trackMatch.id, variant.id);

  assert.deepEqual(AlbumLibraryIndexService.rebuild(), { rows: 1 });
  assert.deepEqual(TrackLibraryIndexService.rebuild(), { rows: 1 });
  assert.deepEqual(
    db.prepare(`
      SELECT included, monitored, monitored_lock,
             has_stereo_provider, has_spatial_provider
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    {
      included: 1,
      monitored: 1,
      monitored_lock: 1,
      has_stereo_provider: 1,
      has_spatial_provider: 0,
    },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT popularity, downloaded, has_stereo, has_spatial
      FROM TrackLibraryIndex
      WHERE track_id = ?
    `).get(track.id),
    {
      popularity: 42,
      downloaded: 0,
      has_stereo: 1,
      has_spatial: 0,
    },
  );

  db.prepare(`
    UPDATE ProviderItemAudioVariants
    SET quality_class = 'spatial'
    WHERE id = ?
  `).run(variant.id);
  assert.equal(AlbumLibraryIndexService.isReady(), false);
  assert.equal(TrackLibraryIndexService.isReady(), false);

  AlbumLibraryIndexService.rebuild();
  TrackLibraryIndexService.rebuild();
  assert.deepEqual(
    db.prepare(`
      SELECT has_stereo_provider, has_spatial_provider
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    { has_stereo_provider: 1, has_spatial_provider: 0 },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT has_stereo, has_spatial
      FROM TrackLibraryIndex
      WHERE track_id = ?
    `).get(track.id),
    { has_stereo: 1, has_spatial: 0 },
  );

  // The library profile, not an individual source variant, classifies the
  // selected media as nonspatial or spatial.
  const spatialProfile = db.prepare(`
    INSERT INTO quality_profiles (
      name, upgrade_allowed, cutoff, items, allowed_source_formats,
      preference_order, continue_upgrades, fallback_policy,
      output_format, transcode_policy
    ) VALUES (
      'Index Spatial', 0, 'DOLBY_ATMOS', '["DOLBY_ATMOS"]',
      '["spatial"]', '["spatial"]', 0, 'best_allowed',
      '{"codec":"preserve"}', 'preserve'
    )
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    UPDATE Libraries SET quality_profile_id = ? WHERE id = ?
  `).run(spatialProfile.id, library.id);
  AlbumLibraryIndexService.rebuild();
  TrackLibraryIndexService.rebuild();
  assert.deepEqual(
    db.prepare(`
      SELECT has_stereo_provider, has_spatial_provider
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    { has_stereo_provider: 0, has_spatial_provider: 1 },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT has_stereo, has_spatial
      FROM TrackLibraryIndex
      WHERE track_id = ?
    `).get(track.id),
    { has_stereo: 0, has_spatial: 1 },
  );

  db.prepare(`
    UPDATE LibraryReleaseGroups
    SET monitored = 0
    WHERE library_id = ? AND release_group_id = ?
  `).run(library.id, releaseGroup.id);
  AlbumLibraryIndexService.rebuild();
  assert.deepEqual(TrackLibraryIndexService.rebuild(), { rows: 0 });
  assert.deepEqual(
    db.prepare(`
      SELECT included, monitored
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    { included: 1, monitored: 0 },
  );
});
