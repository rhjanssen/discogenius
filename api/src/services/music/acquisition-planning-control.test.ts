import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-planning-control-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.planning-control.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let controlModule: typeof import("./acquisition-planning-control.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  controlModule = await import("./acquisition-planning-control.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM runtime_controls").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-priority revisions are durable and compare-and-delete safe", () => {
  assert.equal(controlModule.getPendingAcquisitionPlanningRevision(), null);
  const first = controlModule.markAcquisitionPlanningStale();
  assert.equal(controlModule.getPendingAcquisitionPlanningRevision(), first);

  const second = controlModule.markAcquisitionPlanningStale();
  assert.notEqual(second, first);
  assert.equal(controlModule.clearAcquisitionPlanningRevision(first), false);
  assert.equal(controlModule.getPendingAcquisitionPlanningRevision(), second);
  assert.equal(controlModule.clearAcquisitionPlanningRevision(second), true);
  assert.equal(controlModule.getPendingAcquisitionPlanningRevision(), null);
});
