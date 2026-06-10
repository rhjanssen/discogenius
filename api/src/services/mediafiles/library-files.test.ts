import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

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

function writeTestConfig(overrides?: {
  artistFolder?: string;
  albumTrackPathSingle?: string;
  createEmptyArtistFolders?: boolean;
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
  configModule.writeConfig(config);
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

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM LyricFiles").run();
  db.prepare("DELETE FROM MetadataFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM ProviderMediaArtists").run();
  db.prepare("DELETE FROM ProviderAlbumArtists").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
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

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen (legacy-folder)", 1);

  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("10", "1", "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1);

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("100", "1", "10", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1);

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 500,
    artist_id: "1" as unknown as number,
    album_id: "10" as unknown as number,
    media_id: "100" as unknown as number,
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
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "Edition-Specific Title", 1, 1);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title) VALUES (?, ?)")
    .run("recording-mbid-1", "Canonical Recording");
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 7, "7", "Canonical Track Title");
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_provider,
      selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", "tidal", "10", "release-mbid-1", "LOSSLESS", "verified");
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("10", "1", "provider Album Title", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 354, "release-mbid-1", "rg-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("100", "1", "10", "provider Track Title", 1, 1, 0, "Track", "LOSSLESS", 354, "recording-mbid-1");

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 500,
    artist_id: "1" as unknown as number,
    album_id: "10" as unknown as number,
    media_id: "100" as unknown as number,
    file_path: path.join(tempDir, "legacy.flac"),
    relative_path: null,
    library_root: "music",
    file_type: "track",
    extension: "flac",
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

test("ensureEmptyArtistFoldersIfEnabled creates the artist folder under each configured library root", () => {
  writeTestConfig({ createEmptyArtistFolders: true });

  const ensured = artistPathsModule.ensureEmptyArtistFoldersIfEnabled(path.join("Bastille {mbid-artist-mbid-1}"));

  assert.equal(ensured.length, 3);
  assert.ok(fs.existsSync(path.join(configModule.Config.getMusicPath(), "Bastille {mbid-artist-mbid-1}")));
  assert.ok(fs.existsSync(path.join(configModule.Config.getSpatialPath(), "Bastille {mbid-artist-mbid-1}")));
  assert.ok(fs.existsSync(path.join(configModule.Config.getVideoPath(), "Bastille {mbid-artist-mbid-1}")));
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

test("backfillArtistPaths assigns numeric folders when multiple legacy artists are missing paths", () => {
  writeTestConfig({ artistFolder: "{artistName}" });

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, monitored, path)
    VALUES (?, ?, ?, NULL), (?, ?, ?, NULL)
  `).run("1", "Air", 1, "2", "Air", 1);

  const updated = dbModule.backfillArtistPaths();
  const rows = dbModule.db.prepare(`
    SELECT id, path
    FROM Artists
    ORDER BY id ASC
  `).all() as Array<{ id: string; path: string }>;

  assert.equal(updated, 2);
  assert.deepEqual(rows, [
    { id: "1", path: "Air" },
    { id: "2", path: "Air (1)" },
  ]);
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
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
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
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider,
      selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "10", "release-mbid-1", "LOSSLESS", "verified");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("10", "1", "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1, "release-mbid-1", "rg-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("100", "1", "10", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1, "track-mbid-1");

  const filePath = path.join(configModule.Config.getMusicPath(), "Queen", "01 - Bohemian Rhapsody.flac");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
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

test("upsertLibraryFile resolves canonical release group from provider item mapping", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-local", "Bastille", "artist-mbid-1", "Bastille {mbid-artist-mbid-1}", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-album-1", "artist-local", "provider Album", "2025-01-01", "SINGLE", 0, "HIRES_LOSSLESS", 1, 1, 0, 180, 1, null, null);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-track-1", "artist-local", "provider-album-1", "provider Track", 1, 1, 0, "Track", "HIRES_LOSSLESS", 180, 1, null);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, title, quality, library_slot, match_status, match_confidence, match_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-1",
    "artist-mbid-1",
    "release-group-mbid-1",
    "release-mbid-1",
    "provider Album",
    "HIRES_LOSSLESS",
    "stereo",
    "verified",
    1,
    "test",
  );

  const root = configModule.Config.getMusicPath();
  const filePath = path.join(root, "Bastille {mbid-artist-mbid-1}", "provider Album", "01 - provider Track.flac");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "artist-local",
    albumId: "provider-album-1",
    mediaId: "provider-track-1",
    filePath,
    libraryRoot: root,
    fileType: "track",
    quality: "HIRES_LOSSLESS",
  });

  const row = dbModule.db.prepare(`
    SELECT canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
           provider, provider_entity_type, provider_id, library_slot
    FROM TrackFiles
    WHERE id = ?
  `).get(id) as Record<string, string | null>;

  assert.deepEqual(row, {
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "release-group-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "provider-track-1",
    library_slot: "stereo",
  });
});

test("upsertLibraryFile prefers selected release-group slot identity over legacy provider album identity", () => {
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
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, country, status, media_count, track_count)
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
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-album-1", "artist-local", "Give Me The Future", "2022-02-04", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, 1, "legacy-release-mbid", "release-group-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-track-1", "artist-local", "provider-album-1", "Shut Off The Lights", 1, 1, 0, "Track", "LOSSLESS", 180, 1, "recording-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, title, quality, library_slot, match_status, match_confidence, match_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-1",
    "artist-mbid-1",
    "release-group-mbid-1",
    "legacy-release-mbid",
    "Give Me The Future",
    "LOSSLESS",
    "stereo",
    "verified",
    1,
    "test",
  );
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider,
      selected_provider_id, selected_release_mbid, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "release-group-mbid-1", "stereo", 1, "tidal", "provider-album-1", "selected-release-mbid", "matched");

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

test("disk scan relinks Lidarr-style album covers and renamed lyrics to their provider album and track", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-local", "Bastille", "artist-mbid-1", "Bastille {mbid-artist-mbid-1}", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-album-1", "artist-local", "SAVE MY SOUL", "SINGLE", 0, "LOSSLESS", 1, 1, 0, 237, 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, type, explicit, quality, track_number, volume_number, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("provider-track-1", "artist-local", "provider-album-1", "SAVE MY SOUL", "Track", 0, "LOSSLESS", 1, 1, 237, 1);

  const root = configModule.Config.getMusicPath();
  const albumDir = path.join(root, "Bastille {mbid-artist-mbid-1}", "SAVE MY SOUL (2025)");
  const audioPath = path.join(albumDir, "Track 01 - SAVE MY SOUL.flac");
  const lyricPath = path.join(albumDir, "Track 01 - SAVE MY SOUL.lrc");
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

test("upsertLibraryFile merges duplicate path and media identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Queen", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("10", "1", "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 2, 1, 0, 3551, 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "100", "1", "10", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1,
    "101", "1", "10", "Love of My Life", 2, 1, 0, "Track", "LOSSLESS", 219, 1,
  );

  const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "01 - Bohemian Rhapsody.flac");
  const stalePath = path.join(root, "Queen", "old.flac");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "audio");
  fs.writeFileSync(stalePath, "audio");

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id, file_path, relative_path, library_root,
      filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "1", "10", "101", targetPath, path.relative(root, targetPath), root, path.basename(targetPath), "flac", 5, "track", "LOSSLESS",
    "1", "10", "100", stalePath, path.relative(root, stalePath), root, path.basename(stalePath), "flac", 5, "track", "LOSSLESS",
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
    SELECT id, media_id, file_path
    FROM TrackFiles
    ORDER BY id
  `).all() as Array<{ id: number; media_id: string; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.media_id, "100");
  assert.equal(rows[0]?.file_path, targetPath);
});

test("upsertLibraryFile keeps stereo and spatial track rows separate for the same canonical track", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
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
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider,
      selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "10", "release-mbid-1", "LOSSLESS", "verified",
    "artist-mbid-1", "rg-mbid-1", "spatial", 1, "tidal", "10", "release-mbid-1", "DOLBY_ATMOS", "verified",
  );
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Queen", "artist-mbid-1", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("10", "1", "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1, "release-mbid-1", "rg-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("100", "1", "10", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1, "track-mbid-1");

  const stereoRoot = configModule.Config.getMusicPath();
  const spatialRoot = configModule.Config.getSpatialPath();
  const stereoPath = path.join(stereoRoot, "Queen", "A Night at the Opera", "01 - Bohemian Rhapsody.flac");
  const spatialPath = path.join(spatialRoot, "Queen", "A Night at the Opera", "01 - Bohemian Rhapsody.flac");
  fs.mkdirSync(path.dirname(stereoPath), { recursive: true });
  fs.mkdirSync(path.dirname(spatialPath), { recursive: true });
  fs.writeFileSync(stereoPath, "stereo-audio");
  fs.writeFileSync(spatialPath, "spatial-audio");

  const stereoId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
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
    albumId: "10",
    mediaId: "100",
    filePath: spatialPath,
    libraryRoot: spatialRoot,
    fileType: "track",
    quality: "DOLBY_ATMOS",
    librarySlot: "spatial",
  });

  const rows = dbModule.db.prepare(`
    SELECT id, media_id, library_slot, file_path
    FROM TrackFiles
    WHERE media_id = ?
    ORDER BY library_slot
  `).all("100") as Array<{ id: number; media_id: string; library_slot: string; file_path: string }>;

  assert.notEqual(stereoId, spatialId);
  assert.deepEqual(rows.map((row) => row.library_slot), ["spatial", "stereo"]);
  assert.deepEqual(new Set(rows.map((row) => row.file_path)).size, 2);
  assert.equal(downloadStateModule.countDownloadedTracks(), 2);
  assert.equal(downloadStateModule.countDownloadedAlbums(), 2);

  const snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(snapshot.albums.total, 2);
  assert.equal(snapshot.albums.monitored, 2);
  assert.equal(snapshot.albums.downloaded, 2);
  assert.equal(snapshot.tracks.total, 2);
  assert.equal(snapshot.tracks.monitored, 2);
  assert.equal(snapshot.tracks.downloaded, 2);
});

test("upsertLibraryFile merges duplicate path and tracked asset identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("1", "Queen", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "10", "1", "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1,
    "11", "1", "Sheer Heart Attack", "1974-11-08", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1,
  );

  const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "A Night at the Opera", "cover.jpg");
  const stalePath = path.join(root, "Queen", "old-cover.jpg");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "cover");
  fs.writeFileSync(stalePath, "cover");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, album_id, relative_path, file_path, library_root, extension, type, file_type
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
  });

  const rows = dbModule.db.prepare(`
    SELECT id AS id, album_id AS album_id, file_type AS file_type, file_path AS file_path
    FROM MetadataFiles
    ORDER BY id
  `).all() as Array<{ id: number; album_id: string; file_type: string; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.album_id, "10");
  assert.equal(rows[0]?.file_type, "cover");
  assert.equal(rows[0]?.file_path, targetPath);

  const metadataFile = dbModule.db.prepare(`
    SELECT artist_id, album_id, file_path, file_type, type
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(targetPath) as { artist_id?: string; album_id?: string; file_path?: string; file_type?: string; type?: string } | undefined;

  assert.equal(metadataFile?.artist_id, "1");
  assert.equal(metadataFile?.album_id, "10");
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
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("album-inline-test", "artist-inline-test", "Bad Blood", "2013-03-04", "ALBUM", 0, "LOSSLESS", 1, 1, 1, 200, 1);

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-inline-test", "artist-inline-test", "album-inline-test", "Pompeii", 1, 1, 0, "Track", "LOSSLESS", 210, 1, "track-mbid-pompeii");

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("video-inline-test", "artist-inline-test", "album-inline-test", "Pompeii Video", 1, 1, 0, "Music Video", "LOSSLESS", 220, 1, "recording-mbid-pompeii");

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-pompeii", "artist-mbid-bastille", "Bad Blood", "Album");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-pompeii", "rg-mbid-pompeii", "artist-mbid-bastille", "Bad Blood", 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `).run("recording-mbid-pompeii", "Pompeii");

  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-pompeii", "release-mbid-pompeii", "recording-mbid-pompeii", 1, 1, "1", "Pompeii");

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
  const expectedSeparatedPath = path.join(tempDir, "library", "videos", "Bastille", "Bastille - Pompeii Video {TIDAL-video-inline-test}.mp4");
  assert.equal(expectedSeparated.expectedPath, expectedSeparatedPath);

  const expectedSeparatedThumbnail = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1001,
    file_type: "video_thumbnail",
    extension: "jpg",
  });
  assert.equal(
    expectedSeparatedThumbnail.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Bastille - Pompeii Video {TIDAL-video-inline-test}.jpg"),
  );

  const expectedSeparatedNfo = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1002,
    file_type: "nfo",
    extension: "nfo",
  });
  assert.equal(
    expectedSeparatedNfo.expectedPath,
    path.join(tempDir, "library", "videos", "Bastille", "Bastille - Pompeii Video {TIDAL-video-inline-test}.nfo"),
  );

  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const expectedInlineMonitored = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  const expectedInlineMonitoredPath = path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video.mp4");
  assert.equal(expectedInlineMonitored.expectedPath, expectedInlineMonitoredPath);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, album_id, media_id, file_path, relative_path, library_root,
      filename, extension, file_size, file_type, quality, canonical_recording_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2000, "artist-inline-test", "album-inline-test", "track-inline-test",
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii.flac"),
    path.join("Bastille", "Bad Blood", "01 - Pompeii.flac"),
    "music", "01 - Pompeii.flac", "flac", 100, "track", "LOSSLESS", "recording-mbid-pompeii"
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

  dbModule.db.prepare("UPDATE ProviderMedia SET mbid = 'non-existent-recording' WHERE id = 'video-inline-test'").run();

  const expectedAlbumLinkedFallback = libraryFilesModule.LibraryFilesService.computeExpectedPath(rowVideoSeparated);
  assert.equal(expectedAlbumLinkedFallback.expectedPath, expectedInlineMonitoredPath);

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("video-inline-duplicate", "artist-inline-test", "album-inline-test", "Pompeii (Official Video)", 1, 1, 0, "Music Video", "LOSSLESS", 220, 1);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_id, album_id, media_id, file_path, relative_path, library_root,
      filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2001, "artist-inline-test", "album-inline-test", "video-inline-test",
    expectedInlineMonitoredPath,
    path.relative(configModule.Config.getMusicPath(), expectedInlineMonitoredPath),
    "music", path.basename(expectedInlineMonitoredPath), "mp4", 100, "video", "MP4_1080P",
  );

  const expectedDuplicate = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1003,
    media_id: "video-inline-duplicate",
  });
  assert.equal(
    expectedDuplicate.expectedPath,
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video {TIDAL-video-inline-duplicate}.mp4"),
  );

  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("video-inline-unlinked", "artist-inline-test", null, "Pompeii (Official Video)", 1, 1, 0, "Music Video", "LOSSLESS", 220, 1);

  const expectedUnlinkedDuplicate = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1004,
    album_id: null,
    media_id: "video-inline-unlinked",
  });
  assert.equal(
    expectedUnlinkedDuplicate.expectedPath,
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video {TIDAL-video-inline-unlinked}.mp4"),
  );

  dbModule.db.prepare("DELETE FROM ProviderMedia WHERE id = 'track-inline-test'").run();
  const expectedCanonicalOnlyDuplicate = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...rowVideoSeparated,
    id: 1005,
    album_id: null,
    media_id: "video-inline-unlinked",
  });
  assert.equal(
    expectedCanonicalOnlyDuplicate.expectedPath,
    path.join(tempDir, "library", "music", "Bastille", "Bad Blood", "01 - Pompeii-video {TIDAL-video-inline-unlinked}.mp4"),
  );
});
