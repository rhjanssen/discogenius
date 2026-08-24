import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import { Worker } from "node:worker_threads";
import {
    seedAcceptedProviderReleaseMatch,
    seedAcceptedProviderTrackMatch,
    seedProviderAudioVariant,
} from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-queue-order-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.queue-order.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let downloadQueueQueryModule: typeof import("../download/download-queue-query-service.js");
let waitQueueModule: typeof import("../download/download-wait-queue.js");
const require = createRequire(import.meta.url);
const betterSqlite3ModulePath = require.resolve("better-sqlite3");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue-manager.js");
    downloadQueueQueryModule = await import("../download/download-queue-query-service.js");
    waitQueueModule = await import("../download/download-wait-queue.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM DownloadQueue").run();
    dbModule.db.prepare("DELETE FROM commands").run();
    dbModule.db.prepare("DELETE FROM ProviderVideoMatches").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();
    dbModule.db.prepare("DELETE FROM Tracks").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM AlbumEditions").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM LibraryArtists").run();
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

    return queueModule.CommandQueueManager.push(
        jobType,
        { providerId, type, url: `https://listen.tidal.com/${type}/${providerId}` },
        providerId,
    );
}

function enqueueLive(input: {
    mediaKind: "album" | "track" | "video";
    refKey: string;
    payload: Record<string, unknown>;
    provider?: string;
    providerId?: string | null;
    artistId?: string | null;
    albumId?: string | null;
    title?: string | null;
    artist?: string | null;
    cover?: string | null;
    quality?: string | null;
    slot?: string | null;
}) {
    const commandName = input.mediaKind === "video"
        ? queueModule.CommandNames.DownloadVideo
        : input.mediaKind === "album"
            ? queueModule.CommandNames.DownloadAlbum
            : queueModule.CommandNames.DownloadTrack;
    return waitQueueModule.DownloadWaitQueue.enqueue({
        refKey: input.refKey,
        mediaKind: input.mediaKind,
        commandName,
        provider: input.provider ?? "tidal",
        providerId: input.providerId ?? null,
        artistId: input.artistId ?? null,
        albumId: input.albumId ?? null,
        title: input.title ?? null,
        artist: input.artist ?? null,
        cover: input.cover ?? null,
        quality: input.quality ?? null,
        slot: input.slot ?? null,
        payload: input.payload,
    });
}

async function runWhilePeerWriteIsLocked<T>(
    sql: string,
    params: unknown[],
    operation: () => T,
): Promise<T> {
    const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const Database = require(workerData.modulePath);
        const database = new Database(workerData.dbPath);
        database.pragma("busy_timeout = 5000");
        database.exec("BEGIN IMMEDIATE");
        database.prepare(workerData.sql).run(...workerData.params);
        parentPort.postMessage("locked");
        setTimeout(() => {
            database.exec("COMMIT");
            database.close();
            parentPort.postMessage("committed");
        }, 100);
    `, {
        eval: true,
        workerData: {
            modulePath: betterSqlite3ModulePath,
            dbPath: process.env.DB_PATH,
            sql,
            params,
        },
    });

    const workerExit = new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Concurrent SQLite worker exited with code ${code}`));
        });
    });
    await new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.on("message", (message) => {
            if (message === "locked") resolve();
        });
    });

    let result: T;
    try {
        result = operation();
    } finally {
        await workerExit;
    }
    return result;
}

test("reorderPendingJobs preserves explicit move order deterministically", () => {
    const first = queuePendingDownload("track", "1");
    const second = queuePendingDownload("track", "2");
    const third = queuePendingDownload("track", "3");

    const changed = queueModule.CommandQueueManager.reorderPendingJobs([third, first], {
        beforeJobId: second,
        types: queueModule.DOWNLOAD_COMMAND_NAMES,
    });
    assert.equal(changed, 2);

    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
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

test("reorderPendingJobs makes a cross-priority move the effective execution order", () => {
    const highPriority = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "priority-100", type: "track" },
        "priority-100",
        100,
        1,
    );
    const background = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "priority-0", type: "track" },
        "priority-0",
        0,
        0,
    );

    assert.equal(queueModule.CommandQueueManager.getNextJobByTypes(queueModule.DOWNLOAD_COMMAND_NAMES)?.id, highPriority);

    queueModule.CommandQueueManager.reorderPendingJobs([highPriority], {
        afterJobId: background,
        types: queueModule.DOWNLOAD_COMMAND_NAMES,
    });

    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        10,
        0,
        { orderBy: "execution" },
    );
    assert.deepEqual(pending.map((job) => job.id), [background, highPriority]);
    assert.equal(queueModule.CommandQueueManager.getNextJobByTypes(queueModule.DOWNLOAD_COMMAND_NAMES)?.id, background);
    assert.equal(queueModule.CommandQueueManager.get(highPriority)?.priority, 100);
    assert.equal(queueModule.CommandQueueManager.get(highPriority)?.trigger, 1);
});

test("download enqueue precedence is priority, then Manual, Scheduled, and Unspecified", () => {
    const scheduled = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "scheduled", type: "track" },
        "scheduled",
        0,
        2,
    );
    const manual = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "manual", type: "track" },
        "manual",
        0,
        1,
    );
    const unspecified = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "unspecified", type: "track" },
        "unspecified",
        0,
        0,
    );
    const workflowHandoff = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadTrack,
        { providerId: "workflow", type: "track" },
        "workflow",
        25,
        0,
    );

    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        10,
        0,
        { orderBy: "execution" },
    );
    assert.deepEqual(
        pending.map((job) => job.id),
        [workflowHandoff, manual, scheduled, unspecified],
    );
    assert.deepEqual(
        new Set(pending.map((job) => job.queue_order)).size,
        pending.length,
    );
    assert.ok(pending.every((job) => Number.isFinite(job.queue_order)));
});

test("large same-priority handoff bursts retain precedence without duplicate ranks", () => {
    const background = queuePendingDownload("track", "handoff-background");
    const handoffs = Array.from({ length: 200 }, (_, index) => (
        queueModule.CommandQueueManager.push(
            queueModule.CommandNames.DownloadTrack,
            { providerId: `handoff-${index}`, type: "track" },
            `handoff-${index}`,
            25,
            0,
        )
    ));

    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        250,
        0,
        { orderBy: "execution" },
    );
    assert.deepEqual(pending.slice(0, 200).map((job) => job.id), handoffs);
    assert.equal(pending.at(-1)?.id, background);
    assert.equal(new Set(pending.map((job) => job.queue_order)).size, pending.length);
});

test("authoritative top and bottom moves do not need a client-loaded anchor", () => {
    const ids = Array.from({ length: 100 }, (_, index) => (
        queuePendingDownload("track", `edge-${index}`)
    ));

    assert.equal(
        queueModule.CommandQueueManager.reorderPendingJobs([ids[0]], {
            position: "bottom",
            types: queueModule.DOWNLOAD_COMMAND_NAMES,
        }),
        1,
    );
    let pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        200,
        0,
        { orderBy: "execution" },
    );
    assert.equal(pending.at(-1)?.id, ids[0]);

    assert.equal(
        queueModule.CommandQueueManager.reorderPendingJobs([ids[0]], {
            position: "top",
            types: queueModule.DOWNLOAD_COMMAND_NAMES,
        }),
        1,
    );
    pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        200,
        0,
        { orderBy: "execution" },
    );
    assert.equal(pending[0]?.id, ids[0]);
    assert.equal(
        new Set(pending.map((job) => job.queue_order)).size,
        pending.length,
    );
});

test("active ranks stay reserved and a failed download retry receives a live-safe rank", () => {
    const failed = queuePendingDownload("track", "rank-failed");
    assert.equal(queueModule.CommandQueueManager.markProcessing(failed), true);
    assert.equal(queueModule.CommandQueueManager.fail(failed, "synthetic failure"), true);

    const queued = queuePendingDownload("track", "rank-queued");
    assert.equal(
        queueModule.CommandQueueManager.get(failed)?.queue_order,
        queueModule.CommandQueueManager.get(queued)?.queue_order,
        "a terminal row may retain a historical rank that a live row reuses",
    );

    assert.doesNotThrow(() => queueModule.CommandQueueManager.retry(failed));
    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        10,
        0,
        { orderBy: "execution" },
    );
    assert.deepEqual(pending.map((job) => job.id), [queued, failed]);
    assert.equal(new Set(pending.map((job) => job.queue_order)).size, 2);

    assert.equal(queueModule.CommandQueueManager.markProcessing(queued), true);
    const next = queuePendingDownload("track", "rank-after-active");
    assert.notEqual(
        queueModule.CommandQueueManager.get(queued)?.queue_order,
        queueModule.CommandQueueManager.get(next)?.queue_order,
    );
});

test("reorder serializes behind a concurrent enqueue and resolves the authoritative bottom", async () => {
    const first = queuePendingDownload("track", "race-first");
    const second = queuePendingDownload("track", "race-second");
    const third = queuePendingDownload("track", "race-third");

    await runWhilePeerWriteIsLocked(
        `
            INSERT INTO commands(
                name, ref_id, payload, priority, trigger, queue_order,
                status, created_at, updated_at
            )
            VALUES(
                'DownloadTrack', 'race-concurrent',
                '{"providerId":"race-concurrent","type":"track"}',
                0, 0, 999999, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `,
        [],
        () => queueModule.CommandQueueManager.reorderPendingJobs([first], {
            position: "bottom",
            types: queueModule.DOWNLOAD_COMMAND_NAMES,
        }),
    );

    const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued"],
        10,
        0,
        { orderBy: "execution" },
    );
    assert.deepEqual(
        pending.map((job) => job.ref_id),
        ["race-second", "race-third", "race-concurrent", "race-first"],
    );
    assert.equal(
        new Set(pending.map((job) => job.queue_order)).size,
        pending.length,
    );
    assert.equal(queueModule.CommandQueueManager.getNextJobByTypes(queueModule.DOWNLOAD_COMMAND_NAMES)?.id, second);
    assert.notEqual(third, first);
});

test("reorder fails closed when a concurrent claim takes its anchor", async () => {
    const moving = queuePendingDownload("track", "race-moving");
    const anchor = queuePendingDownload("track", "race-anchor");
    const originalMovingRank = queueModule.CommandQueueManager.get(moving)?.queue_order;

    await assert.rejects(
        () => runWhilePeerWriteIsLocked(
            "UPDATE commands SET status = 'started', started_at = CURRENT_TIMESTAMP WHERE id = ?",
            [anchor],
            () => queueModule.CommandQueueManager.reorderPendingJobs([moving], {
                beforeJobId: anchor,
                types: queueModule.DOWNLOAD_COMMAND_NAMES,
            }),
        ),
        /anchor is not in the pending download queue/i,
    );

    assert.equal(queueModule.CommandQueueManager.get(anchor)?.status, "started");
    assert.equal(queueModule.CommandQueueManager.get(moving)?.queue_order, originalMovingRank);
});

test("provider artist imports reuse an active equivalent source selection", () => {
    const first = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportProviderArtists,
        {
            providerId: "tidal",
            importCategory: "followed-artists",
            importLabel: "Followed artists",
        },
    );
    const duplicateWithDifferentLabel = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportProviderArtists,
        {
            providerId: "tidal",
            importCategory: "followed-artists",
            importLabel: "followed artists",
        },
    );
    const differentSource = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportProviderArtists,
        {
            providerId: "tidal",
            importCategory: "playlist",
            importListId: "playlist-1",
            importLabel: "Playlist 1",
        },
    );

    assert.equal(duplicateWithDifferentLabel, first);
    assert.notEqual(differentSource, first);
    const row = dbModule.db.prepare("SELECT COUNT(*) as count FROM commands WHERE name = ?")
        .get(queueModule.CommandNames.ImportProviderArtists) as { count: number };
    assert.equal(row.count, 2);
});

test("provider artist import duplicate can raise queued priority", () => {
    const first = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportProviderArtists,
        {
            providerId: "tidal",
            importCategory: "playlist",
            importListId: "playlist-1",
            importLabel: "Playlist 1",
        },
        undefined,
        10,
    );
    const duplicate = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportProviderArtists,
        {
            providerId: "tidal",
            importCategory: "playlist",
            importListId: "playlist-1",
            importLabel: "Playlist 1",
        },
        undefined,
        1000,
        1,
    );

    assert.equal(duplicate, first);
    const row = dbModule.db.prepare("SELECT priority, trigger FROM commands WHERE id = ?")
        .get(first) as { priority: number; trigger: number };
    assert.equal(row.priority, 1000);
    assert.equal(row.trigger, 1);
});

test("refresh artist dedupe ignores label-only payload differences and stale expansion flags", () => {
    const first = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        {
            artistId: "artist-1",
            artistName: "Original Name",
            workflow: "metadata-refresh",
            monitorArtist: false,
            hydrateCatalog: true,
            hydrateAlbumTracks: false,
            scanLibrary: false,
            forceDownloadQueue: false,
            forceUpdate: true,
        },
        "artist-1",
    );

    const duplicate = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        {
            artistId: "artist-1",
            artistName: "Renamed Artist",
            workflow: "metadata-refresh",
            monitorArtist: false,
            hydrateCatalog: true,
            hydrateAlbumTracks: false,
            scanLibrary: false,
            forceDownloadQueue: false,
            forceUpdate: true,
            expandCreditedArtists: true,
        } as any,
        "artist-1",
    );

    assert.equal(duplicate, first);
    const row = dbModule.db.prepare("SELECT COUNT(*) as count FROM commands WHERE name = ? AND ref_id = ?")
        .get(queueModule.CommandNames.RefreshArtist, "artist-1") as { count: number };
    assert.equal(row.count, 1);
});

test("reorderPendingJobs rejects invalid reorder sets", () => {
    const first = queuePendingDownload("track", "11");
    const second = queuePendingDownload("track", "12");

    assert.throws(
        () => queueModule.CommandQueueManager.reorderPendingJobs([first, first], { beforeJobId: second }),
        /duplicate queue item ids/i,
    );

    const completed = queuePendingDownload("track", "13");
    queueModule.CommandQueueManager.complete(completed);

    assert.throws(
        () => queueModule.CommandQueueManager.reorderPendingJobs([completed], { beforeJobId: second }),
        /Only pending download queue items can be reordered/i,
    );

    assert.throws(
        () => queueModule.CommandQueueManager.reorderPendingJobs([first], { beforeJobId: first }),
        /anchor must be a different pending queue item/i,
    );

    assert.throws(
        () => queueModule.CommandQueueManager.reorderPendingJobs([first], {}),
        /requires exactly one target/i,
    );
});

test("import jobs inherit durable queue order and live queue listing stays stable across transitions", () => {
    const first = queuePendingDownload("track", "21");
    const second = queuePendingDownload("track", "22");
    const third = queuePendingDownload("track", "23");

    queueModule.CommandQueueManager.markProcessing(first);
    queueModule.CommandQueueManager.markProcessing(second);

    const originalJob = queueModule.CommandQueueManager.get(first);
    const secondJob = queueModule.CommandQueueManager.get(second);
    const thirdJob = queueModule.CommandQueueManager.get(third);
    assert.ok(originalJob);
    assert.ok(secondJob);
    assert.ok(thirdJob);

    const importJobId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportDownload,
        {
            type: "track",
            provider: "tidal",
            providerId: "21",
            path: "E:/tmp/downloads/job_21",
            originalJobId: first,
        },
        "21",
        100,
        0,
        originalJob?.queue_order,
    );

    queueModule.CommandQueueManager.complete(first);

    const importJob = queueModule.CommandQueueManager.get(importJobId);
    assert.ok(importJob);
    assert.equal(importJob?.queue_order, originalJob?.queue_order);

    const liveJobs = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
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
    const processingAlbum = enqueueLive({
        mediaKind: "album",
        refKey: "release-group-1:stereo",
        albumId: "release-group-1",
        title: "Processing Album",
        artist: "Queue Artist",
        cover: "processing-cover",
        quality: "HIRES_LOSSLESS",
        slot: "stereo",
        payload: {
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
    });
    const claimed = waitQueueModule.DownloadWaitQueue.claim(processingAlbum.id);
    assert.ok(claimed);
    queueModule.CommandQueueManager.markProcessing(claimed.commandId);

    const pendingAlbum = enqueueLive({
        mediaKind: "album",
        refKey: "release-group-2:spatial",
        albumId: "release-group-2",
        title: "Pending Album",
        artist: "Queue Artist",
        cover: "pending-cover",
        quality: "DOLBY_ATMOS",
        slot: "spatial",
        payload: {
            type: "album",
            provider: "tidal",
            releaseGroupMbid: "release-group-2",
            slot: "spatial",
            title: "Pending Album",
            artist: "Queue Artist",
            cover: "pending-cover",
            quality: "DOLBY_ATMOS",
        },
    });
    const completedTrackId = queueModule.CommandQueueManager.push(
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

    queueModule.CommandQueueManager.complete(completedTrackId);

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 2);
    assert.deepEqual(live.items.map((item) => item.id), [processingAlbum.id, pendingAlbum.id]);
    assert.equal(live.items[0]?.title, "Processing Album");
    assert.equal(live.items[0]?.progress, 42);
    assert.equal(live.items[0]?.currentFileNum, 2);
    assert.equal(live.items[0]?.totalFiles, 5);
    assert.equal(live.items[0]?.slot, "stereo");
    assert.equal(live.items[1]?.queuePosition, 1);
    assert.equal(live.items[1]?.quality, "DOLBY_ATMOS");
    assert.equal(live.items[1]?.slot, "spatial");

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({});
    assert.deepEqual(details.map((item) => item.id), [processingAlbum.id, pendingAlbum.id]);

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
    const canonicalCoverUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/gmtf/canonical-cover.jpg";
    db.prepare(`
        INSERT INTO Albums (
          mbid, artist_mbid, artist_metadata_id, title, primary_type,
          first_release_date, images
        )
        VALUES (?, ?, (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?, ?, ?, ?)
    `).run(
        "rg-gmtf",
        "artist-bastille",
        "artist-bastille",
        "Give Me the Future",
        "album",
        "2022-02-04",
        JSON.stringify([{ coverType: "Cover", url: canonicalCoverUrl, source: "servarr-metadata" }]),
    );
    db.prepare(`
        INSERT INTO AlbumEditions (
          mbid, release_group_mbid, release_group_id, artist_mbid,
          artist_metadata_id, title, track_count, media_count
        )
        VALUES (
          ?, ?, (SELECT id FROM Albums WHERE mbid = ?), ?,
          (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?, ?, ?
        )
    `).run(
        "release-gmtf", "rg-gmtf", "rg-gmtf", "artist-bastille",
        "artist-bastille", "Give Me the Future", 13, 1,
    );
    const releaseOffer = seedAcceptedProviderReleaseMatch(db, {
        provider: "tidal",
        providerEditionId: "tidal-gmtf-expanded",
        releaseMbid: "release-gmtf",
    });
    db.prepare(`
        UPDATE ProviderItems
        SET title = ?, cover_id = ?
        WHERE id = ?
    `).run(
        "Give Me The Future + Dreams Of The Past",
        "provider-cover",
        releaseOffer.providerEditionItemId,
    );
    seedProviderAudioVariant(db, {
        providerItemId: releaseOffer.providerEditionItemId,
        qualityClass: "hires-lossless",
        providerQualityLabel: "HIRES_LOSSLESS",
    });

    const queued = enqueueLive({
        mediaKind: "album",
        refKey: "rg-gmtf:stereo",
        providerId: "tidal-gmtf-expanded",
        artistId: "artist-bastille",
        albumId: "rg-gmtf",
        slot: "stereo",
        payload: {
            type: "album",
            provider: "tidal",
            providerId: "tidal-gmtf-expanded",
            releaseGroupMbid: "rg-gmtf",
            slot: "stereo",
        },
    });

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 1);
    assert.equal(live.items[0]?.id, queued.id);
    assert.equal(live.items[0]?.title, "Give Me the Future");
    assert.equal(live.items[0]?.artist, "Bastille");
    assert.equal(live.items[0]?.album_id, "rg-gmtf");
    assert.equal(live.items[0]?.album_title, "Give Me the Future");
    assert.equal(live.items[0]?.quality, "HIRES_LOSSLESS");
    // The download queue resolves covers through the same local
    // media-cover route as the rest of the app (no per-request upstream proxy).
    assert.ok(String(live.items[0]?.cover || "").startsWith("/media-cover/Albums/rg-gmtf/cover.jpg?source=canonical"));

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({
        artistId: "artist-bastille",
        albumIds: ["rg-gmtf"],
        providerIds: ["tidal-gmtf-expanded"],
    });
    assert.deepEqual(details.map((item) => item.id), [queued.id]);
});

test("download queue prefers video poster over stamped album cover for DownloadVideo", () => {
    const { db } = dbModule;
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-video-cover", "Video Cover Artist");
    db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, images)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        "rg-video-cover",
        "artist-video-cover",
        "Album With Cover",
        "album",
        JSON.stringify([{ coverType: "Cover", url: "https://images.example/album-cover.jpg" }]),
    );
    const recording = db.prepare(`
        INSERT INTO Recordings (artist_mbid, title, is_video, metadata_status)
        VALUES (?, ?, 1, 'provider_catalog')
        RETURNING id
    `).get("artist-video-cover", "Pompeii") as { id: number };
    db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'video', ?, ?)
    `).run( "tidal", "tidal-video-cover-1", "Pompeii" );

    const queued = enqueueLive({
        mediaKind: "video",
        refKey: "tidal-video-cover-1",
        providerId: "tidal-video-cover-1",
        title: "Pompeii",
        artist: "Video Cover Artist",
        payload: {
            type: "video",
            provider: "tidal",
            providerId: "tidal-video-cover-1",
            canonicalRecordingId: String(recording.id),
            title: "Pompeii",
            artist: "Video Cover Artist",
        },
    });
    const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
    assert.ok(claimed);

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 1);
    assert.equal(live.items[0]?.id, queued.id);
    assert.equal(live.items[0]?.type, "video");
    assert.ok(
        String(live.items[0]?.cover || "").startsWith(`/media-cover/Videos/${recording.id}/`),
        `expected video poster URL, got ${live.items[0]?.cover}`,
    );
    assert.ok(
        !String(live.items[0]?.cover || "").includes("/Albums/"),
        "album cover must not win for DownloadVideo queue rows",
    );

    queueModule.CommandQueueManager.complete(claimed.commandId);
    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });
    assert.equal(history.total, 1);
    assert.ok(
        String(history.items[0]?.cover || "").startsWith(`/media-cover/Videos/${recording.id}/`),
        `expected history video poster URL, got ${history.items[0]?.cover}`,
    );
    assert.equal(history.items[0]?.media_id, String(recording.id));
});

test("download queue history recovers video media_id from the accepted provider match", () => {
    const { db } = dbModule;
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-video-match", "Match Artist");
    const recording = db.prepare(`
        INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
        VALUES (?, ?, ?, 1, 'musicbrainz')
        RETURNING id
    `).get("rec-video-match", "artist-video-match", "Pompeii") as { id: number };
    const item = db.prepare(`
        INSERT INTO ProviderItems (
          provider, entity_type, provider_id, title
        ) VALUES (?, 'video', ?, ?)
        RETURNING id
    `).get("apple-music", "1445311108", "Pompeii") as { id: number };
    db.prepare(`
        INSERT INTO ProviderVideoMatches (
          provider_video_item_id, recording_id, match_state, decision_source,
          confidence, method, matcher_version
        ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
    `).run(item.id, recording.id);

    const commandId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.DownloadVideo,
        {
            type: "video",
            provider: "apple-music",
            providerId: "1445311108",
            title: "Pompeii",
            artist: "Match Artist",
        },
        "1445311108",
    );
    queueModule.CommandQueueManager.complete(commandId);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });
    assert.equal(history.items[0]?.media_id, String(recording.id));
    assert.ok(
        String(history.items[0]?.cover || "").startsWith(`/media-cover/Videos/${recording.id}/`),
    );
});

test("download queue query resolves canonical track provider offers without ProviderMedia rows", () => {
    const { db } = dbModule;
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-track", "Track Artist");
    db.prepare(`
        INSERT INTO Albums (
          mbid, artist_mbid, artist_metadata_id, title, primary_type,
          first_release_date, images
        )
        VALUES (?, ?, (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?, ?, ?, ?)
    `).run(
        "rg-track",
        "artist-track",
        "artist-track",
        "Canonical Album",
        "album",
        "2024-01-01",
        JSON.stringify([{ coverType: "Cover", url: "https://images.example/canonical-track-cover.jpg" }]),
    );
    db.prepare(`
        INSERT INTO AlbumEditions (
          mbid, release_group_mbid, release_group_id, artist_mbid,
          artist_metadata_id, title, track_count, media_count
        )
        VALUES (
          ?, ?, (SELECT id FROM Albums WHERE mbid = ?), ?,
          (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?, ?, ?
        )
    `).run(
        "release-track", "rg-track", "rg-track", "artist-track",
        "artist-track", "Canonical Album", 1, 1,
    );
    db.prepare(`
        INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title)
        VALUES (?, ?, (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?)
    `).run("recording-track", "artist-track", "artist-track", "Canonical Recording");
    db.prepare(`
        INSERT INTO Tracks (
          mbid, release_mbid, album_edition_id, recording_mbid, recording_id,
          title, position, medium_position
        )
        VALUES (
          ?, ?, (SELECT id FROM AlbumEditions WHERE mbid = ?), ?,
          (SELECT id FROM Recordings WHERE mbid = ?), ?, ?, ?
        )
    `).run(
        "track-mbid-1", "release-track", "release-track", "recording-track",
        "recording-track", "Canonical Track", 1, 1,
    );
    const trackOffer = seedAcceptedProviderTrackMatch(db, {
        provider: "tidal",
        providerEditionId: "tidal-track-parent",
        providerTrackId: "tidal-track-1",
        releaseMbid: "release-track",
        trackMbid: "track-mbid-1",
    });
    db.prepare(`
        UPDATE ProviderItems
        SET title = ?, version = ?, cover_id = ?
        WHERE id = ?
    `).run("Canonical Track", "Dolby Atmos", "track-cover", trackOffer.providerTrackItemId);
    seedProviderAudioVariant(db, {
        providerItemId: trackOffer.providerTrackItemId,
        qualityClass: "spatial",
        providerQualityLabel: "DOLBY_ATMOS",
        spatialFormat: "DOLBY_ATMOS",
    });
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
        .run("artist-collision", "Collision Artist");
    db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type)
        VALUES (?, ?, (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?, ?)
    `).run("rg-collision", "artist-collision", "artist-collision", "Collision Album", "album");
    db.prepare(`
        INSERT INTO AlbumEditions (
          mbid, release_group_mbid, release_group_id, artist_mbid,
          artist_metadata_id, title
        )
        VALUES (
          ?, ?, (SELECT id FROM Albums WHERE mbid = ?), ?,
          (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?
        )
    `).run(
        "release-collision", "rg-collision", "rg-collision", "artist-collision",
        "artist-collision", "Collision Album",
    );
    db.prepare(`
        INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title)
        VALUES (?, ?, (SELECT id FROM ArtistMetadata WHERE mbid = ?), ?)
    `).run("recording-collision", "artist-collision", "artist-collision", "Collision Track");
    db.prepare(`
        INSERT INTO Tracks (
          mbid, release_mbid, album_edition_id, recording_mbid, recording_id,
          title, position, medium_position
        )
        VALUES (
          ?, ?, (SELECT id FROM AlbumEditions WHERE mbid = ?), ?,
          (SELECT id FROM Recordings WHERE mbid = ?), ?, ?, ?
        )
    `).run(
        "track-collision", "release-collision", "release-collision", "recording-collision",
        "recording-collision", "Collision Track", 1, 1,
    );
    seedAcceptedProviderTrackMatch(db, {
        provider: "spotify",
        providerEditionId: "spotify-track-parent",
        providerTrackId: "tidal-track-1",
        releaseMbid: "release-collision",
        trackMbid: "track-collision",
    });

    const queued = enqueueLive({
        mediaKind: "track",
        refKey: "tidal-track-1",
        providerId: "tidal-track-1",
        artistId: "artist-track",
        albumId: "rg-track",
        payload: {
            type: "track",
            provider: "tidal",
            providerId: "tidal-track-1",
        },
    });

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 1);
    assert.equal(live.items[0]?.id, queued.id);
    assert.equal(live.items[0]?.title, "Canonical Track");
    assert.equal(live.items[0]?.artist, "Track Artist");
    assert.equal(live.items[0]?.album_id, "rg-track");
    assert.equal(live.items[0]?.album_title, "Canonical Album");
    assert.equal(live.items[0]?.quality, "DOLBY_ATMOS");
    assert.ok(String(live.items[0]?.cover || "").startsWith("/media-cover/Albums/rg-track/cover.jpg?source=canonical"));

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({
        artistId: "artist-track",
        albumIds: ["rg-track"],
        providerIds: ["tidal-track-1"],
    });
    assert.deepEqual(details.map((item) => item.id), [queued.id]);
    assert.deepEqual(
        downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({
            artistId: "artist-collision",
            albumIds: ["rg-collision"],
            providerIds: ["tidal-track-1"],
        }),
        [],
    );
});

test("download queue history collapses completed download and import jobs into one logical item", () => {
    const downloadJobId = queueModule.CommandQueueManager.push(
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
    queueModule.CommandQueueManager.complete(downloadJobId);

    const importJobId = queueModule.CommandQueueManager.push(
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
    queueModule.CommandQueueManager.complete(importJobId);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, importJobId);
    assert.equal(history.items[0]?.stage, "import");
    assert.equal(history.items[0]?.title, "Imported Album");
    assert.equal(history.items[0]?.type, "album");
});

test("download queue keeps the wait row live during the same command's import phase", () => {
    const queued = enqueueLive({
        mediaKind: "album",
        refKey: "release-group-handoff:stereo",
        providerId: "provider-album-handoff",
        albumId: "release-group-handoff",
        title: "Handoff Album",
        artist: "Queue Artist",
        cover: "album-cover",
        quality: "LOSSLESS",
        slot: "stereo",
        payload: {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-handoff",
            releaseGroupMbid: "release-group-handoff",
            slot: "stereo",
            title: "Handoff Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
            downloadState: {
                state: "importing",
                tracks: [
                    { title: "Import Track 1", trackNum: 1, status: "completed" },
                    { title: "Import Track 2", trackNum: 2, status: "completed" },
                ],
            },
        },
    });
    const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
    assert.ok(claimed);
    queueModule.CommandQueueManager.markProcessing(claimed.commandId);
    queueModule.CommandQueueManager.updateState(claimed.commandId, {
        payloadPatch: {
            downloadState: {
                state: "importing",
                tracks: [
                    { title: "Import Track 1", trackNum: 1, status: "queued" },
                    { title: "Import Track 2", trackNum: 2, status: "queued" },
                ],
            },
        },
    });

    const activeDuringImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    const historyDuringImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(activeDuringImport.total, 1);
    assert.equal(activeDuringImport.items[0]?.id, queued.id);
    assert.equal(activeDuringImport.items[0]?.stage, "import");
    assert.deepEqual(activeDuringImport.items[0]?.tracks, [
        { title: "Import Track 1", trackNum: 1, volumeNum: undefined, status: "queued" },
        { title: "Import Track 2", trackNum: 2, volumeNum: undefined, status: "queued" },
    ]);
    assert.equal(historyDuringImport.total, 0);

    queueModule.CommandQueueManager.complete(claimed.commandId);
    waitQueueModule.DownloadWaitQueue.finishClaimed(claimed.commandId);

    const historyAfterImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(historyAfterImport.total, 1);
    assert.equal(historyAfterImport.items[0]?.id, claimed.commandId);
    assert.equal(historyAfterImport.items[0]?.stage, "import");
    assert.equal(historyAfterImport.items[0]?.title, "Handoff Album");
});

test("terminal queue jobs ignore late progress, state, complete, and fail updates", () => {
    const commandId = queuePendingDownload("track", "99");
    queueModule.CommandQueueManager.markProcessing(commandId);
    queueModule.CommandQueueManager.updateState(commandId, {
        progress: 45,
        payloadPatch: { downloadState: { state: "downloading", statusMessage: "Downloading track" } },
    });
    queueModule.CommandQueueManager.cancel(commandId);

    queueModule.CommandQueueManager.updateProgress(commandId, 88);
    queueModule.CommandQueueManager.updateState(commandId, {
        progress: 90,
        payloadPatch: { downloadState: { state: "importing", statusMessage: "Late import state" } },
    });
    queueModule.CommandQueueManager.complete(commandId);
    queueModule.CommandQueueManager.fail(commandId, "Late failure");

    const job = queueModule.CommandQueueManager.get(commandId);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
    assert.equal(job.progress, 45);
    assert.equal(job.error ?? null, null);
    assert.equal(job.payload.downloadState?.state, "downloading");
    assert.equal(job.payload.downloadState?.statusMessage, "Downloading track");
});

test("terminal queue jobs cannot be resurrected as processing", () => {
    const commandId = queuePendingDownload("track", "100");
    queueModule.CommandQueueManager.cancel(commandId);

    const marked = queueModule.CommandQueueManager.markProcessing(commandId);

    const job = queueModule.CommandQueueManager.get(commandId);
    assert.equal(marked, false);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
});

test("manual retry resets attempts so max-attempt jobs can run again", () => {
    const commandId = queuePendingDownload("track", "101");

    queueModule.CommandQueueManager.fail(commandId, "first failure");
    queueModule.CommandQueueManager.retry(commandId);

    const job = queueModule.CommandQueueManager.get(commandId);
    assert.ok(job);
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(job.progress, 0);
    assert.equal(job.error ?? null, null);
});

test("active import blocks duplicate download for the same content id", () => {
    const importJobId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.ImportDownload,
        {
            type: "track",
            provider: "tidal",
            providerId: "102",
            path: path.join(tempDir, "download-102"),
            originalJobId: 1,
        },
        "102",
    );

    const duplicateDownloadId = queuePendingDownload("track", "102");
    const pendingDownloads = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_COMMAND_NAMES,
        ["queued", "started"],
    );

    assert.equal(duplicateDownloadId, importJobId);
    assert.equal(pendingDownloads.length, 0);
});

test("getTopPendingJobsByTypes perTypeLimit keeps a deep single-type backlog from starving other types", () => {
    // Intake-shaped backlog: many queued RefreshArtist ahead of a single
    // MatchArtistProviders. Without the per-type cap the 20-row window is all
    // RefreshArtist; with RefreshArtist concurrency-capped at 1 that idled the
    // other worker slots for the whole drain.
    for (let i = 0; i < 25; i += 1) {
        queueModule.CommandQueueManager.push(
            queueModule.CommandNames.RefreshArtist,
            {
                artistId: `starve-artist-${i}`,
                artistName: `Starve Artist ${i}`,
                workflow: "monitoring-intake",
                monitorArtist: true,
                hydrateCatalog: true,
                hydrateAlbumTracks: true,
                scanLibrary: false,
                forceDownloadQueue: false,
                forceUpdate: false,
            },
            `starve-artist-${i}`,
        );
    }
    queueModule.CommandQueueManager.push(
        queueModule.CommandNames.MatchArtistProviders,
        {
            artistId: "starve-match-artist",
            artistName: "Starve Match Artist",
            artistMbid: "starve-match-artist",
            shouldHydrateCatalog: true,
            workflow: "monitoring-intake",
            scanLibrary: false,
            forceDownloadQueue: false,
            forceUpdate: false,
        },
        "starve-match-artist",
    );

    const types = [
        queueModule.CommandNames.RefreshArtist,
        queueModule.CommandNames.MatchArtistProviders,
    ] as const;

    // Documents the flat-window behavior the cap exists to fix.
    const flatWindow = queueModule.CommandQueueManager.getTopPendingJobsByTypes(types, 20);
    assert.equal(flatWindow.length, 20);
    assert.ok(flatWindow.every((job) => job.name === queueModule.CommandNames.RefreshArtist));

    const diverseWindow = queueModule.CommandQueueManager.getTopPendingJobsByTypes(types, 20, 5);
    assert.equal(diverseWindow.filter((job) => job.name === queueModule.CommandNames.RefreshArtist).length, 5);
    assert.equal(diverseWindow.filter((job) => job.name === queueModule.CommandNames.MatchArtistProviders).length, 1);
    // Global execution order still applies within the capped window: the
    // earlier-queued RefreshArtist rows come before the later MatchArtistProviders.
    assert.equal(diverseWindow[0].name, queueModule.CommandNames.RefreshArtist);
});

