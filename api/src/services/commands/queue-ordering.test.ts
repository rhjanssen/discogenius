import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-queue-order-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.queue-order.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue.js");
let downloadQueueQueryModule: typeof import("../download/download-queue-query-service.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue.js");
    downloadQueueQueryModule = await import("../download/download-queue-query-service.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM commands").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();
    dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
    dbModule.db.prepare("DELETE FROM Tracks").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM AlbumReleases").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function queuePendingDownload(type: "track" | "video" | "album", providerId: string) {
    const jobType = type === "video"
        ? queueModule.CommandNames.DownloadVideo
        : type === "album"
            ? queueModule.CommandNames.DownloadAlbum
            : queueModule.CommandNames.DownloadTrack;

    return queueModule.CommandQueueService.addJob(
        jobType,
        { providerId, type, url: `https://listen.tidal.com/${type}/${providerId}` },
        providerId,
    );
}

test("reorderPendingJobs preserves explicit move order deterministically", () => {
    const first = queuePendingDownload("track", "1");
    const second = queuePendingDownload("track", "2");
    const third = queuePendingDownload("track", "3");

    const changed = queueModule.CommandQueueService.reorderPendingJobs([third, first], {
        beforeJobId: second,
        types: queueModule.DOWNLOAD_COMMAND_NAMES,
    });
    assert.equal(changed, 3);

    const pending = queueModule.CommandQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        10,
        0,
        { orderBy: "execution" },
    );

    assert.deepEqual(
        pending.map((job) => job.id),
        [third, first, second],
    );
});

test("reorderPendingJobs rejects invalid reorder sets", () => {
    const first = queuePendingDownload("track", "11");
    const second = queuePendingDownload("track", "12");

    assert.throws(
        () => queueModule.CommandQueueService.reorderPendingJobs([first, first], { beforeJobId: second }),
        /duplicate queue item ids/i,
    );

    const completed = queuePendingDownload("track", "13");
    queueModule.CommandQueueService.complete(completed);

    assert.throws(
        () => queueModule.CommandQueueService.reorderPendingJobs([completed], { beforeJobId: second }),
        /Only pending download queue items can be reordered/i,
    );

    assert.throws(
        () => queueModule.CommandQueueService.reorderPendingJobs([first], { beforeJobId: first }),
        /anchor must be a different pending queue item/i,
    );

    assert.throws(
        () => queueModule.CommandQueueService.reorderPendingJobs([first], {}),
        /requires exactly one anchor/i,
    );
});

test("import jobs inherit durable queue order and live queue listing stays stable across transitions", () => {
    const first = queuePendingDownload("track", "21");
    const second = queuePendingDownload("track", "22");
    const third = queuePendingDownload("track", "23");

    queueModule.CommandQueueService.markProcessing(first);
    queueModule.CommandQueueService.markProcessing(second);

    const originalJob = queueModule.CommandQueueService.getById(first);
    const secondJob = queueModule.CommandQueueService.getById(second);
    const thirdJob = queueModule.CommandQueueService.getById(third);
    assert.ok(originalJob);
    assert.ok(secondJob);
    assert.ok(thirdJob);

    const importJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.ImportDownload,
        {
            type: "track",
            providerId: "21",
            path: "E:/tmp/downloads/job_21",
            originalJobId: first,
        },
        "21",
        100,
        0,
        originalJob?.queue_order,
    );

    queueModule.CommandQueueService.complete(first);

    const importJob = queueModule.CommandQueueService.getById(importJobId);
    assert.ok(importJob);
    assert.equal(importJob?.queue_order, originalJob?.queue_order);

    const liveJobs = queueModule.CommandQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
        ["queued", "started"],
        10,
        0,
        { orderBy: "queue_order" },
    );

    assert.deepEqual(
        liveJobs.map((job) => ({ id: job.id, type: job.name, status: job.status, queueOrder: job.queue_order })),
        [
            {
                id: importJobId,
                type: queueModule.CommandNames.ImportDownload,
                status: "queued",
                queueOrder: originalJob?.queue_order,
            },
            {
                id: second,
                type: queueModule.CommandNames.DownloadTrack,
                status: "started",
                queueOrder: secondJob?.queue_order,
            },
            {
                id: third,
                type: queueModule.CommandNames.DownloadTrack,
                status: "queued",
                queueOrder: thirdJob?.queue_order,
            },
        ],
    );
});

test("download queue query surfaces pending, processing, and history items with payload metadata", () => {
    const processingAlbumId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            releaseGroupMbid: "release-group-1",
            slot: "stereo",
            title: "Processing Album",
            artist: "Queue Artist",
            cover: "processing-cover",
            quality: "HIRES_LOSSLESS",
            downloadState: { progress: 42, currentFileNum: 2, totalFiles: 5 },
        },
        "release-group-1:stereo",
    );
    const pendingAlbumId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            releaseGroupMbid: "release-group-2",
            slot: "spatial",
            title: "Pending Album",
            artist: "Queue Artist",
            cover: "pending-cover",
            quality: "DOLBY_ATMOS",
        },
        "release-group-2:spatial",
    );
    const completedTrackId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadTrack,
        {
            type: "track",
            provider: "tidal",
            title: "Completed Track",
            artist: "Queue Artist",
            cover: "track-cover",
            quality: "LOSSLESS",
        },
        "provider-track-1",
    );

    queueModule.CommandQueueService.markProcessing(processingAlbumId);
    queueModule.CommandQueueService.complete(completedTrackId);

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 2);
    assert.deepEqual(live.items.map((item) => item.id), [processingAlbumId, pendingAlbumId]);
    assert.equal(live.items[0]?.title, "Processing Album");
    assert.equal(live.items[0]?.progress, 42);
    assert.equal(live.items[0]?.currentFileNum, 2);
    assert.equal(live.items[0]?.totalFiles, 5);
    assert.equal(live.items[0]?.slot, "stereo");
    assert.equal(live.items[1]?.queuePosition, 1);
    assert.equal(live.items[1]?.quality, "DOLBY_ATMOS");
    assert.equal(live.items[1]?.slot, "spatial");

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({});
    assert.deepEqual(details.map((item) => item.id), [processingAlbumId, pendingAlbumId]);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });
    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, completedTrackId);
    assert.equal(history.items[0]?.title, "Completed Track");
    assert.equal(history.items[0]?.type, "track");
});

test("download queue query resolves canonical release-group provider offers without legacy provider catalog rows", () => {
    const { db } = dbModule;
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-bastille", "Bastille");
    db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
        VALUES (?, ?, ?, ?, ?)
    `).run("rg-gmtf", "artist-bastille", "Give Me the Future", "album", "2022-02-04");
    db.prepare(`
        INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run("release-gmtf", "rg-gmtf", "artist-bastille", "Give Me the Future", 13, 1);
    db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            title, quality, asset_id, match_status, match_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "album",
        "tidal-gmtf-expanded",
        "artist-bastille",
        "rg-gmtf",
        "release-gmtf",
        "Give Me The Future + Dreams Of The Past",
        "HIRES_LOSSLESS",
        "provider-cover",
        "probable",
        0.9,
    );
    db.prepare(`
        INSERT INTO ReleaseGroupSlots (
            artist_mbid, release_group_mbid, slot, monitored,
            selected_provider, selected_provider_id, selected_release_mbid, quality,
            match_status, match_confidence, provider_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "artist-bastille",
        "rg-gmtf",
        "stereo",
        1,
        "tidal",
        "tidal-gmtf-expanded",
        "release-gmtf",
        "HIRES_LOSSLESS",
        "probable",
        0.9,
        JSON.stringify({
            title: "Give Me The Future + Dreams Of The Past",
            cover: "provider-cover",
            quality: "HIRES_LOSSLESS",
            artist: { name: "Bastille" },
        }),
    );

    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "tidal-gmtf-expanded",
            releaseGroupMbid: "rg-gmtf",
            slot: "stereo",
        },
        "rg-gmtf:stereo",
    );

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 1);
    assert.equal(live.items[0]?.id, jobId);
    assert.equal(live.items[0]?.title, "Give Me the Future");
    assert.equal(live.items[0]?.artist, "Bastille");
    assert.equal(live.items[0]?.album_id, "rg-gmtf");
    assert.equal(live.items[0]?.album_title, "Give Me the Future");
    assert.equal(live.items[0]?.quality, "HIRES_LOSSLESS");
    assert.equal(live.items[0]?.cover, "provider-cover");

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({
        artistId: "artist-bastille",
        albumIds: ["rg-gmtf"],
        providerIds: ["tidal-gmtf-expanded"],
    });
    assert.deepEqual(details.map((item) => item.id), [jobId]);
});

test("download queue query resolves canonical track provider offers without ProviderMedia rows", () => {
    const { db } = dbModule;
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-track", "Track Artist");
    db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
        VALUES (?, ?, ?, ?, ?)
    `).run("rg-track", "artist-track", "Canonical Album", "album", "2024-01-01");
    db.prepare(`
        INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run("release-track", "rg-track", "artist-track", "Canonical Album", 1, 1);
    db.prepare("INSERT INTO Recordings (mbid, title) VALUES (?, ?)")
        .run("recording-track", "Canonical Recording");
    db.prepare(`
        INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run("track-mbid-1", "release-track", "recording-track", "Canonical Track", 1, 1);
    db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            track_mbid, recording_mbid, title, version, quality, asset_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "track",
        "tidal-track-1",
        "artist-track",
        "rg-track",
        "release-track",
        "track-mbid-1",
        "recording-track",
        "Canonical Track",
        "Dolby Atmos",
        "DOLBY_ATMOS",
        "track-cover",
    );

    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadTrack,
        {
            type: "track",
            provider: "tidal",
            providerId: "tidal-track-1",
        },
        "tidal-track-1",
    );

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 1);
    assert.equal(live.items[0]?.id, jobId);
    assert.equal(live.items[0]?.title, "Canonical Track");
    assert.equal(live.items[0]?.artist, "Track Artist");
    assert.equal(live.items[0]?.album_id, "rg-track");
    assert.equal(live.items[0]?.album_title, "Canonical Album");
    assert.equal(live.items[0]?.quality, "DOLBY_ATMOS");
    assert.equal(live.items[0]?.cover, "track-cover");

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({
        artistId: "artist-track",
        albumIds: ["rg-track"],
        providerIds: ["tidal-track-1"],
    });
    assert.deepEqual(details.map((item) => item.id), [jobId]);
});

test("download queue history collapses completed download and import jobs into one logical item", () => {
    const downloadJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-history",
            releaseGroupMbid: "release-group-history",
            slot: "stereo",
            title: "Imported Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
        },
        "release-group-history:stereo",
    );
    queueModule.CommandQueueService.complete(downloadJobId);

    const importJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.ImportDownload,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-history",
            releaseGroupMbid: "release-group-history",
            slot: "stereo",
            title: "Imported Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
            path: path.join(tempDir, "download-provider-album-history"),
            originalJobId: downloadJobId,
        },
        "provider-album-history",
    );
    queueModule.CommandQueueService.complete(importJobId);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, importJobId);
    assert.equal(history.items[0]?.stage, "import");
    assert.equal(history.items[0]?.title, "Imported Album");
    assert.equal(history.items[0]?.type, "album");
});

test("download queue history keeps completed album visible during import handoff", () => {
    const downloadJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-handoff",
            releaseGroupMbid: "release-group-handoff",
            slot: "stereo",
            title: "Handoff Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
        },
        "release-group-handoff:stereo",
    );
    queueModule.CommandQueueService.complete(downloadJobId);

    const importJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.ImportDownload,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-handoff",
            releaseGroupMbid: "release-group-handoff",
            slot: "stereo",
            title: "Handoff Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
            path: path.join(tempDir, "download-provider-album-handoff"),
            originalJobId: downloadJobId,
        },
        "provider-album-handoff",
    );
    queueModule.CommandQueueService.markProcessing(importJobId);

    const historyDuringImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(historyDuringImport.total, 1);
    assert.equal(historyDuringImport.items[0]?.id, downloadJobId);
    assert.equal(historyDuringImport.items[0]?.stage, "download");
    assert.equal(historyDuringImport.items[0]?.title, "Handoff Album");

    queueModule.CommandQueueService.complete(importJobId);

    const historyAfterImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(historyAfterImport.total, 1);
    assert.equal(historyAfterImport.items[0]?.id, importJobId);
    assert.equal(historyAfterImport.items[0]?.stage, "import");
    assert.equal(historyAfterImport.items[0]?.title, "Handoff Album");
});

test("terminal queue jobs ignore late progress, state, complete, and fail updates", () => {
    const jobId = queuePendingDownload("track", "99");
    queueModule.CommandQueueService.markProcessing(jobId);
    queueModule.CommandQueueService.updateState(jobId, {
        progress: 45,
        payloadPatch: { downloadState: { state: "downloading", statusMessage: "Downloading track" } },
    });
    queueModule.CommandQueueService.cancel(jobId);

    queueModule.CommandQueueService.updateProgress(jobId, 88);
    queueModule.CommandQueueService.updateState(jobId, {
        progress: 90,
        payloadPatch: { downloadState: { state: "importing", statusMessage: "Late import state" } },
    });
    queueModule.CommandQueueService.complete(jobId);
    queueModule.CommandQueueService.fail(jobId, "Late failure");

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
    assert.equal(job.progress, 45);
    assert.equal(job.error ?? null, null);
    assert.equal(job.payload.downloadState?.state, "downloading");
    assert.equal(job.payload.downloadState?.statusMessage, "Downloading track");
});

test("terminal queue jobs cannot be resurrected as processing", () => {
    const jobId = queuePendingDownload("track", "100");
    queueModule.CommandQueueService.cancel(jobId);

    const marked = queueModule.CommandQueueService.markProcessing(jobId);

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.equal(marked, false);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
});

test("manual retry resets attempts so max-attempt jobs can run again", () => {
    const jobId = queuePendingDownload("track", "101");

    queueModule.CommandQueueService.fail(jobId, "first failure");
    queueModule.CommandQueueService.retry(jobId);

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(job.progress, 0);
    assert.equal(job.error ?? null, null);
});

test("active import blocks duplicate download for the same content id", () => {
    const importJobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.ImportDownload,
        {
            type: "track",
            providerId: "102",
            path: path.join(tempDir, "download-102"),
            originalJobId: 1,
        },
        "102",
    );

    const duplicateDownloadId = queuePendingDownload("track", "102");
    const pendingDownloads = queueModule.CommandQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued", "started"],
    );

    assert.equal(duplicateDownloadId, importJobId);
    assert.equal(pendingDownloads.length, 0);
});
