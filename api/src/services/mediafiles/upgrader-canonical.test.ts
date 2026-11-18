import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { selectVideoInVideoLibraries, resetActiveSchemaRows } from "../../test-support/active-schema-fixture.js";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

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
  resetActiveSchemaRows(db, ["DownloadQueue", "commands", "TrackFiles"]);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedArtistAndRelease() {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-mbid", "Canonical Artist") as { id: number };
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  return artist;
}

/**
 * A provider resource. `entity_type` is 'release' now, never 'album', and
 * availability is NOT NULL, so the legacy bare-column inserts no longer work.
 */
function providerItem(
  provider: string,
  entityType: "release" | "track" | "video",
  providerId: string,
  title: string,
): number {
  return (db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES (?, ?, ?, ?, 'available')
    RETURNING id
  `).get(provider, entityType, providerId, title) as { id: number }).id;
}

/**
 * A track's occurrence on a provider release. This membership — not a
 * provider_album_id column — is what gives the upgrader its album context and
 * what countProviderAlbumTracks counts.
 */
function addReleaseMember(releaseItemId: number, memberItemId: number, position = 1): void {
  db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, ?)
  `).run(releaseItemId, memberItemId, position);
}

function canonicalTrackId(trackMbid: string): number {
  return (db.prepare("SELECT id FROM Tracks WHERE mbid = ?").get(trackMbid) as { id: number }).id;
}

/**
 * The accepted ProviderTrackMatches edge for a member — the only way a provider
 * track resource is reachable from a canonical track now. Requires a release
 * match, hence a canonical release.
 */
function seedAcceptedTrackEdge(input: {
  releaseItemId: number;
  memberItemId: number;
  canonicalReleaseMbid: string;
  canonicalTrackMbid: string;
}): void {
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?")
    .get(input.canonicalReleaseMbid) as { id: number };
  const track = db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = ?")
    .get(input.canonicalTrackMbid) as { id: number; recording_id: number | null };
  const recordingId = track.recording_id
    ?? (db.prepare("SELECT id FROM Recordings WHERE mbid = 'recording-1'").get() as { id: number }).id;
  const member = db.prepare(`
    SELECT id FROM ProviderEditionMembers
    WHERE provider_edition_item_id = ? AND member_item_id = ?
  `).get(input.releaseItemId, input.memberItemId) as { id: number };
  let releaseMatch = db.prepare(`
    SELECT id FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ? AND edition_id = ?
  `).get(input.releaseItemId, release.id) as { id: number } | undefined;
  if (!releaseMatch) {
    releaseMatch = db.prepare(`
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.99, 'test_fixture', 1)
      RETURNING id
    `).get(input.releaseItemId, release.id) as { id: number };
  }
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
      track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 0.99, 'test_fixture', 1)
  `).run(input.memberItemId, member.id, releaseMatch.id, track.id, recordingId);
}

function insertTrackFile(overrides: Record<string, unknown>) {
  const legacyMediaId = overrides.media_id;
  const artistMetadataId = overrides.artist_metadata_id
    ?? (overrides.canonical_artist_mbid
      ? (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(overrides.canonical_artist_mbid) as { id: number } | undefined)?.id
      : (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number } | undefined)?.id)
    ?? null;
  const row = {
    track_id: null,
    canonical_artist_mbid: null,
    canonical_release_group_mbid: null,
    canonical_release_mbid: null,
    canonical_track_mbid: null,
    canonical_recording_mbid: null,
    provider: null,
    provider_entity_type: null,
    provider_id: typeof legacyMediaId === "string" ? legacyMediaId : null,
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
    artist_metadata_id: overrides.artist_metadata_id ?? artistMetadataId,
  };
  delete (row as any).artist_id;
  delete (row as any).media_id;

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      track_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type,
      quality, codec, bit_depth, sample_rate
    ) VALUES (
      @artist_metadata_id, @canonical_artist_mbid, @canonical_release_group_mbid,
      @canonical_release_mbid, @canonical_track_mbid, @canonical_recording_mbid,
      @track_id,
      @provider, @provider_entity_type, @provider_id, @library_slot,
      @file_path, @relative_path, @library_root, @filename, @extension, @file_type,
      @quality, @codec, @bit_depth, @sample_rate
    )
  `).run(row);
}

function listDownloadJobs() {
  return db.prepare(`
    SELECT command_name AS name, ref_key AS ref_id, payload
    FROM DownloadQueue
    WHERE command_name IN (?, ?, ?)
    ORDER BY id
  `).all(CommandNames.DownloadAlbum, CommandNames.DownloadTrack, CommandNames.DownloadVideo) as Array<{
    name: string;
    ref_id: string | null;
    payload: string;
  }>;
}

test("checkUpgrades queues canonical audio album upgrades without provider catalog rows", async () => {
  seedArtistAndRelease();
  const tidalRelease = providerItem("tidal", "release", "album-provider-1", "Canonical Album");
  addReleaseMember(tidalRelease, providerItem("tidal", "track", "track-provider-1", "Track One"));
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

  const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));

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
  const albumPayload = JSON.parse(jobs[0].payload);
  assert.equal(albumPayload.providerId, "album-provider-1");
  assert.equal(albumPayload.provider, "tidal");
  assert.equal(albumPayload.type, "album");
  assert.equal(albumPayload.reason, "upgrade");
  assert.equal(albumPayload.url, "https://tidal.com/browse/album/album-provider-1");
  assert.equal(albumPayload.slot, "stereo");
  assert.equal(albumPayload.libraryId, 1);
});

test("checkUpgrades queues canonical video upgrades without provider catalog rows", async () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("video-recording-1", "Video One", "artist-mbid", 1);
  selectVideoInVideoLibraries(
    db,
    (db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get("video-recording-1") as { id: number }).id,
  );
  providerItem("tidal", "video", "video-provider-1", "Video One");
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

  const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));

  assert.equal(result.tracks, 0);
  assert.equal(result.videos, 1);
  assert.equal(result.albums, 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_queue'").get(), undefined);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadVideo);
  assert.equal(jobs[0].ref_id, "video-provider-1");
  const videoPayload = JSON.parse(jobs[0].payload);
  assert.equal(videoPayload.providerId, "video-provider-1");
  assert.equal(videoPayload.provider, "tidal");
  assert.equal(videoPayload.type, "video");
  assert.equal(videoPayload.reason, "upgrade");
  assert.equal(videoPayload.url, "https://tidal.com/browse/video/video-provider-1");
  assert.equal(videoPayload.slot, "video");
});

test("checkUpgrades does not queue Apple Music album ids as TIDAL (Grace Note)", async () => {
  // Bakermat / Grace Note shaped: Apple album id with LOSSLESS library files that
  // need a higher cutoff. Must never enqueue DownloadAlbum against TIDAL.
  seedArtistAndRelease();
  const appleAlbumId = "1776562088";
  const appleRelease = providerItem("apple-music", "release", appleAlbumId, "Grace Note");
  addReleaseMember(appleRelease, providerItem("apple-music", "track", "apple-track-1", "Grace Note"));
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "apple-music",
    provider_entity_type: "track",
    provider_id: "apple-track-1",
    quality: "LOW",
    codec: "AAC",
    extension: "m4a",
    file_path: "C:/Music/grace-note.m4a",
    relative_path: "grace-note.m4a",
    filename: "grace-note.m4a",
  });

  const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));

  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 1);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadAlbum);
  assert.equal(jobs[0].ref_id, appleAlbumId);

  const payload = JSON.parse(jobs[0].payload) as Record<string, unknown>;
  assert.equal(payload.provider, "apple-music");
  assert.equal(payload.providerId, appleAlbumId);
  assert.equal(payload.type, "album");
  assert.equal(payload.reason, "upgrade");
  assert.match(String(payload.url), /^https:\/\/music\.apple\.com\/[^/]+\/album\/1776562088$/);
  assert.notEqual(payload.provider, "tidal");
  assert.doesNotMatch(String(payload.url || ""), /tidal/i);
});

test("checkUpgrades skips album-level upgrade when provider has zero album tracks", async () => {
  seedArtistAndRelease();
  // The file came from an album download, so it records the provider RELEASE id
  // — and that release's tracklist was never fetched, so it carries no members.
  // The album id is therefore known while the provider has zero tracks for it,
  // which is exactly what the coverage guard exists to catch (old bug: 1/0
  // always passed the ≥50% check and enqueued a whole-album re-download).
  providerItem("apple-music", "release", "1776562088", "Grace Note");

  // The track resource is reachable through its typed canonical edge, and sits
  // on a DIFFERENT provider release (a single), so it cannot supply members for
  // the album the file names.
  const singleRelease = providerItem("apple-music", "release", "single-999", "Grace Note - Single");
  const trackItem = providerItem("apple-music", "track", "apple-track-orphan", "Grace Note");
  addReleaseMember(singleRelease, trackItem);
  seedAcceptedTrackEdge({
    releaseItemId: singleRelease,
    memberItemId: trackItem,
    canonicalReleaseMbid: "release-1",
    canonicalTrackMbid: "track-1",
  });

  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    track_id: canonicalTrackId("track-1"),
    provider: "apple-music",
    provider_entity_type: "release",
    provider_id: "1776562088",
    quality: "LOW",
    codec: "AAC",
    extension: "m4a",
  });

  const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));

  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  const payload = JSON.parse(jobs[0].payload) as Record<string, unknown>;
  assert.equal(payload.provider, "apple-music");
  assert.equal(payload.providerId, "apple-track-orphan");
  assert.notEqual(payload.provider, "tidal");
});

test("checkUpgrades does not immediately requeue a recent completed no-improvement upgrade", async () => {
  seedArtistAndRelease();
  const tidalRelease = providerItem("tidal", "release", "album-provider-1", "Canonical Album");
  addReleaseMember(tidalRelease, providerItem("tidal", "track", "track-provider-1", "Track One"));
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

  const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));

  assert.equal(result.tracks, 0);
  assert.equal(result.videos, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

async function withQualityConfig(
  updates: { audio_quality: "low" | "normal" | "high" | "max" },
  fn: () => Promise<void>,
): Promise<void> {
  const { updateConfig, getConfigSection } = await import("../config/config.js");
  const previous = getConfigSection("quality");
  updateConfig("quality", updates);
  try {
    await fn();
  } finally {
    updateConfig("quality", {
      audio_quality: previous.audio_quality,
    });
  }
}

test("CheckUpgrades keeps 24/48 when the setting is MAX", {
  skip: !ffmpegAvailable,
}, async () => {
  seedArtistAndRelease();
  const source = path.join(tempDir, "keep-max.flac");
  const generated = spawnSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
    "-c:a", "flac", "-sample_fmt", "s32", source,
  ], { windowsHide: true });
  assert.equal(generated.status, 0, String(generated.stderr || ""));
  const tidalRelease = providerItem("tidal", "release", "album-provider-1", "Canonical Album");
  addReleaseMember(tidalRelease, providerItem("tidal", "track", "track-provider-1", "Track One"));
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-provider-1",
    quality: "HIRES_LOSSLESS",
    codec: "FLAC",
    bit_depth: 24,
    sample_rate: 48000,
    file_path: source,
    relative_path: "keep-max.flac",
    filename: "keep-max.flac",
    extension: "flac",
  });

  await withQualityConfig({ audio_quality: "max" }, async () => {
    const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));
    assert.equal(result.tracks, 0);
    assert.deepEqual(listDownloadJobs(), []);
  });
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=sample_rate", "-of", "default=noprint_wrappers=1", source,
  ], { windowsHide: true, encoding: "utf-8" });
  assert.match(probe.stdout, /48000/);
});

test("CheckUpgrades downconverts 24/48 FLAC to 16/44.1 when the setting is HIGH", {
  skip: !ffmpegAvailable,
}, async () => {
  seedArtistAndRelease();
  const source = path.join(tempDir, "down-high.flac");
  const generated = spawnSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
    "-c:a", "flac", "-sample_fmt", "s32", source,
  ], { windowsHide: true });
  assert.equal(generated.status, 0, String(generated.stderr || ""));
  const tidalRelease = providerItem("tidal", "release", "album-provider-1", "Canonical Album");
  addReleaseMember(tidalRelease, providerItem("tidal", "track", "track-provider-1", "Track One"));
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-provider-1",
    quality: "HIRES_LOSSLESS",
    codec: "FLAC",
    bit_depth: 24,
    sample_rate: 48000,
    file_path: source,
    relative_path: "down-high.flac",
    filename: "down-high.flac",
    extension: "flac",
  });

  await withQualityConfig({ audio_quality: "high" }, async () => {
    const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));
    assert.equal(result.tracks, 1);
    assert.equal(result.details[0]?.action, "downconvert");
    assert.deepEqual(listDownloadJobs(), []);
  });
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_name,sample_rate,bits_per_sample",
    "-of", "default=noprint_wrappers=1", source,
  ], { windowsHide: true, encoding: "utf-8" });
  assert.match(probe.stdout, /codec_name=flac/);
  assert.match(probe.stdout, /sample_rate=44100/);
  const row = db.prepare("SELECT quality, bit_depth, sample_rate FROM TrackFiles WHERE file_path = ?")
    .get(source) as { quality: string; bit_depth: number; sample_rate: number };
  assert.equal(row.quality, "LOSSLESS");
  assert.equal(row.bit_depth, 16);
  assert.equal(row.sample_rate, 44100);
});

test("CheckUpgrades downconverts FLAC to Opus 160 when Settings is NORMAL", {
  skip: !ffmpegAvailable,
}, async () => {
  seedArtistAndRelease();
  const source = path.join(tempDir, "down-normal.flac");
  const generated = spawnSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.3",
    "-c:a", "flac", "-sample_fmt", "s16", source,
  ], { windowsHide: true });
  assert.equal(generated.status, 0, String(generated.stderr || ""));
  const tidalRelease = providerItem("tidal", "release", "album-provider-1", "Canonical Album");
  addReleaseMember(tidalRelease, providerItem("tidal", "track", "track-provider-1", "Track One"));
  insertTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-provider-1",
    quality: "LOSSLESS",
    codec: "FLAC",
    bit_depth: 16,
    sample_rate: 44100,
    file_path: source,
    relative_path: "down-normal.flac",
    filename: "down-normal.flac",
    extension: "flac",
  });

  await withQualityConfig({ audio_quality: "normal" }, async () => {
    const result = await UpgraderService.checkUpgrades(true, String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id));
    assert.equal(result.tracks, 1);
    assert.equal(result.details[0]?.action, "downconvert");
    assert.deepEqual(listDownloadJobs(), []);
  });
  const opusPath = path.join(tempDir, "down-normal.opus");
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(opusPath), true);
  const row = db.prepare("SELECT quality, extension, codec FROM TrackFiles WHERE id = (SELECT id FROM TrackFiles LIMIT 1)")
    .get() as { quality: string; extension: string; codec: string };
  assert.equal(row.extension, "opus");
  assert.match(String(row.codec), /opus/i);
  assert.equal(row.quality, "HIGH");
});

test("checkUpgrades sets explicit slot: stereo and libraryId when queuing single track upgrade", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-single-trk", "Canonical Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-single-trk", "artist-single-trk", "Stereo Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-single-trk", "rg-single-trk", "artist-single-trk", "Stereo Album", 4, 1);

  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-single-${i}`, `Track ${i}`, "artist-single-trk", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-single-${i}`, "rel-single-trk", `rec-single-${i}`, `Track ${i}`, 1, i);
  }

  const tidalRelease = providerItem("tidal", "release", "album-single-prov", "Stereo Album");
  for (let i = 1; i <= 4; i++) {
    const memberItem = providerItem("tidal", "track", `track-single-prov-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, memberItem, i);
    seedAcceptedTrackEdge({
      releaseItemId: tidalRelease,
      memberItemId: memberItem,
      canonicalReleaseMbid: "rel-single-trk",
      canonicalTrackMbid: `trk-single-${i}`,
    });
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label, delivered_quality_class, availability
      ) VALUES (?, ?, 'hires-lossless', 'HIRES_LOSSLESS', 'hires-lossless', 'available')
    `).run(memberItem, `vk-single-${i}`);
  }

  insertTrackFile({
    canonical_artist_mbid: "artist-single-trk",
    canonical_release_group_mbid: "rg-single-trk",
    canonical_release_mbid: "rel-single-trk",
    canonical_track_mbid: "trk-single-1",
    canonical_recording_mbid: "rec-single-1",
    track_id: canonicalTrackId("trk-single-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-single-prov-1",
    quality: "LOW",
    library_slot: "stereo",
    file_path: "C:/Music/file-1.flac",
    relative_path: "file-1.flac",
  });
  for (let i = 2; i <= 4; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-single-trk",
      canonical_release_group_mbid: "rg-single-trk",
      canonical_release_mbid: "rel-single-trk",
      canonical_track_mbid: `trk-single-${i}`,
      canonical_recording_mbid: `rec-single-${i}`,
      track_id: canonicalTrackId(`trk-single-${i}`),
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-single-prov-${i}`,
      quality: "HIRES_LOSSLESS",
      library_slot: "stereo",
      file_path: `C:/Music/file-${i}.flac`,
      relative_path: `file-${i}.flac`,
    });
  }

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-single-prov-1");

  const payload = JSON.parse(jobs[0].payload) as Record<string, unknown>;
  assert.equal(payload.provider, "tidal");
  assert.equal(payload.providerId, "track-single-prov-1");
  assert.equal(payload.type, "track");
  assert.equal(payload.reason, "upgrade");
  assert.equal(payload.slot, "stereo");
  assert.equal(payload.libraryId, 1);
});

test("checkUpgrades sets explicit slot: spatial and spatial libraryId for spatial track upgrade", async () => {
  db.prepare("UPDATE Libraries SET enabled = 1 WHERE name = 'Spatial'").run();
  const spatialLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Spatial'").get() as { id: number };

  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-spatial-trk", "Spatial Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-spatial-trk", "artist-spatial-trk", "Spatial Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-spatial-trk", "rg-spatial-trk", "artist-spatial-trk", "Spatial Album", 4, 1);

  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-spatial-${i}`, `Track ${i}`, "artist-spatial-trk", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-spatial-${i}`, "rel-spatial-trk", `rec-spatial-${i}`, `Track ${i}`, 1, i);
  }

  const tidalRelease = providerItem("tidal", "release", "album-spatial-prov", "Spatial Album");
  for (let i = 1; i <= 4; i++) {
    const memberItem = providerItem("tidal", "track", `track-spatial-prov-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, memberItem, i);
    seedAcceptedTrackEdge({
      releaseItemId: tidalRelease,
      memberItemId: memberItem,
      canonicalReleaseMbid: "rel-spatial-trk",
      canonicalTrackMbid: `trk-spatial-${i}`,
    });
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
      ) VALUES (?, ?, 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
    `).run(memberItem, `vk-spatial-${i}`);
  }

  insertTrackFile({
    canonical_artist_mbid: "artist-spatial-trk",
    canonical_release_group_mbid: "rg-spatial-trk",
    canonical_release_mbid: "rel-spatial-trk",
    canonical_track_mbid: "trk-spatial-1",
    canonical_recording_mbid: "rec-spatial-1",
    track_id: canonicalTrackId("trk-spatial-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-spatial-prov-1",
    quality: "LOSSLESS",
    library_slot: "spatial",
    library_id: spatialLib.id,
    file_path: "C:/Spatial/file-1.flac",
    relative_path: "file-1.flac",
  });
  for (let i = 2; i <= 4; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-spatial-trk",
      canonical_release_group_mbid: "rg-spatial-trk",
      canonical_release_mbid: "rel-spatial-trk",
      canonical_track_mbid: `trk-spatial-${i}`,
      canonical_recording_mbid: `rec-spatial-${i}`,
      track_id: canonicalTrackId(`trk-spatial-${i}`),
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-spatial-prov-${i}`,
      quality: "DOLBY_ATMOS",
      library_slot: "spatial",
      library_id: spatialLib.id,
      file_path: `C:/Spatial/file-${i}.flac`,
      relative_path: `file-${i}.flac`,
    });
  }

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-spatial-prov-1");

  const payload = JSON.parse(jobs[0].payload) as Record<string, unknown>;
  assert.equal(payload.provider, "tidal");
  assert.equal(payload.providerId, "track-spatial-prov-1");
  assert.equal(payload.type, "track");
  assert.equal(payload.reason, "upgrade");
  assert.equal(payload.slot, "spatial");
  assert.equal(payload.libraryId, spatialLib.id);
});

test("checkUpgrades does not queue stereo interlude in spatial album when track has no spatial offer", async () => {
  db.prepare("UPDATE Libraries SET enabled = 1 WHERE name = 'Spatial'").run();
  const spatialLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Spatial'").get() as { id: number };

  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-spatial-interlude", "Interlude Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-spatial-interlude", "artist-spatial-interlude", "Interlude Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-spatial-interlude", "rg-spatial-interlude", "artist-spatial-interlude", "Interlude Album", 4, 1);

  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-interlude-${i}`, `Track ${i}`, "artist-spatial-interlude", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-interlude-${i}`, "rel-spatial-interlude", `rec-interlude-${i}`, `Track ${i}`, 1, i);
  }

  const tidalRelease = providerItem("tidal", "release", "album-interlude-prov", "Interlude Album");
  // Track 1 is a stereo interlude: only has lossless variant, NO spatial variant
  const memberItem1 = providerItem("tidal", "track", "track-interlude-prov-1", "Track 1");
  addReleaseMember(tidalRelease, memberItem1, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: memberItem1,
    canonicalReleaseMbid: "rel-spatial-interlude",
    canonicalTrackMbid: "trk-interlude-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, ?, 'lossless', 'LOSSLESS', 'available')
  `).run(memberItem1, "vk-interlude-1");

  // Tracks 2-4 have Dolby Atmos spatial variants
  for (let i = 2; i <= 4; i++) {
    const memberItem = providerItem("tidal", "track", `track-interlude-prov-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, memberItem, i);
    seedAcceptedTrackEdge({
      releaseItemId: tidalRelease,
      memberItemId: memberItem,
      canonicalReleaseMbid: "rel-spatial-interlude",
      canonicalTrackMbid: `trk-interlude-${i}`,
    });
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
      ) VALUES (?, ?, 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
    `).run(memberItem, `vk-interlude-${i}`);
  }

  // File 1 is stereo (LOSSLESS) in the spatial library
  insertTrackFile({
    canonical_artist_mbid: "artist-spatial-interlude",
    canonical_release_group_mbid: "rg-spatial-interlude",
    canonical_release_mbid: "rel-spatial-interlude",
    canonical_track_mbid: "trk-interlude-1",
    canonical_recording_mbid: "rec-interlude-1",
    track_id: canonicalTrackId("trk-interlude-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-interlude-prov-1",
    quality: "LOSSLESS",
    library_slot: "spatial",
    library_id: spatialLib.id,
    file_path: "C:/Spatial/interlude-1.flac",
    relative_path: "interlude-1.flac",
  });

  // Files 2-4 are DOLBY_ATMOS in the spatial library
  for (let i = 2; i <= 4; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-spatial-interlude",
      canonical_release_group_mbid: "rg-spatial-interlude",
      canonical_release_mbid: "rel-spatial-interlude",
      canonical_track_mbid: `trk-interlude-${i}`,
      canonical_recording_mbid: `rec-interlude-${i}`,
      track_id: canonicalTrackId(`trk-interlude-${i}`),
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-interlude-prov-${i}`,
      quality: "DOLBY_ATMOS",
      library_slot: "spatial",
      library_id: spatialLib.id,
      file_path: `C:/Spatial/interlude-${i}.flac`,
      relative_path: `interlude-${i}.flac`,
    });
  }

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 0);
});

test("checkUpgrades skips upgrade at enqueue time when destination slot cannot be determined", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-noslot", "No Slot Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-noslot", "artist-noslot", "No Slot Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-noslot", "rg-noslot", "artist-noslot", "No Slot Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-noslot-1", "Track 1", "artist-noslot", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-noslot-1", "rel-noslot", "rec-noslot-1", "Track 1", 1, 1);

  const tidalRelease = providerItem("tidal", "release", "album-noslot-prov", "No Slot Album");
  const trackItem = providerItem("tidal", "track", "track-noslot-prov-1", "Track 1");
  addReleaseMember(tidalRelease, trackItem, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem,
    canonicalReleaseMbid: "rel-noslot",
    canonicalTrackMbid: "trk-noslot-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, delivered_quality_class, availability
    ) VALUES (?, 'vk-noslot-1', 'hires-lossless', 'HIRES_LOSSLESS', 'hires-lossless', 'available')
  `).run(trackItem);

  insertTrackFile({
    canonical_artist_mbid: "artist-noslot",
    canonical_release_group_mbid: "rg-noslot",
    canonical_release_mbid: "rel-noslot",
    canonical_track_mbid: "trk-noslot-1",
    canonical_recording_mbid: "rec-noslot-1",
    track_id: canonicalTrackId("trk-noslot-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-noslot-prov-1",
    quality: "LOW",
    library_slot: "invalid_unknown_slot",
    library_id: null,
    library_root: "/nonexistent/root/without/library",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

test("checkUpgrades skips stereo file when only spatial offer is available", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-spatial-skip", "Spatial Skip Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-spatial-skip", "artist-spatial-skip", "Spatial Skip Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-spatial-skip", "rg-spatial-skip", "artist-spatial-skip", "Spatial Skip Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-spatial-skip-1", "Track 1", "artist-spatial-skip", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-spatial-skip-1", "rel-spatial-skip", "rec-spatial-skip-1", "Track 1", 1, 1);

  const tidalRelease = providerItem("tidal", "release", "album-spatial-skip-prov", "Spatial Skip Album");
  const trackItem = providerItem("tidal", "track", "track-spatial-skip-prov-1", "Track 1");
  addReleaseMember(tidalRelease, trackItem, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem,
    canonicalReleaseMbid: "rel-spatial-skip",
    canonicalTrackMbid: "trk-spatial-skip-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
    ) VALUES (?, 'vk-spatial-skip-1', 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
  `).run(trackItem);

  insertTrackFile({
    canonical_artist_mbid: "artist-spatial-skip",
    canonical_release_group_mbid: "rg-spatial-skip",
    canonical_release_mbid: "rel-spatial-skip",
    canonical_track_mbid: "trk-spatial-skip-1",
    canonical_recording_mbid: "rec-spatial-skip-1",
    track_id: canonicalTrackId("trk-spatial-skip-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-spatial-skip-prov-1",
    quality: "LOW",
    library_slot: "stereo",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

function seedPlanForEdition(input: {
  provider: string;
  providerReleaseId: string;
  providerTrackId: string;
  albumEditionMbid: string;
  trackMbid: string;
  libraryId: number;
  quality?: string;
  position?: number;
}) {
  const edition = db.prepare("SELECT id, release_group_id FROM AlbumEditions WHERE mbid = ?")
    .get(input.albumEditionMbid) as { id: number; release_group_id: number };
  const track = db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = ?")
    .get(input.trackMbid) as { id: number; recording_id: number };

  db.prepare(`
    INSERT OR IGNORE INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(input.libraryId, edition.release_group_id);

  let libraryEdition = db.prepare("SELECT id FROM LibraryEditions WHERE library_id = ? AND edition_id = ?")
    .get(input.libraryId, edition.id) as { id: number } | undefined;
  if (!libraryEdition) {
    libraryEdition = db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
      VALUES (?, ?, 'auto', 'test', 1)
      RETURNING id
    `).get(input.libraryId, edition.id) as { id: number };
  }

  let providerReleaseItem = db.prepare("SELECT id FROM ProviderItems WHERE provider = ? AND entity_type = 'release' AND provider_id = ?")
    .get(input.provider, input.providerReleaseId) as { id: number } | undefined;
  if (!providerReleaseItem) {
    providerReleaseItem = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
      VALUES (?, 'release', ?, 'Plan Release', 'available')
      RETURNING id
    `).get(input.provider, input.providerReleaseId) as { id: number };
  }

  const providerTrackItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES (?, 'track', ?, 'Plan Track', 'available')
    RETURNING id
  `).get(input.provider, input.providerTrackId) as { id: number };

  const member = db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, ?)
    RETURNING id
  `).get(providerReleaseItem.id, providerTrackItem.id, input.position ?? 1) as { id: number };

  let releaseMatch = db.prepare("SELECT id FROM ProviderEditionMatches WHERE provider_edition_item_id = ? AND edition_id = ?")
    .get(providerReleaseItem.id, edition.id) as { id: number } | undefined;
  if (!releaseMatch) {
    releaseMatch = db.prepare(`
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
      RETURNING id
    `).get(providerReleaseItem.id, edition.id) as { id: number };
  }

  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerTrackItem.id, member.id, releaseMatch.id, track.id, track.recording_id) as { id: number };

  const quality = input.quality ?? "hires-lossless";
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, ?, ?, ?, 'available')
    RETURNING id
  `).get(
    providerTrackItem.id,
    quality,
    quality === "hires-lossless" ? "lossless" : quality,
    quality === "hires-lossless" ? "HIRES_LOSSLESS" : quality.toUpperCase(),
  ) as { id: number };

  const plan = db.prepare(`
    SELECT plan.id FROM SelectedAcquisitionPlans plan
    WHERE plan.library_edition_id = ?
  `).get(libraryEdition.id) as { id: number } | undefined;

  let planId: number;
  let sourceId: number;
  if (!plan) {
    const trackCount = db.prepare("SELECT track_count FROM AlbumEditions WHERE id = ?").get(edition.id) as { track_count: number };
    const seeded = seedSelectedAcquisitionPlan(db, {
      libraryEditionId: libraryEdition.id,
      provider: input.provider,
      coverage: trackCount?.track_count || 1,
      targetTrackCount: trackCount?.track_count || 1,
    });
    planId = seeded.id;
    const source = db.prepare(`
      INSERT INTO AcquisitionPlanSources (plan_id, provider_edition_match_id, role, sort_order)
      VALUES (?, ?, 'primary', 0)
      RETURNING id
    `).get(planId, releaseMatch.id) as { id: number };
    sourceId = source.id;
  } else {
    planId = plan.id;
    const source = db.prepare("SELECT id FROM AcquisitionPlanSources WHERE plan_id = ?").get(planId) as { id: number };
    sourceId = source.id;
  }

  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id,
      source_quality_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(planId, track.id, sourceId, trackMatch.id, variant.id, JSON.stringify({ quality: "hires-lossless" }));

  return {
    planId,
    providerReleaseItemId: providerReleaseItem.id,
    providerTrackItemId: providerTrackItem.id,
    variantId: variant.id,
    libraryEditionId: libraryEdition.id,
    editionId: edition.id,
    trackId: track.id,
  };
}

test("checkUpgrades album-level upgrade enqueue with current acquisition plan includes trackOffers from winning plan", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-plan-album", "Plan Album Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-plan-album", "artist-plan-album", "Plan Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-plan-album", "rg-plan-album", "artist-plan-album", "Plan Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-plan-album-1", "Plan Track 1", "artist-plan-album", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-plan-album-1", "rel-plan-album", "rec-plan-album-1", "Plan Track 1", 1, 1);

  const planInfo = seedPlanForEdition({
    provider: "tidal",
    providerReleaseId: "album-plan-prov-1",
    providerTrackId: "track-plan-prov-1",
    albumEditionMbid: "rel-plan-album",
    trackMbid: "trk-plan-album-1",
    libraryId: 1,
    quality: "hires-lossless",
  });

  insertTrackFile({
    canonical_artist_mbid: "artist-plan-album",
    canonical_release_group_mbid: "rg-plan-album",
    canonical_release_mbid: "rel-plan-album",
    canonical_track_mbid: "trk-plan-album-1",
    canonical_recording_mbid: "rec-plan-album-1",
    track_id: planInfo.trackId,
    album_edition_id: planInfo.editionId,
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-plan-prov-1",
    album_id: "album-plan-prov-1",
    library_id: 1,
    library_slot: "stereo",
    quality: "LOW",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.albums, 1);
  assert.equal(result.tracks, 1);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadAlbum);
  assert.equal(jobs[0].ref_id, "album-plan-prov-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.acquisitionPlanId, planInfo.planId);
  assert.equal(payload.reason, "upgrade");
  assert.equal(payload.slot, "stereo");
  assert.equal(payload.libraryId, 1);
  assert.ok(Array.isArray(payload.trackOffers));
  assert.equal(payload.trackOffers.length, 1);
  assert.equal(payload.trackOffers[0].provider, "tidal");
  assert.equal(payload.trackOffers[0].providerTrackId, "track-plan-prov-1");
  assert.equal(payload.trackOffers[0].providerTrackItemId, planInfo.providerTrackItemId);
  assert.equal(payload.trackOffers[0].providerAudioVariantId, planInfo.variantId);
  assert.equal(payload.trackOffers[0].canonicalTrackMbid, "trk-plan-album-1");
  assert.equal(payload.trackOffers[0].canonicalRecordingMbid, "rec-plan-album-1");
});

test("checkUpgrades per-track DownloadTrack upgrade enqueue with current acquisition plan includes that one offer", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-plan-track", "Plan Track Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-plan-track", "artist-plan-track", "Plan Track Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-plan-track", "rg-plan-track", "artist-plan-track", "Plan Track Album", 3, 1);

  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-plan-track-${i}`, `Track ${i}`, "artist-plan-track", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, 1, ?)`).run(`trk-plan-track-${i}`, "rel-plan-track", `rec-plan-track-${i}`, `Track ${i}`, i);
  }

  const planInfo1 = seedPlanForEdition({
    provider: "tidal",
    providerReleaseId: "album-plan-track-prov",
    providerTrackId: "track-plan-prov-1",
    albumEditionMbid: "rel-plan-track",
    trackMbid: "trk-plan-track-1",
    libraryId: 1,
    quality: "hires-lossless",
    position: 1,
  });
  seedPlanForEdition({
    provider: "tidal",
    providerReleaseId: "album-plan-track-prov",
    providerTrackId: "track-plan-prov-2",
    albumEditionMbid: "rel-plan-track",
    trackMbid: "trk-plan-track-2",
    libraryId: 1,
    quality: "hires-lossless",
    position: 2,
  });
  seedPlanForEdition({
    provider: "tidal",
    providerReleaseId: "album-plan-track-prov",
    providerTrackId: "track-plan-prov-3",
    albumEditionMbid: "rel-plan-track",
    trackMbid: "trk-plan-track-3",
    libraryId: 1,
    quality: "hires-lossless",
    position: 3,
  });

  insertTrackFile({
    canonical_artist_mbid: "artist-plan-track",
    canonical_release_group_mbid: "rg-plan-track",
    canonical_release_mbid: "rel-plan-track",
    canonical_track_mbid: "trk-plan-track-1",
    canonical_recording_mbid: "rec-plan-track-1",
    track_id: canonicalTrackId("trk-plan-track-1"),
    album_edition_id: planInfo1.editionId,
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-plan-prov-1",
    album_id: "album-plan-track-prov",
    library_id: 1,
    library_slot: "stereo",
    quality: "LOW",
    file_path: "C:/Music/file1.flac",
    relative_path: "file1.flac",
  });
  insertTrackFile({
    canonical_artist_mbid: "artist-plan-track",
    canonical_release_group_mbid: "rg-plan-track",
    canonical_release_mbid: "rel-plan-track",
    canonical_track_mbid: "trk-plan-track-2",
    canonical_recording_mbid: "rec-plan-track-2",
    track_id: canonicalTrackId("trk-plan-track-2"),
    album_edition_id: planInfo1.editionId,
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-plan-prov-2",
    album_id: "album-plan-track-prov",
    library_id: 1,
    library_slot: "stereo",
    quality: "HIRES_LOSSLESS",
    file_path: "C:/Music/file2.flac",
    relative_path: "file2.flac",
  });
  insertTrackFile({
    canonical_artist_mbid: "artist-plan-track",
    canonical_release_group_mbid: "rg-plan-track",
    canonical_release_mbid: "rel-plan-track",
    canonical_track_mbid: "trk-plan-track-3",
    canonical_recording_mbid: "rec-plan-track-3",
    track_id: canonicalTrackId("trk-plan-track-3"),
    album_edition_id: planInfo1.editionId,
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-plan-prov-3",
    album_id: "album-plan-track-prov",
    library_id: 1,
    library_slot: "stereo",
    quality: "HIRES_LOSSLESS",
    file_path: "C:/Music/file3.flac",
    relative_path: "file3.flac",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.albums, 0);
  assert.equal(result.tracks, 1);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-plan-prov-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.type, "track");
  assert.equal(payload.acquisitionPlanId, planInfo1.planId);
  assert.equal(payload.reason, "upgrade");
  assert.equal(payload.slot, "stereo");
  assert.equal(payload.libraryId, 1);
  assert.ok(Array.isArray(payload.trackOffers));
  assert.equal(payload.trackOffers.length, 1);
  assert.equal(payload.trackOffers[0].provider, "tidal");
  assert.equal(payload.trackOffers[0].providerTrackId, "track-plan-prov-1");
  assert.equal(payload.trackOffers[0].providerTrackItemId, planInfo1.providerTrackItemId);
  assert.equal(payload.trackOffers[0].providerAudioVariantId, planInfo1.variantId);
  assert.equal(payload.trackOffers[0].canonicalTrackMbid, "trk-plan-track-1");
  assert.equal(payload.trackOffers[0].canonicalRecordingMbid, "rec-plan-track-1");
});

test("checkUpgrades does not attach offers from a different provider than the winning plan", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-plan-diff-prov", "Diff Prov Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-plan-diff-prov", "artist-plan-diff-prov", "Diff Prov Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-plan-diff-prov", "rg-plan-diff-prov", "artist-plan-diff-prov", "Diff Prov Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-plan-diff-prov-1", "Diff Track 1", "artist-plan-diff-prov", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-plan-diff-prov-1", "rel-plan-diff-prov", "rec-plan-diff-prov-1", "Diff Track 1", 1, 1);

  const planInfo = seedPlanForEdition({
    provider: "apple-music",
    providerReleaseId: "album-apple-prov-1",
    providerTrackId: "track-apple-prov-1",
    albumEditionMbid: "rel-plan-diff-prov",
    trackMbid: "trk-plan-diff-prov-1",
    libraryId: 1,
    quality: "hires-lossless",
  });

  insertTrackFile({
    canonical_artist_mbid: "artist-plan-diff-prov",
    canonical_release_group_mbid: "rg-plan-diff-prov",
    canonical_release_mbid: "rel-plan-diff-prov",
    canonical_track_mbid: "trk-plan-diff-prov-1",
    canonical_recording_mbid: "rec-plan-diff-prov-1",
    track_id: planInfo.trackId,
    album_edition_id: planInfo.editionId,
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-tidal-prov-1",
    album_id: "album-tidal-prov-1",
    library_id: 1,
    library_slot: "stereo",
    quality: "LOW",
  });

  const tidalRelease = providerItem("tidal", "release", "album-tidal-prov-1", "Tidal Album");
  const tidalTrack = providerItem("tidal", "track", "track-tidal-prov-1", "Tidal Track");
  addReleaseMember(tidalRelease, tidalTrack, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: tidalTrack,
    canonicalReleaseMbid: "rel-plan-diff-prov",
    canonicalTrackMbid: "trk-plan-diff-prov-1",
  });

  await UpgraderService.checkUpgrades(true, String(artist.id));
  const jobs = listDownloadJobs();
  for (const job of jobs) {
    const payload = JSON.parse(job.payload);
    if (payload.provider === "tidal") {
      assert.equal(payload.trackOffers, undefined, "tidal job must not carry apple-music offers");
    }
  }
});

test("checkUpgrades allows genuine stereo upgrade in a spatial album within winning plan", async () => {
  db.prepare("UPDATE Libraries SET enabled = 1 WHERE name = 'Spatial'").run();
  const spatialLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Spatial'").get() as { id: number };

  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-spatial-stereo-up", "Spatial Stereo Upgrade Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-spatial-stereo-up", "artist-spatial-stereo-up", "Spatial Stereo Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-spatial-stereo-up", "rg-spatial-stereo-up", "artist-spatial-stereo-up", "Spatial Stereo Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-spatial-stereo-up-1", "Track 1", "artist-spatial-stereo-up", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-spatial-stereo-up-1", "rel-spatial-stereo-up", "rec-spatial-stereo-up-1", "Track 1", 1, 1);

  const tidalRelease = providerItem("tidal", "release", "album-spatial-stereo-up-prov", "Spatial Stereo Album");
  const trackItem = providerItem("tidal", "track", "track-spatial-stereo-up-prov-1", "Track 1");
  addReleaseMember(tidalRelease, trackItem, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem,
    canonicalReleaseMbid: "rel-spatial-stereo-up",
    canonicalTrackMbid: "trk-spatial-stereo-up-1",
  });
  // Winning plan only has LOSSLESS stereo (no spatial offer)
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-spatial-stereo-up-1', 'lossless', 'LOSSLESS', 'available')
  `).run(trackItem);

  // File is currently LOW quality in spatial library
  insertTrackFile({
    canonical_artist_mbid: "artist-spatial-stereo-up",
    canonical_release_group_mbid: "rg-spatial-stereo-up",
    canonical_release_mbid: "rel-spatial-stereo-up",
    canonical_track_mbid: "trk-spatial-stereo-up-1",
    canonical_recording_mbid: "rec-spatial-stereo-up-1",
    track_id: canonicalTrackId("trk-spatial-stereo-up-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-spatial-stereo-up-prov-1",
    quality: "LOW",
    library_slot: "spatial",
    library_id: spatialLib.id,
    file_path: "C:/Spatial/interlude.flac",
    relative_path: "interlude.flac",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-spatial-stereo-up-prov-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.slot, "spatial");
  assert.equal(payload.libraryId, spatialLib.id);
  assert.equal(payload.reason, "upgrade");
  assert.match(result.details[0].reason, /Quality upgrade: LOW -> LOSSLESS/);
});

test("checkUpgrades replaces Atmos file in stereo library with stereo from winning plan", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-atmos-replace", "Atmos Replace Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-atmos-replace", "artist-atmos-replace", "Atmos Replace Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-atmos-replace", "rg-atmos-replace", "artist-atmos-replace", "Atmos Replace Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-atmos-replace-1", "Track 1", "artist-atmos-replace", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-atmos-replace-1", "rel-atmos-replace", "rec-atmos-replace-1", "Track 1", 1, 1);

  const tidalRelease = providerItem("tidal", "release", "album-atmos-replace-prov", "Atmos Replace Album");
  const trackItem = providerItem("tidal", "track", "track-atmos-replace-prov-1", "Track 1");
  addReleaseMember(tidalRelease, trackItem, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem,
    canonicalReleaseMbid: "rel-atmos-replace",
    canonicalTrackMbid: "trk-atmos-replace-1",
  });
  // Winning plan has both DOLBY_ATMOS and LOSSLESS stereo
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
    ) VALUES (?, 'vk-atmos-replace-spatial', 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
  `).run(trackItem);
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-atmos-replace-stereo', 'lossless', 'LOSSLESS', 'available')
  `).run(trackItem);

  // File was imported as DOLBY_ATMOS in stereo library (was Atmos-only at import time)
  insertTrackFile({
    canonical_artist_mbid: "artist-atmos-replace",
    canonical_release_group_mbid: "rg-atmos-replace",
    canonical_release_mbid: "rel-atmos-replace",
    canonical_track_mbid: "trk-atmos-replace-1",
    canonical_recording_mbid: "rec-atmos-replace-1",
    track_id: canonicalTrackId("trk-atmos-replace-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-atmos-replace-prov-1",
    quality: "DOLBY_ATMOS",
    library_slot: "stereo",
    file_path: "C:/Music/track1.flac",
    relative_path: "track1.flac",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-atmos-replace-prov-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.slot, "stereo");
  assert.equal(payload.reason, "upgrade");
  assert.match(result.details[0].reason, /Stereo replacement of spatial file in stereo library/);
});

test("checkUpgrades upgrades stereo interlude when Atmos offer later appears in winning plan and does not re-queue after import", async () => {
  db.prepare("UPDATE Libraries SET enabled = 1 WHERE name = 'Spatial'").run();
  const spatialLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Spatial'").get() as { id: number };

  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-later-atmos", "Later Atmos Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-later-atmos", "artist-later-atmos", "Later Atmos Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-later-atmos", "rg-later-atmos", "artist-later-atmos", "Later Atmos Album", 4, 1);

  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-later-atmos-${i}`, `Track ${i}`, "artist-later-atmos", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-later-atmos-${i}`, "rel-later-atmos", `rec-later-atmos-${i}`, `Track ${i}`, 1, i);
  }

  const tidalRelease = providerItem("tidal", "release", "album-later-atmos-prov", "Later Atmos Album");
  const trackItem1 = providerItem("tidal", "track", "track-later-atmos-prov-1", "Track 1");
  addReleaseMember(tidalRelease, trackItem1, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem1,
    canonicalReleaseMbid: "rel-later-atmos",
    canonicalTrackMbid: "trk-later-atmos-1",
  });
  // Track 1 initially only has LOSSLESS stereo
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-later-atmos-stereo', 'lossless', 'LOSSLESS', 'available')
  `).run(trackItem1);

  // Tracks 2-4 already have DOLBY_ATMOS
  for (let i = 2; i <= 4; i++) {
    const memberItem = providerItem("tidal", "track", `track-later-atmos-prov-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, memberItem, i);
    seedAcceptedTrackEdge({
      releaseItemId: tidalRelease,
      memberItemId: memberItem,
      canonicalReleaseMbid: "rel-later-atmos",
      canonicalTrackMbid: `trk-later-atmos-${i}`,
    });
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
      ) VALUES (?, ?, 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
    `).run(memberItem, `vk-later-atmos-spatial-${i}`);

    insertTrackFile({
      canonical_artist_mbid: "artist-later-atmos",
      canonical_release_group_mbid: "rg-later-atmos",
      canonical_release_mbid: "rel-later-atmos",
      canonical_track_mbid: `trk-later-atmos-${i}`,
      canonical_recording_mbid: `rec-later-atmos-${i}`,
      track_id: canonicalTrackId(`trk-later-atmos-${i}`),
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-later-atmos-prov-${i}`,
      quality: "DOLBY_ATMOS",
      library_slot: "spatial",
      library_id: spatialLib.id,
      file_path: `C:/Spatial/later-atmos-${i}.flac`,
      relative_path: `later-atmos-${i}.flac`,
    });
  }

  insertTrackFile({
    canonical_artist_mbid: "artist-later-atmos",
    canonical_release_group_mbid: "rg-later-atmos",
    canonical_release_mbid: "rel-later-atmos",
    canonical_track_mbid: "trk-later-atmos-1",
    canonical_recording_mbid: "rec-later-atmos-1",
    track_id: canonicalTrackId("trk-later-atmos-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-later-atmos-prov-1",
    quality: "LOSSLESS",
    library_slot: "spatial",
    library_id: spatialLib.id,
    file_path: "C:/Spatial/later-atmos-1.flac",
    relative_path: "later-atmos-1.flac",
  });

  // Step 1: without Atmos offer, interlude not queued (satisfies cutoff)
  const resultInitial = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(resultInitial.tracks, 0);

  // Step 2: winning plan gains DOLBY_ATMOS variant for track 1
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
    ) VALUES (?, 'vk-later-atmos-spatial-1', 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
  `).run(trackItem1);

  const resultWithAtmos = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(resultWithAtmos.tracks, 1);
  assert.equal(resultWithAtmos.albums, 0);
  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-later-atmos-prov-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.slot, "spatial");
  assert.equal(payload.reason, "upgrade");
  assert.match(resultWithAtmos.details[0].reason, /Spatial upgrade: LOSSLESS -> DOLBY_ATMOS/);

  // Step 3: after successful import, file is DOLBY_ATMOS; not re-queued
  db.prepare("DELETE FROM DownloadQueue").run();
  db.prepare("UPDATE TrackFiles SET quality = 'DOLBY_ATMOS' WHERE canonical_track_mbid = 'trk-later-atmos-1'").run();

  const resultAfterImport = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(resultAfterImport.tracks, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

test("checkUpgrades does not mix cross-provider or cross-edition offers outside winning plan", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-no-cross", "No Cross Mixing Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-no-cross", "artist-no-cross", "No Cross Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-no-cross", "rg-no-cross", "artist-no-cross", "No Cross Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-no-cross-1", "Track 1", "artist-no-cross", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-no-cross-1", "rel-no-cross", "rec-no-cross-1", "Track 1", 1, 1);

  // Winning plan on TIDAL: album-tidal-win, only has LOSSLESS (16/44.1)
  const tidalRelease = providerItem("tidal", "release", "album-tidal-win", "No Cross Album");
  const tidalTrack = providerItem("tidal", "track", "track-tidal-win-1", "Track 1");
  addReleaseMember(tidalRelease, tidalTrack, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: tidalTrack,
    canonicalReleaseMbid: "rel-no-cross",
    canonicalTrackMbid: "trk-no-cross-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-tidal-lossless', 'lossless', 'LOSSLESS', 'available')
  `).run(tidalTrack);

  // Existing file in library has quality LOW and provider tidal
  insertTrackFile({
    canonical_artist_mbid: "artist-no-cross",
    canonical_release_group_mbid: "rg-no-cross",
    canonical_release_mbid: "rel-no-cross",
    canonical_track_mbid: "trk-no-cross-1",
    canonical_recording_mbid: "rec-no-cross-1",
    track_id: canonicalTrackId("trk-no-cross-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-tidal-win-1",
    quality: "LOW",
    codec: "AAC",
    library_slot: "stereo",
  });

  // Apple Music has a HIRES_LOSSLESS offer for the same track
  const appleRelease = providerItem("apple-music", "release", "album-apple-cross", "No Cross Album");
  const appleTrack = providerItem("apple-music", "track", "track-apple-cross-1", "Track 1");
  addReleaseMember(appleRelease, appleTrack, 1);
  seedAcceptedTrackEdge({
    releaseItemId: appleRelease,
    memberItemId: appleTrack,
    canonicalReleaseMbid: "rel-no-cross",
    canonicalTrackMbid: "trk-no-cross-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-apple-hires', 'hires-lossless', 'HIRES_LOSSLESS', 'available')
  `).run(appleTrack);

  // Selected/winning plan for this album in stereo library is TIDAL (album-tidal-win)
  // Insert SelectedAcquisitionPlans / AcquisitionPlans for the winning plan:
  const stereoLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state, plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-no-cross'), 'tidal', 'single_source', 'album', 'current', 'plan-tidal-win', 0, 1, 1, 1, 'hash-tidal-win', CURRENT_TIMESTAMP)
  `).run(stereoLib.id);
  const planId = (db.prepare("SELECT id FROM AcquisitionPlans WHERE plan_key = 'plan-tidal-win'").get() as { id: number }).id;
  const sourceMatchId = (db.prepare("SELECT id FROM ProviderEditionMatches WHERE provider_edition_item_id = ?").get(tidalRelease) as { id: number }).id;
  const sourceId = (db.prepare(`
    INSERT INTO AcquisitionPlanSources (plan_id, provider_edition_match_id, role, sort_order)
    VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(planId, sourceMatchId) as { id: number }).id;
  const trackMatchId = (db.prepare("SELECT id FROM ProviderTrackMatches WHERE provider_track_item_id = ?").get(tidalTrack) as { id: number }).id;
  const tidalVariantId = (db.prepare("SELECT id FROM ProviderItemAudioVariants WHERE provider_item_id = ?").get(tidalTrack) as { id: number }).id;
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(planId, canonicalTrackId('trk-no-cross-1'), sourceId, trackMatchId, tidalVariantId);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, preferred_plan_key, plan_selection_mode, selection_mode, curation_version)
    VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-no-cross'), 'plan-tidal-win', 'auto', 'auto', 1)
  `).run(stereoLib.id);

  // Run with audio_quality = max (HIRES_LOSSLESS cutoff)
  await withQualityConfig({ audio_quality: "max" }, async () => {
    const result = await UpgraderService.checkUpgrades(true, String(artist.id));
    // Upgrades MUST be evaluated strictly against the winning album plan (album-tidal-win)
    // It should upgrade from TIDAL to LOSSLESS, NOT cross-mix with Apple Music HIRES_LOSSLESS!
    assert.equal(result.tracks, 1);
    const jobs = listDownloadJobs();
    assert.equal(jobs.length, 1);
    const payload = JSON.parse(jobs[0].payload);
    assert.equal(payload.provider, "tidal");
    assert.equal(payload.providerId, "album-tidal-win");
    assert.notEqual(payload.provider, "apple-music");
  });
});

test("checkUpgrades does not cause rule-4 loop when Atmos track has no stereo variant on winning release", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-r4-loop", "Rule 4 Loop Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-r4-loop", "artist-r4-loop", "Rule 4 Loop Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-r4-loop", "rg-r4-loop", "artist-r4-loop", "Rule 4 Loop Album", 2, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-r4-loop-1", "Track 1", "artist-r4-loop", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-r4-loop-1", "rel-r4-loop", "rec-r4-loop-1", "Track 1", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-r4-loop-2", "Track 2", "artist-r4-loop", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-r4-loop-2", "rel-r4-loop", "rec-r4-loop-2", "Track 2", 1, 2);

  const tidalRelease = providerItem("tidal", "release", "album-r4-loop-prov", "Rule 4 Loop Album");
  const trackItem1 = providerItem("tidal", "track", "track-r4-loop-prov-1", "Track 1");
  const trackItem2 = providerItem("tidal", "track", "track-r4-loop-prov-2", "Track 2");
  addReleaseMember(tidalRelease, trackItem1, 1);
  addReleaseMember(tidalRelease, trackItem2, 2);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem1,
    canonicalReleaseMbid: "rel-r4-loop",
    canonicalTrackMbid: "trk-r4-loop-1",
  });
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem2,
    canonicalReleaseMbid: "rel-r4-loop",
    canonicalTrackMbid: "trk-r4-loop-2",
  });

  // Track 1 is Atmos-only
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
    ) VALUES (?, 'vk-r4-spatial-1', 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
  `).run(trackItem1);

  // Track 2 has LOSSLESS stereo
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-r4-stereo-2', 'lossless', 'LOSSLESS', 'available')
  `).run(trackItem2);

  // File 1 is an Atmos file in the stereo library
  insertTrackFile({
    canonical_artist_mbid: "artist-r4-loop",
    canonical_release_group_mbid: "rg-r4-loop",
    canonical_release_mbid: "rel-r4-loop",
    canonical_track_mbid: "trk-r4-loop-1",
    canonical_recording_mbid: "rec-r4-loop-1",
    track_id: canonicalTrackId("trk-r4-loop-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-r4-loop-prov-1",
    quality: "DOLBY_ATMOS",
    library_slot: "stereo",
    file_path: "C:/Music/track1.flac",
    relative_path: "track1.flac",
  });

  // File 2 is already LOSSLESS in the stereo library
  insertTrackFile({
    canonical_artist_mbid: "artist-r4-loop",
    canonical_release_group_mbid: "rg-r4-loop",
    canonical_release_mbid: "rel-r4-loop",
    canonical_track_mbid: "trk-r4-loop-2",
    canonical_recording_mbid: "rec-r4-loop-2",
    track_id: canonicalTrackId("trk-r4-loop-2"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-r4-loop-prov-2",
    quality: "LOSSLESS",
    library_slot: "stereo",
    file_path: "C:/Music/track2.flac",
    relative_path: "track2.flac",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

test("checkUpgrades does not queue LOW stereo file whose own track is Atmos-only via sibling stereo fallback", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-low-atmos-only", "Low Atmos Only Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-low-atmos", "artist-low-atmos-only", "Low Atmos Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-low-atmos", "rg-low-atmos", "artist-low-atmos-only", "Low Atmos Album", 2, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-low-atmos-1", "Track 1", "artist-low-atmos-only", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-low-atmos-1", "rel-low-atmos", "rec-low-atmos-1", "Track 1", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-low-atmos-2", "Track 2", "artist-low-atmos-only", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-low-atmos-2", "rel-low-atmos", "rec-low-atmos-2", "Track 2", 1, 2);

  const tidalRelease = providerItem("tidal", "release", "album-low-atmos-prov", "Low Atmos Album");
  const trackItem1 = providerItem("tidal", "track", "track-low-atmos-prov-1", "Track 1");
  const trackItem2 = providerItem("tidal", "track", "track-low-atmos-prov-2", "Track 2");
  addReleaseMember(tidalRelease, trackItem1, 1);
  addReleaseMember(tidalRelease, trackItem2, 2);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem1,
    canonicalReleaseMbid: "rel-low-atmos",
    canonicalTrackMbid: "trk-low-atmos-1",
  });
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: trackItem2,
    canonicalReleaseMbid: "rel-low-atmos",
    canonicalTrackMbid: "trk-low-atmos-2",
  });

  // Track 1 is Atmos-only
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, spatial_format, availability
    ) VALUES (?, 'vk-low-spatial-1', 'spatial', 'DOLBY_ATMOS', 'dolby-atmos', 'available')
  `).run(trackItem1);

  // Track 2 has LOSSLESS stereo
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-low-stereo-2', 'lossless', 'LOSSLESS', 'available')
  `).run(trackItem2);

  // File 1 is LOW stereo in stereo library
  insertTrackFile({
    canonical_artist_mbid: "artist-low-atmos-only",
    canonical_release_group_mbid: "rg-low-atmos",
    canonical_release_mbid: "rel-low-atmos",
    canonical_track_mbid: "trk-low-atmos-1",
    canonical_recording_mbid: "rec-low-atmos-1",
    track_id: canonicalTrackId("trk-low-atmos-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-low-atmos-prov-1",
    quality: "LOW",
    library_slot: "stereo",
    file_path: "C:/Music/track1.flac",
    relative_path: "track1.flac",
  });

  // File 2 is LOSSLESS in stereo library
  insertTrackFile({
    canonical_artist_mbid: "artist-low-atmos-only",
    canonical_release_group_mbid: "rg-low-atmos",
    canonical_release_mbid: "rel-low-atmos",
    canonical_track_mbid: "trk-low-atmos-2",
    canonical_recording_mbid: "rec-low-atmos-2",
    track_id: canonicalTrackId("trk-low-atmos-2"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-low-atmos-prov-2",
    quality: "LOSSLESS",
    library_slot: "stereo",
    file_path: "C:/Music/track2.flac",
    relative_path: "track2.flac",
  });

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

test("checkUpgrades does not queue standalone per-track upgrade from another provider into existing album", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-mix-album", "Mix Album Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-mix-album", "artist-mix-album", "Mix Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-mix-album", "rg-mix-album", "artist-mix-album", "Mix Album", 4, 1);

  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-mix-${i}`, `Track ${i}`, "artist-mix-album", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-mix-${i}`, "rel-mix-album", `rec-mix-${i}`, `Track ${i}`, 1, i);
  }

  // Winning plan is TIDAL with LOSSLESS on all 4 tracks
  const tidalRelease = providerItem("tidal", "release", "album-tidal-mix", "Mix Album");
  for (let i = 1; i <= 4; i++) {
    const tidalTrack = providerItem("tidal", "track", `track-tidal-mix-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, tidalTrack, i);
    seedAcceptedTrackEdge({
      releaseItemId: tidalRelease,
      memberItemId: tidalTrack,
      canonicalReleaseMbid: "rel-mix-album",
      canonicalTrackMbid: `trk-mix-${i}`,
    });
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, provider_quality_label, availability
      ) VALUES (?, ?, 'lossless', 'LOSSLESS', 'available')
    `).run(tidalTrack, `vk-tidal-mix-${i}`);
  }

  // Existing files on disk are all from apple-music
  // Track 1 is LOW quality, tracks 2-4 are LOSSLESS
  insertTrackFile({
    canonical_artist_mbid: "artist-mix-album",
    canonical_release_group_mbid: "rg-mix-album",
    canonical_release_mbid: "rel-mix-album",
    canonical_track_mbid: "trk-mix-1",
    canonical_recording_mbid: "rec-mix-1",
    track_id: canonicalTrackId("trk-mix-1"),
    provider: "apple-music",
    provider_entity_type: "track",
    provider_id: "apple-mix-1",
    quality: "LOW",
    library_slot: "stereo",
    file_path: "C:/Music/mix-1.m4a",
    relative_path: "mix-1.m4a",
  });
  for (let i = 2; i <= 4; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-mix-album",
      canonical_release_group_mbid: "rg-mix-album",
      canonical_release_mbid: "rel-mix-album",
      canonical_track_mbid: `trk-mix-${i}`,
      canonical_recording_mbid: `rec-mix-${i}`,
      track_id: canonicalTrackId(`trk-mix-${i}`),
      provider: "apple-music",
      provider_entity_type: "track",
      provider_id: `apple-mix-${i}`,
      quality: "LOSSLESS",
      library_slot: "stereo",
      file_path: `C:/Music/mix-${i}.m4a`,
      relative_path: `mix-${i}.m4a`,
    });
  }

  // Winning plan for rel-mix-album in stereo library is TIDAL
  const stereoLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state, plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-mix-album'), 'tidal', 'single_source', 'album', 'current', 'plan-tidal-mix', 0, 4, 4, 1, 'hash-tidal-mix', CURRENT_TIMESTAMP)
  `).run(stereoLib.id);
  const planId = (db.prepare("SELECT id FROM AcquisitionPlans WHERE plan_key = 'plan-tidal-mix'").get() as { id: number }).id;
  const sourceMatchId = (db.prepare("SELECT id FROM ProviderEditionMatches WHERE provider_edition_item_id = ?").get(tidalRelease) as { id: number }).id;
  const sourceId = (db.prepare(`
    INSERT INTO AcquisitionPlanSources (plan_id, provider_edition_match_id, role, sort_order)
    VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(planId, sourceMatchId) as { id: number }).id;
  for (let i = 1; i <= 4; i++) {
    const trackItemId = (db.prepare("SELECT id FROM ProviderItems WHERE provider = 'tidal' AND provider_id = ?").get(`track-tidal-mix-${i}`) as { id: number }).id;
    const trackMatchId = (db.prepare("SELECT id FROM ProviderTrackMatches WHERE provider_track_item_id = ?").get(trackItemId) as { id: number }).id;
    const variantId = (db.prepare("SELECT id FROM ProviderItemAudioVariants WHERE provider_item_id = ?").get(trackItemId) as { id: number }).id;
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(planId, canonicalTrackId(`trk-mix-${i}`), sourceId, trackMatchId, variantId);
  }
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, preferred_plan_key, plan_selection_mode, selection_mode, curation_version)
    VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-mix-album'), 'plan-tidal-mix', 'auto', 'auto', 1)
  `).run(stereoLib.id);

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  // 1/4 tracks needed upgrade (does not meet 50% album threshold), and per-track upgrade cannot come from TIDAL in an Apple album.
  // It must be skipped rather than mixing providers.
  assert.equal(result.tracks, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});

test("checkUpgrades does not leak cross-edition track offers for the same recording from other releases of the same provider", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-cross-ed", "Cross Edition Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-cross-ed", "artist-cross-ed", "Cross Edition Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-cross-ed", "rg-cross-ed", "artist-cross-ed", "Cross Edition Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-cross-ed-1", "Track 1", "artist-cross-ed", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-cross-ed-1", "rel-cross-ed", "rec-cross-ed-1", "Track 1", 1, 1);

  // Standard release on TIDAL: album-tidal-std is the winning release
  const stdRelease = providerItem("tidal", "release", "album-tidal-std", "Cross Edition Album");
  // stdRelease has a member track for a different track/position (so provider album tracks > 0,
  // but steps 1 and 2 find nothing inside stdRelease for trk-cross-ed-1)
  const stdTrackOther = providerItem("tidal", "track", "track-tidal-std-other", "Track 2");
  addReleaseMember(stdRelease, stdTrackOther, 2);

  // Standard release is the accepted match for rel-cross-ed
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-cross-ed'), 'exact', 'accepted', 'automatic', 0.90, 'test_fixture', 1)
  `).run(stdRelease);

  // Another release on TIDAL: deluxe edition (album-tidal-deluxe) has HIRES_LOSSLESS for the same recording
  const deluxeRelease = providerItem("tidal", "release", "album-tidal-deluxe", "Cross Edition Album (Deluxe)");
  const deluxeTrack = providerItem("tidal", "track", "track-tidal-deluxe-1", "Track 1");
  addReleaseMember(deluxeRelease, deluxeTrack, 1);
  // Match deluxe track to the same canonical recording (cross-edition match)
  const deluxeReleaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-cross-ed'), 'exact', 'accepted', 'automatic', 0.80, 'test_fixture', 1)
    RETURNING id
  `).get(deluxeRelease) as { id: number };
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
      track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, (SELECT id FROM ProviderEditionMembers WHERE provider_edition_item_id = ? AND member_item_id = ?), ?, ?, ?, 'accepted', 'automatic', 0.90, 'test_fixture', 1)
  `).run(deluxeTrack, deluxeRelease, deluxeTrack, deluxeReleaseMatch.id, canonicalTrackId("trk-cross-ed-1"), (db.prepare("SELECT id FROM Recordings WHERE mbid = 'rec-cross-ed-1'").get() as { id: number }).id);
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-deluxe-hires', 'hires-lossless', 'HIRES_LOSSLESS', 'available')
  `).run(deluxeTrack);

  // Existing file in library came from the deluxe track, currently LOSSLESS
  insertTrackFile({
    canonical_artist_mbid: "artist-cross-ed",
    canonical_release_group_mbid: "rg-cross-ed",
    canonical_release_mbid: "rel-cross-ed",
    canonical_track_mbid: "trk-cross-ed-1",
    canonical_recording_mbid: "rec-cross-ed-1",
    track_id: canonicalTrackId("trk-cross-ed-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-tidal-deluxe-1",
    quality: "LOSSLESS",
    codec: "FLAC",
    bit_depth: 16,
    sample_rate: 44100,
    library_slot: "stereo",
  });

  // Even with audio_quality = max (which wants HIRES_LOSSLESS), the winning release (stdRelease)
  // has no offer for this track. When providerEditionItemId is known, resolveWinningTrack must
  // NOT fall through to the deluxe release offer via step 3.
  await withQualityConfig({ audio_quality: "max" }, async () => {
    const result = await UpgraderService.checkUpgrades(true, String(artist.id));
    assert.equal(result.tracks, 0);
    assert.equal(result.albums, 0);
    assert.deepEqual(listDownloadJobs(), []);
  });
});

test("checkUpgrades deterministic release fallback prefers release with accepted edition match", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-fallback", "Fallback Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-fallback", "artist-fallback", "Fallback Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-fallback", "rg-fallback", "artist-fallback", "Fallback Album", 3, 1);

  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-fallback-${i}`, `Track ${i}`, "artist-fallback", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-fallback-${i}`, "rel-fallback", `rec-fallback-${i}`, `Track ${i}`, 1, i);
  }

  // 1. Single release inserted FIRST (smaller ProviderItems.id)
  const singleRelease = providerItem("tidal", "release", "album-tidal-single", "Single Release");

  // 2. Album release inserted SECOND (larger ProviderItems.id)
  const albumRelease = providerItem("tidal", "release", "album-tidal-album", "Album Release");

  // Track 1 belongs to BOTH the single and the album
  const sharedTrack = providerItem("tidal", "track", "track-shared-1", "Track 1");
  addReleaseMember(singleRelease, sharedTrack, 1);
  addReleaseMember(albumRelease, sharedTrack, 1);

  // Tracks 2 and 3 belong to albumRelease (so album has 3 tracks total)
  for (let i = 2; i <= 3; i++) {
    const albumTrack = providerItem("tidal", "track", `track-album-${i}`, `Track ${i}`);
    addReleaseMember(albumRelease, albumTrack, i);
  }

  // ONLY albumRelease has an accepted ProviderEditionMatches row for rel-fallback
  seedAcceptedTrackEdge({
    releaseItemId: albumRelease,
    memberItemId: sharedTrack,
    canonicalReleaseMbid: "rel-fallback",
    canonicalTrackMbid: "trk-fallback-1",
  });

  // Track 1 has LOSSLESS variant
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-shared-lossless', 'lossless', 'LOSSLESS', 'available')
  `).run(sharedTrack);

  // File 1 is LOW quality; provider_id is track-shared-1
  insertTrackFile({
    canonical_artist_mbid: "artist-fallback",
    canonical_release_group_mbid: "rg-fallback",
    canonical_release_mbid: "rel-fallback",
    canonical_track_mbid: "trk-fallback-1",
    canonical_recording_mbid: "rec-fallback-1",
    track_id: canonicalTrackId("trk-fallback-1"),
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "track-shared-1",
    quality: "LOW",
    codec: "AAC",
    library_slot: "stereo",
    file_path: "C:/Music/fallback-1.m4a",
    relative_path: "fallback-1.m4a",
  });

  // Files 2 and 3 are already LOSSLESS (1/3 tracks needing upgrade = 33% < 50% threshold, so standalone track upgrade)
  for (let i = 2; i <= 3; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-fallback",
      canonical_release_group_mbid: "rg-fallback",
      canonical_release_mbid: "rel-fallback",
      canonical_track_mbid: `trk-fallback-${i}`,
      canonical_recording_mbid: `rec-fallback-${i}`,
      track_id: canonicalTrackId(`trk-fallback-${i}`),
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-album-${i}`,
      quality: "LOSSLESS",
      codec: "FLAC",
      library_slot: "stereo",
      file_path: `C:/Music/fallback-${i}.flac`,
      relative_path: `fallback-${i}.flac`,
    });
  }

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  assert.equal(result.albums, 0);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadTrack);
  assert.equal(jobs[0].ref_id, "track-shared-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.provider, "tidal");
  assert.equal(payload.providerId, "track-shared-1");
  assert.equal(payload.slot, "stereo");
});

test("checkUpgrades allows upgrading provider-less (manual-import) files from the winning plan", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-manual-import", "Manual Import Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-manual-import", "artist-manual-import", "Manual Import Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-manual-import", "rg-manual-import", "artist-manual-import", "Manual Import Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("rec-manual-1", "Track 1", "artist-manual-import", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("trk-manual-1", "rel-manual-import", "rec-manual-1", "Track 1", 1, 1);

  const tidalRelease = providerItem("tidal", "release", "album-manual-win", "Manual Import Album");
  const tidalTrack = providerItem("tidal", "track", "track-manual-win-1", "Track 1");
  addReleaseMember(tidalRelease, tidalTrack, 1);
  seedAcceptedTrackEdge({
    releaseItemId: tidalRelease,
    memberItemId: tidalTrack,
    canonicalReleaseMbid: "rel-manual-import",
    canonicalTrackMbid: "trk-manual-1",
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (?, 'vk-manual-lossless', 'lossless', 'LOSSLESS', 'available')
  `).run(tidalTrack);

  // Existing file has provider = null (manual/unmapped import)
  insertTrackFile({
    canonical_artist_mbid: "artist-manual-import",
    canonical_release_group_mbid: "rg-manual-import",
    canonical_release_mbid: "rel-manual-import",
    canonical_track_mbid: "trk-manual-1",
    canonical_recording_mbid: "rec-manual-1",
    track_id: canonicalTrackId("trk-manual-1"),
    quality: "LOW",
    codec: "AAC",
    library_slot: "stereo",
  });

  const stereoLib = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state, plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-manual-import'), 'tidal', 'single_source', 'album', 'current', 'plan-manual-win', 0, 1, 1, 1, 'hash-manual-win', CURRENT_TIMESTAMP)
  `).run(stereoLib.id);
  const planId = (db.prepare("SELECT id FROM AcquisitionPlans WHERE plan_key = 'plan-manual-win'").get() as { id: number }).id;
  const sourceMatchId = (db.prepare("SELECT id FROM ProviderEditionMatches WHERE provider_edition_item_id = ?").get(tidalRelease) as { id: number }).id;
  const sourceId = (db.prepare(`
    INSERT INTO AcquisitionPlanSources (plan_id, provider_edition_match_id, role, sort_order)
    VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(planId, sourceMatchId) as { id: number }).id;
  const trackMatchId = (db.prepare("SELECT id FROM ProviderTrackMatches WHERE provider_track_item_id = ?").get(tidalTrack) as { id: number }).id;
  const tidalVariantId = (db.prepare("SELECT id FROM ProviderItemAudioVariants WHERE provider_item_id = ?").get(tidalTrack) as { id: number }).id;
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(planId, canonicalTrackId('trk-manual-1'), sourceId, trackMatchId, tidalVariantId);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, preferred_plan_key, plan_selection_mode, selection_mode, curation_version)
    VALUES (?, (SELECT id FROM AlbumEditions WHERE mbid = 'rel-manual-import'), 'plan-manual-win', 'auto', 'auto', 1)
  `).run(stereoLib.id);

  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.tracks, 1);
  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.provider, "tidal");
  assert.equal(payload.providerId, "album-manual-win");
});


test("checkUpgrades album upgrade enqueued from new winning plan carries that winning plan's trackOffers", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-new-winner-album", "New Winner Artist") as { id: number };

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("rg-new-winner-album", "artist-new-winner-album", "New Winner Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("rel-new-winner-album", "rg-new-winner-album", "artist-new-winner-album", "New Winner Album", 3, 1);

  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
      VALUES (?, ?, ?, ?)`).run(`rec-new-winner-${i}`, `Track ${i}`, "artist-new-winner-album", 0);
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`trk-new-winner-${i}`, "rel-new-winner-album", `rec-new-winner-${i}`, `Track ${i}`, 1, i);
  }

  // Seed winning plan for Apple Music with hires-lossless quality
  const planInfo1 = seedPlanForEdition({
    provider: "apple-music",
    providerReleaseId: "album-apple-winner-1",
    providerTrackId: "track-apple-winner-1",
    albumEditionMbid: "rel-new-winner-album",
    trackMbid: "trk-new-winner-1",
    libraryId: 1,
    quality: "hires-lossless",
    position: 1,
  });
  const planInfo2 = seedPlanForEdition({
    provider: "apple-music",
    providerReleaseId: "album-apple-winner-1",
    providerTrackId: "track-apple-winner-2",
    albumEditionMbid: "rel-new-winner-album",
    trackMbid: "trk-new-winner-2",
    libraryId: 1,
    quality: "hires-lossless",
    position: 2,
  });
  const planInfo3 = seedPlanForEdition({
    provider: "apple-music",
    providerReleaseId: "album-apple-winner-1",
    providerTrackId: "track-apple-winner-3",
    albumEditionMbid: "rel-new-winner-album",
    trackMbid: "trk-new-winner-3",
    libraryId: 1,
    quality: "hires-lossless",
    position: 3,
  });

  // Existing files on disk came from TIDAL and are LOW quality
  for (let i = 1; i <= 3; i++) {
    insertTrackFile({
      canonical_artist_mbid: "artist-new-winner-album",
      canonical_release_group_mbid: "rg-new-winner-album",
      canonical_release_mbid: "rel-new-winner-album",
      canonical_track_mbid: `trk-new-winner-${i}`,
      canonical_recording_mbid: `rec-new-winner-${i}`,
      track_id: canonicalTrackId(`trk-new-winner-${i}`),
      album_edition_id: planInfo1.editionId,
      provider: "tidal",
      provider_entity_type: "track",
      provider_id: `track-tidal-old-${i}`,
      album_id: "album-tidal-old-1",
      library_id: 1,
      library_slot: "stereo",
      quality: "LOW",
      file_path: `C:/Music/old-${i}.flac`,
      relative_path: `old-${i}.flac`,
    });
  }

  // Also seed TIDAL release with 3 tracks in ProviderItems/ProviderEditionMembers
  const tidalRelease = providerItem("tidal", "release", "album-tidal-old-1", "Tidal Old Album");
  for (let i = 1; i <= 3; i++) {
    const tidalTrack = providerItem("tidal", "track", `track-tidal-old-${i}`, `Track ${i}`);
    addReleaseMember(tidalRelease, tidalTrack, i);
  }

  // All 3 tracks need upgrading (>=50% and >=3 tracks) -> whole album upgrade is eligible
  // Winning plan (Apple Music) wins over old file provider (Tidal)
  const result = await UpgraderService.checkUpgrades(true, String(artist.id));
  assert.equal(result.albums, 1);
  assert.equal(result.tracks, 3);

  const jobs = listDownloadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, CommandNames.DownloadAlbum);
  assert.equal(jobs[0].ref_id, "album-apple-winner-1");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.provider, "apple-music");
  assert.equal(payload.providerId, "album-apple-winner-1");
  assert.equal(payload.acquisitionPlanId, planInfo1.planId);
  assert.ok(Array.isArray(payload.trackOffers));
  assert.equal(payload.trackOffers.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(payload.trackOffers[i].provider, "apple-music");
    assert.equal(payload.trackOffers[i].providerTrackId, `track-apple-winner-${i + 1}`);
  }
});

