import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let albumQueryModule: typeof import("./album-query-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  albumQueryModule = await import("./album-query-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM AlbumLibraryProjectionState").run();
  db.prepare("DELETE FROM AlbumLibraryIndex").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderEditionMatches").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ArtistReleaseGroupCuration").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedAlbum(options: {
  mbid: string;
  title: string;
  stereoProvider: string;
  stereoQuality: string;
  spatialProvider: string;
  spatialQuality: string;
}): void {
  const { db } = dbModule;
  const artistMbid = "artist-mbid";
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Filter Artist')
  `).run(artistMbid);
  db.prepare(`
    INSERT OR IGNORE INTO Artists (id, mbid, name, monitored)
    VALUES (?, ?, 'Filter Artist', 1)
  `).run(artistMbid, artistMbid);

  const album = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, 'Album', '2026-01-01')
    RETURNING id
  `).get(options.mbid, artistMbid, options.title) as { id: number };

  db.prepare(`
    INSERT INTO ArtistReleaseGroupCuration (
      source_artist_mbid, release_group_id, release_group_mbid, included
    ) VALUES (?, ?, ?, 1)
  `).run(artistMbid, album.id, options.mbid);

  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES (?, ?, ?, ?, ?, 1)
    RETURNING id
  `).get(
    `${options.mbid}-release`,
    album.id,
    options.mbid,
    artistMbid,
    options.title,
  ) as { id: number };

  const insertOffer = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, quality, provider_url
    ) VALUES (?, 'release', ?, ?, ?)
    RETURNING id
  `);
  const stereoOffer = insertOffer.get(
    options.stereoProvider,
    `${options.mbid}-stereo`,
    options.stereoQuality,
    `https://example.test/${options.stereoProvider}/albums/${options.mbid}-stereo`,
  ) as { id: number };
  const spatialOffer = insertOffer.get(
    options.spatialProvider,
    `${options.mbid}-spatial`,
    options.spatialQuality,
    `https://example.test/${options.spatialProvider}/albums/${options.mbid}-spatial`,
  ) as { id: number };

  const insertMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `);
  const stereoMatch = insertMatch.get(stereoOffer.id, release.id) as { id: number };
  const spatialMatch = insertMatch.get(spatialOffer.id, release.id) as { id: number };

  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Album Query Test', '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO quality_profiles (
      name, upgrade_allowed, cutoff, items, allowed_source_formats,
      preference_order, continue_upgrades, fallback_policy,
      output_format, transcode_policy
    ) VALUES (
      'Album Query Spatial', 0, 'DOLBY_ATMOS', '["DOLBY_ATMOS"]',
      '["spatial"]', '["spatial"]', 0, 'best_allowed',
      '{"codec":"preserve"}', 'preserve'
    )
  `).run();
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = 'Album Query Test'
  `).get() as { id: number };
  const nonspatialQualityProfile = db.prepare(`
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
  const spatialQualityProfile = db.prepare(`
    SELECT id FROM quality_profiles WHERE name = 'Album Query Spatial'
  `).get() as { id: number };
  const insertLibrary = db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    ) VALUES (?, ?, ?, ?, 1)
  `);
  insertLibrary.run(
    "Album Query Nonspatial",
    path.join(tempDir, "libraries", "nonspatial"),
    metadataProfile.id,
    nonspatialQualityProfile.id,
  );
  insertLibrary.run(
    "Album Query Spatial",
    path.join(tempDir, "libraries", "spatial"),
    metadataProfile.id,
    spatialQualityProfile.id,
  );

  const libraries = db.prepare(`
    SELECT id, name
    FROM Libraries
    WHERE name IN ('Album Query Nonspatial', 'Album Query Spatial')
  `).all() as Array<{ id: number; name: string }>;
  for (const library of libraries) {
    db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, monitored, selection_mode, locked,
        curation_version
      ) VALUES (?, ?, 1, 'auto', 0, 1)
    `).run(library.id, album.id);
    const libraryRelease = db.prepare(`
      INSERT INTO LibraryEditions (
        library_id, edition_id, selection_mode, locked, curation_version
      ) VALUES (?, ?, 'auto', 0, 1)
      RETURNING id
    `).get(library.id, release.id) as { id: number };
    const spatial = library.name === "Album Query Spatial";
    const plan = db.prepare(`
      INSERT INTO AcquisitionPlans (
        library_edition_id, provider, composition, download_mode, state,
        planner_version, policy_hash, computed_at
      ) VALUES (?, ?, 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
      RETURNING id
    `).get(
      libraryRelease.id,
      spatial ? options.spatialProvider : options.stereoProvider,
    ) as { id: number };
    db.prepare(`
      INSERT INTO AcquisitionPlanSources (
        plan_id, provider_edition_match_id, role, sort_order
      ) VALUES (?, ?, 'primary', 0)
    `).run(plan.id, spatial ? spatialMatch.id : stereoMatch.id);
  }
}

test("album list carries selected provider permalinks through the indexed detail path", async () => {
  seedAlbum({
    mbid: "linked-album",
    title: "Linked Album",
    stereoProvider: "soundcloud",
    stereoQuality: "SOUNDCLOUD_LOSSY",
    spatialProvider: "apple-music",
    spatialQuality: "DOLBY_ATMOS",
  });
  const { AlbumLibraryIndexService } = await import("./album-library-index-service.js");
  AlbumLibraryIndexService.rebuild();

  const result = albumQueryModule.AlbumQueryService.listAlbums({
    limit: 20,
    offset: 0,
  });

  assert.equal(
    result.items[0]?.stereo_provider_url,
    "https://example.test/soundcloud/albums/linked-album-stereo",
  );
});

test("provider and quality filters must be satisfied by the same selected library", () => {
  seedAlbum({
    mbid: "cross-slot-album",
    title: "Cross Slot",
    stereoProvider: "tidal",
    stereoQuality: "HIRES_LOSSLESS",
    spatialProvider: "apple-music",
    spatialQuality: "DOLBY_ATMOS",
  });
  seedAlbum({
    mbid: "same-slot-album",
    title: "Same Slot",
    stereoProvider: "apple-music",
    stereoQuality: "HIRES_LOSSLESS",
    spatialProvider: "tidal",
    spatialQuality: "DOLBY_ATMOS",
  });

  const result = albumQueryModule.AlbumQueryService.listAlbums({
    limit: 20,
    offset: 0,
    provider: "apple-music",
    qualityTier: "MAX",
  });

  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map((album) => album.id), ["same-slot-album"]);
});
