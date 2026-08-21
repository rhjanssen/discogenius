import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-index-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let AlbumLibraryIndexService: typeof import("./album-library-index-service.js").AlbumLibraryIndexService;
let TrackLibraryIndexService: typeof import("./track-library-index-service.js").TrackLibraryIndexService;
let ALBUM_LIBRARY_INDEX_JOIN_SQL: typeof import("./album-library-index-service.js").ALBUM_LIBRARY_INDEX_JOIN_SQL;
let TRACK_LIBRARY_INDEX_INSERT_SQL: typeof import("./track-library-index-service.js").TRACK_LIBRARY_INDEX_INSERT_SQL;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  ({ AlbumLibraryIndexService, ALBUM_LIBRARY_INDEX_JOIN_SQL } = await import("./album-library-index-service.js"));
  ({ TrackLibraryIndexService, TRACK_LIBRARY_INDEX_INSERT_SQL } = await import("./track-library-index-service.js"));
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("track library index classifies spatial vs stereo once per library", () => {
  assert.match(TRACK_LIBRARY_INDEX_INSERT_SQL, /library_class AS MATERIALIZED/);
  assert.match(TRACK_LIBRARY_INDEX_INSERT_SQL, /library_class\.is_spatial = 0/);
  assert.match(TRACK_LIBRARY_INDEX_INSERT_SQL, /library_class\.is_spatial = 1/);
  assert.equal((TRACK_LIBRARY_INDEX_INSERT_SQL.match(/json_each/g) || []).length, 1);
});

test("album library index joins LibraryEditions through the album's editions", () => {
  assert.match(
    ALBUM_LIBRARY_INDEX_JOIN_SQL,
    /AlbumEditions release\s+ON release\.release_group_id = library_group\.release_group_id/,
  );
  assert.match(
    ALBUM_LIBRARY_INDEX_JOIN_SQL,
    /library_release\.edition_id = release\.id/,
  );
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
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerTrack.id, member.id, releaseMatch.id, track.id, recording.id) as { id: number };
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
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 1, 'test', 1)
  `).run(library.id, releaseGroup.id);
  const libraryRelease = db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(db, { libraryEditionId: libraryRelease.id, provider: 'tidal' }) as { id: number };
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
      SELECT included, monitored_lock,
             has_stereo_provider, has_spatial_provider
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    {
      included: 1,
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
  // Provider variants are source capability. The index reads the library
  // quality profile, so a variant UPDATE must not wipe the projection.
  assert.equal(AlbumLibraryIndexService.isReady(), true);
  assert.equal(TrackLibraryIndexService.isReady(), true);

  db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('group-catalog-only', ?, 'artist-1', 'Catalog Only')
  `).run(artist.id);
  assert.equal(AlbumLibraryIndexService.isReady(), true);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM AlbumLibraryIndex`).get() as { n: number }).n,
    1,
  );

  const releaseGroup2 = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('group-2', ?, 'artist-1', 'Second Library Album')
    RETURNING id
  `).get(artist.id) as { id: number };
  const release2 = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title
    ) VALUES ('release-2', ?, 'group-2', ?, 'artist-1', 'Second Library Album')
    RETURNING id
  `).get(releaseGroup2.id, artist.id) as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup2.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(library.id, release2.id);
  assert.deepEqual(AlbumLibraryIndexService.rebuild(), { rows: 2 });

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
  assert.equal(AlbumLibraryIndexService.isReady(), true);
  assert.equal(TrackLibraryIndexService.isReady(), true);
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

  // Unmonitoring is the row going away — the index then has nothing to include.
  db.prepare(`
    DELETE FROM LibraryEditions WHERE library_id = ?
  `).run(library.id);
  db.prepare(`
    DELETE FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?
  `).run(library.id, releaseGroup.id);
  AlbumLibraryIndexService.rebuild();
  assert.deepEqual(TrackLibraryIndexService.rebuild(), { rows: 0 });
  assert.equal(
    db.prepare(`
      SELECT included
      FROM AlbumLibraryIndex
      WHERE release_group_id = ?
    `).get(releaseGroup.id),
    undefined,
  );
});
