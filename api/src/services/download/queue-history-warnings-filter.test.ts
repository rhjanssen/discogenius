import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-warnings-filter-test-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.warnings-filter.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
const { DownloadQueueQueryService } = await import("./download-queue-query-service.js");
const { DownloadProcessor } = await import("./download-processor.js");

test("history warnings filter returns albums completed with warning and excludes clean completion and failed jobs (#97)", () => {
  // 1. Clean completion
  const cleanId = 97001;
  db.prepare(`
    INSERT INTO commands (id, name, payload, status, progress, progress_phase, created_at, completed_at)
    VALUES (?, 'DownloadAlbum', ?, 'completed', 100, 'completed', datetime('now', '-30 minutes'), datetime('now', '-25 minutes'))
  `).run(
    cleanId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "clean-album-1",
      title: "Clean Album",
      artist: "Clean Artist",
      type: "album",
      slot: "stereo",
      downloadState: {
        state: "completed",
        progress: 100,
        outcome: "ok",
      },
    }),
  );

  // 2. Apple album completed with warning (persisted outcome: completedWithWarning)
  const warningId = 97002;
  const warningMessage = "Completed with 1 unavailable track(s) [1440904919: Failed to dl aac-lc: Unavailable]";
  db.prepare(`
    INSERT INTO commands (id, name, payload, status, progress, progress_phase, created_at, completed_at)
    VALUES (?, 'DownloadAlbum', ?, 'completed', 100, 'completed', datetime('now', '-20 minutes'), datetime('now', '-15 minutes'))
  `).run(
    warningId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "warning-album-1",
      title: "Warning Album",
      artist: "Warning Artist",
      type: "album",
      slot: "stereo",
      downloadState: {
        state: "completed",
        progress: 100,
        outcome: "completedWithWarning",
        warningMessage,
        statusMessage: warningMessage,
      },
    }),
  );

  // 3. Hard failure
  const failedId = 97003;
  db.prepare(`
    INSERT INTO commands (id, name, payload, status, error, progress, progress_phase, created_at, completed_at)
    VALUES (?, 'DownloadAlbum', ?, 'failed', 'Network timeout', 50, 'failed', datetime('now', '-10 minutes'), datetime('now', '-5 minutes'))
  `).run(
    failedId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "failed-album-1",
      title: "Failed Album",
      artist: "Failed Artist",
      type: "album",
      slot: "stereo",
      downloadState: {
        state: "failed",
        progress: 50,
      },
    }),
  );

  // 4. Retroactive Primula case: completed with warningMessage but outcome was omitted in DB
  const legacyWarningId = 97004;
  const legacyWarningMessage = "Completed with 2 unavailable track(s) [t1: Unavailable; t2: Unavailable]";
  db.prepare(`
    INSERT INTO commands (id, name, payload, status, progress, progress_phase, created_at, completed_at)
    VALUES (?, 'DownloadAlbum', ?, 'completed', 100, 'completed', datetime('now', '-4 minutes'), datetime('now', '-2 minutes'))
  `).run(
    legacyWarningId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "legacy-warning-album-1",
      title: "Legacy Warning Album",
      artist: "Legacy Artist",
      type: "album",
      slot: "stereo",
      downloadState: {
        state: "completed",
        progress: 100,
        warningMessage: legacyWarningMessage,
        statusMessage: "Import completed",
      },
    }),
  );

  // Query warnings filter
  const warningHistory = DownloadQueueQueryService.getQueueHistory({
    outcomes: ["warning"],
  });
  const warningIds = warningHistory.items.map((item) => item.id);
  assert.ok(warningIds.includes(warningId), "Expected warning album with persisted outcome to match warnings filter");
  assert.ok(warningIds.includes(legacyWarningId), "Expected legacy warning album with warningMessage to match warnings filter");
  assert.ok(!warningIds.includes(cleanId), "Clean completion must not be returned by warnings filter");
  assert.ok(!warningIds.includes(failedId), "Hard failure must not be returned by warnings filter");

  // Verify warning details
  const warningItem = warningHistory.items.find((item) => item.id === warningId);
  assert.equal(warningItem?.outcome, "completedWithWarning");
  assert.equal(warningItem?.warningMessage, warningMessage);

  const legacyItem = warningHistory.items.find((item) => item.id === legacyWarningId);
  assert.equal(legacyItem?.outcome, "completedWithWarning");
  assert.equal(legacyItem?.warningMessage, legacyWarningMessage);

  // Query completed filter
  const completedHistory = DownloadQueueQueryService.getQueueHistory({
    outcomes: ["completed"],
  });
  const completedIds = completedHistory.items.map((item) => item.id);
  assert.ok(completedIds.includes(cleanId), "Clean album must match completed filter");
  assert.ok(!completedIds.includes(warningId), "Warning album must not match pure completed filter");
  assert.ok(!completedIds.includes(legacyWarningId), "Legacy warning album must not match pure completed filter");
  assert.ok(!completedIds.includes(failedId), "Failed album must not match pure completed filter");

  // Query failed filter
  const failedHistory = DownloadQueueQueryService.getQueueHistory({
    outcomes: ["failed"],
  });
  const failedIds = failedHistory.items.map((item) => item.id);
  assert.ok(failedIds.includes(failedId), "Failed album must match failed filter");
  assert.ok(!failedIds.includes(cleanId), "Clean album must not match failed filter");
  assert.ok(!failedIds.includes(warningId), "Warning album must not match failed filter");
});

test("writeDownloadState and persistDownloadState persist outcome: completedWithWarning when warningMessage is present (#97)", () => {
  const processor = new DownloadProcessor() as any;
  const commandId = 97005;

  db.prepare(`
    INSERT INTO commands (id, name, payload, status)
    VALUES (?, 'DownloadAlbum', ?, 'started')
  `).run(
    commandId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "persisted-warning-album",
      type: "album",
    }),
  );

  const warningMsg = "Completed with 1 unavailable track(s) [1440904919: Failed to dl aac-lc: Unavailable]";
  processor.writeDownloadState(commandId, {
    state: "completed",
    progress: 100,
    warningMessage: warningMsg,
  });

  const row = db.prepare("SELECT payload FROM commands WHERE id = ?").get(commandId) as { payload: string };
  const payload = JSON.parse(row.payload);
  assert.equal(payload.downloadState.outcome, "completedWithWarning");
  assert.equal(payload.downloadState.warningMessage, warningMsg);
});

test("clean completion without warningMessage leaves outcome clean and does not set completedWithWarning (#97)", () => {
  const processor = new DownloadProcessor() as any;
  const commandId = 97006;

  db.prepare(`
    INSERT INTO commands (id, name, payload, status)
    VALUES (?, 'DownloadAlbum', ?, 'started')
  `).run(
    commandId,
    JSON.stringify({
      provider: "apple-music",
      providerId: "clean-album-persisted",
      type: "album",
    }),
  );

  processor.writeDownloadState(commandId, {
    state: "completed",
    progress: 100,
  });

  const row = db.prepare("SELECT payload FROM commands WHERE id = ?").get(commandId) as { payload: string };
  const payload = JSON.parse(row.payload);
  assert.notEqual(payload.downloadState.outcome, "completedWithWarning");
  assert.equal(payload.downloadState.warningMessage, undefined);
});
