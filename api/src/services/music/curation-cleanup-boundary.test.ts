import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-cleanup-boundary-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let curationModule: typeof import("./curation-service.js");
let libraryFilesModule: typeof import("../mediafiles/library-files.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  libraryFilesModule = await import("../mediafiles/library-files.js");
  curationModule = await import("./curation-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("curation does not mutate the file registry or run housekeeping cleanup", async () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Bastille')
  `).run(artistMbid);
  seedLibraryArtistMonitoring(dbModule.db, artistMbid);
  configModule.updateConfig("monitoring", { remove_unmonitored_files: true });

  const originalRebind = libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions;
  const originalPruneUnmonitored = libraryFilesModule.LibraryFilesService.pruneUnmonitoredFiles;
  const originalPruneMetadata = libraryFilesModule.LibraryFilesService.pruneDisabledMetadataFiles;
  const calls = {
    rebind: [] as string[],
    pruneUnmonitored: [] as string[],
    pruneMetadata: [] as string[],
  };

  libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions = ((artistId: string) => {
    calls.rebind.push(artistId);
    return { rebound: 0 };
  }) as typeof originalRebind;
  libraryFilesModule.LibraryFilesService.pruneUnmonitoredFiles = ((artistId: string) => {
    calls.pruneUnmonitored.push(artistId);
    return { deleted: 0, missing: 0, errors: 0 };
  }) as typeof originalPruneUnmonitored;
  libraryFilesModule.LibraryFilesService.pruneDisabledMetadataFiles = ((artistId: string) => {
    calls.pruneMetadata.push(artistId);
    return { deleted: 0, missing: 0, errors: 0 };
  }) as typeof originalPruneMetadata;

  try {
    await curationModule.CurationService.processAll(artistMbid);
  } finally {
    libraryFilesModule.LibraryFilesService.rebindFilesToMonitoredEditions = originalRebind;
    libraryFilesModule.LibraryFilesService.pruneUnmonitoredFiles = originalPruneUnmonitored;
    libraryFilesModule.LibraryFilesService.pruneDisabledMetadataFiles = originalPruneMetadata;
    configModule.updateConfig("monitoring", { remove_unmonitored_files: false });
  }

  assert.deepEqual(calls.rebind, []);
  assert.deepEqual(calls.pruneUnmonitored, []);
  assert.deepEqual(calls.pruneMetadata, []);
});
