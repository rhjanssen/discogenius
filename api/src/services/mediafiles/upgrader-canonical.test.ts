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
    "ProviderTrackMatches",
    "ProviderEditionMatches",
    "ProviderEditionMembers",
    "ProviderItems",
    "Tracks",
    "Recordings",
    "AlbumEditions",
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
  db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)`).run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare(`INSERT INTO Tracks (mbid, edition_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
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
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.99, 'test_fixture', 1)
    RETURNING id
  `).get(input.releaseItemId, release.id) as { id: number };
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 0.99, 'test_fixture', 1)
  `).run(member.id, releaseMatch.id, track.id, recordingId);
}

function insertTrackFile(overrides: Record<string, unknown>) {
  const legacyMediaId = overrides.media_id;
  const row = {
    artist_id: "artist-local",
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
  };

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      track_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type,
      quality, codec, bit_depth, sample_rate
    ) VALUES (
      @artist_id, @canonical_artist_mbid, @canonical_release_group_mbid,
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
  assert.deepEqual(JSON.parse(jobs[0].payload), {
    providerId: "album-provider-1",
    provider: "tidal",
    type: "album",
    reason: "upgrade",
    url: "https://tidal.com/browse/album/album-provider-1",
  });
});

test("checkUpgrades queues canonical video upgrades without provider catalog rows", async () => {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Canonical Artist");
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video, monitored)
    VALUES (?, ?, ?, ?, ?)`).run("video-recording-1", "Video One", "artist-mbid", 1, 1);
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
  assert.deepEqual(JSON.parse(jobs[0].payload), {
    providerId: "video-provider-1",
    provider: "tidal",
    type: "video",
    reason: "upgrade",
    url: "https://tidal.com/browse/video/video-provider-1",
  });
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

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

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

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

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

  const result = await UpgraderService.checkUpgrades(true, "artist-local");

  assert.equal(result.tracks, 0);
  assert.equal(result.videos, 0);
  assert.equal(result.albums, 0);
  assert.deepEqual(listDownloadJobs(), []);
});





