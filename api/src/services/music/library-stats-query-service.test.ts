import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { resetActiveSchemaRows } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-stats-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let libraryStatsModule: typeof import("./library-stats-query-service.js");
let appEventsModule: typeof import("../commands/app-events.js");

type ArtistFixture = {
  id: string;
  mbid: string;
  metadataId: number;
  managedArtistId: number;
};

type AlbumFixture = {
  releaseGroupId: number;
  releaseGroupMbid: string;
  editionId: number;
  editionMbid: string;
  tracks: Array<{ id: number; mbid: string; recordingId: number; recordingMbid: string }>;
};

type LibraryFixture = {
  id: number;
  rootPath: string;
};

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  libraryStatsModule = await import("./library-stats-query-service.js");
  appEventsModule = await import("../commands/app-events.js");
});

beforeEach(() => {
  resetActiveSchemaRows(dbModule.db);
  dbModule.db.prepare("DELETE FROM ArtistStatistics").run();
  dbModule.db.prepare("UPDATE Libraries SET enabled = 1").run();
  libraryStatsModule.LibraryStatsQueryService.clearCache();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function getLibrary(name: "Stereo" | "Spatial" | "Video"): LibraryFixture {
  const row = dbModule.db.prepare(`
    SELECT id, root_path AS rootPath
    FROM Libraries
    WHERE name = ?
  `).get(name) as LibraryFixture | undefined;
  assert.ok(row, `default ${name} library exists`);
  return row;
}

function seedArtist(key: string): ArtistFixture {
  const mbid = `artist-${key}`;
  const metadata = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
    RETURNING id
  `).get(mbid, `Artist ${key}`) as { id: number };

  return {
    id: mbid,
    mbid,
    metadataId: metadata.id,
    managedArtistId: metadata.id,
  };
}

function monitorArtist(artist: ArtistFixture, library: LibraryFixture): void {
  dbModule.db.prepare(`
    INSERT INTO LibraryArtists (library_id, artist_metadata_id, policy)
    VALUES (?, ?, 'all')
  `).run(library.id, artist.metadataId);
}

function seedAlbum(
  key: string,
  artist: ArtistFixture,
  trackCount: number,
): AlbumFixture {
  const releaseGroupMbid = `album-${key}`;
  const releaseGroup = dbModule.db.prepare(`
    INSERT INTO Albums (
      foreign_album_id, mbid, artist_metadata_id, artist_mbid, title
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    releaseGroupMbid,
    releaseGroupMbid,
    artist.metadataId,
    artist.mbid,
    `Album ${key}`,
  ) as { id: number };

  const editionMbid = `edition-${key}`;
  const edition = dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      foreign_release_id, mbid, release_group_id, release_group_mbid,
      artist_metadata_id, artist_mbid, title, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    editionMbid,
    editionMbid,
    releaseGroup.id,
    releaseGroupMbid,
    artist.metadataId,
    artist.mbid,
    `Edition ${key}`,
    trackCount,
  ) as { id: number };

  const tracks: AlbumFixture["tracks"] = [];
  for (let position = 1; position <= trackCount; position++) {
    const recordingMbid = `recording-${key}-${position}`;
    const recording = dbModule.db.prepare(`
      INSERT INTO Recordings (
        foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
        title, is_video, metadata_status
      ) VALUES (?, ?, ?, ?, ?, 0, 'musicbrainz')
      RETURNING id
    `).get(
      recordingMbid,
      recordingMbid,
      artist.metadataId,
      artist.mbid,
      `Track ${position}`,
    ) as { id: number };

    const trackMbid = `track-${key}-${position}`;
    const track = dbModule.db.prepare(`
      INSERT INTO Tracks (
        foreign_track_id, mbid, album_edition_id, release_mbid,
        recording_id, recording_mbid, medium_position, position, title
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      RETURNING id
    `).get(
      trackMbid,
      trackMbid,
      edition.id,
      editionMbid,
      recording.id,
      recordingMbid,
      position,
      `Track ${position}`,
    ) as { id: number };

    tracks.push({
      id: track.id,
      mbid: trackMbid,
      recordingId: recording.id,
      recordingMbid,
    });
  }

  return {
    releaseGroupId: releaseGroup.id,
    releaseGroupMbid,
    editionId: edition.id,
    editionMbid,
    tracks,
  };
}

function monitorAlbum(album: AlbumFixture, library: LibraryFixture): void {
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, curation_version
    ) VALUES (?, ?, 'auto', 1)
  `).run(library.id, album.releaseGroupId);
  dbModule.db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, representative, curation_version
    ) VALUES (?, ?, 'auto', 1, 1)
  `).run(library.id, album.editionId);
}

function addAudioFile(
  artist: ArtistFixture,
  album: AlbumFixture,
  trackIndex: number,
  library: LibraryFixture,
  suffix: string,
): void {
  const track = album.tracks[trackIndex];
  assert.ok(track);
  const relativePath = `${artist.mbid}/${album.releaseGroupMbid}/${track.mbid}-${suffix}.flac`;
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      release_group_id, album_edition_id, track_id, recording_id,
      library_slot, library_id, file_path, relative_path, library_root,
      filename, extension, file_type, file_class, quality, file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'flac',
      'track', 'audio', 'LOSSLESS', 100)
  `).run(
    artist.metadataId,
    artist.mbid,
    album.releaseGroupMbid,
    album.editionMbid,
    track.mbid,
    track.recordingMbid,
    album.releaseGroupId,
    album.editionId,
    track.id,
    track.recordingId,
    library.id === getLibrary("Spatial").id ? "spatial" : "stereo",
    library.id,
    path.join(library.rootPath, relativePath),
    relativePath,
    library.rootPath,
    path.basename(relativePath),
  );
}

function seedVideo(
  key: string,
  artist: ArtistFixture,
): { id: number; mbid: string } {
  const mbid = `video-${key}`;
  const row = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, is_video, metadata_status
    ) VALUES (?, ?, ?, ?, ?, 1, 'musicbrainz')
    RETURNING id
  `).get(mbid, mbid, artist.metadataId, artist.mbid, `Video ${key}`) as { id: number };
  return { id: row.id, mbid };
}

function selectVideo(recordingId: number, library: LibraryFixture): void {
  dbModule.db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode, reason
    ) VALUES (?, ?, 'auto', 'separated', 'stats fixture')
  `).run(library.id, recordingId);
}

function addVideoFile(
  artist: ArtistFixture,
  video: { id: number; mbid: string },
  library: LibraryFixture,
  suffix: string,
): void {
  const relativePath = `${artist.mbid}/${video.mbid}-${suffix}.mp4`;
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_recording_mbid,
      recording_id, library_slot, library_id, file_path, relative_path,
      library_root, filename, extension, file_type, file_class, quality, file_size
    ) VALUES (?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, 'mp4',
      'video', 'video', 'FHD', 200)
  `).run(
    artist.metadataId,
    artist.mbid,
    video.mbid,
    video.id,
    library.id,
    path.join(library.rootPath, relativePath),
    relativePath,
    library.rootPath,
    path.basename(relativePath),
  );
}

test("global stats deduplicate collaborations and require every selected Library track occurrence", () => {
  const stereo = getLibrary("Stereo");
  const spatial = getLibrary("Spatial");
  const firstArtist = seedArtist("one");
  const collaborator = seedArtist("two");
  monitorArtist(firstArtist, stereo);
  monitorArtist(firstArtist, spatial);
  monitorArtist(collaborator, stereo);

  const album = seedAlbum("shared", firstArtist, 2);
  dbModule.db.prepare(`
    INSERT INTO ArtistReleaseGroups (
      artist_metadata_id, artist_mbid, release_group_id,
      release_group_mbid, relationship
    ) VALUES (?, ?, ?, ?, 'release_credit')
  `).run(
    collaborator.metadataId,
    collaborator.mbid,
    album.releaseGroupId,
    album.releaseGroupMbid,
  );
  monitorAlbum(album, stereo);

  // These per-Artist projections deliberately describe the same shared Album
  // twice. Whole-library stats must not sum them.
  const insertProjection = dbModule.db.prepare(`
    INSERT INTO ArtistStatistics (
      library_id, artist_metadata_id, artist_mbid, album_count, monitored_album_count,
      downloaded_album_count, track_count, monitored_track_count,
      track_file_count
    ) VALUES (?, ?, ?, 1, 1, 99, 2, 2, 99)
  `);
  insertProjection.run(stereo.id, firstArtist.metadataId, firstArtist.mbid);
  insertProjection.run(stereo.id, collaborator.metadataId, collaborator.mbid);

  let snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.artists, { total: 2, monitored: 2, downloaded: 0 });
  assert.deepEqual(snapshot.albums, { total: 1, monitored: 1, downloaded: 0 });
  assert.deepEqual(snapshot.tracks, { total: 2, monitored: 2, downloaded: 0 });

  addAudioFile(firstArtist, album, 0, stereo, "first");
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.albums, { total: 1, monitored: 1, downloaded: 0 });
  assert.deepEqual(snapshot.tracks, { total: 2, monitored: 2, downloaded: 1 });
  assert.equal(snapshot.artists.downloaded, 0);

  addAudioFile(firstArtist, album, 1, stereo, "second");
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(snapshot.albums.downloaded, 1);
  assert.equal(snapshot.tracks.downloaded, 2);
  assert.equal(snapshot.artists.downloaded, 2);

  // Selecting the same canonical Edition into Spatial creates additional
  // completion requirements but never additional dashboard entities.
  monitorAlbum(album, spatial);
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.albums, { total: 1, monitored: 1, downloaded: 0 });
  assert.deepEqual(snapshot.tracks, { total: 2, monitored: 2, downloaded: 0 });

  addAudioFile(firstArtist, album, 0, spatial, "first");
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(snapshot.albums.downloaded, 0);
  assert.equal(snapshot.tracks.downloaded, 1);

  addAudioFile(firstArtist, album, 1, spatial, "second");
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.albums, { total: 1, monitored: 1, downloaded: 1 });
  assert.deepEqual(snapshot.tracks, { total: 2, monitored: 2, downloaded: 2 });
  assert.deepEqual(snapshot.artists, { total: 2, monitored: 2, downloaded: 2 });
});

test("video downloaded stats count selected canonical videos, not physical files", () => {
  const videoLibrary = getLibrary("Video");
  const artist = seedArtist("video");
  monitorArtist(artist, videoLibrary);
  const selected = seedVideo("selected", artist);
  const unselected = seedVideo("unselected", artist);
  selectVideo(selected.id, videoLibrary);

  addVideoFile(artist, selected, videoLibrary, "first-copy");
  addVideoFile(artist, selected, videoLibrary, "duplicate-copy");
  addVideoFile(artist, unselected, videoLibrary, "unselected-file");

  let snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.videos, { total: 2, monitored: 1, downloaded: 1 });
  assert.deepEqual(snapshot.artists, { total: 1, monitored: 1, downloaded: 1 });
  assert.deepEqual(snapshot.files, { total: 3, totalSizeBytes: 600 });

  dbModule.db.prepare("UPDATE Libraries SET enabled = 0 WHERE id = ?").run(videoLibrary.id);
  libraryStatsModule.LibraryStatsQueryService.clearCache();
  snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(snapshot.videos, { total: 2, monitored: 0, downloaded: 0 });
  assert.deepEqual(snapshot.artists, { total: 1, monitored: 0, downloaded: 0 });
  assert.deepEqual(snapshot.files, { total: 3, totalSizeBytes: 600 });
});

test("disabled audio Libraries do not contribute monitoring or completion", () => {
  const stereo = getLibrary("Stereo");
  const artist = seedArtist("disabled");
  monitorArtist(artist, stereo);
  const album = seedAlbum("disabled", artist, 1);
  monitorAlbum(album, stereo);
  addAudioFile(artist, album, 0, stereo, "only");

  dbModule.db.prepare("UPDATE Libraries SET enabled = 0 WHERE id = ?").run(stereo.id);
  const snapshot = libraryStatsModule.LibraryStatsQueryService.getSnapshot();

  assert.deepEqual(snapshot.artists, { total: 1, monitored: 0, downloaded: 0 });
  assert.deepEqual(snapshot.albums, { total: 1, monitored: 0, downloaded: 0 });
  assert.deepEqual(snapshot.tracks, { total: 1, monitored: 0, downloaded: 0 });
  assert.deepEqual(snapshot.files, { total: 1, totalSizeBytes: 100 });
});

test("snapshot caching is stable and mutation events invalidate it", () => {
  const initial = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(initial.artists.total, 0);

  seedArtist("cached");
  const cached = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(cached, initial);
  assert.equal(cached.artists.total, 0);

  appEventsModule.appEvents.emit(appEventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-cached",
    artistName: "Artist cached",
    scanLibrary: false,
    metadataChanged: true,
    isNewArtist: true,
    forceDownloadQueue: false,
    trigger: 0,
    priority: 0,
  });
  const refreshed = libraryStatsModule.LibraryStatsQueryService.getSnapshot();
  assert.notEqual(refreshed, initial);
  assert.equal(refreshed.artists.total, 1);
});
