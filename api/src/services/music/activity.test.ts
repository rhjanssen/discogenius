import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-activity-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.activity.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let commandHistoryModule: typeof import("../jobs/command-history.js");
let queueModule: typeof import("../jobs/queue.js");
let historyEventsModule: typeof import("../jobs/history-events.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("../jobs/queue.js");
    commandHistoryModule = await import("../jobs/command-history.js");
    historyEventsModule = await import("../jobs/history-events.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
    dbModule.db.prepare("DELETE FROM history_events").run();
    for (const table of ["ProviderItems", "Tracks", "Recordings", "AlbumReleases", "Albums", "ArtistMetadata", "Artists"]) {
        dbModule.db.prepare(`DELETE FROM ${table}`).run();
    }
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("activity page supports pagination and category/status filters", () => {
    const refreshAlbumId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.RefreshAlbum,
        { albumId: "album-1" },
        "album-1",
    );
    const applyCurationId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ApplyCuration,
        { expectedArtists: 1 },
    );
    const refreshMetadataId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.RefreshMetadata,
        { target: "library" },
    );
    const healthCheckId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.CheckHealth,
        {},
    );
    const downloadTrackId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadTrack,
        { providerId: "t1", url: "https://listen.tidal.com/track/t1", type: "track" },
        "t1",
    );

    queueModule.TaskQueueService.markProcessing(refreshMetadataId);
    queueModule.TaskQueueService.complete(healthCheckId);

    const defaultPage = commandHistoryModule.getActivityPage({ limit: 100, offset: 0 });
    assert.equal(defaultPage.total, 5);
    assert.equal(defaultPage.items.some((item) => item.id === downloadTrackId), true);

    const pendingScans = commandHistoryModule.getActivityPage({
        statuses: ["pending"],
        categories: ["scans"],
        limit: 10,
        offset: 0,
    });
    assert.equal(pendingScans.total, 2);
    assert.deepEqual(
        pendingScans.items.map((item) => item.id),
        [refreshAlbumId, applyCurationId],
    );
    assert.deepEqual(
        pendingScans.items.map((item) => item.queuePosition),
        [1, 2],
    );

    const pendingScansPage2 = commandHistoryModule.getActivityPage({
        statuses: ["pending"],
        categories: ["scans"],
        limit: 1,
        offset: 1,
    });
    assert.equal(pendingScansPage2.total, 2);
    assert.equal(pendingScansPage2.items.length, 1);
    assert.equal(pendingScansPage2.items[0]?.id, applyCurationId);
    assert.equal(pendingScansPage2.items[0]?.queuePosition, 2);

    const pendingDownloads = commandHistoryModule.getActivityPage({
        statuses: ["pending"],
        categories: ["downloads"],
        limit: 10,
        offset: 0,
    });
    assert.equal(pendingDownloads.total, 1);
    assert.equal(pendingDownloads.items[0]?.id, downloadTrackId);
    assert.equal(pendingDownloads.items[0]?.queuePosition, 1);
});

test("activity summary returns command-surface counts without download queue duplication", () => {
    queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "album-2" }, "album-2");

    const metadataId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshMetadata, { target: "all" });
    queueModule.TaskQueueService.markProcessing(metadataId);

    const healthId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.CheckHealth, {});
    queueModule.TaskQueueService.fail(healthId, "failed health check");

    queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadTrack,
        { providerId: "t2", url: "https://listen.tidal.com/track/t2", type: "track" },
        "t2",
    );

    const summary = commandHistoryModule.getActivitySummary();
    assert.deepEqual(summary, {
        pending: 2,
        processing: 1,
        history: 1,
    });
});

test("activity page computes absolute pending queue positions without scanning the full page set", () => {
    queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "qp-1" }, "qp-1");
    queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "qp-2" }, "qp-2");
    const pendingThirdId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "qp-3" }, "qp-3");
    const completedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.CheckHealth, {});
    queueModule.TaskQueueService.complete(completedId);

    const mixedPage = commandHistoryModule.getActivityPage({
        statuses: ["pending", "completed"],
        categories: ["scans", "other"],
        limit: 2,
        offset: 0,
    });

    assert.equal(mixedPage.total, 4);
    assert.equal(mixedPage.items.length, 2);
    assert.equal(mixedPage.items[0]?.id, completedId);
    assert.equal(mixedPage.items[0]?.queuePosition, undefined);
    assert.equal(mixedPage.items[1]?.id, pendingThirdId);
    assert.equal(mixedPage.items[1]?.status, "pending");
    assert.equal(mixedPage.items[1]?.queuePosition, 3);
});

test("activity page prioritizes processing downloads ahead of newer pending downloads", () => {
    const processingId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadVideo,
        { providerId: "video-processing", url: "https://listen.tidal.com/video/video-processing", type: "video" },
        "video-processing",
    );
    queueModule.TaskQueueService.markProcessing(processingId);

    const pendingOneId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadVideo,
        { providerId: "video-pending-1", url: "https://listen.tidal.com/video/video-pending-1", type: "video" },
        "video-pending-1",
    );
    const pendingTwoId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadVideo,
        { providerId: "video-pending-2", url: "https://listen.tidal.com/video/video-pending-2", type: "video" },
        "video-pending-2",
    );

    dbModule.db.prepare("UPDATE job_queue SET created_at = ?, started_at = ?, updated_at = ? WHERE id = ?")
        .run("2024-04-01 08:00:00", "2024-04-01 08:01:00", "2024-04-01 08:03:00", processingId);
    dbModule.db.prepare("UPDATE job_queue SET created_at = ?, updated_at = ? WHERE id = ?")
        .run("2024-04-01 08:04:00", "2024-04-01 08:04:00", pendingOneId);
    dbModule.db.prepare("UPDATE job_queue SET created_at = ?, updated_at = ? WHERE id = ?")
        .run("2024-04-01 08:05:00", "2024-04-01 08:05:00", pendingTwoId);

    const page = commandHistoryModule.getActivityPage({
        statuses: ["pending", "processing"],
        categories: ["downloads"],
        limit: 2,
        offset: 0,
    });

    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map((item) => item.id), [processingId, pendingOneId]);
    assert.equal(page.items[0]?.status, "running");
    assert.equal(page.items[1]?.queuePosition, 1);
});

test("activity descriptions resolve download jobs from canonical provider items without legacy provider rows", () => {
    dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
        .run("artist-local", "Canonical Artist", "artist-mbid", 1);
    dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-mbid", "Canonical Artist");
    dbModule.db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
        VALUES (?, ?, ?, ?)
    `).run("release-group-mbid", "artist-mbid", "Canonical Album", "album");
    dbModule.db.prepare(`
        INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run("release-mbid", "release-group-mbid", "artist-mbid", "Canonical Album", 1, 1);
    dbModule.db.prepare(`
        INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
        "recording-mbid",
        "Canonical Track",
        "artist-mbid",
        0,
        "video-recording-mbid",
        "Canonical Video",
        "artist-mbid",
        1,
    );
    dbModule.db.prepare(`
        INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run("track-mbid", "release-mbid", "recording-mbid", "Canonical Track", 1, 1);
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid, release_group_mbid,
            release_mbid, track_mbid, recording_mbid, title, library_slot,
            match_status, match_confidence, match_method
        ) VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal", "album", "provider-album", "artist-mbid", "release-group-mbid",
        "release-mbid", null, null, "Canonical Album", "stereo", "verified", 1, "test",
        "tidal", "track", "provider-track", "artist-mbid", "release-group-mbid",
        "release-mbid", "track-mbid", "recording-mbid", "Canonical Track", "stereo", "verified", 1, "test",
        "tidal", "video", "provider-video", "artist-mbid", null,
        null, null, "video-recording-mbid", "Canonical Video", "video", "verified", 1, "test",
    );

    const albumJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadAlbum,
        { providerId: "provider-album" },
        "provider-album",
    );
    const trackJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadTrack,
        { providerId: "provider-track" },
        "provider-track",
    );
    const videoJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadVideo,
        { providerId: "provider-video" },
        "provider-video",
    );

    const page = commandHistoryModule.getActivityPage({
        statuses: ["pending"],
        categories: ["downloads"],
        limit: 10,
        offset: 0,
    });

    const descriptionById = new Map(page.items.map((item) => [item.id, item.description]));
    assert.equal(descriptionById.get(albumJobId), "Canonical Album by Canonical Artist");
    assert.equal(descriptionById.get(trackJobId), "Canonical Track on Canonical Album by Canonical Artist");
    assert.equal(descriptionById.get(videoJobId), "Canonical Video by Canonical Artist");
});

test("activity events page merges task and history events with deterministic newest-first ordering", () => {
    const pendingId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "events-album" }, "events-album");
    const completedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.CheckHealth, {});
    queueModule.TaskQueueService.complete(completedId);

    const historyImportedId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.TrackFileImported,
        sourceTitle: "Imported item",
    });
    const historyFailedId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.DownloadFailed,
        sourceTitle: "Failed item",
    });

    dbModule.db.prepare("UPDATE job_queue SET created_at = ? WHERE id = ?").run("2024-02-01 08:00:00", pendingId);
    dbModule.db.prepare("UPDATE job_queue SET created_at = ?, started_at = ?, completed_at = ? WHERE id = ?")
        .run("2024-02-02 08:00:00", "2024-02-02 08:01:00", "2024-02-02 08:02:00", completedId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-02-03 08:00:00", historyImportedId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-02-04 08:00:00", historyFailedId);

    const page = commandHistoryModule.getActivityEventsPage({ limit: 10, offset: 0 });
    assert.equal(page.total, 4);
    assert.equal(page.items.length, 4);
    assert.deepEqual(page.items.map((item) => item.id), [
        `history:${historyFailedId}`,
        `history:${historyImportedId}`,
        `task:${completedId}`,
        `task:${pendingId}`,
    ]);
    assert.equal(page.items[0]?.level, "error");
    assert.equal(page.items[1]?.level, "info");
    assert.equal(page.items[2]?.source, "task");
    assert.equal(page.items[3]?.source, "task");
    assert.equal(page.hasMore, false);
});

test("activity events page pagination returns limit/offset/hasMore consistently", () => {
    const taskId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAlbum, { albumId: "events-pagination" }, "events-pagination");
    const historyOneId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.TrackFileImported,
        sourceTitle: "Imported A",
    });
    const historyTwoId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.TrackFileImported,
        sourceTitle: "Imported B",
    });

    dbModule.db.prepare("UPDATE job_queue SET created_at = ? WHERE id = ?").run("2024-03-01 08:00:00", taskId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-03-02 08:00:00", historyOneId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-03-03 08:00:00", historyTwoId);

    const firstPage = commandHistoryModule.getActivityEventsPage({ limit: 2, offset: 0 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.limit, 2);
    assert.equal(firstPage.offset, 0);
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(firstPage.items.map((item) => item.id), [
        `history:${historyTwoId}`,
        `history:${historyOneId}`,
    ]);

    const secondPage = commandHistoryModule.getActivityEventsPage({ limit: 2, offset: 2 });
    assert.equal(secondPage.total, 3);
    assert.equal(secondPage.limit, 2);
    assert.equal(secondPage.offset, 2);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.items[0]?.id, `task:${taskId}`);
});
