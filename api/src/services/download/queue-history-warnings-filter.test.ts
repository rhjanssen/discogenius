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
const { downloadBackendRegistry } = await import("./download-backend.js");
const { streamingProviderManager } = await import("../../providers/index.js");
const { CommandQueueManager } = await import("../commands/command-queue-manager.js");
const organizerModule = await import("../mediafiles/organizer.js");
const tagServiceModule = await import("../mediafiles/audio-tag-service.js");

function registerProvider(id: string): void {
  if ([...streamingProviderManager.getAllStreamingProviders()].some((provider) => provider.id === id)) return;
  streamingProviderManager.registerStreamingProvider({
    id,
    name: id,
    capabilities: {},
    async getAlbumTracks() { return []; },
    async getAlbum() { return null; },
  } as never);
}

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

  // Query warnings filter
  const warningHistory = DownloadQueueQueryService.getQueueHistory({
    limit: 50,
    offset: 0,
    outcomes: ["warning"],
  });
  const warningIds = warningHistory.items.map((item) => item.id);
  assert.ok(warningIds.includes(warningId), "Expected warning album with persisted outcome to match warnings filter");
  assert.ok(!warningIds.includes(cleanId), "Clean completion must not be returned by warnings filter");
  assert.ok(!warningIds.includes(failedId), "Hard failure must not be returned by warnings filter");

  // Verify warning details
  const warningItem = warningHistory.items.find((item) => item.id === warningId);
  assert.equal(warningItem?.outcome, "completedWithWarning");
  assert.equal(warningItem?.warningMessage, warningMessage);

  // Query completed filter
  const completedHistory = DownloadQueueQueryService.getQueueHistory({
    limit: 50,
    offset: 0,
    outcomes: ["completed"],
  });
  const completedIds = completedHistory.items.map((item) => item.id);
  assert.ok(completedIds.includes(cleanId), "Clean album must match completed filter");
  assert.ok(!completedIds.includes(warningId), "Warning album must not match pure completed filter");
  assert.ok(!completedIds.includes(failedId), "Failed album must not match pure completed filter");

  // Query failed filter
  const failedHistory = DownloadQueueQueryService.getQueueHistory({
    limit: 50,
    offset: 0,
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

test("buffered backend warningMessage propagates to importPending and completed ImportDownload outcome (#97)", async () => {
  const provider = "buffered-backend-warning-provider";
  const backendId = "buffered-backend-warning";
  const commandId = 97050;
  const providerAlbumId = "buffered-warning-album";
  const warningMessage = "Completed with 1 unavailable track(s) [1440904919: Failed to dl aac-lc: Unavailable]";

  registerProvider(provider);

  downloadBackendRegistry.register({
    id: backendId,
    supportedProviders: [provider],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request, options) {
      fs.mkdirSync(request.downloadPath, { recursive: true });
      fs.writeFileSync(path.join(request.downloadPath, "01.m4a"), "mock audio");
      // Backend emits progress carrying warningMessage right as download finishes.
      // persistDownloadState puts this in progressBuffer without immediately flushing to DB.
      options?.onProgress?.({
        state: "downloading",
        warningMessage,
        progress: 100,
        totalFiles: 2,
        currentFileNum: 1,
      });
    },
  });

  const originalOrganizeDownload = organizerModule.OrganizerService.organizeDownload;
  const originalAudioTagApply = tagServiceModule.AudioTagService.apply;
  (organizerModule.OrganizerService as any).organizeDownload = async () => ({
    processedTrackIds: ["t1"],
    expectedTracks: 1,
    totalTracksInStaging: 1,
    importedTrackFileIds: { t1: 1001 },
    trackGaps: [],
  });
  (tagServiceModule.AudioTagService as any).apply = async () => ({
    missing: 0,
    errors: [],
    applied: 1,
    skipped: 0,
  });

  const processor = new DownloadProcessor() as any;
  processor.scheduleNext = () => {};
  processor.ensureMetadataReady = async () => {};
  processor.resolveDownloadMetadata = () => ({
    title: "Buffered Warning Album",
    artist: "Buffered Artist",
    cover: null,
  });

  db.prepare(`
    INSERT INTO commands (id, name, payload, status)
    VALUES (?, 'DownloadAlbum', ?, 'queued')
  `).run(
    commandId,
    JSON.stringify({
      provider,
      providerId: providerAlbumId,
      type: "album",
      slot: "stereo",
      title: "Buffered Warning Album",
      artist: "Buffered Artist",
      downloadState: {
        tracks: [{ title: "Track 1", status: "queued", providerTrackId: "p1" }],
      },
    }),
  );

  const command = CommandQueueManager.get(commandId)!;

  try {
    // 1. Run download phase
    await processor.dispatchDownloadPhase(command);

    // Flush any pending progress buffer to SQLite
    processor.flushProgressBuffer();

    // 2. Assert persisted downloadState at importPending
    const jobAtImportPending = CommandQueueManager.get(commandId);
    const handoff = (jobAtImportPending?.payload as any)?.downloadImportHandoff as {
      importPayload?: { downloadState?: { outcome?: string; warningMessage?: string } };
    } | undefined;

    assert.equal(jobAtImportPending?.payload?.downloadState?.state, "importPending");
    assert.equal(jobAtImportPending?.payload?.downloadState?.outcome, "completedWithWarning");
    assert.equal(jobAtImportPending?.payload?.downloadState?.warningMessage, warningMessage);
    assert.equal(handoff?.importPayload?.downloadState?.outcome, "completedWithWarning");
    assert.equal(handoff?.importPayload?.downloadState?.warningMessage, warningMessage);

    // 3. Drive the import phase
    const pendingImport = processor.pendingImports.find((e: any) => e.commandId === commandId);
    assert.ok(pendingImport, "Expected command to be queued in pendingImports");
    processor.dispatchImportPhase(pendingImport);

    const activeImport = processor.activeImports.get(commandId);
    await activeImport?.promise;

    // 4. Assert persisted state after ImportDownload completes
    const finalJob = CommandQueueManager.get(commandId);
    assert.equal(finalJob?.status, "completed");
    assert.equal(finalJob?.payload?.downloadState?.state, "completed");
    assert.equal(finalJob?.payload?.downloadState?.outcome, "completedWithWarning");
    assert.equal(finalJob?.payload?.downloadState?.warningMessage, warningMessage);

    // 5. Assert the command is returned by the queue history warnings filter
    const warningHistory = DownloadQueueQueryService.getQueueHistory({
      limit: 50,
      offset: 0,
      outcomes: ["warning"],
    });
    const found = warningHistory.items.find((item) => item.id === commandId);
    assert.ok(found, "Command must be present in queue history warnings filter");
    assert.equal(found?.outcome, "completedWithWarning");
    assert.equal(found?.warningMessage, warningMessage);

    // 6. Assert clean completed filter does not include the warning album
    const cleanHistory = DownloadQueueQueryService.getQueueHistory({
      limit: 50,
      offset: 0,
      outcomes: ["completed"],
    });
    assert.ok(!cleanHistory.items.some((item) => item.id === commandId), "Warning album must not appear in pure completed filter");
  } finally {
    (organizerModule.OrganizerService as any).organizeDownload = originalOrganizeDownload;
    (tagServiceModule.AudioTagService as any).apply = originalAudioTagApply;
    if (processor.progressFlushTimer) {
      clearInterval(processor.progressFlushTimer);
    }
    processor.progressBuffer?.clear();
  }
});
