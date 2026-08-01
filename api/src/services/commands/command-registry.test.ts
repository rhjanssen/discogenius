import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-command-registry-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();

const {
  findSystemTaskDefinitionByCommandName,
  getCommandDefinition,
  getCommandTypesForQueueCategory,
  PENDING_ACTIVITY_COMMAND_NAMES,
  resolveRefreshArtistMaxConcurrent,
} = await import("./command-registry.js");
const { updateConfig } = await import("../config/config.js");
const { NON_DOWNLOAD_COMMAND_NAMES } = await import("./command-names.js");
const { commandExecutors } = await import("./executors/registry.js");

test("command registry exposes canonical command and task metadata", () => {
  const healthCheck = getCommandDefinition("CheckHealth");
  assert.equal(healthCheck.name, "Check Health");
  assert.equal(healthCheck.isTypeExclusive, true);
  assert.equal(healthCheck.requiresDiskAccess, false);

  const databaseBackup = getCommandDefinition("BackupDatabase");
  assert.equal(databaseBackup.name, "Backup Database");
  assert.equal(databaseBackup.requiresDiskAccess, true);
  assert.equal(databaseBackup.isTypeExclusive, true);
  assert.ok(commandExecutors.BackupDatabase);
  assert.ok(NON_DOWNLOAD_COMMAND_NAMES.includes("BackupDatabase"));

  const monitoringCycle = findSystemTaskDefinitionByCommandName("MonitoringCycle");
  assert.ok(monitoringCycle);
  assert.equal(monitoringCycle?.id, "monitoring-cycle");
  assert.equal(monitoringCycle?.kind, "scheduled");
  assert.equal(findSystemTaskDefinitionByCommandName("CheckHealth")?.kind, "scheduled");
  assert.equal(findSystemTaskDefinitionByCommandName("BackupDatabase")?.kind, "scheduled");

  assert.ok(PENDING_ACTIVITY_COMMAND_NAMES.includes("RefreshArtist"));
  assert.ok(getCommandTypesForQueueCategory("downloads").includes("ImportDownload"));
  assert.ok(getCommandTypesForQueueCategory("other").includes("CheckHealth"));

  const downloadTypes = new Set(getCommandTypesForQueueCategory("downloads"));
  const scanTypes = new Set(getCommandTypesForQueueCategory("scans"));
  const otherTypes = new Set(getCommandTypesForQueueCategory("other"));

  for (const scanType of scanTypes) {
    assert.equal(downloadTypes.has(scanType), false, `scan type ${scanType} must not overlap downloads`);
  }
  for (const otherType of otherTypes) {
    assert.equal(downloadTypes.has(otherType), false, `other type ${otherType} must not overlap downloads`);
    assert.equal(scanTypes.has(otherType), false, `other type ${otherType} must not overlap scans`);
  }
  for (const pendingType of PENDING_ACTIVITY_COMMAND_NAMES) {
    assert.equal(scanTypes.has(pendingType), true, `pending activity type ${pendingType} must be in scans category`);
  }
});

test("RefreshArtist concurrency stays conservative for Servarr and exposes a bounded local-MB sweep control", () => {
  const refresh = getCommandDefinition("RefreshArtist");
  assert.equal(refresh.maxConcurrent, 1);
  assert.equal(typeof refresh.resolveMaxConcurrent, "function");

  delete process.env.DISCOGENIUS_LOCAL_MB_REFRESH_CONCURRENCY;
  updateConfig("catalog", { source: "servarr" });
  assert.equal(resolveRefreshArtistMaxConcurrent(), 1);
  assert.equal(refresh.resolveMaxConcurrent?.(), 1);

  updateConfig("catalog", { source: "musicbrainz" });
  assert.equal(resolveRefreshArtistMaxConcurrent(), 2);
  assert.equal(refresh.resolveMaxConcurrent?.(), 2);

  for (const concurrency of [1, 2, 3, 4, 5, 6, 8]) {
    process.env.DISCOGENIUS_LOCAL_MB_REFRESH_CONCURRENCY = String(concurrency);
    assert.equal(resolveRefreshArtistMaxConcurrent(), concurrency);
  }
  process.env.DISCOGENIUS_LOCAL_MB_REFRESH_CONCURRENCY = "99";
  assert.equal(resolveRefreshArtistMaxConcurrent(), 8);

  delete process.env.DISCOGENIUS_LOCAL_MB_REFRESH_CONCURRENCY;
  updateConfig("catalog", { source: "servarr" });
});
