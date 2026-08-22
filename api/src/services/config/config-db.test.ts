import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-config-db-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("./config.js");

before(async () => {
  dbModule = await import("../../database.js");
  configModule = await import("./config.js");
  dbModule.initDatabase();
});


after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("editable settings are persisted to database and read through the cache", () => {
  const rowBefore = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.quality'")
    .get() as { value: string } | undefined;
  
  if (rowBefore) {
    assert.match(rowBefore.value, /"audio_quality":"max"/);
    assert.doesNotMatch(rowBefore.value, /embed_synced_lyrics/);
  }

  configModule.updateConfig("quality", { audio_quality: "normal" });

  const rowAfter = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.quality'")
    .get() as { value: string } | undefined;
  
  assert.notEqual(rowAfter, undefined);
  assert.match(rowAfter!.value, /"audio_quality":"normal"/);
  assert.equal(configModule.getConfigSection("quality").audio_quality, "normal");

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().quality.audio_quality, "normal");
});

test("fresh installs use the production monitoring and library defaults", () => {
  const config = configModule.readConfig();

  assert.equal(config.monitoring.monitor_new_artists, false);
  assert.equal(config.monitoring.remove_unmonitored_files, false);
  assert.equal(config.quality.upgrade_existing_files, false);
  assert.equal(config.quality.downconvert_existing_files, false);
  assert.equal(config.filtering.require_provider_availability, true);
  assert.equal(config.filtering.include_spatial, false);
  assert.equal(config.filtering.include_videos, false);
  assert.equal(config.filtering.include_video_official, true);
  assert.equal(config.filtering.include_video_lyric, false);
  assert.equal(config.filtering.include_video_live, true);
  assert.equal(config.filtering.include_video_visualizer, false);
  assert.equal(config.filtering.include_video_official_audio, false);
  assert.equal(config.quality.video_quality, "uhd");
  assert.equal(config.path.create_empty_artist_folders, false);
  assert.equal(config.path.video_folder_layout, "separated");
  assert.equal(config.naming.video_file, "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}");
  assert.equal(config.naming.album_track_path_single, "{Edition Title} ({Release Year})/{track:00} - {Track Title}");
  assert.equal(config.naming.album_track_path_multi, "{Edition Title} ({Release Year})/{medium:0}{track:00} - {Track Title}");
  assert.equal(config.naming.artist_folder, "{Artist Name} {mbid-{Artist MbId}}");
  assert.equal(config.metadata.enable_fingerprinting, true);
  assert.equal(config.metadata.artwork_preference, "canonical");
  assert.equal(config.catalog.source, "servarr");
  assert.equal(config.catalog.musicbrainz_host, "localhost");
});

test("DISCOGENIUS_CATALOG_SOURCE env overrides stored catalog source", () => {
  const previous = process.env.DISCOGENIUS_CATALOG_SOURCE;
  try {
    process.env.DISCOGENIUS_CATALOG_SOURCE = "musicbrainz-local";
    configModule.clearConfigCache();
    assert.equal(configModule.readConfig().catalog.source, "musicbrainz");

    process.env.DISCOGENIUS_CATALOG_SOURCE = "servarr-metadata";
    configModule.clearConfigCache();
    assert.equal(configModule.readConfig().catalog.source, "servarr");

    delete process.env.DISCOGENIUS_CATALOG_SOURCE;
    configModule.clearConfigCache();
    assert.equal(configModule.readConfig().catalog.source, "servarr");
  } finally {
    if (previous === undefined) delete process.env.DISCOGENIUS_CATALOG_SOURCE;
    else process.env.DISCOGENIUS_CATALOG_SOURCE = previous;
    configModule.clearConfigCache();
  }
});

test("config writes strip retired quality settings", () => {
  const config = configModule.readConfig() as any;
  config.quality.embed_synced_lyrics = false;
  configModule.writeConfig(config);

  configModule.clearConfigCache();
  const rowAfter = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.quality'")
    .get() as { value: string } | undefined;
  assert.notEqual(rowAfter, undefined);
  assert.doesNotMatch(rowAfter!.value, /embed_synced_lyrics/);
  assert.equal("embed_synced_lyrics" in (configModule.readConfig().quality as any), false);
});

test("config writes keep the sync metadata tag policy", () => {
  const config = configModule.readConfig() as any;
  config.metadata.write_audio_tags_policy = "sync";
  configModule.writeConfig(config);

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().metadata.write_audio_tags_policy, "sync");
});

test("config writes normalize unsupported metadata tag policy values", () => {
  const config = configModule.readConfig() as any;
  config.metadata.write_audio_tags_policy = "whenever";
  configModule.writeConfig(config);

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().metadata.write_audio_tags_policy, "new_files");
});

test("app settings update database and retain configured keys", () => {
  const config = configModule.readConfig();
  config.app.admin_password = "from-db";
  configModule.writeConfig(config);

  configModule.updateConfig("app", {
    admin_password: "from-db",
    acoustid_api_key: "acoustid-test-key",
  });

  configModule.clearConfigCache();
  const appConfig = configModule.getConfigSection("app");
  assert.equal(appConfig.admin_password, "from-db");
  assert.equal(appConfig.acoustid_api_key, "acoustid-test-key");

  const row = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.app'")
    .get() as { value: string } | undefined;
  assert.notEqual(row, undefined);
  assert.match(row!.value, /"acoustid_api_key":"acoustid-test-key"/);
});
