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
let JobTypes: typeof import("../jobs/queue.js").JobTypes;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  db = dbModule.db;
  ({ UpgraderService } = await import("./upgrader.js"));
  ({ JobTypes } = await import("../jobs/queue.js"));
});

afterEach(() => {
  for (const table of [
    "job_queue",
    "upgrade_queue",
    "TrackFiles",
    "ProviderItems",
    "ReleaseGroupSlots",
    "Tracks",
    "Recordings",
    "AlbumReleases",
    "Albums",
    "ArtistMetadata",
    "Artists",
    "ProviderMedia",
    "ProviderAlbums",
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
    SELECT type, ref_id, payload
    FROM job_queue
    WHERE type IN (?, ?, ?)
    ORDER BY id
  `).all(JobTypes.DownloadAlbum, JobTypes.DownloadTrack, JobTypes.DownloadVideo) as Array<{
    type: string;
    ref_id: string | null;
    payload: string;
  }>;
}

test("checkUpgrades queues canonical audio album upgrades without legacy provider rows", async () => {
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
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderAlbums").get() as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number }).count, 0);
  const ledger = db.prepare(`
    SELECT provider, entity_type, provider_id, album_provider_id, media_id, album_id, target_quality, status
    FROM upgrade_queue
  `).get() as {
    provider: string;
    entity_type: string;
    provider_id: string;
    album_provider_id: string | null;
    media_id: string | null;
    album_id: string | null;
    target_quality: string;
    status: string;
  };
  assert.deepEqual(ledger, {
    provider: "tidal",
    entity_type: "track",
    provider_id: "track-provider-1",
    album_provider_id: "album-provider-1",
    media_id: null,
    album_id: null,
    target_quality: "HIRES_LOSSLESS",
    status: "pending",
  });

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, JobTypes.DownloadAlbum);
  assert.equal(jobs[0].ref_id, "album-provider-1");
  assert.deepEqual(JSON.parse(jobs[0].payload), { providerId: "album-provider-1", reason: "upgrade" });
});

test("checkUpgrades updates migrated queue rows by legacy media shadow before inserting", async () => {
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
  db.prepare(`INSERT INTO ProviderAlbums (
    id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "legacy-album-1",
    "artist-local",
    "Canonical Album",
    "ALBUM",
    0,
    "LOSSLESS",
    1,
    1,
    0,
    180,
  );
  db.prepare(`INSERT INTO ProviderMedia (
    id, artist_id, album_id, title, type, explicit, quality
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "legacy-media-1",
    "artist-local",
    "legacy-album-1",
    "Track One",
    "ALBUM",
    0,
    "LOSSLESS",
  );
  insertTrackFile({
    album_id: "legacy-album-1",
    media_id: "legacy-media-1",
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
    INSERT INTO upgrade_queue (
      media_id, provider, entity_type, provider_id, current_quality, target_quality, reason, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-media-1", "tidal", "track", "legacy-media-1", "LOW", "LOSSLESS", "old", "skipped");

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

  assert.equal(result.tracks, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM upgrade_queue").get() as { count: number }).count, 1);
  const ledger = db.prepare(`
    SELECT provider, entity_type, provider_id, album_provider_id, media_id, target_quality, status
    FROM upgrade_queue
  `).get() as {
    provider: string;
    entity_type: string;
    provider_id: string;
    album_provider_id: string | null;
    media_id: string | null;
    target_quality: string;
    status: string;
  };
  assert.deepEqual(ledger, {
    provider: "tidal",
    entity_type: "track",
    provider_id: "track-provider-1",
    album_provider_id: "album-provider-1",
    media_id: "legacy-media-1",
    target_quality: "HIRES_LOSSLESS",
    status: "pending",
  });
});

test("checkUpgrades queues canonical video upgrades without legacy provider rows", async () => {
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
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number }).count, 0);
  const ledger = db.prepare(`
    SELECT provider, entity_type, provider_id, media_id, album_id, target_quality, status
    FROM upgrade_queue
  `).get() as {
    provider: string;
    entity_type: string;
    provider_id: string;
    media_id: string | null;
    album_id: string | null;
    target_quality: string;
    status: string;
  };
  assert.deepEqual(ledger, {
    provider: "tidal",
    entity_type: "video",
    provider_id: "video-provider-1",
    media_id: null,
    album_id: null,
    target_quality: "MP4_1080P",
    status: "pending",
  });

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, JobTypes.DownloadVideo);
  assert.equal(jobs[0].ref_id, "video-provider-1");
  assert.deepEqual(JSON.parse(jobs[0].payload), { providerId: "video-provider-1", reason: "upgrade" });
});
