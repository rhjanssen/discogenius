import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ImportDownloadState } from "./downloaded-tracks-import-service.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-cancellation-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const queueModule = await import("../commands/command-queue-manager.js");
const routingModule = await import("../download/download-routing.js");
const organizerModule = await import("./organizer.js");
const importModule = await import("./downloaded-tracks-import-service.js");

beforeEach(() => {
  db.prepare("DELETE FROM commands").run();
});

test("import cancellation at a safe boundary cleans staging without reporting a failed state", async () => {
  const providerId = "cancel-before-organize";
  const downloadPath = routingModule.getDownloadWorkspacePath("track", providerId, "tidal");
  fs.mkdirSync(downloadPath, { recursive: true });
  fs.writeFileSync(path.join(downloadPath, `${providerId}.flac`), "staged media");
  const states: ImportDownloadState[] = [];

  const job = {
    id: 91,
    name: queueModule.CommandNames.ImportDownload,
    payload: {
      type: "track",
      providerId,
      provider: "tidal",
      path: downloadPath,
    },
    status: "started",
    progress: 0,
    priority: 0,
    attempts: 0,
    created_at: new Date().toISOString(),
  } as any;

  await assert.rejects(
    importModule.DownloadedTracksImportService.process(job, {
      updateState: (state) => states.push(state),
      isCancelled: () => true,
    }),
    (error) => {
      assert.equal(importModule.isImportDownloadCancelledError(error), true);
      assert.match((error as Error).message, /safe boundary/i);
      return true;
    },
  );

  assert.equal(states.some((state) => state.state === "completed" || state.state === "failed"), false);
  assert.equal(fs.existsSync(downloadPath), false);
});

test("persisted import cancellation marker crosses worker boundaries while status stays active", () => {
  const commandId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadTrack,
    { type: "track", providerId: "marker-test", provider: "tidal" },
    "marker-test",
  );
  queueModule.CommandQueueManager.markProcessing(commandId);

  assert.equal(importModule.isImportDownloadCancellationRequested(commandId), false);
  queueModule.CommandQueueManager.updateState(commandId, {
    payloadPatch: { importCancellationRequested: true },
  });

  assert.equal(queueModule.CommandQueueManager.get(commandId)?.status, "started");
  assert.equal(importModule.isImportDownloadCancellationRequested(commandId), true);
});

test("cancellation after an organizer boundary preserves media already moved into the library", async () => {
  const providerId = "cancel-after-move";
  const downloadPath = routingModule.getDownloadWorkspacePath("track", providerId, "tidal");
  const stagedFile = path.join(downloadPath, `${providerId}.flac`);
  const libraryFile = path.join(tempDir, "library", `${providerId}.flac`);
  fs.mkdirSync(downloadPath, { recursive: true });
  fs.writeFileSync(stagedFile, "organized media must survive cancellation");

  let cancellationRequested = false;
  const originalOrganizeDownload = organizerModule.OrganizerService.organizeDownload;
  (organizerModule.OrganizerService as any).organizeDownload = async (request: {
    onProgress?: (progress: {
      phase: "importing";
      currentFileNum: number;
      totalFiles: number;
    }) => void;
  }) => {
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.renameSync(stagedFile, libraryFile);
    cancellationRequested = true;
    request.onProgress?.({ phase: "importing", currentFileNum: 1, totalFiles: 1 });
    throw new Error("cancellation checkpoint should have interrupted organizer progress");
  };

  const job = {
    id: 92,
    name: queueModule.CommandNames.ImportDownload,
    payload: {
      type: "track",
      providerId,
      provider: "tidal",
      path: downloadPath,
    },
    status: "started",
    progress: 0,
    priority: 0,
    attempts: 0,
    created_at: new Date().toISOString(),
  } as any;

  try {
    await assert.rejects(
      importModule.DownloadedTracksImportService.process(job, {
        updateState: () => {},
        isCancelled: () => cancellationRequested,
      }),
      (error) => importModule.isImportDownloadCancelledError(error),
    );

    assert.equal(fs.existsSync(downloadPath), false);
    assert.equal(fs.readFileSync(libraryFile, "utf8"), "organized media must survive cancellation");
  } finally {
    (organizerModule.OrganizerService as any).organizeDownload = originalOrganizeDownload;
    fs.rmSync(path.dirname(libraryFile), { recursive: true, force: true });
  }
});

test("album-mode imports with provenance offers do not hard-fail a shortfall", () => {
  assert.equal(importModule.shouldHardFailIncompleteAlbumImport({
    type: "album",
    acquisitionMode: "album",
    processedCount: 23,
    trackOfferCount: 24,
  }), false);
  assert.equal(importModule.shouldHardFailIncompleteAlbumImport({
    type: "album",
    acquisitionMode: "trackOffers",
    processedCount: 23,
    trackOfferCount: 24,
  }), true);
});
