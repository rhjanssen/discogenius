import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-pipeline-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let pipelineModule: typeof import("./artist-pipeline-service.js");
let refreshServiceModule: typeof import("./refresh-artist-service.js");
let diskScanModule: typeof import("../mediafiles/library-scan.js");
let curationModule: typeof import("./curation-service.js");
let downloadMissingModule: typeof import("./download-missing-service.js");
let eventsModule: typeof import("../commands/app-events.js");
let listenerModule: typeof import("./curation.listener.js");
let commandNamesModule: typeof import("../commands/command-names.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  eventsModule = await import("../commands/app-events.js");
  commandNamesModule = await import("../commands/command-names.js");
  listenerModule = await import("./curation.listener.js");
  listenerModule.initCurationListeners();

  pipelineModule = await import("./artist-pipeline-service.js");
  refreshServiceModule = await import("./refresh-artist-service.js");
  diskScanModule = await import("../mediafiles/library-scan.js");
  curationModule = await import("./curation-service.js");
  downloadMissingModule = await import("./download-missing-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  eventsModule.appEvents.removeAllListeners();
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("ArtistPipelineService executes all 5 stages in order for monitoring-intake without queue explosion", async () => {
  const { seedLibraryArtistMonitoring } = await import("../../test-support/active-schema-fixture.js");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, content_hash) VALUES
      ('pipeline-artist-mbid', 'Pipeline Artist', 'hydrated')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "pipeline-artist-mbid");

  const executionOrder: string[] = [];

  const originalRefresh = refreshServiceModule.RefreshArtistService.refreshArtist;
  const originalMatch = refreshServiceModule.RefreshArtistService.matchArtistProviders;
  const originalScan = diskScanModule.DiskScanService.scan;
  const originalFill = diskScanModule.DiskScanService.fillMissingMetadataFiles;
  const originalCurate = curationModule.CurationService.processAll;
  const originalQueueDownloads = downloadMissingModule.DownloadMissingService.queueMonitoredItems;

  (refreshServiceModule.RefreshArtistService as any).refreshArtist = async (artistId: string) => {
    executionOrder.push(`1:refresh:${artistId}`);
    return {
      artistMbid: artistId,
      shouldHydrateCatalog: true,
      metadataChanged: true,
      isNewArtist: false,
      creditedArtistMbids: [],
    };
  };

  (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = async (artistId: string) => {
    executionOrder.push(`2:match:${artistId}`);
  };

  (diskScanModule.DiskScanService as any).scan = async (options: any) => {
    executionOrder.push(`3:scan:${options.artistIds[0]}`);
    return {
      orphansRemoved: 0,
      filesIndexed: 2,
      filesUpdated: 0,
      artists: 1,
      unmappedOrphans: 0,
    };
  };

  (diskScanModule.DiskScanService as any).fillMissingMetadataFiles = async (artistId: string) => {
    executionOrder.push(`3b:fillSidecars:${artistId}`);
    return { covers: 0, nfo: 0, lyrics: 0 };
  };

  (curationModule.CurationService as any).processAll = async (artistId: string) => {
    executionOrder.push(`4:curate:${artistId}`);
  };

  (downloadMissingModule.DownloadMissingService as any).queueMonitoredItems = async (artistId: string) => {
    executionOrder.push(`5:downloadMissing:${artistId}`);
    return {
      albums: 3,
      tracks: 0,
      videos: 0,
      alreadyQueued: 0,
      missingPlans: 0,
    };
  };

  const progressSteps: Array<{ progress: number; desc: string }> = [];

  try {
    const result = await pipelineModule.ArtistPipelineService.executePipeline({
      artistId: "pipeline-artist-mbid",
      artistName: "Pipeline Artist",
      workflow: "monitoring-intake",
      onProgress: (progress, desc) => {
        progressSteps.push({ progress, desc });
      },
    });

    assert.equal(result.artistId, "pipeline-artist-mbid");
    assert.equal(result.downloadsQueued?.albums, 3);
    assert.equal(result.scanResult?.filesIndexed, 2);
  } finally {
    (refreshServiceModule.RefreshArtistService as any).refreshArtist = originalRefresh;
    (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = originalMatch;
    (diskScanModule.DiskScanService as any).scan = originalScan;
    (diskScanModule.DiskScanService as any).fillMissingMetadataFiles = originalFill;
    (curationModule.CurationService as any).processAll = originalCurate;
    (downloadMissingModule.DownloadMissingService as any).queueMonitoredItems = originalQueueDownloads;
  }

  // 1. Strict sequence verification
  assert.deepEqual(executionOrder, [
    "1:refresh:pipeline-artist-mbid",
    "2:match:pipeline-artist-mbid",
    "3:scan:pipeline-artist-mbid",
    "3b:fillSidecars:pipeline-artist-mbid",
    "4:curate:pipeline-artist-mbid",
    "5:downloadMissing:pipeline-artist-mbid",
  ]);

  // 2. Verify progress reported all 5 phases
  assert.ok(progressSteps.some((p) => p.progress === 5));
  assert.ok(progressSteps.some((p) => p.progress >= 25 && p.desc.includes("provider")));
  assert.ok(progressSteps.some((p) => p.progress >= 55 && p.desc.includes("scanning")));
  assert.ok(progressSteps.some((p) => p.progress >= 75 && p.desc.includes("monitoring rules")));
  assert.ok(progressSteps.some((p) => p.progress === 100 && p.desc.includes("queued 3 missing download(s)")));

  // 3. Verify zero queue fan-out: curation listener did NOT enqueue intermediate commands
  const queuedCommands = dbModule.db.prepare("SELECT name FROM commands").all() as Array<{ name: string }>;
  assert.deepEqual(queuedCommands, []);
});

test("ArtistPipelineService respects workflow phases: refresh-scan skips curation and download", async () => {
  const { seedLibraryArtistMonitoring } = await import("../../test-support/active-schema-fixture.js");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, content_hash) VALUES
      ('scan-only-mbid', 'Scan Only Artist', 'hydrated')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "scan-only-mbid");

  const executionOrder: string[] = [];

  const originalRefresh = refreshServiceModule.RefreshArtistService.refreshArtist;
  const originalMatch = refreshServiceModule.RefreshArtistService.matchArtistProviders;
  const originalScan = diskScanModule.DiskScanService.scan;
  const originalFill = diskScanModule.DiskScanService.fillMissingMetadataFiles;
  const originalCurate = curationModule.CurationService.processAll;
  const originalQueueDownloads = downloadMissingModule.DownloadMissingService.queueMonitoredItems;

  (refreshServiceModule.RefreshArtistService as any).refreshArtist = async (artistId: string) => {
    executionOrder.push(`1:refresh:${artistId}`);
    return {
      artistMbid: artistId,
      shouldHydrateCatalog: true,
      metadataChanged: false,
      isNewArtist: false,
      creditedArtistMbids: [],
    };
  };

  (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = async (artistId: string) => {
    executionOrder.push(`2:match:${artistId}`);
  };

  (diskScanModule.DiskScanService as any).scan = async (options: any) => {
    executionOrder.push(`3:scan:${options.artistIds[0]}`);
    return {
      orphansRemoved: 0,
      filesIndexed: 0,
      filesUpdated: 0,
      artists: 1,
      unmappedOrphans: 0,
    };
  };

  (diskScanModule.DiskScanService as any).fillMissingMetadataFiles = async (artistId: string) => {
    executionOrder.push(`3b:fillSidecars:${artistId}`);
    return { covers: 0, nfo: 0, lyrics: 0 };
  };

  (curationModule.CurationService as any).processAll = async (artistId: string) => {
    executionOrder.push(`4:curate:${artistId}`);
  };

  (downloadMissingModule.DownloadMissingService as any).queueMonitoredItems = async (artistId: string) => {
    executionOrder.push(`5:downloadMissing:${artistId}`);
    return { albums: 0, tracks: 0, videos: 0, alreadyQueued: 0, missingPlans: 0 };
  };

  try {
    await pipelineModule.ArtistPipelineService.executePipeline({
      artistId: "scan-only-mbid",
      artistName: "Scan Only Artist",
      workflow: "refresh-scan",
    });
  } finally {
    (refreshServiceModule.RefreshArtistService as any).refreshArtist = originalRefresh;
    (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = originalMatch;
    (diskScanModule.DiskScanService as any).scan = originalScan;
    (diskScanModule.DiskScanService as any).fillMissingMetadataFiles = originalFill;
    (curationModule.CurationService as any).processAll = originalCurate;
    (downloadMissingModule.DownloadMissingService as any).queueMonitoredItems = originalQueueDownloads;
  }

  assert.deepEqual(executionOrder, [
    "1:refresh:scan-only-mbid",
    "2:match:scan-only-mbid",
    "3:scan:scan-only-mbid",
    "3b:fillSidecars:scan-only-mbid",
  ]);
});

test("ArtistPipelineService for unmonitored artist stops after metadata refresh", async () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, content_hash) VALUES
      ('unmonitored-mbid', 'Unmonitored Artist', NULL)
  `).run();

  const executionOrder: string[] = [];

  const originalRefresh = refreshServiceModule.RefreshArtistService.refreshArtist;
  const originalMatch = refreshServiceModule.RefreshArtistService.matchArtistProviders;

  (refreshServiceModule.RefreshArtistService as any).refreshArtist = async (artistId: string) => {
    executionOrder.push(`1:refresh:${artistId}`);
    return {
      artistMbid: artistId,
      shouldHydrateCatalog: true,
      metadataChanged: false,
      isNewArtist: true,
      creditedArtistMbids: [],
    };
  };

  (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = async (artistId: string) => {
    executionOrder.push(`2:match:${artistId}`);
  };

  try {
    await pipelineModule.ArtistPipelineService.executePipeline({
      artistId: "unmonitored-mbid",
      artistName: "Unmonitored Artist",
      workflow: "metadata-refresh",
    });
  } finally {
    (refreshServiceModule.RefreshArtistService as any).refreshArtist = originalRefresh;
    (refreshServiceModule.RefreshArtistService as any).matchArtistProviders = originalMatch;
  }

  assert.deepEqual(executionOrder, [
    "1:refresh:unmonitored-mbid",
  ]);
});
