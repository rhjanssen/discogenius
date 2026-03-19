import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFilteringConfigContract,
  parseMonitoringStatusResponseContract,
  parsePublicAppConfigContract,
  parseQualityConfigContract,
} from "./config.js";
import {
  parseAlbumTracksContract,
  parseLibraryFilesListResponseContract,
  parseVideoDetailContract,
} from "./media.js";

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
