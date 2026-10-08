import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-config-prune-handler-"));
process.env.DB_PATH = path.join(tempDir, "config-prune-handler.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let maintenanceModule: typeof import("./scheduler-maintenance-handlers.js");
let dbModule: typeof import("../../database.js");

before(async () => {
  dbModule = await import("../../database.js");
  maintenanceModule = await import("./scheduler-maintenance-handlers.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function configPruneJob(refreshArtworkPreference: boolean) {
  return {
    id: 1,
    name: "ConfigPrune",
    payload: refreshArtworkPreference ? { refreshArtworkPreference: true } : {},
    status: "started",
    progress: 0,
    priority: 0,
    attempts: 1,
    created_at: new Date(0).toISOString(),
  } as any;
}

test("ordinary ConfigPrune keeps missing-only local repair", async () => {
  const events: string[] = [];
  const progress: string[] = [];
  await maintenanceModule.runConfigPruneMaintenance(configPruneJob(false), {
    updateCommandDescription: update => progress.push(String(update.description)),
  }, {
    pruneDisabledMetadata: async () => { events.push("prune"); },
    reconcileLibraryMetadata: async options => {
      events.push("reconcile");
      assert.equal(options.repairMissingOnly,true);
      assert.equal(options.writeEmbeddedMediaMetadata,false);
      assert.equal(options.fetchMissingLyrics,false);
      return {downloaded:0,failed:0,skipped:0};
    },
  });
  assert.deepEqual(events,["prune","reconcile"]);
  assert.deepEqual(progress,[]);
});

test("artwork preference uses one library reconciliation with live detail and honest completion", async () => {
  const events: string[] = [];
  const progress: Array<{progress?:number;description?:string}> = [];
  await maintenanceModule.runConfigPruneMaintenance(configPruneJob(true), {
    updateCommandDescription: update => progress.push({...update}),
  }, {
    pruneDisabledMetadata: async () => {events.push("prune");},
    reconcileLibraryMetadata: async options => {
      events.push("reconcile");
      assert.equal(options.repairMissingOnly,false);
      assert.equal(options.writeEmbeddedMediaMetadata,true);
      assert.equal(options.fetchMissingLyrics,false);
      options.onProgress?.("The Example Artist - checking album sidecars (1/2)");
      return {downloaded:2,failed:0,skipped:4};
    },
  });
  assert.deepEqual(events,["prune","reconcile"]);
  assert.equal(progress.at(-1)?.progress,100);
  assert.match(String(progress.at(-1)?.description),/reconciled 2 library metadata file\(s\), 0 failed/);
  assert.ok(progress.some(update => update.description?.includes("The Example Artist")));
});

test("artwork preference library failures cannot report a fully applied source switch", async () => {
  const progress: Array<{progress?:number}> = [];
  await assert.rejects(maintenanceModule.runConfigPruneMaintenance(configPruneJob(true), {
    updateCommandDescription: update => progress.push(update),
  }, {
    pruneDisabledMetadata: async () => {},
    reconcileLibraryMetadata: async () => ({downloaded:0,skipped:0,failed:1}),
  }), /Artwork preference update incomplete/);
  assert.equal(progress.some(update => update.progress === 100),false);
});
