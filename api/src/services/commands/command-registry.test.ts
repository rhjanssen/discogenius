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
} = await import("./command-registry.js");

test("command registry exposes canonical command and task metadata", () => {
  const healthCheck = getCommandDefinition("CheckHealth");
  assert.equal(healthCheck.name, "Check Health");
  assert.equal(healthCheck.isTypeExclusive, true);
  assert.equal(healthCheck.requiresDiskAccess, false);

  const monitoringCycle = findSystemTaskDefinitionByCommandName("MonitoringCycle");
  assert.ok(monitoringCycle);
  assert.equal(monitoringCycle?.id, "monitoring-cycle");
  assert.equal(monitoringCycle?.kind, "scheduled");

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
