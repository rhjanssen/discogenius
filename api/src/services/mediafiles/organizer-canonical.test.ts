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
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
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

test("resolveMatchedCanonicalAlbumTrackRow fails closed when catalog track is missing", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  // Offer exists but points at MBIDs that are not on the selected release.
  // Provider-native positions must not rematch a different Tracks row.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, track_number, volume_number, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-orphan",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "missing-track-mbid",
    "missing-recording-mbid",
    "Provider Native Title",
    1,
    1,
    "matched",
  );

  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "provider-orphan",
    releaseMbid: "release-1",
    fallbackAlbumId: "provider-album-1",
    fallbackArtistId: "artist-local",
    fallbackQuality: "LOSSLESS",
  });

  assert.equal(row, null);
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
    // albumProviderId only — never seed trackPosition/mediumPosition for binding.
    JSON.stringify({ albumProviderId: "provider-album-1" }),
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

test("hybrid composite identity prefers monitored hybrid over native provider albums", async () => {
  const { getCanonicalTrackPosition, resolveCanonicalTrackPosition } = await import("../metadata/canonical-track-position.js");
  const { getCanonicalAlbumMetadata } = await import("../metadata/canonical-album-metadata.js");

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Bastille", "artist-mbid");

  // Native source albums (what ProviderItems point at).
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-pompeii", "artist-mbid", "Pompeii");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-come", "artist-mbid", "Come as You Are");
  // Monitored hybrid composite.
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-hybrid", "artist-mbid", "Killing Me Softly");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-pompeii", "rg-pompeii", "artist-mbid", "Pompeii", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-come", "rg-come", "artist-mbid", "Come as You Are", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-hybrid", "rg-hybrid", "artist-mbid", "Killing Me Softly", 1, 3);

  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-softly", "Killing Me Softly", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-pompeii", "Pompeii", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-come", "Come as You Are", "artist-mbid", 0);

  // Native positions (1 on each native release).
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-pompeii-native", "rel-pompeii", "rec-pompeii", "Pompeii", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-come-native", "rel-come", "rec-come", "Come as You Are", 1, 1);
  // Hybrid positions (2 and 3).
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-softly-hybrid", "rel-hybrid", "rec-softly", "Killing Me Softly", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-pompeii-hybrid", "rel-hybrid", "rec-pompeii", "Pompeii", 1, 2);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-come-hybrid", "rel-hybrid", "rec-come", "Come as You Are", 1, 3);

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, selected_release_mbid
    ) VALUES (?, ?, 'stereo', 1, 'tidal', ?, ?)
  `).run("artist-mbid", "rg-hybrid", "album-softly;album-pompeii;album-come", "rel-hybrid");

  // Native Pompeii offer — what a DownloadTrack job would resolve from provider id alone.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid,
      release_group_mbid, release_mbid, track_mbid, recording_mbid,
      title, quality, library_slot, match_status, match_confidence,
      match_evidence
    ) VALUES (?, 'track', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stereo', 'matched', 1, ?)
  `).run(
    "tidal",
    "provider-pompeii",
    "album-pompeii",
    "artist-mbid",
    "rg-pompeii",
    "rel-pompeii",
    "t-pompeii-native",
    "rec-pompeii",
    "Pompeii",
    "LOSSLESS",
    // Counterpart/album linkage only — provider-native positions must not bind.
    JSON.stringify({ albumProviderId: "album-pompeii" }),
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid,
      release_group_mbid, release_mbid, title, quality, library_slot, match_status
    ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, 'stereo', 'matched')
  `).run("tidal", "album-pompeii", "artist-mbid", "rg-pompeii", "rel-pompeii", "Pompeii", "LOSSLESS");

  // Without job hybrid fields, slot remapping via composite selected_provider_id
  // must still win over native ProviderItems RG/track MBIDs.
  const fromSlot = identityModule.resolveLibraryFileIdentity({
    provider: "tidal",
    providerEntityType: "track",
    providerId: "provider-pompeii",
    mediaId: "provider-pompeii",
    albumId: "album-pompeii",
    fileType: "track",
    librarySlot: "stereo",
  });
  assert.equal(fromSlot.canonicalReleaseGroupMbid, "rg-hybrid");
  assert.equal(fromSlot.canonicalReleaseMbid, "rel-hybrid");
  assert.equal(fromSlot.canonicalTrackMbid, "t-pompeii-hybrid");
  assert.equal(getCanonicalTrackPosition(fromSlot.canonicalTrackMbid)?.trackNumber, 2);
  assert.equal(getCanonicalAlbumMetadata({
    canonicalReleaseGroupMbid: fromSlot.canonicalReleaseGroupMbid,
    canonicalReleaseMbid: fromSlot.canonicalReleaseMbid,
  })?.title, "Killing Me Softly");

  // Explicit DownloadTrack job fields (as acquisition plan emits them) are highest priority.
  const fromJob = resolveCanonicalTrackPosition({
    provider: "tidal",
    providerEntityType: "track",
    providerId: "provider-come",
    mediaId: "provider-come",
    albumId: "album-come",
    fileType: "track",
    librarySlot: "stereo",
    canonicalReleaseGroupMbid: "rg-hybrid",
    canonicalReleaseMbid: "rel-hybrid",
    canonicalTrackMbid: "t-come-hybrid",
    canonicalRecordingMbid: "rec-come",
  });
  assert.equal(fromJob?.trackNumber, 3);
  assert.equal(fromJob?.title, "Come as You Are");

  // Native track MBID must not win when the monitored slot remaps via recording
  // (the Softly/Pompeii bug: hybrid RG + native Pompeii track ⇒ filename 01).
  const fromNativeTrackOnHybrid = identityModule.resolveLibraryFileIdentity({
    provider: "tidal",
    providerEntityType: "track",
    providerId: "provider-pompeii",
    mediaId: "provider-pompeii",
    albumId: "album-pompeii",
    fileType: "track",
    librarySlot: "stereo",
    canonicalReleaseGroupMbid: "rg-hybrid",
    canonicalReleaseMbid: "rel-hybrid",
    canonicalTrackMbid: "t-pompeii-native",
    canonicalRecordingMbid: "rec-pompeii",
  });
  assert.equal(fromNativeTrackOnHybrid.canonicalTrackMbid, "t-pompeii-hybrid");
  assert.equal(getCanonicalTrackPosition(fromNativeTrackOnHybrid.canonicalTrackMbid)?.trackNumber, 2);
});
