import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-statistics-truth-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let statsModule: typeof import("./library-stats-query-service.js");
let artistStatsModule: typeof import("./artist-statistics-service.js");
let eventsModule: typeof import("../commands/app-events.js");
let selectionModule: typeof import("./library-release-selection-service.js");
let albumCommandsModule: typeof import("./album-command-service.js");
let artistMonitoringModule: typeof import("./artist-monitoring.js");
let fileDeleteModule: typeof import("../mediafiles/library-file-delete-service.js");
let parseStats: typeof import("../../contracts/catalog.js").parseLibraryStatsContract;
let server: http.Server;
let statsUrl: string;

type Library = { id: number; name: string; rootPath: string };
type Fixture = {
  artistId: string;
  artistMbid: string;
  artistMetadataId: number;
  managedArtistId: number;
  releaseGroupId: number;
  releaseGroupMbid: string;
  editionId: number;
  editionMbid: string;
  tracks: Array<{
    id: number;
    mbid: string;
    recordingId: number;
    recordingMbid: string;
  }>;
  videoId: number;
  videoMbid: string;
};

type StatsBucket = { total: number; monitored: number; downloaded: number };
type TruthSnapshot = {
  artists: StatsBucket;
  albums: StatsBucket;
  tracks: StatsBucket;
  videos: StatsBucket;
  files: { total: number; totalSizeBytes: number };
};

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  statsModule = await import("./library-stats-query-service.js");
  artistStatsModule = await import("./artist-statistics-service.js");
  eventsModule = await import("../commands/app-events.js");
  selectionModule = await import("./library-release-selection-service.js");
  albumCommandsModule = await import("./album-command-service.js");
  artistMonitoringModule = await import("./artist-monitoring.js");
  fileDeleteModule = await import("../mediafiles/library-file-delete-service.js");
  ({ parseLibraryStatsContract: parseStats } = await import("../../contracts/catalog.js"));

  const statsRouter = (await import("../../routes/stats.js")).default;
  const app = express();
  app.use("/stats", statsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  statsUrl = `http://127.0.0.1:${address.port}/stats`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function libraries(): Record<"stereo" | "spatial" | "video", Library> {
  const mediaRoot = path.join(tempDir, "media");
  const byName = new Map<string, Library>();
  for (const row of dbModule.db.prepare(`
    SELECT id, name, root_path AS rootPath FROM Libraries
  `).all() as Library[]) {
    const key = row.name.toLowerCase();
    const rootPath = path.join(mediaRoot, key);
    fs.mkdirSync(rootPath, { recursive: true });
    dbModule.db.prepare("UPDATE Libraries SET root_path = ?, enabled = 1 WHERE id = ?")
      .run(rootPath, row.id);
    byName.set(key, { ...row, rootPath });
  }
  const stereo = byName.get("stereo");
  const spatial = byName.get("spatial");
  const video = byName.get("video");
  assert.ok(stereo && spatial && video);
  return { stereo, spatial, video };
}

function seedCanonicalFixture(): Fixture {
  const artistMbid = "truth-artist";
  const artistMetadataId = Number((dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Truth Artist')
    RETURNING id
  `).get(artistMbid) as { id: number }).id);
  const managedArtistId = artistMetadataId;
  const releaseGroupMbid = "truth-release-group";
  const releaseGroupId = Number((dbModule.db.prepare(`
    INSERT INTO Albums (
      foreign_album_id, mbid, artist_metadata_id, artist_mbid, title
    ) VALUES (?, ?, ?, ?, 'Truth Album')
    RETURNING id
  `).get(
    releaseGroupMbid,
    releaseGroupMbid,
    artistMetadataId,
    artistMbid,
  ) as { id: number }).id);

  const editionMbid = "truth-edition";
  const editionId = Number((dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      foreign_release_id, mbid, release_group_id, release_group_mbid,
      artist_metadata_id, artist_mbid, title, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, 'Truth Edition', 2)
    RETURNING id
  `).get(
    editionMbid,
    editionMbid,
    releaseGroupId,
    releaseGroupMbid,
    artistMetadataId,
    artistMbid,
  ) as { id: number }).id);

  const tracks: Fixture["tracks"] = [];
  for (let position = 1; position <= 2; position += 1) {
    const recordingMbid = `truth-recording-${position}`;
    const recordingId = Number((dbModule.db.prepare(`
      INSERT INTO Recordings (
        foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
        title, is_video, metadata_status
      ) VALUES (?, ?, ?, ?, ?, 0, 'musicbrainz')
      RETURNING id
    `).get(
      recordingMbid,
      recordingMbid,
      artistMetadataId,
      artistMbid,
      `Truth Track ${position}`,
    ) as { id: number }).id);
    const trackMbid = `truth-track-${position}`;
    const trackId = Number((dbModule.db.prepare(`
      INSERT INTO Tracks (
        foreign_track_id, mbid, album_edition_id, release_mbid,
        recording_id, recording_mbid, medium_position, position, title
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      RETURNING id
    `).get(
      trackMbid,
      trackMbid,
      editionId,
      editionMbid,
      recordingId,
      recordingMbid,
      position,
      `Truth Track ${position}`,
    ) as { id: number }).id);
    tracks.push({ id: trackId, mbid: trackMbid, recordingId, recordingMbid });
  }

  const videoMbid = "truth-video";
  const videoId = Number((dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, is_video, metadata_status
    ) VALUES (?, ?, ?, ?, 'Truth Video', 1, 'musicbrainz')
    RETURNING id
  `).get(videoMbid, videoMbid, artistMetadataId, artistMbid) as { id: number }).id);

  return {
    artistId: artistMbid,
    artistMbid,
    artistMetadataId,
    managedArtistId,
    releaseGroupId,
    releaseGroupMbid,
    editionId,
    editionMbid,
    tracks,
    videoId,
    videoMbid,
  };
}

function seedProviderMatch(fixture: Fixture): void {
  const providerArtistItemId = Number((dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('synthetic', 'artist', 'provider-artist', 'Truth Artist', 'available')
    RETURNING id
  `).get() as { id: number }).id);
  dbModule.db.prepare(`
    INSERT INTO ProviderArtistMatches (
      provider_artist_item_id, artist_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'truth-gate', 1)
  `).run(providerArtistItemId, fixture.artistMetadataId);
}

function addAudioFile(
  fixture: Fixture,
  library: Library,
  trackIndex: number,
  slot: "stereo" | "spatial",
): number {
  const track = fixture.tracks[trackIndex];
  assert.ok(track);
  const relativePath = path.join(
    fixture.artistMbid,
    fixture.releaseGroupMbid,
    `${track.mbid}-${slot}.flac`,
  );
  const filePath = path.join(library.rootPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.alloc(100 + trackIndex);
  fs.writeFileSync(filePath, bytes);
  const id = Number((dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      release_group_id, album_edition_id, track_id, recording_id,
      library_slot, library_id, file_path, relative_path, library_root,
      filename, extension, file_type, file_class, quality, file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'flac',
      'track', 'audio', ?, ?)
    RETURNING id
  `).get(
    fixture.artistMetadataId,
    fixture.artistMbid,
    fixture.releaseGroupMbid,
    fixture.editionMbid,
    track.mbid,
    track.recordingMbid,
    fixture.releaseGroupId,
    fixture.editionId,
    track.id,
    track.recordingId,
    slot,
    library.id,
    filePath,
    relativePath,
    library.rootPath,
    path.basename(filePath),
    slot === "spatial" ? "DOLBY_ATMOS" : "LOSSLESS",
    bytes.length,
  ) as { id: number }).id);
  eventsModule.emitFileAdded({
    libraryFileId: id,
    artistId: fixture.artistId,
    albumId: fixture.releaseGroupMbid,
    mediaId: track.mbid,
    fileType: "track",
    filePath,
    libraryRoot: library.rootPath,
  });
  artistStatsModule.ArtistStatisticsService.refresh([fixture.artistId]);
  return id;
}

function addVideoFile(fixture: Fixture, library: Library): number {
  const relativePath = path.join(fixture.artistMbid, `${fixture.videoMbid}.mp4`);
  const filePath = path.join(library.rootPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.alloc(250);
  fs.writeFileSync(filePath, bytes);
  const id = Number((dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_recording_mbid,
      recording_id, library_slot, library_id, file_path, relative_path,
      library_root, filename, extension, file_type, file_class, quality, file_size
    ) VALUES (?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, 'mp4',
      'video', 'video', 'FHD', ?)
    RETURNING id
  `).get(
    fixture.artistMetadataId,
    fixture.artistMbid,
    fixture.videoMbid,
    fixture.videoId,
    library.id,
    filePath,
    relativePath,
    library.rootPath,
    path.basename(filePath),
    bytes.length,
  ) as { id: number }).id);
  eventsModule.emitFileAdded({
    libraryFileId: id,
    artistId: fixture.artistId,
    mediaId: fixture.videoMbid,
    fileType: "video",
    filePath,
    libraryRoot: library.rootPath,
  });
  artistStatsModule.ArtistStatisticsService.refresh([fixture.artistId]);
  return id;
}

function directTruth(): TruthSnapshot {
  const scalar = (sql: string, key = "value"): number => {
    const row = dbModule.db.prepare(sql).get() as Record<string, number | null>;
    return Number(row[key] || 0);
  };

  const monitoredArtists = dbModule.db.prepare(`
    SELECT DISTINCT
      CAST(canonical_artist.id AS TEXT) AS artist_id,
      canonical_artist.mbid AS artist_mbid
    FROM LibraryArtists library_artist
    JOIN Libraries library
      ON library.id = library_artist.library_id AND library.enabled = 1
    JOIN ArtistMetadata canonical_artist
      ON canonical_artist.id = library_artist.artist_metadata_id
    WHERE library_artist.policy IN ('all', 'new')
  `).all() as Array<{ artist_id: string; artist_mbid: string }>;

  const audioRequirements = dbModule.db.prepare(`
    SELECT DISTINCT
      selected_album.library_id,
      selected_album.release_group_id,
      track.id AS track_id
    FROM LibraryAlbums selected_album
    JOIN Libraries library
      ON library.id = selected_album.library_id AND library.enabled = 1
    JOIN quality_profiles quality ON quality.id = library.quality_profile_id
    JOIN LibraryEditions selected_edition
      ON selected_edition.library_id = selected_album.library_id
    JOIN AlbumEditions edition
      ON edition.id = selected_edition.edition_id
     AND edition.release_group_id = selected_album.release_group_id
    JOIN Tracks track ON track.album_edition_id = edition.id
    JOIN Recordings recording ON recording.id = track.recording_id
    WHERE recording.is_video = 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(quality.allowed_source_formats, '[]')) format
        WHERE format.value = 'video'
      )
  `).all() as Array<{ library_id: number; release_group_id: number; track_id: number }>;

  const videoRequirements = dbModule.db.prepare(`
    SELECT DISTINCT
      selected.video_recording_id AS recording_id,
      CASE WHEN selected.placement_mode = 'inline'
        THEN selected.placement_library_id ELSE selected.library_id END AS library_id
    FROM LibraryVideos selected
    JOIN Libraries selected_library
      ON selected_library.id = selected.library_id AND selected_library.enabled = 1
    LEFT JOIN Libraries placement_library
      ON placement_library.id = selected.placement_library_id
    JOIN Recordings recording
      ON recording.id = selected.video_recording_id AND recording.is_video = 1
    WHERE selected.placement_mode = 'separated'
       OR placement_library.enabled = 1
  `).all() as Array<{ recording_id: number; library_id: number }>;

  const hasFile = (
    libraryId: number,
    mediaColumn: "track_id" | "recording_id",
    mediaId: number,
    fileClass: "audio" | "video",
  ): boolean => Boolean(dbModule.db.prepare(`
    SELECT 1 FROM TrackFiles
    WHERE library_id = ? AND ${mediaColumn} = ? AND file_class = ?
    LIMIT 1
  `).get(libraryId, mediaId, fileClass));

  const completeAlbumIds = new Set<number>();
  for (const releaseGroupId of new Set(audioRequirements.map((row) => row.release_group_id))) {
    const requirements = audioRequirements.filter((row) => row.release_group_id === releaseGroupId);
    if (requirements.every((row) => hasFile(row.library_id, "track_id", row.track_id, "audio"))) {
      completeAlbumIds.add(releaseGroupId);
    }
  }
  const completeTrackIds = new Set<number>();
  for (const trackId of new Set(audioRequirements.map((row) => row.track_id))) {
    const requirements = audioRequirements.filter((row) => row.track_id === trackId);
    if (requirements.every((row) => hasFile(row.library_id, "track_id", row.track_id, "audio"))) {
      completeTrackIds.add(trackId);
    }
  }
  const completeVideoIds = new Set<number>();
  for (const recordingId of new Set(videoRequirements.map((row) => row.recording_id))) {
    const requirements = videoRequirements.filter((row) => row.recording_id === recordingId);
    if (requirements.every((row) => hasFile(row.library_id, "recording_id", row.recording_id, "video"))) {
      completeVideoIds.add(recordingId);
    }
  }

  let completedArtists = 0;
  for (const artist of monitoredArtists) {
    const albumIds = new Set((dbModule.db.prepare(`
      SELECT album.id
      FROM Albums album
      WHERE album.artist_mbid = ?
      UNION
      SELECT album.id
      FROM ArtistReleaseGroups scope
      JOIN Albums album ON album.mbid = scope.release_group_mbid
      WHERE scope.artist_mbid = ?
    `).all(artist.artist_mbid, artist.artist_mbid) as Array<{ id: number }>).map((row) => row.id));
    const artistAudio = audioRequirements.filter((row) => albumIds.has(row.release_group_id));
    const artistVideoIds = new Set((dbModule.db.prepare(`
      SELECT id FROM Recordings WHERE artist_mbid = ? AND is_video = 1
    `).all(artist.artist_mbid) as Array<{ id: number }>).map((row) => row.id));
    const artistVideos = videoRequirements.filter((row) => artistVideoIds.has(row.recording_id));
    const requirementCount = artistAudio.length + artistVideos.length;
    const completeCount = artistAudio.filter(
      (row) => hasFile(row.library_id, "track_id", row.track_id, "audio"),
    ).length + artistVideos.filter(
      (row) => hasFile(row.library_id, "recording_id", row.recording_id, "video"),
    ).length;
    if (requirementCount > 0 && completeCount === requirementCount) {
      completedArtists += 1;
    }
  }

  const fileRow = dbModule.db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(file_size), 0) AS total_size
    FROM TrackFiles
  `).get() as { total: number; total_size: number };

  return {
    artists: {
      total: scalar("SELECT COUNT(*) AS value FROM ArtistMetadata"),
      monitored: monitoredArtists.length,
      downloaded: completedArtists,
    },
    albums: {
      total: scalar("SELECT COUNT(*) AS value FROM Albums"),
      monitored: new Set(audioRequirements.map((row) => row.release_group_id)).size,
      downloaded: completeAlbumIds.size,
    },
    tracks: {
      total: scalar(`
        SELECT COUNT(*) AS value
        FROM Tracks track
        JOIN Recordings recording ON recording.id = track.recording_id
        WHERE recording.is_video = 0
      `),
      monitored: new Set(audioRequirements.map((row) => row.track_id)).size,
      downloaded: completeTrackIds.size,
    },
    videos: {
      total: scalar("SELECT COUNT(*) AS value FROM Recordings WHERE is_video = 1"),
      monitored: new Set(videoRequirements.map((row) => row.recording_id)).size,
      downloaded: completeVideoIds.size,
    },
    files: {
      total: Number(fileRow.total),
      totalSizeBytes: Number(fileRow.total_size),
    },
  };
}

function directArtistProjection(fixture: Fixture) {
  const requirements = dbModule.db.prepare(`
    SELECT DISTINCT
      selected_album.library_id,
      selected_album.release_group_id,
      track.id AS track_id
    FROM LibraryAlbums selected_album
    JOIN Libraries library
      ON library.id = selected_album.library_id AND library.enabled = 1
    JOIN quality_profiles quality ON quality.id = library.quality_profile_id
    JOIN LibraryEditions selected_edition
      ON selected_edition.library_id = selected_album.library_id
    JOIN AlbumEditions edition
      ON edition.id = selected_edition.edition_id
     AND edition.release_group_id = selected_album.release_group_id
    JOIN Tracks track ON track.album_edition_id = edition.id
    JOIN Recordings recording ON recording.id = track.recording_id AND recording.is_video = 0
    WHERE selected_album.release_group_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(quality.allowed_source_formats, '[]')) format
        WHERE format.value = 'video'
      )
  `).all(fixture.releaseGroupId) as Array<{
    library_id: number;
    release_group_id: number;
    track_id: number;
  }>;
  const completedRequirements = requirements.filter((row) => Boolean(dbModule.db.prepare(`
    SELECT 1 FROM TrackFiles
    WHERE library_id = ? AND track_id = ? AND file_class = 'audio'
    LIMIT 1
  `).get(row.library_id, row.track_id))).length;
  const downloadedAlbumCount = requirements.length > 0 && completedRequirements === requirements.length ? 1 : 0;
  const videoCount = Number((dbModule.db.prepare(`
    SELECT COUNT(DISTINCT recording.id) AS value
    FROM Recordings recording
    JOIN TrackFiles file
      ON file.file_type = 'video'
     AND (file.recording_id = recording.id OR file.canonical_recording_mbid = recording.mbid)
    WHERE recording.is_video = 1 AND recording.artist_mbid = ?
  `).get(fixture.artistMbid) as { value: number }).value || 0);
  const sizeOnDisk = Number((dbModule.db.prepare(`
    SELECT COALESCE(SUM(file_size), 0) AS value
    FROM TrackFiles
    WHERE file_type IN ('track', 'video') AND canonical_artist_mbid = ?
  `).get(fixture.artistMbid) as { value: number }).value || 0);
  return {
    artist_id: fixture.artistId,
    artist_mbid: fixture.artistMbid,
    album_count: 1,
    monitored_album_count: requirements.length > 0 ? 1 : 0,
    downloaded_album_count: downloadedAlbumCount,
    track_count: requirements.length,
    monitored_track_count: requirements.length,
    track_file_count: completedRequirements,
    video_count: videoCount,
    size_on_disk: sizeOnDisk,
  };
}

async function assertAllTruth(label: string, fixture: Fixture, checkProjection = true): Promise<void> {
  const direct = directTruth();
  const service = statsModule.LibraryStatsQueryService.getSnapshot();
  assert.deepEqual(service, direct, `${label}: service snapshot differs from direct SQL truth`);
  assert.equal(
    statsModule.LibraryStatsQueryService.getSnapshot(),
    service,
    `${label}: hot cache should reuse the authoritative immutable snapshot`,
  );

  const response = await fetch(statsUrl);
  assert.equal(response.status, 200, `${label}: statistics API status`);
  const api = parseStats(await response.json());
  assert.deepEqual(api, direct, `${label}: API/contract statistic differs from direct SQL truth`);

  if (checkProjection) {
    const projection = artistStatsModule.ArtistStatisticsService
      .getStatisticsMap([fixture.artistId])
      .get(fixture.artistId);
    assert.ok(projection, `${label}: ArtistStatistics projection exists`);
    const expectedProjection = directArtistProjection(fixture);
    for (const [key, value] of Object.entries(expectedProjection)) {
      assert.equal(
        projection[key as keyof typeof projection],
        value,
        `${label}: ArtistStatistics.${key} differs from direct SQL truth`,
      );
    }
  }
}

test("release statistics stay equal across service, API, cache, projection, and direct SQL lifecycle truth", async () => {
  const library = libraries();

  // Prime a cold zero snapshot. The metadata completion event must discard it.
  const zero = statsModule.LibraryStatsQueryService.getSnapshot();
  assert.equal(zero.artists.total, 0);
  const fixture = seedCanonicalFixture();
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: fixture.artistId,
    artistName: "Truth Artist",
    scanLibrary: false,
    metadataChanged: true,
    isNewArtist: true,
    trigger: 0,
    priority: 0,
  });
  artistStatsModule.ArtistStatisticsService.refresh([fixture.artistId]);
  await assertAllTruth("metadata refresh", fixture);

  // Provider availability and typed match decisions are not canonical/library
  // counters. A completed matching command still invalidates the cache, and the
  // recomputed result must remain identical.
  const beforeProvider = statsModule.LibraryStatsQueryService.getSnapshot();
  seedProviderMatch(fixture);
  eventsModule.appEvents.emit(eventsModule.AppEvent.COMMAND_UPDATED, {
    id: 1,
    type: "RefreshArtist",
    status: "completed",
    progress: 100,
  } as any);
  const afterProvider = statsModule.LibraryStatsQueryService.getSnapshot();
  assert.notEqual(afterProvider, beforeProvider);
  await assertAllTruth("provider matching", fixture);

  // Artist monitoring and canonical Edition selection are direct route/service
  // mutations; library.updated must make an immediate /stats refetch truthful.
  assert.equal(artistMonitoringModule.applyArtistMonitoringState(fixture.artistId, true), 1);
  new selectionModule.LibraryReleaseSelectionService(dbModule.db).selectRelease({
    releaseGroupMbid: fixture.releaseGroupMbid,
    libraryId: library.stereo.id,
    editionId: fixture.editionId,
  });
  await assertAllTruth("stereo curation", fixture);

  addAudioFile(fixture, library.stereo, 0, "stereo");
  await assertAllTruth("partial stereo import", fixture);
  addAudioFile(fixture, library.stereo, 1, "stereo");
  await assertAllTruth("complete stereo import", fixture);

  // The same canonical Edition in Spatial creates another exact (Library,
  // Track) requirement without inflating canonical total/monitored entities.
  new selectionModule.LibraryReleaseSelectionService(dbModule.db).selectRelease({
    releaseGroupMbid: fixture.releaseGroupMbid,
    libraryId: library.spatial.id,
    editionId: fixture.editionId,
  });
  await assertAllTruth("spatial selection creates incomplete requirements", fixture);
  addAudioFile(fixture, library.spatial, 0, "spatial");
  addAudioFile(fixture, library.spatial, 1, "spatial");
  await assertAllTruth("spatial completion", fixture);

  dbModule.db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode, reason
    ) VALUES (?, ?, 'manual', 'separated', 'truth gate')
  `).run(library.video.id, fixture.videoId);
  eventsModule.emitLibraryUpdated({
    reason: "video-selected",
    artistIds: [fixture.artistId],
    libraryIds: [library.video.id],
  });
  await assertAllTruth("selected video is incomplete", fixture);
  addVideoFile(fixture, library.video);
  await assertAllTruth("selected video completion", fixture);

  // The real manual-delete service removes bytes and rows, emits FILE_DELETED,
  // and must refresh ArtistStatistics before the browser's immediate refetch.
  const deletion = fileDeleteModule.deleteTrackLibraryFiles(fixture.tracks[0].mbid, {
    libraryId: library.stereo.id,
  });
  assert.equal(deletion.deleted, 1);
  await assertAllTruth("track file deletion", fixture);

  // Unmonitoring one Library preserves Spatial's authoritative order/state and
  // its completion. Unmonitor the remaining Album and Video explicitly, then
  // unmonitor the Artist; canonical totals and physical file inventory survive.
  const stereoUnmonitor = albumCommandsModule.AlbumCommandService.setAlbumMonitored(
    fixture.releaseGroupMbid,
    false,
    { kind: "library", libraryId: library.stereo.id },
  );
  assert.equal(stereoUnmonitor.success, true);
  await assertAllTruth("stereo unmonitor", fixture);
  albumCommandsModule.AlbumCommandService.setAlbumMonitored(
    fixture.releaseGroupMbid,
    false,
    { kind: "library", libraryId: library.spatial.id },
  );
  dbModule.db.prepare(`
    DELETE FROM LibraryVideos WHERE library_id = ? AND video_recording_id = ?
  `).run(library.video.id, fixture.videoId);
  eventsModule.emitLibraryUpdated({
    reason: "video-unmonitored",
    artistIds: [fixture.artistId],
    libraryIds: [library.video.id],
  });
  assert.equal(artistMonitoringModule.applyArtistMonitoringState(fixture.artistId, false), 1);
  await assertAllTruth("unmonitor without file deletion", fixture);

  // A missing Album must not turn a scoped refresh into refresh([]), whose
  // documented meaning is a full rebuild.
  dbModule.db.prepare("DELETE FROM ArtistStatistics").run();
  assert.deepEqual(
    artistStatsModule.ArtistStatisticsService.refreshForReleaseGroupMbids(["missing-release-group"]),
    [],
  );
  assert.equal(
    Number((dbModule.db.prepare("SELECT COUNT(*) AS n FROM ArtistStatistics").get() as { n: number }).n),
    0,
  );
  artistStatsModule.ArtistStatisticsService.refresh([fixture.artistId]);

  // A fresh process has no in-memory snapshot. Its first read must reconstruct
  // exactly the same truth from the persisted schema-43 database.
  const childCode = `
    import { LibraryStatsQueryService } from "./src/services/music/library-stats-query-service.ts";
    console.log("STAT_RESTART=" + JSON.stringify(LibraryStatsQueryService.getSnapshot()));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childCode],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        DB_PATH: process.env.DB_PATH!,
        DISCOGENIUS_CONFIG_DIR: tempDir,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    child.status,
    0,
    `restart reader failed: error=${String(child.error)} signal=${String(child.signal)} `
      + `stderr=${String(child.stderr)} stdout=${String(child.stdout)}`,
  );
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("STAT_RESTART="));
  assert.ok(line, `restart reader did not report statistics: ${child.stdout}`);
  assert.deepEqual(
    parseStats(JSON.parse(line.slice("STAT_RESTART=".length))),
    directTruth(),
    "fresh-process statistics differ from direct SQL truth",
  );
});
