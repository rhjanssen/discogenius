import test from "node:test";
import assert from "node:assert/strict";
import {
  findSystemTaskDefinitionByCommandName,
  getCommandDefinition,
  getCommandTypesForQueueCategory,
  PENDING_ACTIVITY_JOB_TYPES,
} from "./command-registry.js";

test("command registry exposes canonical command and task metadata", () => {
  const healthCheck = getCommandDefinition("HealthCheck");
  assert.equal(healthCheck.name, "Health Check");
  assert.equal(healthCheck.isTypeExclusive, true);
  assert.equal(healthCheck.requiresDiskAccess, false);

  const monitoringCycle = findSystemTaskDefinitionByCommandName("MonitoringCycle");
  assert.ok(monitoringCycle);
  assert.equal(monitoringCycle?.id, "monitoring-cycle");
  assert.equal(monitoringCycle?.kind, "scheduled");

  assert.ok(PENDING_ACTIVITY_JOB_TYPES.includes("RefreshArtist"));
  assert.ok(getCommandTypesForQueueCategory("downloads").includes("ImportDownload"));
  assert.ok(getCommandTypesForQueueCategory("other").includes("HealthCheck"));

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
  for (const pendingType of PENDING_ACTIVITY_JOB_TYPES) {
    assert.equal(scanTypes.has(pendingType), true, `pending activity type ${pendingType} must be in scans category`);
  }
});
