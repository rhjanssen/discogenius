import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-organizer-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let organizerModule: typeof import("./organizer.js");
let configModule: typeof import("../config/config.js");
let identityModule: typeof import("./library-file-identity.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  organizerModule = await import("./organizer.js");
  identityModule = await import("./library-file-identity.js");
  configModule = await import("../config/config.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM MetadataFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();

  const config = configModule.readConfig();
  config.metadata.save_album_cover = true;
  config.metadata.save_artist_picture = true;
  config.metadata.save_video_thumbnail = true;
  config.metadata.save_nfo = true;
  config.metadata.save_lyrics = true;
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("organizer resolves exact provider track ids to their linked canonical track", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 2);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track-2",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "track-2",
    "recording-2",
    "Track Two",
    "matched",
    1,
  );

  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "provider-track-2",
    releaseMbid: "release-1",
    fallbackAlbumId: "provider-album-1",
    fallbackArtistId: "artist-local",
    fallbackQuality: "LOSSLESS",
  });

  assert.equal(row?.canonical_track_mbid, "track-2");
  assert.equal(row?.canonical_recording_mbid, "recording-2");
  assert.equal(row?.title, "Track Two");
  assert.equal(row?.id, "provider-track-2");
  assert.equal(row?.album_id, "provider-album-1");
  assert.equal(row?.track_number, 2);
  assert.equal(row?.volume_number, 1);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("organizer matches provider-id staging filenames to materialized provider track rows", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Feeling Good", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (id, mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(101, "track-1", "release-1", "recording-1", "Feeling Good", 1, 1);
  // Materialized provider track offer row (the single source of truth). tiddl
  // stages the file as {provider_id}.flac; the importer matches by provider id
  // only — no title/metadata/position fuzzing, no album blob.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid, release_group_mbid, release_mbid,
      title, quality, track_mbid, recording_mbid, library_slot,
      match_status, match_confidence, match_method, match_evidence
    ) VALUES (?, 'track', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "provider-track-1",
    "provider-album-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "Feeling Good",
    "LOSSLESS",
    "track-1",
    "recording-1",
    "stereo",
    "matched",
    0.9,
    "selected-release-position",
    JSON.stringify({ albumProviderId: "provider-album-1", mediumPosition: 1, trackPosition: 1 }),
  );

  const stagedFile = path.join(tempDir, "provider-album-1", "provider-track-1.flac");
  const matches = await (organizerModule.OrganizerService as any).matchAlbumFilesToTracks(
    "provider-album-1",
    [stagedFile],
    {
      provider: "tidal",
      releaseGroupMbid: "release-group-1",
      releaseMbid: "release-1",
      artistMbid: "artist-mbid",
      slot: "stereo",
      quality: "LOSSLESS",
    },
  );
  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: matches.get(stagedFile),
    releaseMbid: "release-1",
    fallbackAlbumId: "provider-album-1",
    fallbackAlbumIds: ["provider-album-1"],
    fallbackArtistId: "artist-local",
    fallbackQuality: "LOSSLESS",
  });

  assert.equal(matches.get(stagedFile), "provider-track-1");
  assert.equal(row?.id, "provider-track-1");
  assert.equal(row?.album_id, "provider-album-1");
  assert.equal(row?.canonical_track_mbid, "track-1");
  assert.equal(row?.canonical_recording_mbid, "recording-1");
});

test("organizer deterministically maps Apple album-bundled video filenames to provider ids", async () => {
  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, title,
      track_number, volume_number, library_slot, match_status
    ) VALUES (?, 'track', ?, ?, ?, ?, 1, 'video', 'matched')
  `);
  insertOffer.run("apple-music", "1445311105", "1445311094", "Bad Blood (Live)", 6);
  insertOffer.run("apple-music", "1445311108", "1445311094", "Pompeii (Live)", 7);
  // The same provider album id in another provider must not enter Apple's
  // fallback candidate set.
  insertOffer.run("tidal", "tidal-video-collision", "1445311094", "Bad Blood (Live)", 6);

  const badBlood = path.join(tempDir, "1445311094", "06. Bad Blood (Live).mp4");
  const pompeii = path.join(tempDir, "1445311094", "07. Pompeii (Live).mp4");
  const matches = await (organizerModule.OrganizerService as any).matchAlbumFilesToTracks(
    "1445311094",
    [badBlood, pompeii],
    { provider: "apple-music", slot: "stereo" },
  );

  assert.equal(matches.get(badBlood), "1445311105");
  assert.equal(matches.get(pompeii), "1445311108");
});

test("organizer leaves ambiguous Apple bundled-video titles staged", async () => {
  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, title,
      track_number, volume_number, library_slot, match_status
    ) VALUES ('apple-music', 'track', ?, 'apple-ambiguous-album', 'Intro', 8, 1, 'video', 'matched')
  `);
  insertOffer.run("apple-intro-a");
  insertOffer.run("apple-intro-b");

  const stagedFile = path.join(tempDir, "apple-ambiguous-album", "08. Intro.mp4");
  const matches = await (organizerModule.OrganizerService as any).matchAlbumFilesToTracks(
    "apple-ambiguous-album",
    [stagedFile],
    { provider: "apple-music", slot: "stereo" },
  );

  assert.equal(matches.has(stagedFile), false);
});

test("organizer returns no match when a staged provider id has no offer row", async () => {
  // No materialized track row and no live provider in the unit env → the
  // force-refresh path fails softly and matching returns empty (recoverable),
  // never a title/position guess.
  const stagedFile = path.join(tempDir, "provider-album-x", "unknown-track.flac");
  const matches = await (organizerModule.OrganizerService as any).matchAlbumFilesToTracks(
    "provider-album-x",
    [stagedFile],
    null,
  );
  assert.equal(matches.size, 0);
});

test("video imports prefer the managed MusicBrainz artist over a provider-only artist", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, path) VALUES (?, ?, ?, ?)")
    .run("managed-artist", "Canonical Artist", "artist-mbid", "Canonical Artist {mbid-artist-mbid}");
  dbModule.db.prepare("INSERT INTO Artists (id, name, path) VALUES (?, ?, ?)")
    .run("12345", "Canonical Artist", "Canonical Artist");
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-recording-mbid", "artist-mbid", "Canonical Video");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_id, title, library_slot,
      match_status, match_confidence
    ) VALUES ('tidal', 'video', ?, ?, ?, 'video', 'verified', 1)
  `).run("provider-video-1", Number(recording.lastInsertRowid), "Canonical Video");

  const artistId = (organizerModule.OrganizerService as any)
    .resolveCanonicalVideoArtistId("tidal", "provider-video-1");

  assert.equal(artistId, "managed-artist");
});

test("video file identity inherits canonical recording and artist from the recording FK", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-recording-mbid", "artist-mbid", "Canonical Video");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_id, title, library_slot,
      match_status, match_confidence
    ) VALUES ('tidal', 'video', ?, ?, ?, 'video', 'verified', 1)
  `).run("provider-video-1", Number(recording.lastInsertRowid), "Canonical Video");

  const identity = identityModule.resolveLibraryFileIdentity({
    provider: "tidal",
    providerEntityType: "video",
    providerId: "provider-video-1",
    mediaId: "provider-video-1",
    fileType: "video",
  });

  assert.equal(identity.canonicalArtistMbid, "artist-mbid");
  assert.equal(identity.canonicalRecordingMbid, "video-recording-mbid");
  assert.equal(identity.librarySlot, "video");
});

test("database startup repairs legacy video files and sidecars to the canonical artist", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, path) VALUES (?, ?, ?, ?)")
    .run("managed-artist", "Canonical Artist", "artist-mbid", "Canonical Artist {mbid-artist-mbid}");
  dbModule.db.prepare("INSERT INTO Artists (id, name, path) VALUES (?, ?, ?)")
    .run("12345", "Canonical Artist", "Canonical Artist");
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-recording-mbid", "artist-mbid", "Canonical Video");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, recording_id, title, library_slot,
      match_status, match_confidence
    ) VALUES ('tidal', 'video', ?, ?, ?, 'video', 'verified', 1)
  `).run("provider-video-1", Number(recording.lastInsertRowid), "Canonical Video");
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_path, relative_path, library_root, filename, extension,
      file_type, provider, provider_entity_type, provider_id, recording_id, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, 'video', 'tidal', 'video', ?, ?, 'video')
  `).run(
    "12345",
    path.join(tempDir, "Canonical Artist", "video.mp4"),
    "Canonical Artist/video.mp4",
    tempDir,
    "video.mp4",
    "mp4",
    "provider-video-1",
    Number(recording.lastInsertRowid),
  );
  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, provider, provider_entity_type, provider_id, library_slot
    ) VALUES (?, ?, ?, ?, ?, 'TrackMetadata', 'nfo', NULL, 'track', ?, 'video')
  `).run(
    "12345",
    "Canonical Artist/video.jpg",
    path.join(tempDir, "Canonical Artist", "video.jpg"),
    tempDir,
    "jpg",
    "provider-video-1",
  );

  dbModule.initDatabase();

  const file = dbModule.db.prepare(`
    SELECT artist_id, canonical_artist_mbid, canonical_recording_mbid
    FROM TrackFiles WHERE provider_id = ?
  `).get("provider-video-1") as any;
  const sidecar = dbModule.db.prepare(`
    SELECT artist_id, provider, provider_entity_type, canonical_artist_mbid, canonical_recording_mbid
    FROM MetadataFiles WHERE provider_id = ?
  `).get("provider-video-1") as any;
  assert.deepEqual(file, {
    artist_id: "managed-artist",
    canonical_artist_mbid: "artist-mbid",
    canonical_recording_mbid: "video-recording-mbid",
  });
  assert.deepEqual(sidecar, {
    artist_id: "managed-artist",
    provider: "tidal",
    provider_entity_type: "video",
    canonical_artist_mbid: "artist-mbid",
    canonical_recording_mbid: "video-recording-mbid",
  });
});

test("metadata pruning removes artist pictures without legacy media_id column", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, provider_entity_type, canonical_artist_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "Canonical Artist/folder.jpg",
    path.join(tempDir, "Canonical Artist", "folder.jpg"),
    tempDir,
    "jpg",
    "cover",
    "cover",
    "artist",
    "artist-mbid",
  );
  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, canonical_artist_mbid, canonical_release_group_mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "Canonical Artist/Canonical Album/cover.jpg",
    path.join(tempDir, "Canonical Artist", "Canonical Album", "cover.jpg"),
    tempDir,
    "jpg",
    "cover",
    "cover",
    "artist-mbid",
    "release-group-1",
  );

  const config = configModule.readConfig();
  config.metadata.save_artist_picture = false;
  configModule.writeConfig(config);

  await organizerModule.OrganizerService.pruneDisabledMetadata();

  const remaining = dbModule.db.prepare(`
    SELECT file_path
    FROM MetadataFiles
    ORDER BY file_path ASC
  `).all() as Array<{ file_path: string }>;

  assert.equal(remaining.length, 1);
  assert.match(remaining[0].file_path, /cover\.jpg$/);
});

test("singleton sidecar relocation uses clean metadata identity columns", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");

  const oldDir = path.join(tempDir, "old");
  const newDir = path.join(tempDir, "new");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldPath = path.join(oldDir, "cover.jpg");
  const newPath = path.join(newDir, "cover.jpg");
  fs.writeFileSync(oldPath, "cover");

  dbModule.db.prepare(`
    INSERT INTO MetadataFiles (
      artist_id, relative_path, file_path, library_root, extension,
      type, file_type, provider, provider_entity_type, provider_id, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "old/cover.jpg",
    oldPath,
    tempDir,
    "jpg",
    "cover",
    "cover",
    "tidal",
    "album",
    "provider-album-1",
    "stereo",
  );

  (organizerModule.OrganizerService as any).relocateSingletonSidecar({
    artistId: "artist-local",
    albumId: "provider-album-1",
    expectedPath: newPath,
    libraryRoot: tempDir,
    fileType: "cover",
  });

  assert.equal(fs.existsSync(newPath), true);
  assert.equal(fs.existsSync(oldPath), false);
  const rows = dbModule.db.prepare(`
    SELECT provider_id, canonical_release_group_mbid, canonical_release_mbid, file_path
    FROM MetadataFiles
    WHERE file_type = 'cover'
  `).all() as Array<{
    provider_id: string | null;
    canonical_release_group_mbid: string | null;
    canonical_release_mbid: string | null;
    file_path: string;
  }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_id, "provider-album-1");
  assert.equal(rows[0].file_path, newPath);
});
