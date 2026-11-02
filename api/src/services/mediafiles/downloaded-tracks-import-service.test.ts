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
  const trackOffers = Array.from({ length: 30 }, (_, index) => ({ provider: 'tidal', providerTrackId: String(index) }));
  assert.equal(importModule.expectedImportedTrackCount({ acquisitionMode: 'trackOffers', trackOffers }, 41), 30,
    'a complete selected subset is not reported as a partial provider album');
  assert.equal(importModule.expectedImportedTrackCount({ acquisitionMode: 'album', trackOffers }, 41), 41,
    'provenance offers must not hide a real full-album shortfall');
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
  }), false);
});

test("YouTube album imports reconcile the exact downloaded plan instead of provider album membership", () => {
  const trackOffers = Array.from({ length: 12 }, (_, index) => ({ provider: 'youtube-music', providerTrackId: String(index) }));
  assert.equal(importModule.expectedImportedTrackCount({ acquisitionMode: 'album', provider: 'youtube-music', trackOffers }, 22), 12);
  assert.equal(importModule.shouldHardFailIncompleteAlbumImport({ type: 'album', acquisitionMode: 'album', provider: 'youtube-music', processedCount: 11, trackOfferCount: 12 }), false);
  assert.equal(importModule.shouldHardFailIncompleteAlbumImport({ type: 'album', acquisitionMode: 'album', provider: 'youtube-music', processedCount: 12, trackOfferCount: 12 }), false);
  assert.equal(importModule.expectedImportedTrackCount({ acquisitionMode: 'album', provider: 'youtube-music' }, 22), 22);
});

test("post-import catalog helpers bind multi-file id lists as one JSON parameter", async () => {
  // Regression: 979ad8b2 spread the ids into a single-parameter json_each()
  // statement, failing every multi-track import with "Too many parameter values".
  const ids = Array.from({ length: 40 }, (_, index) => index + 1);
  await assert.doesNotReject(() => importModule.ensureAlbumCatalogGenresForFileIds(ids));
  await assert.doesNotReject(() => importModule.ensureDestAlbumArtworkForFileIds(ids));
});

test("hybrid import names each offered track the organizer did not place", async () => {
    const { describeUnorganizedTrackOffers } = await import("./downloaded-tracks-import-service.js");
    const missing = describeUnorganizedTrackOffers([
        { provider: "tidal", providerTrackId: "1", title: "Kept", trackNum: 1, volumeNum: 1 },
        { provider: "deezer", providerTrackId: "2", title: "Lost", trackNum: 7, volumeNum: 2 },
        { provider: "deezer", providerTrackId: "2", title: "Lost", trackNum: 7, volumeNum: 2 },
    ], ["1"]);
    assert.deepEqual(missing, ['2-7 "Lost" (deezer:2)']);
    const { listUnorganizedTrackGaps, shouldHardFailIncompleteAlbumImport } = await import("./downloaded-tracks-import-service.js");
    assert.equal(shouldHardFailIncompleteAlbumImport({
        type: "album",
        acquisitionMode: "trackOffers",
        provider: "youtube-music",
        processedCount: 11,
        trackOfferCount: 12,
    }), false);
    assert.deepEqual(listUnorganizedTrackGaps([
        { provider: "tidal", providerTrackId: "1", title: "Kept", trackNum: 1, volumeNum: 1 },
        { provider: "deezer", providerTrackId: "2", title: "Lost", trackNum: 7, volumeNum: 2 },
    ], ["1"]), [{
        position: "2-7",
        title: "Lost",
        providerId: "deezer:2",
        cause: "not organized",
    }]);
});

test("import gaps keep the organizer cause for a path-too-long offered track", async () => {
    const { listUnorganizedTrackGaps } = await import("./downloaded-tracks-import-service.js");
    const missing = listUnorganizedTrackGaps([
        { provider: "tidal", providerTrackId: "108", title: "Firebird", trackNum: 108, volumeNum: 1 },
    ], [], "path component too long (276 bytes): 108 - Firebird.flac");
    assert.equal(missing[0].cause.startsWith("path component too long"), true);
    assert.equal(missing[0].providerId, "tidal:108");
    assert.equal(missing[0].position, "1-108");
});
