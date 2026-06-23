import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-upgrader-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DISABLE_DOWNLOADS = "1";

let dbModule: typeof import("../../database.js");
let db: typeof import("../../database.js").db;
let UpgraderService: typeof import("./upgrader.js").UpgraderService;
let CommandNames: typeof import("../commands/command-queue-manager.js").CommandNames;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  db = dbModule.db;
  ({ UpgraderService } = await import("./upgrader.js"));
  ({ CommandNames } = await import("../commands/command-queue-manager.js"));
});

afterEach(() => {
  for (const table of [
    "commands",
    "TrackFiles",
    "ProviderItems",
    "ReleaseGroupSlots",
    "Tracks",
    "Recordings",
    "AlbumReleases",
    "Albums",
    "ArtistMetadata",
    "Artists",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedArtistAndRelease() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Canonical Artist");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
}

function insertTrackFile(overrides: Record<string, unknown>) {
  const row = {
    artist_id: "artist-local",
    album_id: null,
    media_id: null,
    canonical_artist_mbid: null,
    canonical_release_group_mbid: null,
    canonical_release_mbid: null,
    canonical_track_mbid: null,
    canonical_recording_mbid: null,
    provider: null,
    provider_entity_type: null,
    provider_id: null,
    library_slot: "stereo",
    file_path: "C:/Music/file.flac",
    relative_path: "file.flac",
    library_root: "C:/Music",
    filename: "file.flac",
    extension: "flac",
    file_type: "track",
    quality: "LOW",
    codec: "AAC",
    bit_depth: 16,
    sample_rate: 44100,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type,
      quality, codec, bit_depth, sample_rate
    ) VALUES (
      @artist_id, @album_id, @media_id, @canonical_artist_mbid, @canonical_release_group_mbid,
      @canonical_release_mbid, @canonical_track_mbid, @canonical_recording_mbid,
      @provider, @provider_entity_type, @provider_id, @library_slot,
      @file_path, @relative_path, @library_root, @filename, @extension, @file_type,
      @quality, @codec, @bit_depth, @sample_rate
    )
  `).run(row);
}

function listDownloadJobs() {
  return db.prepare(`
    SELECT name, ref_id, payload
    FROM commands
    WHERE name IN (?, ?, ?)
    ORDER BY id
  `).all(CommandNames.DownloadAlbum, CommandNames.DownloadTrack, CommandNames.DownloadVideo) as Array<{
    name: string;
    ref_id: string | null;
    payload: string;
  }>;
}

test("checkUpgrades queues canonical audio album upgrades without provider catalog rows", async () => {
  seedArtistAndRelease();
  db.prepare(`INSERT INTO ProviderItems (
    provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
    title, quality, library_slot, data
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tidal",
    "album",
    "album-provider-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "Canonical Album",
    "HIRES_LOSSLESS",
    "stereo",
    JSON.stringify({ quality: "HIRES_LOSSLESS" }),
  );
  db.prepare(`INSERT INTO ProviderItems (
    provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
    track_mbid, recording_mbid, title, quality, library_slot, match_evidence, data
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tidal",
    "track",
    "track-provider-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "track-1",
    "recording-1",
    "Track One",
    "HIRES_LOSSLESS",
    "stereo",
    JSON.stringify({ albumProviderId: "album-provider-1" }),
    JSON.stringify({ albumProviderId: "album-provider-1", quality: "HIRES_LOSSLESS" }),
  );
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-provider-1",
  });

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

  assert.equal(result.tracks, 1);
  assert.equal(result.videos, 0);
  assert.equal(result.albums, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_queue'").get(), undefined);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadAlbum);
  assert.equal(jobs[0].ref_id, "album-provider-1");
  assert.deepEqual(JSON.parse(jobs[0].payload), { providerId: "album-provider-1", reason: "upgrade" });
});

test("checkUpgrades queues canonical video upgrades without provider catalog rows", async () => {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Canonical Artist");
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video, monitored)
    VALUES (?, ?, ?, ?, ?)`).run("video-recording-1", "Video One", "artist-mbid", 1, 1);
  db.prepare(`INSERT INTO ProviderItems (
    provider, entity_type, provider_id, artist_mbid, recording_mbid, title, quality, library_slot
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tidal",
    "video",
    "video-provider-1",
    "artist-mbid",
    "video-recording-1",
    "Video One",
    "MP4_1080P",
    "video",
  );
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_recording_mbid: "video-recording-1",
    provider: "tidal",
    provider_entity_type: "video",
    provider_id: "video-provider-1",
    library_slot: "video",
    file_path: "C:/Videos/video-one.mp4",
    relative_path: "video-one.mp4",
    library_root: "C:/Videos",
    filename: "video-one.mp4",
    extension: "mp4",
    file_type: "video",
    quality: "MP4_480P",
    codec: "H264",
  });

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

  assert.equal(result.tracks, 0);
  assert.equal(result.videos, 1);
  assert.equal(result.albums, 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_queue'").get(), undefined);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadVideo);
  assert.equal(jobs[0].ref_id, "video-provider-1");
  assert.deepEqual(JSON.parse(jobs[0].payload), { providerId: "video-provider-1", reason: "upgrade" });
});

test("checkUpgrades does not immediately requeue a recent completed no-improvement upgrade", async () => {
  seedArtistAndRelease();
  db.prepare(`INSERT INTO ProviderItems (
    provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
    title, quality, library_slot, data
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tidal",
    "album",
    "album-provider-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "Canonical Album",
    "HIRES_LOSSLESS",
    "stereo",
    JSON.stringify({ quality: "HIRES_LOSSLESS" }),
  );
  db.prepare(`INSERT INTO ProviderItems (
    provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
    track_mbid, recording_mbid, title, quality, library_slot, match_evidence, data
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tidal",
    "track",
    "track-provider-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "track-1",
    "recording-1",
    "Track One",
    "HIRES_LOSSLESS",
    "stereo",
    JSON.stringify({ albumProviderId: "album-provider-1" }),
    JSON.stringify({ albumProviderId: "album-provider-1", quality: "HIRES_LOSSLESS" }),
  );
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-provider-1",
  });
  db.prepare(`
    INSERT INTO commands(name, ref_id, payload, priority, status, created_at, completed_at, updated_at)
    VALUES (?, ?, ?, 0, 'completed', datetime('now', '-10 minutes'), datetime('now', '-5 minutes'), datetime('now', '-5 minutes'))
  `).run(
    CommandNames.ImportDownload,
    "album-provider-1",
    JSON.stringify({ type: "album", providerId: "album-provider-1", reason: "upgrade" }),
  );

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

  assert.equal(result.tracks, 0);
  assert.equal(result.videos, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});
