import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { seedAcceptedProviderTrackMatch } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-rebind-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let libraryFilesModule: typeof import("./library-files.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  libraryFilesModule = await import("./library-files.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM Libraries").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  seedTestLibrary(db, { name: "Rebind Stereo", rootPath: path.join(tempDir, "stereo") });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("rebind moves a scan-imported file from an unmonitored sibling onto the selected edition", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-bbx", "artist-mbid", "Bad Blood");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 33)
  `).run("rel-bbx-selected", "rg-bbx", "artist-mbid", "Bad Blood X");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 33)
  `).run("rel-bbx-sibling", "rg-bbx", "artist-mbid", "Bad Blood X");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-mmxxiii", "Pompeii MMXXIII", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("t-mmxxiii-selected", "rel-bbx-selected", "rec-mmxxiii", "Pompeii MMXXIII");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 2, 1)
  `).run("t-mmxxiii-sibling", "rel-bbx-sibling", "rec-mmxxiii", "Pompeii MMXXIII");
  db.prepare(`
    UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bbx'").get() as { id: number };
  const selectedEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-bbx-selected'")
    .get() as { id: number };
  const siblingEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-bbx-sibling'")
    .get() as { id: number };
  const selectedTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-mmxxiii-selected'")
    .get() as { id: number };
  const siblingTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-mmxxiii-sibling'")
    .get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };

  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(library.id, selectedEdition.id);

  const filePath = path.join(tempDir, "stereo", "Bastille", "Bad Blood X (2023)", "101 - Pompeii MMXXIII.m4a");
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, 'Bastille/Bad Blood X/101 - Pompeii MMXXIII.m4a', '101 - Pompeii MMXXIII.m4a', 'm4a',
      'rg-bbx', 'rel-bbx-sibling', 't-mmxxiii-sibling', 'rec-mmxxiii'
    )
  `).run(library.id, siblingEdition.id, siblingTrack.id, path.join(tempDir, "stereo"), filePath);

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 1);

  const rebound = db.prepare(`
    SELECT album_edition_id, track_id, canonical_release_mbid, canonical_track_mbid
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as {
    album_edition_id: number;
    track_id: number;
    canonical_release_mbid: string;
    canonical_track_mbid: string;
  };
  assert.equal(rebound.album_edition_id, selectedEdition.id);
  assert.equal(rebound.track_id, selectedTrack.id);
  assert.equal(rebound.canonical_release_mbid, "rel-bbx-selected");
  assert.equal(rebound.canonical_track_mbid, "t-mmxxiii-selected");
});

test("rebind prefers a monitored provider edition over a different monitored sibling", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Billie Eilish");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-hmhas", "artist-mbid", "HIT ME HARD AND SOFT");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
    VALUES (?, ?, ?, ?, '2024-05-17', 1, 10)
  `).run("rel-english", "rg-hmhas", "artist-mbid", "HIT ME HARD AND SOFT");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
    VALUES (?, ?, ?, ?, '2025-08-01', 1, 11)
  `).run("rel-japanese", "rg-hmhas", "artist-mbid", "ヒット・ミー・ハード・アンド・ソフト");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-skinny", "SKINNY", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("t-skinny-english", "rel-english", "rec-skinny", "SKINNY");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("t-skinny-japanese", "rel-japanese", "rec-skinny", "スキニー");
  db.prepare(`UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')`).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const englishEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-english'").get() as { id: number };
  const japaneseEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-japanese'").get() as { id: number };
  const englishTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-skinny-english'").get() as { id: number };
  const japaneseTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-skinny-japanese'").get() as { id: number };
  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-hmhas'").get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (?, ?, 'auto', 1, 'curation_primary', 1)
  `).run(library.id, englishEdition.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'discography_gap_fill', 1)
  `).run(library.id, japaneseEdition.id);
  seedAcceptedProviderTrackMatch(db, {
    provider: "tidal",
    providerEditionId: "tidal-hmhas",
    providerTrackId: "tidal-skinny",
    releaseMbid: "rel-english",
    trackMbid: "t-skinny-english",
  });

  const filePath = path.join(tempDir, "stereo", "Billie Eilish", "japanese", "01.flac");
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      provider, provider_entity_type, provider_id,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, 'Billie Eilish/japanese/01.flac', '01.flac', 'flac',
      'tidal', 'track', 'tidal-skinny',
      'rg-hmhas', 'rel-japanese', 't-skinny-japanese', 'rec-skinny'
    )
  `).run(library.id, japaneseEdition.id, japaneseTrack.id, path.join(tempDir, "stereo"), filePath);

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 1);
  const rebound = db.prepare(`
    SELECT album_edition_id, track_id, canonical_release_mbid, canonical_track_mbid
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as {
    album_edition_id: number;
    track_id: number;
    canonical_release_mbid: string;
    canonical_track_mbid: string;
  };
  assert.equal(rebound.album_edition_id, englishEdition.id);
  assert.equal(rebound.track_id, englishTrack.id);
  assert.equal(rebound.canonical_release_mbid, "rel-english");
  assert.equal(rebound.canonical_track_mbid, "t-skinny-english");
});

test("rebind keeps a file on the monitored edition named in its folder", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Lost Frequencies");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-aywm", "artist-mbid", "Are You With Me");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 1, 20)
  `).run("11111111-1111-4111-8111-111111111111", "rg-aywm", "artist-mbid", "Are You With Me (Remixes Two)");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 1, 12)
  `).run("22222222-2222-4222-8222-222222222222", "rg-aywm", "artist-mbid", "Are You With Me (Remixes Two)");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-extended", "Are You With Me (extended remix)", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 14)
  `).run("t-short", "11111111-1111-4111-8111-111111111111", "rec-extended", "Are You With Me (remix)");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 9)
  `).run("t-extended", "22222222-2222-4222-8222-222222222222", "rec-extended", "Are You With Me (extended remix)");
  db.prepare(`UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')`).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const shortEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = '11111111-1111-4111-8111-111111111111'").get() as { id: number };
  const extendedEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = '22222222-2222-4222-8222-222222222222'").get() as { id: number };
  const shortTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-short'").get() as { id: number };
  const extendedTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-extended'").get() as { id: number };
  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-aywm'").get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (?, ?, 'auto', 1, 'curation_primary', 1)
  `).run(library.id, shortEdition.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'discography_gap_fill', 1)
  `).run(library.id, extendedEdition.id);
  seedAcceptedProviderTrackMatch(db, {
    provider: "tidal",
    providerEditionId: "tidal-short",
    providerTrackId: "tidal-extended-file",
    releaseMbid: "11111111-1111-4111-8111-111111111111",
    trackMbid: "t-short",
  });

  const filePath = path.join(
    tempDir, "stereo", "Lost Frequencies {mbid-artist-mbid}",
    "Are You With Me (Remixes Two) {mbid-22222222-2222-4222-8222-222222222222}",
    "09 - Are You With Me (extended remix).flac",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      provider, provider_entity_type, provider_id,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, 'Lost Frequencies/extended/09.flac', '09 - Are You With Me (extended remix).flac', 'flac',
      'tidal', 'track', 'tidal-extended-file',
      'rg-aywm', '11111111-1111-4111-8111-111111111111', 't-short', 'rec-extended'
    )
  `).run(library.id, shortEdition.id, shortTrack.id, path.join(tempDir, "stereo"), filePath);

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 1);
  const rebound = db.prepare(`
    SELECT album_edition_id, track_id, canonical_release_mbid, canonical_track_mbid
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as {
    album_edition_id: number;
    track_id: number;
    canonical_release_mbid: string;
    canonical_track_mbid: string;
  };
  assert.equal(rebound.album_edition_id, extendedEdition.id);
  assert.equal(rebound.track_id, extendedTrack.id);
  assert.equal(rebound.canonical_release_mbid, "22222222-2222-4222-8222-222222222222");
  assert.equal(rebound.canonical_track_mbid, "t-extended");
});

test("rebind splits two disc files onto the folder edition tracks they are named for", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "The Kinks");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-face", "artist-mbid", "Face to Face");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("33333333-3333-4333-8333-333333333333", "rg-face", "artist-mbid", "Face to Face");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 2)
  `).run("44444444-4444-4444-8444-444444444444", "rg-face", "artist-mbid", "Face to Face");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-party", "Party Line", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 2, 1)
  `).run("t-party-single", "33333333-3333-4333-8333-333333333333", "rec-party", "Party Line");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run("t-party-d1", "44444444-4444-4444-8444-444444444444", "rec-party", "Party Line");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 2, 1)
  `).run("t-party-d2", "44444444-4444-4444-8444-444444444444", "rec-party", "Party Line");
  db.prepare(`UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')`).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const singleEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = '33333333-3333-4333-8333-333333333333'").get() as { id: number };
  const boxEdition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = '44444444-4444-4444-8444-444444444444'").get() as { id: number };
  const singleTrack = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-party-single'").get() as { id: number };
  const disc1 = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-party-d1'").get() as { id: number };
  const disc2 = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-party-d2'").get() as { id: number };
  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-face'").get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  for (const editionId of [singleEdition.id, boxEdition.id]) {
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
      VALUES (?, ?, 'auto', ?, 'test', 1)
    `).run(library.id, editionId, editionId === singleEdition.id ? 1 : 0);
  }
  const insert = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, ?, ?, 'flac',
      'rg-face', '33333333-3333-4333-8333-333333333333', 't-party-single', 'rec-party'
    )
  `);
  const folder = path.join(
    tempDir, "stereo", "The Kinks {mbid-artist-mbid}",
    "Face to Face {mbid-44444444-4444-4444-8444-444444444444}",
  );
  const disc1Path = path.join(folder, "101 - Party Line.flac");
  const disc2Path = path.join(folder, "201 - Party Line.flac");
  insert.run(library.id, singleEdition.id, singleTrack.id, path.join(tempDir, "stereo"), disc1Path, "kinks/101.flac", "101 - Party Line.flac");
  insert.run(library.id, singleEdition.id, singleTrack.id, path.join(tempDir, "stereo"), disc2Path, "kinks/201.flac", "201 - Party Line.flac");

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 2);
  const bound = db.prepare(`
    SELECT file_path, album_edition_id, track_id, canonical_track_mbid
    FROM TrackFiles ORDER BY filename
  `).all() as Array<{ file_path: string; album_edition_id: number; track_id: number; canonical_track_mbid: string }>;
  assert.equal(bound[0].file_path, disc1Path);
  assert.equal(bound[0].album_edition_id, boxEdition.id);
  assert.equal(bound[0].track_id, disc1.id);
  assert.equal(bound[0].canonical_track_mbid, "t-party-d1");
  assert.equal(bound[1].file_path, disc2Path);
  assert.equal(bound[1].album_edition_id, boxEdition.id);
  assert.equal(bound[1].track_id, disc2.id);
  assert.equal(bound[1].canonical_track_mbid, "t-party-d2");
});

test("rebind uses the filename position when one monitored edition lists the recording twice", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "The Supremes");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("rg-joined", "artist-mbid", "Joined Together");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, 2, 2)
  `).run("55555555-5555-4555-8555-555555555555", "rg-joined", "artist-mbid", "Joined Together: The Complete Studio Duets");
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, 0)")
    .run("rec-try", "I'll Try Something New", "artist-mbid");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 1, 8)
  `).run("t-try-stereo", "55555555-5555-4555-8555-555555555555", "rec-try", "I'll Try Something New");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, 2, 11)
  `).run("t-try-single", "55555555-5555-4555-8555-555555555555", "rec-try", "I'll Try Something New (single mix)");
  db.prepare(`UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')`).run();
  db.prepare(`
    UPDATE AlbumEditions SET
      release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid),
      artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid')
  `).run();
  db.prepare(`
    UPDATE Tracks SET
      album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid),
      recording_id = (SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid)
  `).run();

  const edition = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = '55555555-5555-4555-8555-555555555555'").get() as { id: number };
  const stereo = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-try-stereo'").get() as { id: number };
  const single = db.prepare("SELECT id FROM Tracks WHERE mbid = 't-try-single'").get() as { id: number };
  const group = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-joined'").get() as { id: number };
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Rebind Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
    VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, group.id);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
    VALUES (?, ?, 'manual', 1, 'test', 1)
  `).run(library.id, edition.id);
  const insert = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension,
      canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'), ?, ?, ?, 'track', 'stereo',
      ?, ?, ?, ?, 'flac',
      'rg-joined', '55555555-5555-4555-8555-555555555555', 't-try-stereo', 'rec-try'
    )
  `);
  const sessions = path.join(
    tempDir, "stereo", "The Supremes {mbid-artist-mbid}",
    "Joined Together The Complete Studio Sessions {mbid-66666666-6666-4666-8666-666666666666}",
  );
  const stereoPath = path.join(sessions, "108 - I'll Try Something New (stereo version).flac");
  const singlePath = path.join(sessions, "211 - I'll Try Something New.flac");
  insert.run(library.id, edition.id, stereo.id, path.join(tempDir, "stereo"), stereoPath, "supremes/108.flac", "108 - I'll Try Something New (stereo version).flac");
  insert.run(library.id, edition.id, stereo.id, path.join(tempDir, "stereo"), singlePath, "supremes/211.flac", "211 - I'll Try Something New.flac");

  const result = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions("artist-mbid");
  assert.equal(result.rebound, 1);
  const moved = db.prepare(`
    SELECT track_id, canonical_track_mbid FROM TrackFiles WHERE file_path = ?
  `).get(singlePath) as { track_id: number; canonical_track_mbid: string };
  const stayed = db.prepare(`
    SELECT track_id, canonical_track_mbid FROM TrackFiles WHERE file_path = ?
  `).get(stereoPath) as { track_id: number; canonical_track_mbid: string };
  assert.equal(moved.track_id, single.id);
  assert.equal(moved.canonical_track_mbid, "t-try-single");
  assert.equal(stayed.track_id, stereo.id);
  assert.equal(stayed.canonical_track_mbid, "t-try-stereo");
});
