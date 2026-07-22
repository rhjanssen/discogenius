import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFilteringConfigUpdate,
  parseMetadataConfigUpdate,
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
    upgrade_existing_files: true,
    convert_video_mp4: true,
    extract_flac: true,
  });
  assert.deepEqual(qualityUpdate, {
    audio_quality: "max",
    upgrade_existing_files: false,
  });

  const monitoringUpdate = parseMonitoringConfigUpdate({
    enabled: false,
    monitorNewArtists: false,
  }, {
    enabled: true,
    monitorNewArtists: true,
    removeUnmonitoredFiles: true,
  });
  assert.deepEqual(monitoringUpdate, {
    enabled: false,
    monitorNewArtists: false,
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
    include_spatial: false,
    include_video_lyric: false,
  }, {
    include_album: true,
    include_single: true,
    include_ep: true,
    include_broadcast: false,
    include_other: false,
    include_compilation: true,
    include_soundtrack: true,
    include_live: true,
    include_remix: true,
    include_dj_mix: false,
    include_mixtape_street: false,
    include_demo: false,
    include_spatial: true,
    include_videos: false,
    include_video_official: true,
    include_video_lyric: true,
    include_video_live: true,
    prefer_explicit: true,
    enable_redundancy_filter: true,
    require_provider_availability: true,
  });
  assert.deepEqual(filteringUpdate, {
    include_videos: true,
    include_spatial: false,
    include_video_lyric: false,
  });

  const metadataUpdate = parseMetadataConfigUpdate({
    artwork_preference: "provider",
    write_audio_tags_policy: "new_files",
    enable_fingerprinting: false,
  }, {
    artwork_preference: "canonical",
    save_album_cover: true,
    album_cover_name: "cover.jpg",
    album_cover_resolution: "origin",
    save_artist_picture: true,
    artist_picture_name: "folder.jpg",
    artist_picture_resolution: "origin",
    save_video_thumbnail: true,
    embed_video_thumbnail: true,
    video_thumbnail_resolution: "1080x720",
    save_lyrics: true,
    save_nfo: true,
    embed_album_review: true,
    enable_fingerprinting: true,
    write_tidal_url: false,
    mark_explicit: true,
    upc_target: "BARCODE",
    write_audio_tags_policy: "all_files",
    embed_replaygain: true,
  });
  assert.deepEqual(metadataUpdate, {
    artwork_preference: "provider",
    write_audio_tags_policy: "new_files",
    enable_fingerprinting: false,
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
      upgrade_existing_files: true,
      convert_video_mp4: true,
      extract_flac: true,
    });
  }, RequestValidationError);

  assert.throws(() => {
    parseQualityConfigUpdate({
      embed_synced_lyrics: false,
    }, {
      audio_quality: "normal",
      video_quality: "fhd",
      embed_cover: true,
      embed_lyrics: true,
      upgrade_existing_files: true,
      convert_video_mp4: true,
      extract_flac: true,
    });
  }, RequestValidationError);

  assert.throws(() => {
    parseMonitoringConfigUpdate({
      enabled: true,
      scanIntervalHours: 24,
    }, {
      enabled: true,
      monitorNewArtists: true,
      removeUnmonitoredFiles: true,
    });
  }, RequestValidationError);

  assert.throws(() => {
    parseMetadataConfigUpdate({
      write_audio_tags_policy: "sync",
    }, {
      artwork_preference: "canonical",
      save_album_cover: true,
      album_cover_name: "cover.jpg",
      album_cover_resolution: "origin",
      save_artist_picture: true,
      artist_picture_name: "folder.jpg",
      artist_picture_resolution: "origin",
      save_video_thumbnail: true,
      embed_video_thumbnail: true,
      video_thumbnail_resolution: "1080x720",
      save_lyrics: true,
      save_nfo: true,
      embed_album_review: true,
      enable_fingerprinting: false,
      write_tidal_url: false,
      mark_explicit: true,
      upc_target: "BARCODE",
      write_audio_tags_policy: "new_files",
      embed_replaygain: true,
    });
  }, RequestValidationError);
});
