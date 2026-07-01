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

test("editable settings are persisted to config.toml and read through the cache", () => {
  const rawBefore = fs.readFileSync(configModule.CONFIG_FILE, "utf-8");
  assert.match(rawBefore, /audio_quality = "max"/);
  assert.doesNotMatch(rawBefore, /embed_synced_lyrics/);
  assert.match(rawBefore, /enable_fingerprinting = false/);

  configModule.updateConfig("quality", { audio_quality: "normal" });

  const rawAfter = fs.readFileSync(configModule.CONFIG_FILE, "utf-8");
  assert.match(rawAfter, /audio_quality = "normal"/);
  assert.doesNotMatch(rawAfter, /embed_synced_lyrics/);
  assert.equal(configModule.getConfigSection("quality").audio_quality, "normal");

  const row = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.quality'")
    .get() as { value: string } | undefined;
  assert.equal(row, undefined);

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().quality.audio_quality, "normal");
});

test("config writes strip retired quality settings", () => {
  const config = configModule.readConfig() as any;
  config.quality.embed_synced_lyrics = false;
  configModule.writeConfig(config);

  configModule.clearConfigCache();
  const raw = fs.readFileSync(configModule.CONFIG_FILE, "utf-8");
  assert.doesNotMatch(raw, /embed_synced_lyrics/);
  assert.equal("embed_synced_lyrics" in (configModule.readConfig().quality as any), false);
});

test("config writes normalize unsupported metadata tag policy values", () => {
  const config = configModule.readConfig() as any;
  config.metadata.write_audio_tags_policy = "sync";
  configModule.writeConfig(config);

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().metadata.write_audio_tags_policy, "new_files");
});

test("app settings update config.toml without splitting values into database overrides", () => {
  const config = configModule.readConfig();
  config.app.admin_password = "from-file";
  configModule.writeConfig(config);

  configModule.updateConfig("app", {
    admin_password: "from-file",
    acoustid_api_key: "acoustid-test-key",
  });

  configModule.clearConfigCache();
  const appConfig = configModule.getConfigSection("app");
  assert.equal(appConfig.admin_password, "from-file");
  assert.equal(appConfig.acoustid_api_key, "acoustid-test-key");

  const row = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.app'")
    .get() as { value: string } | undefined;
  assert.equal(row, undefined);
});
