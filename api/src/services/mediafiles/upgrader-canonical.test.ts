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






