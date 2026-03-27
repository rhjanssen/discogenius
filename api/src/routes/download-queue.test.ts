import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-queue-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.download-queue.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("../services/queue.js");
let downloadQueueRouteModule: typeof import("./download-queue.js");

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("../services/queue.js");
    downloadQueueRouteModule = await import("./download-queue.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
    dbModule.db.prepare("DELETE FROM playlists").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("mapDownloadQueueJob preserves playlist type for playlist download and import jobs", () => {
    const downloadPlaylistId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadPlaylist,
        {
            tidalId: "playlist-download-1",
            type: "playlist",
            playlistName: "Download playlist",
            url: "https://listen.tidal.com/playlist/playlist-download-1",
        },
        "playlist-download-1",
    );

    const importPlaylistId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ImportDownload,
        {
            tidalId: "playlist-import-1",
            type: "playlist",
            title: "Imported playlist",
            path: "E:/tmp/downloads/playlist-import-1",
            originalJobId: downloadPlaylistId,
        },
        "playlist-import-1",
    );

    const downloadPlaylistJob = queueModule.TaskQueueService.getById(downloadPlaylistId);
    const importPlaylistJob = queueModule.TaskQueueService.getById(importPlaylistId);

    assert.ok(downloadPlaylistJob);
    assert.ok(importPlaylistJob);

    const mappedDownloadPlaylist = downloadQueueRouteModule.mapDownloadQueueJob(downloadPlaylistJob);
    const mappedImportPlaylist = downloadQueueRouteModule.mapDownloadQueueJob(importPlaylistJob);

    assert.equal(mappedDownloadPlaylist.type, "playlist");
    assert.equal(mappedDownloadPlaylist.stage, "download");
    assert.equal(mappedImportPlaylist.type, "playlist");
    assert.equal(mappedImportPlaylist.stage, "import");
});