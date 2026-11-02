import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedAcceptedProviderTrackMatch, seedCanonicalAlbum } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-track-replacement-"));
const musicRoot = path.join(tempDir, "stereo");
const downloadRoot = path.join(tempDir, "downloads");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = musicRoot;
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = downloadRoot;

const SHARED_PROVIDER_TRACK = "boxtrack9001";
const SHARED_RECORDING = "recording-radar-love";

let dbModule: typeof import("../../database.js");
let organizerModule: typeof import("./organizer.js");
let replacementModule: typeof import("./release-track-replacement.js");
let configModule: typeof import("../config/config.js");

before(async () => {
  fs.mkdirSync(musicRoot, { recursive: true });
  fs.mkdirSync(process.env.SPATIAL_PATH!, { recursive: true });
  fs.mkdirSync(process.env.VIDEO_PATH!, { recursive: true });
  fs.mkdirSync(downloadRoot, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  organizerModule = await import("./organizer.js");
  replacementModule = await import("./release-track-replacement.js");
  configModule = await import("../config/config.js");
  const config = configModule.readConfig();
  config.metadata.save_album_cover = false;
  config.metadata.save_artist_picture = false;
  config.metadata.save_video_thumbnail = false;
  config.metadata.embed_video_thumbnail = false;
  config.metadata.save_nfo = false;
  config.metadata.save_lyrics = false;
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function artistId(): number {
  return (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-golden-earring'").get() as { id: number }).id;
}

function trackRowId(trackMbid: string): number {
  return (dbModule.db.prepare("SELECT id FROM Tracks WHERE mbid = ?").get(trackMbid) as { id: number }).id;
}

function stereoLibrary(): { id: number; root_path: string } {
  return dbModule.db.prepare("SELECT id, root_path FROM Libraries WHERE name = 'Stereo'").get() as {
    id: number;
    root_path: string;
  };
}

function insertTrackFile(input: {
  filePath: string;
  trackMbid: string;
  releaseMbid: string;
  releaseGroupMbid: string;
}): number {
  fs.mkdirSync(path.dirname(input.filePath), { recursive: true });
  fs.writeFileSync(input.filePath, "already-in-library");
  const library = stereoLibrary();
  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, track_id, recording_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (
      ?, ?, (SELECT id FROM Tracks WHERE mbid = ?), (SELECT id FROM Recordings WHERE mbid = ?),
      'artist-golden-earring', ?, ?,
      ?, ?,
      'tidal', 'track', ?, 'stereo',
      ?, ?, ?, ?, ?, 'track', 'LOSSLESS'
    )
    RETURNING id
  `).get(
    artistId(),
    library.id,
    input.trackMbid,
    SHARED_RECORDING,
    input.releaseGroupMbid,
    input.releaseMbid,
    input.trackMbid,
    SHARED_RECORDING,
    SHARED_PROVIDER_TRACK,
    input.filePath,
    path.relative(library.root_path, input.filePath),
    library.root_path,
    path.basename(input.filePath),
    path.extname(input.filePath).replace(".", ""),
  ) as { id: number };
  return inserted.id;
}

function seedSharedRecordingAlbums(): void {
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: "artist-golden-earring",
    artistName: "Golden Earring",
    releaseGroupMbid: "rg-moontan",
    releaseMbid: "rel-moontan-2021",
    title: "Moontan",
    tracks: [{ trackMbid: "track-moontan-radar", recordingMbid: SHARED_RECORDING, title: "Radar Love", position: 1 }],
  });
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: "artist-golden-earring",
    artistName: "Golden Earring",
    releaseGroupMbid: "rg-complete",
    releaseMbid: "rel-complete",
    title: "The Complete Studio Recordings",
    tracks: [{ trackMbid: "track-box-radar", recordingMbid: SHARED_RECORDING, title: "Radar Love", position: 4 }],
  });
  dbModule.db.prepare(`
    UPDATE AlbumEditions
    SET release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid)
  `).run();
  dbModule.db.prepare(`
    UPDATE Tracks
    SET album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid)
  `).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "studio-release",
    providerTrackId: SHARED_PROVIDER_TRACK,
    releaseMbid: "rel-moontan-2021",
    trackMbid: "track-moontan-radar",
    quality: "LOSSLESS",
  });
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "box-release",
    providerTrackId: SHARED_PROVIDER_TRACK,
    releaseMbid: "rel-complete",
    trackMbid: "track-box-radar",
    quality: "HI_RES_LOSSLESS",
  });
}

test("a box-set import leaves the other album's copy of the shared recording in place", async () => {
  seedSharedRecordingAlbums();
  const studioPath = path.join(musicRoot, "Golden Earring", "Moontan (2021)", "01 Radar Love.flac");
  const previousBoxPath = path.join(musicRoot, "Golden Earring", "Previous Box", "radar-old.m4a");
  const studioFileId = insertTrackFile({
    filePath: studioPath,
    trackMbid: "track-moontan-radar",
    releaseMbid: "rel-moontan-2021",
    releaseGroupMbid: "rg-moontan",
  });
  const previousBoxFileId = insertTrackFile({
    filePath: previousBoxPath,
    trackMbid: "track-box-radar",
    releaseMbid: "rel-complete",
    releaseGroupMbid: "rg-complete",
  });
  const spatialBoxPath = path.join(tempDir, "spatial", "Golden Earring", "Complete", "radar.flac");
  const spatialBoxFileId = insertTrackFile({
    filePath: spatialBoxPath,
    trackMbid: "track-box-radar",
    releaseMbid: "rel-complete",
    releaseGroupMbid: "rg-complete",
  });
  dbModule.db.prepare("UPDATE TrackFiles SET library_slot = 'spatial' WHERE id = ?").run(spatialBoxFileId);

  const listed = replacementModule.listPreviousReleaseTrackFiles({
    trackId: trackRowId("track-box-radar"),
    librarySlot: "stereo",
    newFilePath: path.join(musicRoot, "Golden Earring", "The Complete Studio Recordings", "04 Radar Love.flac"),
  });
  assert.deepEqual(listed.map((row) => row.id), [previousBoxFileId]);

  const staging = path.join(downloadRoot, "albums", "tidal", "box-release");
  fs.mkdirSync(staging, { recursive: true });
  const source = path.join(staging, `${SHARED_PROVIDER_TRACK}.flac`);
  const generated = spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.2",
    "-c:a", "flac",
    source,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr || "ffmpeg could not write the box-set track");

  const refresh = await import("../music/refresh-album-service.js");
  const refreshMetadata = refresh.RefreshAlbumService.refreshMetadata;
  const refreshTracks = refresh.RefreshAlbumService.refreshTracks;
  refresh.RefreshAlbumService.refreshMetadata = async () => {};
  refresh.RefreshAlbumService.refreshTracks = async () => {};
  try {
    const library = stereoLibrary();
    await organizerModule.OrganizerService.organizeDownload({
      type: "album",
      provider: "tidal",
      providerId: "box-release",
      libraryId: library.id,
      slot: "stereo",
      downloadPath: staging,
      releaseGroupMbid: "rg-complete",
      releaseMbid: "rel-complete",
    });
  } finally {
    refresh.RefreshAlbumService.refreshMetadata = refreshMetadata;
    refresh.RefreshAlbumService.refreshTracks = refreshTracks;
  }

  assert.equal(fs.existsSync(studioPath), true);
  const studioRow = dbModule.db.prepare(
    "SELECT id, file_path, track_id FROM TrackFiles WHERE id = ?",
  ).get(studioFileId) as { id: number; file_path: string; track_id: number } | undefined;
  assert.equal(studioRow?.file_path, studioPath);
  assert.equal(studioRow?.track_id, trackRowId("track-moontan-radar"));

  assert.equal(fs.existsSync(spatialBoxPath), true);
  assert.equal(
    (dbModule.db.prepare("SELECT library_slot FROM TrackFiles WHERE id = ?").get(spatialBoxFileId) as { library_slot: string }).library_slot,
    "spatial",
  );
  assert.equal(fs.existsSync(previousBoxPath), false);
  assert.equal(
    dbModule.db.prepare("SELECT id FROM TrackFiles WHERE id = ?").get(previousBoxFileId),
    undefined,
  );
  const boxCopy = dbModule.db.prepare(`
    SELECT file_path
    FROM TrackFiles
    WHERE track_id = ?
      AND file_type = 'track'
  `).get(trackRowId("track-box-radar")) as { file_path: string } | undefined;
  assert.ok(boxCopy?.file_path);
  assert.equal(fs.existsSync(boxCopy.file_path), true);
  assert.notEqual(path.resolve(boxCopy.file_path), path.resolve(studioPath));
});
