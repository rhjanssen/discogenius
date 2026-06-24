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

test("editable settings are stored in the config table and read through the cache", () => {
  const rawBefore = fs.readFileSync(configModule.CONFIG_FILE, "utf-8");
  assert.match(rawBefore, /audio_quality = "max"/);

  configModule.updateConfig("quality", { audio_quality: "normal" });

  const rawAfter = fs.readFileSync(configModule.CONFIG_FILE, "utf-8");
  assert.match(rawAfter, /audio_quality = "max"/);
  assert.equal(configModule.getConfigSection("quality").audio_quality, "normal");

  const row = dbModule.db
    .prepare("SELECT value FROM config WHERE key = 'settings.quality'")
    .get() as { value: string } | undefined;
  assert.ok(row);
  assert.equal(JSON.parse(row.value).audio_quality, "normal");

  configModule.clearConfigCache();
  assert.equal(configModule.readConfig().quality.audio_quality, "normal");
});

test("app admin password remains file-backed while public app settings can be DB-backed", () => {
  const config = configModule.readConfig();
  config.app.admin_password = "from-file";
  configModule.writeConfig(config);

  configModule.updateConfig("app", {
    admin_password: "from-db-payload",
    acoustid_api_key: "acoustid-test-key",
  });

  configModule.clearConfigCache();
  const appConfig = configModule.getConfigSection("app");
  assert.equal(appConfig.admin_password, "from-file");
  assert.equal(appConfig.acoustid_api_key, "acoustid-test-key");
});
