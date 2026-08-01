import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  seedAcceptedProviderTrackMatch,
  seedAcceptedProviderVideoMatch,
} from "../../test-support/normalized-provider-fixtures.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

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
  dbModule.db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlanSources").run();
  // Release the deferred plan reference before its rows go.
  dbModule.db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlans").run();
  dbModule.db.prepare("DELETE FROM LibraryEditions").run();
  dbModule.db.prepare("DELETE FROM LibraryAlbums").run();
  dbModule.db.prepare("DELETE FROM Libraries").run();
  dbModule.db.prepare("DELETE FROM ProviderTrackMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderEditionMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderEditionMembers").run();
  dbModule.db.prepare("DELETE FROM ProviderItemAudioVariants").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
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
  seedTestLibrary(dbModule.db, { name: "Organizer Scratch", rootPath: tempDir });
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
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
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "provider-album-1",
    providerTrackId: "provider-track-2",
    releaseMbid: "release-1",
    trackMbid: "track-2",
  });

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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  // Offer exists but points at MBIDs that are not on the selected release.
  // Provider-native positions must not rematch a different Tracks row.
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
  `).run( "tidal", "track", "provider-orphan", "Provider Native Title" );

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

test("resolveMatchedCanonicalAlbumTrackRow matches trailing-disc offers by ISRC when MBIDs are missing", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Bastille", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-gmtf", "artist-mbid", "Give Me the Future");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-3vol", "rg-gmtf", "artist-mbid", "Give Me the Future + Dreams of the Past", 3, 2);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video, isrcs) VALUES (?, ?, ?, ?, ?)")
    .run("rec-vol3", "Running Away", "artist-mbid", 0, JSON.stringify(["GBUM72202390"]));
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-vol3", "rel-3vol", "rec-vol3", "Running Away", 3, 6);
  // The matcher already accepted this offer onto the trailing-disc track using
  // its ISRC evidence. The organizer CONSUMES that decision — it does not
  // re-match — and must bind to the vol-3 occurrence, not disc 1.
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "243864035",
    providerTrackId: "243864079",
    releaseMbid: "rel-3vol",
    trackMbid: "track-vol3",
  });
  dbModule.db.prepare(`
    UPDATE ProviderItems SET isrc = 'GBUM72202390', title = 'Running Away'
    WHERE provider = 'tidal' AND entity_type = 'track' AND provider_id = '243864079'
  `).run();

  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "243864079",
    releaseMbid: "rel-3vol",
    fallbackAlbumId: "243864035",
    fallbackArtistId: "artist-local",
    fallbackQuality: "HIRES_LOSSLESS",
  });

  assert.equal(row?.canonical_track_mbid, "track-vol3");
  assert.equal(row?.canonical_recording_mbid, "rec-vol3");
  assert.equal(row?.title, "Running Away");
  assert.equal(row?.track_number, 6);
  assert.equal(row?.volume_number, 3);
});

test("organizer matches provider-id staging filenames to materialized provider track rows", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 1);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Feeling Good", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (id, mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(101, "track-1", "release-1", "recording-1", "Feeling Good", 1, 1);
  // Materialized provider track offer with its accepted typed match (the single
  // source of truth). tiddl stages the file as {provider_id}.flac; the importer
  // matches by provider id only — no title/metadata/position fuzzing.
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "provider-album-1",
    providerTrackId: "provider-track-1",
    releaseMbid: "release-1",
    trackMbid: "track-1",
  });

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
  // A bundled video's album context is a release OCCURRENCE (ProviderEditionMembers),
  // not a scalar column; its position comes from that occurrence.
  const insertOffer = (provider: string, providerId: string, albumProviderId: string, title: string, position: number) => {
    const item = dbModule.db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'track', ?, ?) RETURNING id
    `).get(provider, providerId, title) as { id: number };
    let release = dbModule.db.prepare(`
      SELECT id FROM ProviderItems
      WHERE provider = ? AND entity_type = 'release' AND provider_id = ?
    `).get(provider, albumProviderId) as { id: number } | undefined;
    if (!release) {
      release = dbModule.db.prepare(`
        INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
        VALUES (?, 'release', ?, ?) RETURNING id
      `).get(provider, albumProviderId, "Bundled Album") as { id: number };
    }
    dbModule.db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position, contextual_title
      ) VALUES (?, ?, 1, ?, ?)
    `).run(release.id, item.id, position, title);
  };
  insertOffer("apple-music", "1445311105", "1445311094", "Bad Blood (Live)", 6);
  insertOffer("apple-music", "1445311108", "1445311094", "Pompeii (Live)", 7);
  // The same provider album id in another provider must not enter Apple's
  // fallback candidate set.
  insertOffer("tidal", "tidal-video-collision", "1445311094", "Bad Blood (Live)", 6);

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
      provider, entity_type, provider_id, title
    ) VALUES ('apple-music', 'track', ?, 'Intro')
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
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-recording-mbid", "artist-mbid", "Canonical Video");
  const recordingId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-recording-mbid") as { id: number }).id;
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "provider-video-1",
    recordingId,
    title: "Canonical Video",
  });

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
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', ?, ?)
  `).run( "provider-video-1", "Canonical Video" );
  const providerVideo = dbModule.db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = 'tidal'
      AND entity_type = 'video'
      AND provider_id = 'provider-video-1'
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerVideo.id, Number(recording.lastInsertRowid));

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

test("typed plan identity maps a provider source track onto the selected canonical release", async () => {
  const { getCanonicalTrackPosition, resolveCanonicalTrackPosition } = await import("../metadata/canonical-track-position.js");
  const { getCanonicalAlbumMetadata } = await import("../metadata/canonical-album-metadata.js");

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Bastille", "artist-mbid");

  // Native source albums remain canonical catalog entities, but provider
  // availability is linked to the selected target release through typed edges.
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-pompeii", "artist-mbid", "Pompeii");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-come", "artist-mbid", "Come as You Are");
  // Selected compilation release.
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-hybrid", "artist-mbid", "Killing Me Softly");

  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-pompeii", "rg-pompeii", "artist-mbid", "Pompeii", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-come", "rg-come", "artist-mbid", "Come as You Are", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
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

  const artistMetadata = dbModule.db.prepare(`
    SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'
  `).get() as { id: number };
  dbModule.db.prepare(`
    UPDATE Albums SET artist_metadata_id = ? WHERE artist_mbid = 'artist-mbid'
  `).run(artistMetadata.id);
  dbModule.db.prepare(`
    UPDATE AlbumEditions
    SET
      release_group_id = (
        SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid
      ),
      artist_metadata_id = ?
    WHERE artist_mbid = 'artist-mbid'
  `).run(artistMetadata.id);
  dbModule.db.prepare(`
    UPDATE Tracks
    SET
      album_edition_id = (
        SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid
      ),
      recording_id = (
        SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid
      )
  `).run();
  const hybridGroup = dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-hybrid'")
    .get() as { id: number };
  const hybridRelease = dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-hybrid'")
    .get() as { id: number };
  const hybridTrack = dbModule.db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = 't-pompeii-hybrid'")
    .get() as { id: number; recording_id: number };
  const providerRelease = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', 'album-pompeii', 'Pompeii')
    RETURNING id
  `).get() as { id: number };
  const providerTrack = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', 'provider-pompeii', 'Pompeii')
    RETURNING id
  `).get() as { id: number };
  const member = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'source_subset', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, hybridRelease.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerTrack.id, member.id, releaseMatch.id, hybridTrack.id, hybridTrack.recording_id);
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Identity Test', '{}')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    )
    SELECT
      'Identity Stereo',
      ?,
      metadata_profile.id,
      quality_profile.id
    FROM MetadataProfiles metadata_profile
    JOIN quality_profiles quality_profile
      ON COALESCE(quality_profile.allowed_source_formats, '[]') NOT LIKE '%spatial%'
    WHERE metadata_profile.name = 'Identity Test'
    ORDER BY quality_profile.id
    LIMIT 1
  `).run(path.join(tempDir, "identity-stereo"));
  const library = dbModule.db.prepare("SELECT id FROM Libraries WHERE name = 'Identity Stereo'")
    .get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, hybridGroup.id);
  const libraryRelease = dbModule.db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
    RETURNING id
  `).get(library.id, hybridRelease.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(dbModule.db, { libraryEditionId: libraryRelease.id, provider: 'tidal', downloadMode: 'tracks' }) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
  `).run(plan.id, releaseMatch.id);

  // Without explicit job fields, typed track and release matches resolve the
  // selected canonical target.
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

  // A native catalog track MBID must not override the explicitly selected
  // release when the same recording has a target track there.
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

test("hybrid tips with providerAlbumId on secondary albums match organize scope", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Bastille", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-hybrid-tips", "artist-mbid", "Hybrid Tips");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-hybrid-tips", "rg-hybrid-tips", "artist-mbid", "Hybrid Tips", 1, 2);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-primary", "Primary Tip", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-secondary", "Secondary Tip", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-primary", "rel-hybrid-tips", "rec-primary", "Primary Tip", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-secondary", "rel-hybrid-tips", "rec-secondary", "Secondary Tip", 1, 2);

  // Each track occurs on a DIFFERENT provider album, both accepted-matched onto
  // the one canonical release — the hybrid case membership must express.
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal", providerEditionId: "album-primary", providerTrackId: "trk-primary",
    releaseMbid: "rel-hybrid-tips", trackMbid: "t-primary",
  });
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal", providerEditionId: "album-secondary", providerTrackId: "trk-secondary",
    releaseMbid: "rel-hybrid-tips", trackMbid: "t-secondary",
  });

  const stagedPrimary = path.join(tempDir, "hybrid-tips", "trk-primary.flac");
  const stagedSecondary = path.join(tempDir, "hybrid-tips", "trk-secondary.flac");
  const trackOffers = [
    {
      providerTrackId: "trk-primary",
      providerAlbumId: "album-primary",
      quality: "HIRES_LOSSLESS",
      canonicalTrackMbid: "t-primary",
      canonicalRecordingMbid: "rec-primary",
    },
    {
      providerTrackId: "trk-secondary",
      providerAlbumId: "album-secondary",
      quality: "HIRES_LOSSLESS",
      canonicalTrackMbid: "t-secondary",
      canonicalRecordingMbid: "rec-secondary",
    },
  ];

  // Job tip album ids must expand match scope even when the hybrid providerId
  // string only lists the primary album.
  const matches = await (organizerModule.OrganizerService as any).matchAlbumFilesToTracks(
    "album-primary",
    [stagedPrimary, stagedSecondary],
    {
      provider: "tidal",
      releaseGroupMbid: "rg-hybrid-tips",
      releaseMbid: "rel-hybrid-tips",
      artistMbid: "artist-mbid",
      slot: "stereo",
      quality: "HIRES_LOSSLESS",
    },
    trackOffers,
  );

  assert.equal(matches.get(stagedPrimary), "trk-primary");
  assert.equal(matches.get(stagedSecondary), "trk-secondary");

  const secondaryRow = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "trk-secondary",
    releaseMbid: "rel-hybrid-tips",
    fallbackAlbumId: "album-primary",
    fallbackAlbumIds: ["album-primary", "album-secondary"],
    fallbackArtistId: "artist-local",
    fallbackQuality: "HIRES_LOSSLESS",
  });
  assert.equal(secondaryRow?.id, "trk-secondary");
  assert.equal(secondaryRow?.canonical_track_mbid, "t-secondary");
  assert.equal(secondaryRow?.canonical_recording_mbid, "rec-secondary");
  assert.equal(secondaryRow?.track_number, 2);
});

test("an exact plan source organizes under the job release, not a same-recording single", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-amy", "Amy Winehouse");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-amy-local", "Amy Winehouse", "artist-amy");

  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-btb", "artist-amy", "Back to Black");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-rehab-single", "artist-amy", "Rehab");

  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-btb-deluxe", "rg-btb", "artist-amy", "Back to Black", 1, 2);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rel-rehab-single", "rg-rehab-single", "artist-amy", "Rehab", 1, 1);

  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-rehab", "Rehab", "artist-amy", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("rec-you-know", "You Know I'm No Good", "artist-amy", 0);

  // Deluxe BTB positions.
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-rehab-btb", "rel-btb-deluxe", "rec-rehab", "Rehab", 1, 7);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-you-know-btb", "rel-btb-deluxe", "rec-you-know", "You Know I'm No Good", 1, 2);
  // Competing single position (same recording).
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("t-rehab-single", "rel-rehab-single", "rec-rehab", "Rehab", 1, 1);

  const artistMetadata = dbModule.db.prepare(`
    SELECT id FROM ArtistMetadata WHERE mbid = 'artist-amy'
  `).get() as { id: number };
  const btbGroup = dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-btb'")
    .get() as { id: number };
  const singleGroup = dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-rehab-single'")
    .get() as { id: number };
  const btbRelease = dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-btb-deluxe'")
    .get() as { id: number };
  const singleRelease = dbModule.db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-rehab-single'")
    .get() as { id: number };
  dbModule.db.prepare("UPDATE Albums SET artist_metadata_id = ? WHERE id IN (?, ?)")
    .run(artistMetadata.id, btbGroup.id, singleGroup.id);
  dbModule.db.prepare(`
    UPDATE AlbumEditions
    SET
      release_group_id = CASE mbid
        WHEN 'rel-btb-deluxe' THEN ?
        ELSE ?
      END,
      artist_metadata_id = ?
    WHERE id IN (?, ?)
  `).run(
    btbGroup.id,
    singleGroup.id,
    artistMetadata.id,
    btbRelease.id,
    singleRelease.id,
  );
  dbModule.db.prepare(`
    UPDATE Tracks
    SET
      album_edition_id = (
        SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid
      ),
      recording_id = (
        SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid
      )
    WHERE release_mbid IN ('rel-btb-deluxe', 'rel-rehab-single')
  `).run();

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'release', ?, ?)
  `).run( "tidal", "77661290", "Back to Black" );
  const providerRelease = dbModule.db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = '77661290'
  `).get() as { id: number };
  const releaseMatch = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, btbRelease.id) as { id: number };
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Organizer Test', '{}')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    )
    SELECT
      'Organizer Stereo',
      ?,
      metadata_profile.id,
      quality_profile.id
    FROM MetadataProfiles metadata_profile
    JOIN quality_profiles quality_profile
      ON COALESCE(quality_profile.allowed_source_formats, '[]') NOT LIKE '%spatial%'
    WHERE metadata_profile.name = 'Organizer Test'
    ORDER BY quality_profile.id
    LIMIT 1
  `).run(path.join(tempDir, "organizer-stereo"));
  const library = dbModule.db.prepare("SELECT id FROM Libraries WHERE name = 'Organizer Stereo'")
    .get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, btbGroup.id);
  const libraryRelease = dbModule.db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
    RETURNING id
  `).get(library.id, btbRelease.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(dbModule.db, { libraryEditionId: libraryRelease.id, provider: 'tidal', downloadMode: 'tracks' }) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
  `).run(plan.id, releaseMatch.id);

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'track', ?, ?)
  `).run( "tidal", "77661291", "Rehab" );

  const context = (organizerModule.OrganizerService as any).resolveCanonicalAlbumImportContext(
    {
      type: "album",
      provider: "tidal",
      providerId: "77661290",
      releaseGroupMbid: "rg-btb",
      releaseMbid: "rel-btb-deluxe",
      slot: "stereo",
      trackOffers: [
        {
          providerTrackId: "77661291",
          providerAlbumId: "77661290",
          canonicalTrackMbid: "t-rehab-btb",
          canonicalRecordingMbid: "rec-rehab",
          quality: "HIRES_LOSSLESS",
        },
      ],
    },
    "77661290",
  );

  assert.equal(context?.releaseGroupMbid, "rg-btb");
  assert.equal(context?.releaseMbid, "rel-btb-deluxe");
  assert.notEqual(context?.releaseGroupMbid, "rg-rehab-single");

  // Job RG hint must keep identity on BTB even when albumId is the colliding tip.
  const identity = identityModule.resolveLibraryFileIdentity({
    provider: "tidal",
    providerEntityType: "track",
    providerId: "77661291",
    mediaId: "77661291",
    albumId: "77661290",
    fileType: "track",
    librarySlot: "stereo",
    canonicalReleaseGroupMbid: "rg-btb",
    canonicalReleaseMbid: "rel-btb-deluxe",
    canonicalTrackMbid: "t-rehab-btb",
    canonicalRecordingMbid: "rec-rehab",
  });
  assert.equal(identity.canonicalReleaseGroupMbid, "rg-btb");
  assert.equal(identity.canonicalReleaseMbid, "rel-btb-deluxe");
  assert.equal(identity.canonicalTrackMbid, "t-rehab-btb");

  const { getCanonicalTrackPosition } = await import("../metadata/canonical-track-position.js");
  assert.equal(getCanonicalTrackPosition("t-rehab-btb")?.trackNumber, 7);
  assert.equal(getCanonicalTrackPosition("t-rehab-single")?.trackNumber, 1);

  // Without an explicit job RG, the current plan still provides the authority.
  const contextNoJobRg = (organizerModule.OrganizerService as any).resolveCanonicalAlbumImportContext(
    {
      type: "album",
      provider: "tidal",
      providerId: "77661290",
      slot: "stereo",
    },
    "77661290",
  );
  assert.equal(contextNoJobRg?.releaseGroupMbid, "rg-btb");
  assert.equal(contextNoJobRg?.releaseMbid, "rel-btb-deluxe");
});
