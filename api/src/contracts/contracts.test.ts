import assert from "node:assert/strict";
import test from "node:test";

import { parseAuthStatusContract } from "./auth.js";
import {
  parseArtistsListResponseContract,
  parseLibraryStatsContract,
  parseSearchResponseContract,
  parseVideosListResponseContract,
} from "./catalog.js";
import {
  parseFilteringConfigContract,
  parseMonitoringStatusResponseContract,
  parsePublicAppConfigContract,
  parseQualityConfigContract,
} from "./config.js";
import { parseHistoryEventsResponseContract } from "./history.js";
import {
  parseAlbumTracksContract,
  parseLibraryFilesListResponseContract,
  parseVideoDetailContract,
} from "./media.js";
import {
  parseRunSystemTaskResponseContract,
  parseSystemTaskListContract,
} from "./system-task.js";
import {
  parseActivityListResponseContract,
  parseQueueListResponseContract,
  parseStatusOverviewContract,
} from "./status.js";
import { parseAppReleaseInfoContract } from "./release.js";

test("config contract parsers normalize expected public settings shapes", () => {
  const appConfig = parsePublicAppConfigContract({ acoustid_api_key: "abc123" });
  assert.deepEqual(appConfig, { acoustid_api_key: "abc123" });

  const qualityConfig = parseQualityConfigContract({
    audio_quality: "max",
    video_quality: "fhd",
    embed_cover: true,
    embed_lyrics: false,
    embed_synced_lyrics: true,
    upgrade_existing_files: true,
    convert_video_mp4: true,
  });
  assert.equal(qualityConfig.audio_quality, "max");
  assert.equal(qualityConfig.video_quality, "fhd");
  assert.equal(qualityConfig.convert_video_mp4, true);

  const monitoringStatus = parseMonitoringStatusResponseContract({
    running: true,
    checking: false,
    config: {
      enabled: true,
      scanIntervalHours: 24,
      startHour: 2,
      durationHours: 6,
      monitorNewArtists: true,
      removeUnmonitoredFiles: true,
      artistRefreshDays: 30,
      albumRefreshDays: 60,
      trackRefreshDays: 120,
      videoRefreshDays: 365,
      checkInProgress: false,
      progressArtistIndex: 4,
    },
  });
  assert.equal(monitoringStatus.config.startHour, 2);
  assert.equal(monitoringStatus.running, true);

  const curation = parseFilteringConfigContract({
    include_album: true,
    include_single: true,
    include_ep: true,
    include_compilation: true,
    include_soundtrack: true,
    include_live: true,
    include_remix: false,
    include_appears_on: false,
    include_atmos: false,
    include_videos: true,
    prefer_explicit: true,
    enable_redundancy_filter: true,
  });
  assert.equal(curation.include_videos, true);
});

test("media contract parsers validate album tracks and video detail payloads", () => {
  const tracks = parseAlbumTracksContract([
    {
      id: "101",
      title: "Track One",
      duration: 180,
      track_number: 1,
      volume_number: 1,
      quality: "LOSSLESS",
      downloaded: true,
      is_downloaded: true,
      is_monitored: true,
      explicit: false,
      files: [
        {
          id: 7,
          media_id: "101",
          file_type: "track",
          file_path: "E:/music/Track One.flac",
        },
      ],
    },
  ]);
  assert.equal(tracks[0].files[0].id, 7);
  assert.equal(tracks[0].downloaded, true);

  const video = parseVideoDetailContract({
    id: "202",
    title: "Video One",
    duration: 240,
    artist_id: "303",
    artist_name: "Artist",
    quality: "HIRES_LOSSLESS",
    cover_id: "abcdef",
    is_monitored: false,
    downloaded: true,
    is_downloaded: true,
  });
  assert.equal(video.artist_id, "303");
  assert.equal(video.downloaded, true);
});

test("library files response parser keeps list payloads typed", () => {
  const response = parseLibraryFilesListResponseContract({
    items: [
      {
        id: 1,
        artist_id: 11,
        album_id: 22,
        media_id: 33,
        file_type: "video",
        file_path: "E:/videos/file.mp4",
        qualityTarget: "FHD",
        qualityChangeWanted: false,
      },
    ],
    limit: 100,
    offset: 0,
  });

  assert.deepEqual(response.items[0], {
    id: 1,
    artist_id: "11",
    album_id: "22",
    media_id: "33",
    file_type: "video",
    file_path: "E:/videos/file.mp4",
    relative_path: undefined,
    filename: undefined,
    extension: undefined,
    quality: undefined,
    library_root: undefined,
    file_size: undefined,
    bitrate: undefined,
    sample_rate: undefined,
    bit_depth: undefined,
    channels: undefined,
    codec: undefined,
    duration: undefined,
    qualityTarget: "FHD",
    qualityChangeWanted: false,
    qualityChangeDirection: undefined,
    qualityCutoffNotMet: undefined,
    qualityChangeReason: undefined,
  });
});

test("auth status parser validates live and bypassed auth shapes", () => {
  const live = parseAuthStatusContract({
    connected: true,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry: 12,
    mode: "live",
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable: true,
    authBypassed: false,
    canAuthenticate: true,
    user: { username: "tester" },
  });
  assert.equal(live.mode, "live");
  assert.equal(live.user?.username, "tester");

  const bypassed = parseAuthStatusContract({
    connected: false,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry: 0,
    mode: "disconnected",
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable: false,
    authBypassed: true,
    canAuthenticate: false,
    message: "Disconnected local-library mode is active.",
  });
  assert.equal(bypassed.authBypassed, true);
  assert.equal(bypassed.canAuthenticate, false);
});

test("catalog contract parsers validate list, stats, and search payloads", () => {
  const artists = parseArtistsListResponseContract({
    items: [
      {
        id: 10,
        name: "Bastille",
        picture: "abc",
        is_monitored: true,
        last_scanned: null,
        album_count: 5,
        downloaded: 80,
        is_downloaded: false,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    hasMore: false,
  });
  assert.equal(artists.items[0].id, "10");
  assert.equal(artists.items[0].is_monitored, true);

  const stats = parseLibraryStatsContract({
    artists: { total: 1, monitored: 1, downloaded: 0 },
    albums: { total: 2, monitored: 2, downloaded: 1 },
    tracks: { total: 20, monitored: 18, downloaded: 15 },
    videos: { total: 3, monitored: 2, downloaded: 1 },
    files: { total: 42, totalSizeBytes: 1234 },
  });
  assert.equal(stats.files?.totalSizeBytes, 1234);

  const search = parseSearchResponseContract({
    success: true,
    mode: "mock",
    remoteCatalogAvailable: false,
    results: {
      artists: [
        {
          id: "10",
          name: "Bastille",
          type: "artist",
          monitored: true,
          in_library: true,
          imageId: "abc",
        },
      ],
      albums: [],
      tracks: [],
      videos: [],
    },
  });
  assert.equal(search.mode, "mock");
  assert.equal(search.results.artists[0].in_library, true);

  const videos = parseVideosListResponseContract({
    items: [
      {
        id: "20",
        title: "Distorted Light Beam",
        duration: 240,
        artist_id: "10",
        artist_name: "Bastille",
        is_monitored: true,
        is_downloaded: false,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    hasMore: false,
  });
  assert.equal(videos.items[0].artist_id, "10");
});

test("status contract parsers validate queue and status overview payloads", () => {
  const queue = parseQueueListResponseContract({
    items: [
      {
        id: 7,
        url: "https://tidal.com/album/243864035",
        tidalId: "243864035",
        type: "album",
        status: "processing",
        progress: 55,
        error: null,
        created_at: "2026-03-19 12:00:00",
        updated_at: "2026-03-19 12:01:00",
        title: "Give Me The Future",
        artist: "Bastille",
        tracks: [
          { title: "Track One", trackNum: 1, status: "downloading" },
        ],
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
    hasMore: false,
  });
  assert.equal(queue.items[0].tracks?.[0].status, "downloading");

  const overview = parseStatusOverviewContract({
    activity: {
      pending: 2,
      processing: 1,
      history: 9,
    },
    taskQueueStats: [
      { type: "DownloadAlbum", status: "pending", count: 2 },
    ],
    commandStats: {
      downloads: { pending: 2, processing: 1, failed: 0 },
    },
    runningCommands: [
      {
        id: 1,
        type: "RefreshArtist",
        name: "Refresh Artist",
        isExclusive: false,
        isTypeExclusive: false,
        requiresDiskAccess: false,
      },
    ],
    rateLimitMetrics: {
      currentIntervalMs: 150,
      consecutiveSuccesses: 3,
      recent429Rate: "0%",
      rateLimitUntil: null,
    },
  });
  assert.equal(overview.activity.history, 9);
  assert.equal(overview.commandStats.downloads?.processing, 1);
  assert.equal(overview.runningCommands?.[0].name, "Refresh Artist");

  const activity = parseActivityListResponseContract({
    items: [
      {
        id: 3,
        type: "RefreshArtist",
        description: "Refresh Artist: Bastille",
        queuePosition: 1,
        startTime: Date.now(),
        status: "pending",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    hasMore: false,
  });
  assert.equal(activity.items[0].queuePosition, 1);
});

test("system task contract parsers validate scheduled and manual task payloads", () => {
  const tasks = parseSystemTaskListContract([
    {
      id: "monitoring-cycle",
      kind: "scheduled",
      name: "Monitoring Cycle",
      description: "Refresh due monitored artists during the active window.",
      taskName: "RefreshMetadata",
      commandName: "MonitoringCycle",
      category: "monitoring",
      riskLevel: "medium",
      canRunNow: true,
      requiresDiskAccess: false,
      isExclusive: true,
      isTypeExclusive: true,
      isLongRunning: true,
      intervalMinutes: 240,
      enabled: true,
      active: false,
      lastExecution: "2026-03-24T12:00:00.000Z",
      lastStartTime: "2026-03-24T11:30:00.000Z",
      nextExecution: "2026-03-24T16:00:00.000Z",
    },
    {
      id: "health-check",
      kind: "manual",
      name: "Health Check",
      description: "Run health diagnostics across runtime dependencies.",
      taskName: "CheckHealth",
      commandName: "CheckHealth",
      category: "maintenance",
      riskLevel: "low",
      canRunNow: true,
      requiresDiskAccess: false,
      isExclusive: true,
      isTypeExclusive: false,
      isLongRunning: false,
      intervalMinutes: null,
      enabled: null,
      active: true,
      lastExecution: null,
      lastStartTime: null,
      nextExecution: null,
    },
  ]);

  assert.equal(tasks[0].kind, "scheduled");
  assert.equal(tasks[0].enabled, true);
  assert.equal(tasks[1].kind, "manual");
  assert.equal(tasks[1].intervalMinutes, null);

  const runResponse = parseRunSystemTaskResponseContract({ id: 42 });
  assert.equal(runResponse.id, 42);
});

test("release contract parser validates current and latest release metadata", () => {
  const release = parseAppReleaseInfoContract({
    version: "1.0.4",
    appVersion: "1.0.4",
    apiVersion: "1.0.4",
    latestVersion: "1.0.5",
    latestReleaseName: "v1.0.5",
    latestReleaseUrl: "https://github.com/rhjanssen/discogenius/releases/tag/v1.0.5",
    latestReleasePublishedAt: "2026-03-20T12:00:00.000Z",
    updateAvailable: true,
    updateStatus: "update-available",
    checkedAt: "2026-03-20T12:30:00.000Z",
  });

  assert.equal(release.version, "1.0.4");
  assert.equal(release.latestVersion, "1.0.5");
  assert.equal(release.updateStatus, "update-available");
  assert.equal(release.updateAvailable, true);
});

test("history contract parser validates audit event payloads", () => {
  const history = parseHistoryEventsResponseContract({
    items: [
      {
        id: 91,
        artistId: 11,
        albumId: 22,
        mediaId: 33,
        libraryFileId: 44,
        eventType: "TrackFileImported",
        quality: "FLAC",
        sourceTitle: "Queen of NY",
        data: {
          importedPath: "E:/music/Queen of NY.flac",
        },
        date: "2026-03-20 13:00:00",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });

  assert.equal(history.items[0].eventType, "TrackFileImported");
  assert.equal(history.items[0].data?.importedPath, "E:/music/Queen of NY.flac");
});



