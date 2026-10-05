import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-handlers-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../../database.js");
let queueModule: typeof import("../command-queue-manager.js");
let handlerModule: typeof import("./curation-handlers.js");
let curationModule: typeof import("../../music/curation-service.js");
let statisticsModule: typeof import("../../music/artist-statistics-service.js");
let eventsModule: typeof import("../app-events.js");
let planningControlModule: typeof import("../../music/acquisition-planning-control.js");

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  queueModule = await import("../command-queue-manager.js");
  handlerModule = await import("./curation-handlers.js");
  curationModule = await import("../../music/curation-service.js");
  statisticsModule = await import("../../music/artist-statistics-service.js");
  eventsModule = await import("../app-events.js");
  planningControlModule = await import("../../music/acquisition-planning-control.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
  dbModule.db.prepare("DELETE FROM runtime_controls").run();
});

test("global ApplyCuration clears only the provider-priority revision it processed", async () => {
  const firstRevision = planningControlModule.markAcquisitionPlanningStale();
  const context = {
    updateCommandDescription: () => undefined,
    yieldToEventLoop: async () => undefined,
  } as any;

  await handlerModule.handleApplyCuration({
    id: 100,
    name: queueModule.CommandNames.ApplyCuration,
    status: "started",
    payload: { providerPriorityRevision: firstRevision },
  } as any, context);
  assert.equal(planningControlModule.getPendingAcquisitionPlanningRevision(), null);

  const staleRevision = planningControlModule.markAcquisitionPlanningStale();
  const currentRevision = planningControlModule.markAcquisitionPlanningStale();
  await handlerModule.handleApplyCuration({
    id: 101,
    name: queueModule.CommandNames.ApplyCuration,
    status: "started",
    payload: { providerPriorityRevision: staleRevision },
  } as any, context);
  assert.equal(
    planningControlModule.getPendingAcquisitionPlanningRevision(),
    currentRevision,
    "a reorder made during curation must remain pending",
  );
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("CurateArtist emits completion without queueing DownloadMissing itself", async () => {
  const originalProcessAll = curationModule.CurationService.processAll;
  const originalRefresh = statisticsModule.ArtistStatisticsService.refreshAsync;
  (curationModule.CurationService as any).processAll = async () => undefined;
  (statisticsModule.ArtistStatisticsService as any).refreshAsync = async () => [];

  const completed = new Promise<any>((resolve) => {
    eventsModule.appEvents.once(eventsModule.AppEvent.ARTIST_CURATED, resolve);
  });
  try {
    await handlerModule.handleCurateArtist({
      id: 42,
      name: queueModule.CommandNames.CurateArtist,
      status: "started",
      refId: "artist-1",
      priority: 12,
      trigger: 2,
      payload: {
        artistId: "artist-1",
        artistName: "Bastille",
        workflow: "monitoring-intake",
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
    } as any);
  } finally {
    (curationModule.CurationService as any).processAll = originalProcessAll;
    (statisticsModule.ArtistStatisticsService as any).refreshAsync = originalRefresh;
  }

  const event = await completed;
  assert.equal(event.artistId, "artist-1");
  assert.equal(event.workflow, "monitoring-intake");
  const queued = dbModule.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE name = ?")
    .get(queueModule.CommandNames.DownloadMissing) as { n: number };
  assert.equal(queued.n, 0);
});

test("ApplyCuration persists failed artists and fails the command instead of reporting partial success", async () => {
  const { db } = dbModule;
  const { seedTestLibrary } = await import("../../../test-support/library-fixtures.js");
  const library = seedTestLibrary(db, { name: "Curation failure test", rootPath: tempDir });
  const artist = Number(db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES('failure-artist','Failure artist')").run().lastInsertRowid);
  db.prepare("INSERT INTO LibraryArtists(library_id,artist_metadata_id,policy) VALUES(?,?,'all')").run(library, artist);
  const revision = planningControlModule.markAcquisitionPlanningStale();
  const id = queueModule.CommandQueueManager.push(queueModule.CommandNames.ApplyCuration, { providerPriorityRevision: revision });
  const job = queueModule.CommandQueueManager.claimForExecution(id, "failure-test", 60000)!;
  const original = curationModule.CurationService.processAll;
  curationModule.CurationService.processAll = async () => { throw new Error("meaningful curation failure"); };
  try {
    await assert.rejects(handlerModule.handleApplyCuration(job as any, { updateCommandDescription: () => undefined, yieldToEventLoop: async () => undefined } as any), /Curation failed for 1 of 1 artists/);
    const payload = queueModule.CommandQueueManager.get(id)!.payload as any;
    assert.deepEqual(payload.curationFailures, [{ artistId: "failure-artist", artistName: "Failure artist", error: "meaningful curation failure" }]);
    assert.equal(planningControlModule.getPendingAcquisitionPlanningRevision(), revision);
  } finally {
    curationModule.CurationService.processAll = original;
    db.prepare("DELETE FROM LibraryArtists WHERE artist_metadata_id=?").run(artist);
    db.prepare("DELETE FROM ArtistMetadata WHERE id=?").run(artist);
    db.prepare("DELETE FROM Libraries WHERE id=?").run(library);
  }
});
