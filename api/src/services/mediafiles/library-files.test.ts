import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedAcceptedProviderTrackMatch } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-files-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let artistPathsModule: typeof import("../music/artist-paths.js");
let downloadStateModule: typeof import("../download/download-state.js");
let libraryStatsModule: typeof import("../music/library-stats-query-service.js");
let libraryScanModule: typeof import("./library-scan.js");
let audioLibraryPathModule: typeof import("./audio-library-path.js");
let artistStatisticsModule: typeof import("../music/artist-statistics-service.js");

function writeTestConfig(overrides?: {
  artistFolder?: string;
  albumTrackPathSingle?: string;
  createEmptyArtistFolders?: boolean;
  includeSpatial?: boolean;
  includeVideos?: boolean;
}) {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.spatial_path = path.join(tempDir, "library", "spatial");
  config.path.video_path = path.join(tempDir, "library", "videos");
  if (overrides?.artistFolder) {
    config.naming.artist_folder = overrides.artistFolder;
  }
  if (overrides?.albumTrackPathSingle) {
    config.naming.album_track_path_single = overrides.albumTrackPathSingle;
  }
  if (overrides?.createEmptyArtistFolders !== undefined) {
    config.path.create_empty_artist_folders = overrides.createEmptyArtistFolders;
  }
  if (overrides?.includeSpatial !== undefined) {
    config.filtering.include_spatial = overrides.includeSpatial;
  }
  if (overrides?.includeVideos !== undefined) {
    config.filtering.include_videos = overrides.includeVideos;
  }
  configModule.writeConfig(config);
}

function seedLibraryReleaseSelection(options: {
  key: string;
  releaseGroupMbid: string;
  releaseMbid: string;
  monitored: boolean;
  spatial?: boolean;
  rootPath?: string;
}): number {
  const { db } = dbModule;
  const metadataProfileName = `Library Files ${options.key}`;
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES (?, '{}')
  `).run(metadataProfileName);
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = ?
  `).get(metadataProfileName) as { id: number };

  let qualityProfile: { id: number };
  if (options.spatial) {
    const qualityProfileName = `Library Files Spatial ${options.key}`;
    db.prepare(`
      INSERT OR IGNORE INTO quality_profiles (
        name, upgrade_allowed, cutoff, items, allowed_source_formats,
        preference_order, continue_upgrades, fallback_policy,
        output_format, transcode_policy
      ) VALUES (?, 0, 'DOLBY_ATMOS', '["DOLBY_ATMOS"]', '["spatial"]',
        '["spatial"]', 0, 'best_allowed', '{"codec":"preserve"}', 'preserve')
    `).run(qualityProfileName);
    qualityProfile = db.prepare(`
      SELECT id FROM quality_profiles WHERE name = ?
    `).get(qualityProfileName) as { id: number };
  } else {
    qualityProfile = db.prepare(`
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
  }

  const rootPath = options.rootPath ?? path.join(tempDir, "normalized-libraries", options.key);
  db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    ) VALUES (?, ?, ?, ?, 1)
  `).run(`Library Files ${options.key}`, rootPath, metadataProfile.id, qualityProfile.id);
  const library = db.prepare(`
    SELECT id FROM Libraries WHERE root_path = ?
  `).get(rootPath) as { id: number };
  const releaseGroup = db.prepare(`
    SELECT id FROM Albums WHERE mbid = ?
  `).get(options.releaseGroupMbid) as { id: number };
  const release = db.prepare(`
    SELECT id FROM AlbumEditions WHERE mbid = ?
  `).get(options.releaseMbid) as { id: number };

  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked,
      curation_version
    ) VALUES (?, ?, ?, 'auto', 0, 1)
  `).run(library.id, releaseGroup.id, options.monitored ? 1 : 0);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, locked, curation_version
    ) VALUES (?, ?, 'auto', 0, 1)
  `).run(library.id, release.id);
  return library.id;
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../../database.js");
  dbModule.initDatabase();

  configModule = await import("../config/config.js");
  libraryFilesModule = await import("./library-files.js");
  artistPathsModule = await import("../music/artist-paths.js");
  downloadStateModule = await import("../download/download-state.js");
  libraryStatsModule = await import("../music/library-stats-query-service.js");
  libraryScanModule = await import("./library-scan.js");
  audioLibraryPathModule = await import("./audio-library-path.js");
  artistStatisticsModule = await import("../music/artist-statistics-service.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM LyricFiles").run();
  db.prepare("DELETE FROM MetadataFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();

  downloadStateModule?.invalidateAllDownloadState();
  libraryStatsModule?.LibraryStatsQueryService.clearCache();

  writeTestConfig();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("computeExpectedPath keeps the stored artist folder canonical when naming changes", () => {
  writeTestConfig({
    artistFolder: "{artistName} [{artistMbId}]",
    albumTrackPathSingle: "{albumTitle}/{trackNumber00} - {trackTitle}",
  });

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid-1", "Queen");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen (legacy-folder)", 1);

  // Canonical graph (post-DB-alignment: naming resolves from canonical tables).
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date) VALUES (?, ?, ?, ?, ?)")
    .run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album", "1975-11-21");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", 1, 1, "1975-11-21");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid) VALUES (?, ?, ?)")
    .run("recording-mbid-1", "Bohemian Rhapsody", "artist-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Bohemian Rhapsody");
  // Provider availability mapped to the canonical ids (no legacy ProviderAlbums/ProviderMedia rows).
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', '10', 'A Night at the Opera')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', '100', 'Bohemian Rhapsody')
  `).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "10",
    providerTrackId: "100",
    releaseMbid: "release-mbid-1",
    trackMbid: "track-mbid-1",
  });

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 500,
    artist_id: "1" as unknown as number,
    album_id: "10" as unknown as number,
    media_id: "100" as unknown as number,
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "rg-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    canonical_track_mbid: "track-mbid-1",
    canonical_recording_mbid: "recording-mbid-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "100",
    library_slot: "stereo",
    file_path: path.join(tempDir, "legacy", "Queen", "old.flac"),
    relative_path: null,
    library_root: "music",
    file_type: "track",
    extension: "flac",
  });

  const expectedRoot = path.join(configModule.Config.getMusicPath(), "Queen (legacy-folder)");
  assert.ok(expected.expectedPath);
  assert.ok(expected.expectedPath?.startsWith(expectedRoot));
  assert.ok(!expected.expectedPath?.includes("Queen [artist-mbid-1]"));
});

test("computeExpectedPath prefers canonical release-group and track metadata over provider naming", () => {
  writeTestConfig({
    albumTrackPathSingle: "{albumTitle}/{trackNumber00} - {trackTitle}",
  });

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid-1", "Queen");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, path, monitored) VALUES (?, ?, ?, ?, ?)")
    .run("1", "Queen", "artist-mbid-1", "Queen", 1);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)")
    .run("rg-mbid-1", "artist-mbid-1", "Canonical Group Title", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "Edition-Specific Title", 1, 1);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title) VALUES (?, ?)")
    .run("recording-mbid-1", "Canonical Recording");
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 7, "7", "Canonical Track Title");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', '10', 'provider Album Title')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', '100', 'provider Track Title')
  `).run();

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 500,
    artist_id: "1" as unknown as number,
    album_id: "10" as unknown as number,
    media_id: "100" as unknown as number,
    file_path: path.join(tempDir, "legacy.flac"),
    relative_path: null,
    library_root: "music",
    library_slot: "stereo",
    file_type: "track",
    extension: "flac",
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "rg-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    canonical_track_mbid: "track-mbid-1",
    canonical_recording_mbid: "recording-mbid-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "100",
  });

  assert.equal(
    expected.expectedPath,
    path.join(configModule.Config.getMusicPath(), "Queen", "Canonical Group Title", "07 - Canonical Track Title.flac"),
  );
});

test("unified audio roots allow different extensions and disambiguate only real spatial conflicts", () => {
  const unifiedRoot = path.join(tempDir, "library", "unified");

  assert.equal(
    audioLibraryPathModule.renderAudioRelativePathForLibrary({
      relativePath: path.join("Album", "01 - Example Track"),
      quality: "DOLBY_ATMOS",
      musicRoot: unifiedRoot,
      spatialRoot: unifiedRoot,
    }),
    path.join("Album", "01 - Example Track"),
  );

  assert.equal(
    audioLibraryPathModule.renderAudioRelativePathForLibrary({
      relativePath: path.join("Album", "01 - Example Track"),
      quality: "DOLBY_ATMOS",
      musicRoot: unifiedRoot,
      spatialRoot: unifiedRoot,
      mustDisambiguate: true,
    }),
    path.join("Album", "01 - Example Track [DOLBY_ATMOS]"),
  );

  assert.equal(
    audioLibraryPathModule.renderAudioRelativePathForLibrary({
      relativePath: path.join("Album", "01 - Example Track"),
      quality: "LOSSLESS",
      musicRoot: unifiedRoot,
      spatialRoot: unifiedRoot,
    }),
    path.join("Album", "01 - Example Track"),
  );
});

test("resolveArtistFolderForPersistence disambiguates same-name artists with numeric suffixes outside the repository layer", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Phoenix", "Phoenix", 1);

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: "2",
    artistName: "Phoenix",
  });

  assert.equal(resolved, "Phoenix (1)");
});

test("resolveArtistFolderForPersistence prefers MusicBrainz disambiguation for same-name artist collisions", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Phoenix", "Phoenix", 1);

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: "2",
    artistName: "Phoenix",
    artistDisambiguation: "French band",
  });

  assert.equal(resolved, "Phoenix (French band)");
});

test("ensureEmptyArtistFoldersIfEnabled creates only stereo folders when spatial/video are disabled", () => {
  writeTestConfig({
    createEmptyArtistFolders: true,
    includeSpatial: false,
    includeVideos: false,
  });

  const ensured = artistPathsModule.ensureEmptyArtistFoldersIfEnabled(path.join("Bastille {mbid-artist-mbid-1}"));

  assert.equal(ensured.length, 1);
  assert.ok(fs.existsSync(path.join(configModule.Config.getMusicPath(), "Bastille {mbid-artist-mbid-1}")));
  assert.equal(fs.existsSync(path.join(configModule.Config.getSpatialPath(), "Bastille {mbid-artist-mbid-1}")), false);
  assert.equal(fs.existsSync(path.join(configModule.Config.getVideoPath(), "Bastille {mbid-artist-mbid-1}")), false);
});

test("ensureEmptyArtistFoldersIfEnabled creates spatial and video folders when those features are enabled", () => {
  writeTestConfig({
    createEmptyArtistFolders: true,
    includeSpatial: true,
    includeVideos: true,
  });

  const ensured = artistPathsModule.ensureEmptyArtistFoldersIfEnabled(path.join("Bastille {mbid-artist-mbid-1}"));

  assert.equal(ensured.length, 3);
  assert.ok(fs.existsSync(path.join(configModule.Config.getMusicPath(), "Bastille {mbid-artist-mbid-1}")));
  assert.ok(fs.existsSync(path.join(configModule.Config.getSpatialPath(), "Bastille {mbid-artist-mbid-1}")));
  assert.ok(fs.existsSync(path.join(configModule.Config.getVideoPath(), "Bastille {mbid-artist-mbid-1}")));
});

test("removeEmptyParents prunes nested empty download folders up to the stop directory", () => {
  const downloadRoot = path.join(tempDir, "downloads-prune");
  const jobDir = path.join(downloadRoot, "tidal", "12345", "album", "job_abc");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.rmdirSync(jobDir);

  libraryFilesModule.removeEmptyParents(path.dirname(jobDir), downloadRoot);

  assert.equal(fs.existsSync(path.join(downloadRoot, "tidal", "12345", "album")), false);
  assert.equal(fs.existsSync(path.join(downloadRoot, "tidal", "12345")), false);
  assert.equal(fs.existsSync(path.join(downloadRoot, "tidal")), false);
  assert.ok(fs.existsSync(downloadRoot));
});

test("removeEmptyParents prunes empty video job trees under downloads/videos", () => {
  const downloadRoot = path.join(tempDir, "downloads-videos-prune");
  const jobDir = path.join(downloadRoot, "videos", "tidal", "99999", "job_42");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.rmdirSync(jobDir);

  libraryFilesModule.removeEmptyParents(path.dirname(jobDir), downloadRoot);

  assert.equal(fs.existsSync(path.join(downloadRoot, "videos", "tidal", "99999")), false);
  assert.equal(fs.existsSync(path.join(downloadRoot, "videos", "tidal")), false);
  assert.equal(fs.existsSync(path.join(downloadRoot, "videos")), false);
  assert.ok(fs.existsSync(downloadRoot));
});

test("resolveArtistFolderForPersistence reuses the canonical folder for provider rows with the same MusicBrainz artist", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "artist-mbid-1",
    "Bastille",
    "artist-mbid-1",
    "Bastille {mbid-artist-mbid-1}",
    1,
  );

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "artist-mbid-1",
  });

  assert.equal(resolved, "Bastille {mbid-artist-mbid-1}");
});

test("resolveArtistFolderForPersistence avoids nested folder collisions for generated artist paths", () => {
  writeTestConfig({ artistFolder: "Artists/{artistName}" });

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Air", "Artists", 1);

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: "2",
    artistName: "Air",
  });

  assert.equal(resolved, path.join("Artists (1)", "Air"));
});

test("shouldReapplyArtistPathTemplate detects legacy generated folders once artist MBIDs exist", () => {
  writeTestConfig({ artistFolder: "{artistName} [{artistMbId}]" });

  const shouldReapply = artistPathsModule.shouldReapplyArtistPathTemplate({
    artistId: "1",
    artistName: "Queen",
    artistMbId: "artist-mbid-1",
    existingPath: "Queen",
  });

  assert.equal(shouldReapply, true);
});

test("shouldReapplyArtistPathTemplate detects obsolete provider-id disambiguators for canonical artists", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  const shouldReapply = artistPathsModule.shouldReapplyArtistPathTemplate({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "artist-mbid-1",
    existingPath: "Bastille {mbid-artist-mbid-1} (4526830)",
  });

  assert.equal(shouldReapply, true);
});

test("resolveArtistFolderForIdentityUpdate replaces generated legacy folders after MBID resolution", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  const resolved = artistPathsModule.resolveArtistFolderForIdentityUpdate({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "7808accb-6395-4b25-858c-678bbb73896b",
    existingPath: "Bastille",
  });

  assert.equal(resolved.shouldReplaceExistingPath, true);
  assert.equal(resolved.path, "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}");
});

test("resolveArtistFolderForIdentityUpdate preserves custom folders after MBID resolution", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  const resolved = artistPathsModule.resolveArtistFolderForIdentityUpdate({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "7808accb-6395-4b25-858c-678bbb73896b",
    existingPath: path.join("Indie", "Bastille"),
  });

  assert.equal(resolved.shouldReplaceExistingPath, false);
  assert.equal(resolved.path, path.join("Indie", "Bastille"));
});

test("upsertLibraryFile stores canonical MusicBrainz and provider identity for imported tracks", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", 1);
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `).run("recording-mbid-1", "Bohemian Rhapsody");
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Bohemian Rhapsody");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen", 1);
  // Provider availability rows supply the streaming identity; TrackFiles links
  // through canonical MBIDs/catalog FKs plus provider provenance.

dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', '10', 'A Night at the Opera')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', '100', 'Bohemian Rhapsody')
  `).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "10",
    providerTrackId: "100",
    releaseMbid: "release-mbid-1",
    trackMbid: "track-mbid-1",
  });
  const libraryId = seedLibraryReleaseSelection({
    key: "identity-stereo",
    releaseGroupMbid: "rg-mbid-1",
    releaseMbid: "release-mbid-1",
    monitored: true,
    rootPath: configModule.Config.getMusicPath(),
  });

  const filePath = path.join(configModule.Config.getMusicPath(), "Queen", "01 - Bohemian Rhapsody.flac");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    libraryId,
    albumId: "10",
    mediaId: "100",
    filePath,
    libraryRoot: configModule.Config.getMusicPath(),
    fileType: "track",
    quality: "LOSSLESS",
  });

  const row = dbModule.db.prepare(`
    SELECT
      canonical_artist_mbid,
      canonical_release_group_mbid,
      canonical_release_mbid,
      canonical_track_mbid,
      canonical_recording_mbid,
      provider,
      provider_entity_type,
      provider_id,
      library_slot
    FROM TrackFiles
    WHERE id = ?
  `).get(id) as Record<string, string | null>;

  assert.deepEqual(row, {
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "rg-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    canonical_track_mbid: "track-mbid-1",
    canonical_recording_mbid: "recording-mbid-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "100",
    library_slot: "stereo",
  });

  const stats = downloadStateModule.getReleaseGroupDownloadStatsMap(["rg-mbid-1"]).get("rg-mbid-1");
  assert.equal(stats?.totalTracks, 1);
  assert.equal(stats?.downloadedTracks, 1);
  assert.equal(stats?.isDownloaded, true);
});

test("upsertLibraryFile uses accepted typed matches instead of provider shadow identity", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-local", "Bastille", "artist-mbid-1", "Bastille {mbid-artist-mbid-1}", 1);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "artist-mbid-1", "Give Me The Future", "album", null);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, country, status, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-release-mbid",
    "release-group-mbid-1",
    "artist-mbid-1",
    "Give Me The Future",
    "2022-02-04",
    "US",
    "official",
    1,
    1,
    "selected-release-mbid",
    "release-group-mbid-1",
    "artist-mbid-1",
    "Give Me The Future + Dreams Of The Past",
    "2022-08-26",
    "XW",
    "official",
    1,
    1,
  );
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, ?)
  `).run("recording-mbid-1", "artist-mbid-1", "Shut Off The Lights", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, recording_mbid, release_mbid, medium_position, position, title)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("selected-track-mbid", "recording-mbid-1", "selected-release-mbid", 1, 1, "Shut Off The Lights");
  // Provider availability rows intentionally point at a different provider
  // release so the selected MusicBrainz release-group identity wins.

dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
  `).run( "tidal", "release", "provider-album-1", "Give Me The Future" );
  // Track offer carries the recording mbid; the selected slot resolves the exact
  // release/track (preferring the selected-release over the offer's legacy release).
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', 'provider-track-1', 'Shut Off The Lights')
  `).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "provider-album-1",
    providerTrackId: "provider-track-1",
    releaseMbid: "selected-release-mbid",
    trackMbid: "selected-track-mbid",
  });

  const root = configModule.Config.getMusicPath();
  const filePath = path.join(root, "Bastille {mbid-artist-mbid-1}", "Give Me The Future", "01 - Shut Off The Lights.flac");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "artist-local",
    albumId: "provider-album-1",
    mediaId: "provider-track-1",
    filePath,
    libraryRoot: root,
    fileType: "track",
    quality: "LOSSLESS",
  });

  const row = dbModule.db.prepare(`
    SELECT canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    FROM TrackFiles
    WHERE id = ?
  `).get(id) as Record<string, string | null>;

  assert.deepEqual(row, {
    canonical_release_mbid: "selected-release-mbid",
    canonical_track_mbid: "selected-track-mbid",
    canonical_recording_mbid: "recording-mbid-1",
  });
});

test("upsertLibraryFile does not invent provider ids for canonical artist assets", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-local", "Bastille", "artist-mbid-1", "Bastille {mbid-artist-mbid-1}", 1);

  const root = configModule.Config.getMusicPath();
  const filePath = path.join(root, "Bastille {mbid-artist-mbid-1}", "folder.jpg");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "artist-local",
    albumId: null,
    mediaId: null,
    filePath,
    libraryRoot: root,
    fileType: "cover",
    quality: null,
  });

  const row = dbModule.db.prepare(`
    SELECT provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id
    FROM MetadataFiles
    WHERE id = ?
  `).get(id) as Record<string, string | null>;

  assert.deepEqual(row, {
    provider: null,
    provider_entity_type: "artist",
    provider_id: null,
  });
});

test("disk scan relinks album covers and renamed lyrics to their provider album and track", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-local", "Bastille", "artist-mbid-1", "Bastille {mbid-artist-mbid-1}", 1);

  const releaseItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    RETURNING id
  `).get("tidal", "release", "provider-album-1", "SAVE MY SOUL") as { id: number };
  const trackItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    RETURNING id
  `).get("tidal", "track", "provider-track-1", "SAVE MY SOUL") as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(releaseItem.id, trackItem.id);
  // Scope the provider release/track to the managed artist through the typed
  // credit chain, the way real ingestion does.
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid-1', 'Bastille')
  `).run();
  const artistMeta = dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-1'")
    .get() as { id: number };
  const artistItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'artist', 'provider-artist-1', 'Bastille')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderArtistMatches (
      provider_artist_item_id, artist_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(artistItem.id, artistMeta.id);
  for (const itemId of [releaseItem.id, trackItem.id]) {
    dbModule.db.prepare(`
      INSERT INTO ProviderItemCredits (item_id, artist_item_id, ordinal, credited_name)
      VALUES (?, ?, 0, 'Bastille')
    `).run(itemId, artistItem.id);
  }

  const root = configModule.Config.getMusicPath();
  const albumDir = path.join(root, "Bastille {mbid-artist-mbid-1}", "SAVE MY SOUL (2025)");
  const audioPath = path.join(albumDir, "Track 01 - SAVE MY SOUL.flac");
  const lyricPath = path.join(albumDir, "Track 01 - SAVE MY SOUL.txt");
  const coverPath = path.join(albumDir, "cover.jpg");
  fs.mkdirSync(albumDir, { recursive: true });
  fs.writeFileSync(audioPath, "audio");
  fs.writeFileSync(lyricPath, "lyrics");
  fs.writeFileSync(coverPath, "cover");

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "artist-local",
    albumId: "provider-album-1",
    mediaId: "provider-track-1",
    filePath: audioPath,
    libraryRoot: root,
    fileType: "track",
    quality: "LOSSLESS",
  });

  const matchFileToMedia = (libraryScanModule.DiskScanService as any).matchFileToMedia.bind(libraryScanModule.DiskScanService);
  assert.deepEqual(matchFileToMedia(coverPath, "artist-local", "music"), {
    albumId: "provider-album-1",
    mediaId: null,
    fileType: "cover",
    quality: null,
  });
  assert.deepEqual(matchFileToMedia(lyricPath, "artist-local", "music"), {
    albumId: "provider-album-1",
    mediaId: "provider-track-1",
    fileType: "lyrics",
    quality: null,
  });
});

test("upsertLibraryFile links lyric sidecars through TrackFiles provider identity", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Queen", "Queen", 1);

  const root = configModule.Config.getMusicPath();
  const albumDir = path.join(root, "Queen", "A Night at the Opera");
  const audioPath = path.join(albumDir, "01 - Bohemian Rhapsody.flac");
  const lyricPath = path.join(albumDir, "01 - Bohemian Rhapsody.lrc");
  fs.mkdirSync(albumDir, { recursive: true });
  fs.writeFileSync(audioPath, "audio");
  fs.writeFileSync(lyricPath, "lyrics");

  const trackFileId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: audioPath,
    libraryRoot: root,
    fileType: "track",
    quality: "LOSSLESS",
    provider: "tidal",
    providerEntityType: "track",
    providerId: "100",
    librarySlot: "stereo",
  });

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: lyricPath,
    libraryRoot: root,
    fileType: "lyrics",
    quality: "LOSSLESS",
    provider: "tidal",
    providerEntityType: "track",
    providerId: "100",
    librarySlot: "stereo",
  });

  const lyric = dbModule.db.prepare(`
    SELECT canonical_track_mbid AS canonicalTrackMbid,
           canonical_recording_mbid AS canonicalRecordingMbid,
           provider_id AS providerId,
           track_file_id AS trackFileId
    FROM LyricFiles
    WHERE file_path = ?
  `).get(lyricPath) as {
    canonicalTrackMbid: string | null;
    canonicalRecordingMbid: string | null;
    providerId: string | null;
    trackFileId: number | null;
  } | undefined;

  assert.equal(lyric?.canonicalTrackMbid, null);
  assert.equal(lyric?.canonicalRecordingMbid, null);
  assert.equal(lyric?.providerId, "100");
  assert.equal(lyric?.trackFileId, trackFileId);
});

test("upsertLibraryFile merges duplicate path and media identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Queen", "Queen", 1);

const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "01 - Bohemian Rhapsody.flac");
  const stalePath = path.join(root, "Queen", "old.flac");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "audio");
  fs.writeFileSync(stalePath, "audio");

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "1", "tidal", "track", "101", "stereo", targetPath, path.relative(root, targetPath), root, path.basename(targetPath), "flac", 5, "track", "LOSSLESS",
    "1", "tidal", "track", "100", "stereo", stalePath, path.relative(root, stalePath), root, path.basename(stalePath), "flac", 5, "track", "LOSSLESS",
  );

  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: targetPath,
    libraryRoot: root,
    fileType: "track",
    quality: "LOSSLESS",
  });

  const rows = dbModule.db.prepare(`
    SELECT id, provider_id, file_path
    FROM TrackFiles
    ORDER BY id
  `).all() as Array<{ id: number; provider_id: string; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.provider_id, "100");
  assert.equal(rows[0]?.file_path, targetPath);
});

test("upsertLibraryFile keeps stereo and spatial track rows separate for the same canonical track", () => {
  writeTestConfig({ includeSpatial: true });
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", 1);
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `).run("recording-mbid-1", "Bohemian Rhapsody");
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Bohemian Rhapsody");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen", 1);
  // Provider availability rows supply the streaming identity for both slots.

dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', '10', 'A Night at the Opera')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', '100', 'Bohemian Rhapsody')
  `).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "10",
    providerTrackId: "100",
    releaseMbid: "release-mbid-1",
    trackMbid: "track-mbid-1",
  });

  const stereoRoot = configModule.Config.getMusicPath();
  const spatialRoot = configModule.Config.getSpatialPath();
  const stereoLibraryId = seedLibraryReleaseSelection({
    key: "dual-stereo",
    releaseGroupMbid: "rg-mbid-1",
    releaseMbid: "release-mbid-1",
    monitored: true,
    rootPath: stereoRoot,
  });
  const spatialLibraryId = seedLibraryReleaseSelection({
    key: "dual-spatial",
    releaseGroupMbid: "rg-mbid-1",
    releaseMbid: "release-mbid-1",
    monitored: true,
    spatial: true,
    rootPath: spatialRoot,
  });
  const stereoPath = path.join(stereoRoot, "Queen", "A Night at the Opera", "01 - Bohemian Rhapsody.flac");
  const spatialPath = path.join(spatialRoot, "Queen", "A Night at the Opera", "01 - Bohemian Rhapsody.flac");
  fs.mkdirSync(path.dirname(stereoPath), { recursive: true });
  fs.mkdirSync(path.dirname(spatialPath), { recursive: true });
  fs.writeFileSync(stereoPath, "stereo-audio");
  fs.writeFileSync(spatialPath, "spatial-audio");

  const stereoId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    libraryId: stereoLibraryId,
    albumId: "10",
    mediaId: "100",
    filePath: stereoPath,
    libraryRoot: stereoRoot,
    fileType: "track",
    quality: "LOSSLESS",
    librarySlot: "stereo",
  });
  const spatialId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    libraryId: spatialLibraryId,
    albumId: "10",
    mediaId: "100",
    filePath: spatialPath,
    libraryRoot: spatialRoot,
    fileType: "track",
    quality: "DOLBY_ATMOS",
    librarySlot: "spatial",
  });

  const rows = dbModule.db.prepare(`
    SELECT id, provider_id, library_slot, file_path
    FROM TrackFiles
    WHERE provider_id = ?
    ORDER BY library_slot
  `).all("100") as Array<{ id: number; provider_id: string; library_slot: string; file_path: string }>;

  assert.notEqual(stereoId, spatialId);
  assert.deepEqual(rows.map((row) => row.library_slot), ["spatial", "stereo"]);
  assert.deepEqual(new Set(rows.map((row) => row.file_path)).size, 2);
  assert.equal(downloadStateModule.countDownloadedTracks(), 2);
  assert.equal(downloadStateModule.countDownloadedAlbums(), 2);

  // Statistics are precomputed off the request path now, so refresh the cache
  // before reading the library snapshot (which no longer recomputes on demand).
  artistStatisticsModule.ArtistStatisticsService.refresh();
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  const snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(snapshot.albums.total, 1);
  assert.equal(snapshot.albums.monitored, 1);
  assert.equal(snapshot.albums.downloaded, 1);
  assert.equal(snapshot.tracks.total, 2);
  assert.equal(snapshot.tracks.monitored, 2);
  assert.equal(snapshot.tracks.downloaded, 2);
  assert.equal(snapshot.files?.total, 2);
});

test("upsertLibraryFile merges duplicate path and tracked asset identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Queen", "Queen", 1);
const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "A Night at the Opera", "cover.jpg");
  const stalePath = path.join(root, "Queen", "old-cover.jpg");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "cover");
  fs.writeFileSync(stalePath, "cover");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, canonical_release_group_mbid, relative_path, file_path, library_root, extension, type, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "1", "11", path.relative(root, targetPath), targetPath, root, "jpg", "AlbumImage", "cover",
    "1", "10", path.relative(root, stalePath), stalePath, root, "jpg", "AlbumImage", "cover"
  );

  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: null,
    filePath: targetPath,
    libraryRoot: root,
    fileType: "cover",
    quality: null,
    canonicalReleaseGroupMbid: "10",
  });

  const rows = dbModule.db.prepare(`
    SELECT id AS id, canonical_release_group_mbid AS releaseGroupMbid, file_type AS file_type, file_path AS file_path
    FROM MetadataFiles
    ORDER BY id
  `).all() as Array<{ id: number; releaseGroupMbid: string; file_type: string; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.releaseGroupMbid, "10");
  assert.equal(rows[0]?.file_type, "cover");
  assert.equal(rows[0]?.file_path, targetPath);

  const metadataFile = dbModule.db.prepare(`
    SELECT artist_id, canonical_release_group_mbid AS releaseGroupMbid, file_path, file_type, type
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(targetPath) as { artist_id?: string; releaseGroupMbid?: string; file_path?: string; file_type?: string; type?: string } | undefined;

  assert.equal(metadataFile?.artist_id, "1");
  assert.equal(metadataFile?.releaseGroupMbid, "10");
  assert.equal(metadataFile?.file_type, "cover");
  assert.equal(metadataFile?.type, "AlbumImage");

  const staleMetadataFile = dbModule.db.prepare(`
    SELECT id
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(stalePath);
  assert.equal(staleMetadataFile, undefined);
});

test("computeExpectedPath inline vs separated layouts for video files", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-inline-test", "Bastille", "artist-mbid-bastille", "Bastille", 1);


dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-pompeii", "artist-mbid-bastille", "Bad Blood", "Album");

  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-pompeii", "rg-mbid-pompeii", "artist-mbid-bastille", "Bad Blood", 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid)
    VALUES (?, ?, ?)
  `).run("recording-mbid-pompeii", "Pompeii", "artist-mbid-bastille");
  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("recording-mbid-pompeii") as { id: number }).id;

  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-pompeii", "release-mbid-pompeii", "recording-mbid-pompeii", 1, 1, "1", "Pompeii");

  const nonspatialLibraryId = seedLibraryReleaseSelection({
    key: "inline-main",
    releaseGroupMbid: "rg-mbid-pompeii",
    releaseMbid: "release-mbid-pompeii",
    monitored: true,
  });

  // The music video is its own canonical recording (is_video=1) surfaced via a
  // video ProviderItem; naming + inline matching resolve from these, not ProviderMedia.
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-rec-pompeii", "Pompeii Video", "artist-mbid-bastille");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get("video-rec-pompeii") as { id: number }).id;
  const videoItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-inline-test', 'Pompeii Video')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(videoItem.id, videoRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', 'track-inline-test', 'Pompeii')
  `).run();

  const config = configModule.readConfig();
  config.path.video_folder_layout = "separated";
  configModule.writeConfig(config);

  const rowVideoSeparated: any = {
    id: 1000,
    artist_id: "artist-inline-test",
    album_id: "album-inline-test",
    media_id: "video-inline-test",
    file_path: path.join(tempDir, "library", "videos", "Bastille", "Pompeii Video.mp4"),
    relative_path: null,
    library_root: "videos",
    file_type: "video",
    extension: "mp4",
  };

  const expectedSeparated = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  // Separated layout: {Video Type} comes from the naming template (no post-render append).
  const expectedSeparatedPath = path.join(tempDir, "library", "videos", "Bastille", "Pompeii Video-video {TIDAL-video-inline-test}.mp4");
  assert.equal(expectedSeparated.expectedPath, expectedSeparatedPath);

  const expectedSeparatedThumbnail = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1001,
    file_type: "video_thumbnail",
    extension: "jpg",
  });
  assert.equal(
    expectedSeparatedThumbnail.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Pompeii Video-video {TIDAL-video-inline-test}.jpg"),
  );

  const expectedSeparatedNfo = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1002,
    file_type: "nfo",
    extension: "nfo",
  });
  assert.equal(
    expectedSeparatedNfo.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Pompeii Video-video {TIDAL-video-inline-test}.nfo"),
  );

  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const expectedInlineMonitored = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  const expectedInlineMonitoredPath = path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video.mp4");
  assert.equal(expectedInlineMonitored.expectedPath, expectedInlineMonitoredPath);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_size,
      file_type, quality, library_id, release_group_id, album_edition_id,
      recording_id, canonical_recording_mbid, canonical_release_group_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2000, "artist-inline-test", "tidal", "track", "track-inline-test", "stereo",
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii.flac"),
    path.join("Bastille", "Bad Blood", "01 - Pompeii.flac"),
    "music", "01 - Pompeii.flac", "flac", 100, "track", "LOSSLESS",
    nonspatialLibraryId,
    (dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-mbid-pompeii'").get() as { id: number }).id,
    (dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-pompeii'").get() as { id: number }).id,
    audioRecId, "recording-mbid-pompeii", "rg-mbid-pompeii",
  );

  const expectedInlineImported = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  assert.equal(expectedInlineImported.expectedPath, expectedInlineMonitoredPath);

  const rowThumbnail: any = {
    id: 1001,
    artist_id: "artist-inline-test",
    album_id: "album-inline-test",
    media_id: "video-inline-test",
    file_path: "",
    relative_path: null,
    library_root: "videos",
    file_type: "video_thumbnail",
    extension: "jpg",
  };
  const expectedThumbnail = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowThumbnail);
  const expectedThumbnailPath = path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video.jpg");
  assert.equal(expectedThumbnail.expectedPath, expectedThumbnailPath);

  const rowNfo: any = {
    id: 1002,
    artist_id: "artist-inline-test",
    album_id: "album-inline-test",
    media_id: "video-inline-test",
    file_path: "",
    relative_path: null,
    library_root: "videos",
    file_type: "nfo",
    extension: "nfo",
  };
  const expectedNfo = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowNfo);
  const expectedNfoPath = path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video.nfo");
  assert.equal(expectedNfo.expectedPath, expectedNfoPath);

  const expectedAlbumLinkedFallback = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  assert.equal(expectedAlbumLinkedFallback.expectedPath, expectedInlineMonitoredPath);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 1)")
    .run("video-rec-dup", "Pompeii (Official Video)", "artist-mbid-bastille");
  const dupVideoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-dup") as { id: number }).id;
  const dupVideoItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-inline-duplicate', 'Pompeii (Official Video)')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(dupVideoItem.id, dupVideoRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.9)
  `).run(dupVideoRecId, audioRecId);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2001, "artist-inline-test", "tidal", "video", "video-inline-test", "video",
    expectedInlineMonitoredPath,
    path.relative(configModule.Config.getMusicPath(), expectedInlineMonitoredPath),
    "music", path.basename(expectedInlineMonitoredPath), "mp4", 100, "video", "MP4_1080P",
  );

  const expectedDuplicate = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1003,
    media_id: "video-inline-duplicate",
  });
  // Same audio stem + same Plex type (-video) always shares one primary path.
  // Multi-provider / alternate cuts do not create descriptive or provider-tagged
  // siblings beside the track.
  assert.equal(expectedDuplicate.expectedPath, expectedInlineMonitoredPath);

  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 1)")
    .run("video-rec-unlinked", "Pompeii (Official Video)", "artist-mbid-bastille");
  const unlinkedVideoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-unlinked") as { id: number }).id;
  const unlinkedVideoItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-inline-unlinked', 'Pompeii (Official Video)')
    RETURNING id
  `).get() as { id: number };
  // Matched to its own recording, but deliberately NO provider_video_for
  // relation — the inline gate must fall back to the separated video library.
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(unlinkedVideoItem.id, unlinkedVideoRecId);

  const expectedUnlinked = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1004,
    album_id: null,
    media_id: "video-inline-unlinked",
  });
  // No provider_video_for association → separated video library even when layout is inline.
  assert.equal(
    expectedUnlinked.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Pompeii (Official Video)-video {TIDAL-video-inline-unlinked}.mp4"),
  );
});

test("computeExpectedPath inline requires a monitored nonspatial library release group", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-inline-gate", "Bastille", "artist-mbid-inline-gate", "Bastille", 1);
  dbModule.db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`)
    .run("artist-mbid-inline-gate", "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-inline-gate", "artist-mbid-inline-gate", "Bad Blood", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-inline-gate", "rg-mbid-inline-gate", "artist-mbid-inline-gate", "Bad Blood", 1);
  dbModule.db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid) VALUES (?, ?, ?)`)
    .run("recording-mbid-inline-gate", "Pompeii", "artist-mbid-inline-gate");
  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("recording-mbid-inline-gate") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-inline-gate", "release-mbid-inline-gate", "recording-mbid-inline-gate", 1, 1, "1", "Pompeii");
  seedLibraryReleaseSelection({
    key: "inline-gate",
    releaseGroupMbid: "rg-mbid-inline-gate",
    releaseMbid: "release-mbid-inline-gate",
    monitored: false,
  });
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video, video_variant)
    VALUES (?, ?, ?, 1, 'video')
  `).run("video-rec-inline-gate", "Pompeii", "artist-mbid-inline-gate");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-inline-gate") as { id: number }).id;
  const videoItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-inline-gate', 'Pompeii')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(videoItem.id, videoRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);

  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 5000,
    artist_id: "artist-inline-gate",
    album_id: null,
    media_id: "video-inline-gate",
    file_path: path.join(tempDir, "library", "videos", "Bastille", "Pompeii.mp4"),
    relative_path: null,
    library_root: "videos",
    file_type: "video",
    extension: "mp4",
  } as any);

  assert.equal(
    expected.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Pompeii-video {TIDAL-video-inline-gate}.mp4"),
  );
});

test("computeExpectedPath prefers stereo over spatial for inline videos", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-inline-stereo-pref", "Bastille", "artist-mbid-stereo-pref", "Bastille", 1);
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
  `).run("artist-mbid-stereo-pref", "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, monitored)
    VALUES (?, ?, ?, ?, 1)
  `).run("rg-mbid-stereo-pref", "artist-mbid-stereo-pref", "Bad Blood", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-mbid-stereo-pref", "rg-mbid-stereo-pref", "artist-mbid-stereo-pref", "Bad Blood", 1, "2013-01-01");
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid) VALUES (?, ?, ?)
  `).run("recording-mbid-stereo-pref", "Pompeii", "artist-mbid-stereo-pref");
  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("recording-mbid-stereo-pref") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-stereo-pref", "release-mbid-stereo-pref", "recording-mbid-stereo-pref", 1, 1, "1", "Pompeii");
  const nonspatialLibraryId = seedLibraryReleaseSelection({
    key: "inline-nonspatial-pref",
    releaseGroupMbid: "rg-mbid-stereo-pref",
    releaseMbid: "release-mbid-stereo-pref",
    monitored: true,
  });
  const spatialLibraryId = seedLibraryReleaseSelection({
    key: "inline-spatial-pref",
    releaseGroupMbid: "rg-mbid-stereo-pref",
    releaseMbid: "release-mbid-stereo-pref",
    monitored: true,
    spatial: true,
  });

  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video, video_variant)
    VALUES (?, ?, ?, 1, 'video')
  `).run("video-rec-stereo-pref", "Pompeii", "artist-mbid-stereo-pref");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-stereo-pref") as { id: number }).id;
  const videoItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-stereo-pref', 'Pompeii')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(videoItem.id, videoRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);

  const stereoPath = path.join(tempDir, "library", "music", "Bastille", "Bad Blood (2013)", "01 - Pompeii.flac");
  const spatialPath = path.join(tempDir, "library", "spatial", "Bastille", "Bad Blood (2015)", "01 - Pompeii.m4a");
  // Spatial imported first (lower id) — old ORDER BY tf.id ASC would pick it.
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_size,
      file_type, quality, library_id, release_group_id, album_edition_id,
      recording_id, canonical_recording_mbid, canonical_release_group_mbid, canonical_release_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    3001, "artist-inline-stereo-pref", "apple-music", "track", "spatial-track-1", "spatial",
    spatialPath, path.relative(configModule.Config.getSpatialPath(), spatialPath),
    "spatial", "01 - Pompeii.m4a", "m4a", 100, "track", "DOLBY_ATMOS",
    spatialLibraryId,
    (dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-mbid-stereo-pref'").get() as { id: number }).id,
    (dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-stereo-pref'").get() as { id: number }).id,
    audioRecId, "recording-mbid-stereo-pref", "rg-mbid-stereo-pref", "release-mbid-stereo-pref",
  );
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_size,
      file_type, quality, library_id, release_group_id, album_edition_id,
      recording_id, canonical_recording_mbid, canonical_release_group_mbid, canonical_release_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    3002, "artist-inline-stereo-pref", "tidal", "track", "stereo-track-1", "stereo",
    stereoPath, path.relative(configModule.Config.getMusicPath(), stereoPath),
    "music", "01 - Pompeii.flac", "flac", 100, "track", "LOSSLESS",
    nonspatialLibraryId,
    (dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-mbid-stereo-pref'").get() as { id: number }).id,
    (dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-stereo-pref'").get() as { id: number }).id,
    audioRecId, "recording-mbid-stereo-pref", "rg-mbid-stereo-pref", "release-mbid-stereo-pref",
  );

  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 4000,
    artist_id: "artist-inline-stereo-pref",
    album_id: null,
    media_id: "video-stereo-pref",
    file_path: path.join(tempDir, "library", "videos", "Bastille", "Pompeii.mp4"),
    relative_path: null,
    library_root: "videos",
    file_type: "video",
    extension: "mp4",
  } as any);

  assert.equal(
    expected.expectedPath,
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video.mp4"),
  );
  assert.ok(!String(expected.expectedPath || "").includes(`${path.sep}spatial${path.sep}`));
});

test("upsertLibraryFile persists video_codec and frame size for music videos", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-video-codec", "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("video-artist-1", "Bastille", "artist-mbid-video-codec", "Bastille", 1);
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-recording-codec", "Pompeii", "artist-mbid-video-codec");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', 'video-provider-codec', 'Pompeii')
  `).run();

  const videoRoot = configModule.Config.getVideoPath();
  const filePath = path.join(videoRoot, "Bastille", "Pompeii.mp4");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "fake-video");

  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "video-artist-1",
    mediaId: "video-provider-codec",
    filePath,
    libraryRoot: videoRoot,
    fileType: "video",
    quality: "MP4_1080P",
    codec: "aac",
    videoCodec: "h264",
    bitrate: 320000,
    channels: 2,
    width: 1920,
    height: 1080,
    provider: "tidal",
    providerEntityType: "video",
    providerId: "video-provider-codec",
    librarySlot: "video",
    canonicalArtistMbid: "artist-mbid-video-codec",
    canonicalRecordingMbid: "video-recording-codec",
  });

  const row = dbModule.db.prepare(`
    SELECT codec, video_codec, width, height, bitrate, quality
    FROM TrackFiles
    WHERE id = ?
  `).get(id) as {
    codec: string | null;
    video_codec: string | null;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    quality: string | null;
  };

  assert.equal(row.codec, "aac");
  assert.equal(row.video_codec, "h264");
  assert.equal(row.width, 1920);
  assert.equal(row.height, 1080);
  assert.equal(row.bitrate, 320000);
  assert.equal(row.quality, "MP4_1080P");
});

