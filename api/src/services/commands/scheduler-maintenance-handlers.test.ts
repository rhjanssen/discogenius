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

test("ordinary ConfigPrune keeps its existing prune then reconciliation behavior", async () => {
  const events: string[] = [];
  const progress: string[] = [];

  await maintenanceModule.runConfigPruneMaintenance(
    configPruneJob(false),
    {
      updateCommandDescription: (update) => {
        progress.push(String(update.description));
      },
    },
    {
      refreshArtworkPreferenceCache: async () => {
        events.push("refresh");
        return { total: 0, completed: 0, failed: 0, albums: 0, artists: 0 };
      },
      pruneDisabledMetadata: async () => {
        events.push("prune");
      },
      reconcileLibraryMetadata: async () => {
        events.push("reconcile");
        return { downloaded: 0, failed: 0, skipped: 0 };
      },
    },
  );

  assert.deepEqual(events, ["prune", "reconcile"]);
  assert.deepEqual(progress, []);
});

test("artwork preference ConfigPrune refreshes globally before sidecars and embeds", async () => {
  const events: string[] = [];
  const progress: Array<{ progress?: number; description?: string }> = [];
  let suppliedYield: (() => Promise<void>) | undefined;
  const yieldToEventLoop = async () => {
    events.push("yield");
  };

  await maintenanceModule.runConfigPruneMaintenance(
    configPruneJob(true),
    {
      updateCommandDescription: (update) => progress.push({ ...update }),
      yieldToEventLoop,
    },
    {
      refreshArtworkPreferenceCache: async (options) => {
        events.push("refresh");
        suppliedYield = options.yieldToEventLoop;
        options.onProgress?.({
          completed: 3,
          total: 3,
          albumsCompleted: 2,
          artistsCompleted: 1,
        });
        return { total: 3, completed: 3, failed: 0, albums: 2, artists: 1 };
      },
      pruneDisabledMetadata: async () => {
        events.push("prune");
      },
      reconcileLibraryMetadata: async () => {
        events.push("reconcile");
        return { downloaded: 2, failed: 0, skipped: 4 };
      },
    },
  );

  assert.deepEqual(events, ["refresh", "prune", "reconcile"]);
  assert.equal(suppliedYield, yieldToEventLoop);
  assert.equal(progress.at(-1)?.progress, 100);
  assert.match(
    String(progress.at(-1)?.description),
    /reconciled 2 library metadata file\(s\), 0 failed/,
  );
});
