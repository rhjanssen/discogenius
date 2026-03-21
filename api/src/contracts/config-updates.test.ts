import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFilteringConfigUpdate,
  parseMonitoringConfigUpdate,
  parsePublicAppConfigUpdate,
  parseQualityConfigUpdate,
} from "./config-updates.js";
import { RequestValidationError } from "../utils/request-validation.js";

test("config update parsers return only validated partial updates", () => {
  const qualityUpdate = parseQualityConfigUpdate({
    audio_quality: "max",
    upgrade_existing_files: false,
  }, {
    audio_quality: "normal",
    video_quality: "fhd",
    embed_cover: true,
    embed_lyrics: true,
    embed_synced_lyrics: false,
    upgrade_existing_files: true,
    convert_video_mp4: true,
    download_dolby_atmos: false,
    extract_flac: true,
  });
  assert.deepEqual(qualityUpdate, {
    audio_quality: "max",
    upgrade_existing_files: false,
  });

  const monitoringUpdate = parseMonitoringConfigUpdate({
    enabled: false,
    scanIntervalHours: 12,
  }, {
    enabled: true,
    scanIntervalHours: 24,
    startHour: 2,
    durationHours: 6,
    monitorNewArtists: true,
    removeUnmonitoredFiles: true,
    artistRefreshDays: 30,
    albumRefreshDays: 120,
    trackRefreshDays: 240,
    videoRefreshDays: 365,
  });
  assert.deepEqual(monitoringUpdate, {
    enabled: false,
    scanIntervalHours: 12,
  });

  const appUpdate = parsePublicAppConfigUpdate({
    acoustid_api_key: "  ",
  }, {
    acoustid_api_key: "abc123",
  });
  assert.deepEqual(appUpdate, {
    acoustid_api_key: undefined,
  });

  const filteringUpdate = parseFilteringConfigUpdate({
    include_videos: true,
    include_atmos: false,
  }, {
    include_album: true,
    include_single: true,
    include_ep: true,
    include_compilation: true,
    include_soundtrack: true,
    include_live: true,
    include_remix: true,
    include_appears_on: false,
    include_atmos: true,
    include_videos: false,
    prefer_explicit: true,
    enable_redundancy_filter: true,
  });
  assert.deepEqual(filteringUpdate, {
    include_videos: true,
    include_atmos: false,
  });
});

test("config update parsers reject unsupported keys and invalid values", () => {
  assert.throws(() => {
    parseQualityConfigUpdate({
      audio_quality: "ultra",
    }, {
      audio_quality: "normal",
      video_quality: "fhd",
      embed_cover: true,
      embed_lyrics: true,
      embed_synced_lyrics: false,
      upgrade_existing_files: true,
      convert_video_mp4: true,
      download_dolby_atmos: false,
      extract_flac: true,
    });
  }, RequestValidationError);

  assert.throws(() => {
    parseMonitoringConfigUpdate({
      enabled: true,
      extra: 1,
    }, {
      enabled: true,
      scanIntervalHours: 24,
      startHour: 2,
      durationHours: 6,
      monitorNewArtists: true,
    removeUnmonitoredFiles: true,
      artistRefreshDays: 30,
      albumRefreshDays: 120,
      trackRefreshDays: 240,
      videoRefreshDays: 365,
    });
  }, RequestValidationError);
});


