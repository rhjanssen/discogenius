import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-queue-scale-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.queue-scale.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let queryModule: typeof import("../download/download-queue-query-service.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue-manager.js");
    queryModule = await import("../download/download-queue-query-service.js");
    dbModule.initDatabase();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function elapsed<T>(operation: () => T): { value: T; elapsedMs: number } {
    const startedAt = performance.now();
    const value = operation();
    return { value, elapsedMs: performance.now() - startedAt };
}

function queuePayload(index: number): string {
    return JSON.stringify({
        provider: "synthetic",
        providerId: `scale-${index}`,
        type: "track",
        title: `Scale Track ${index}`,
        artist: "Scale Artist",
        cover: "https://example.invalid/cover.jpg",
    });
}

test("queue/history queries and sparse reorder stay bounded at 100k command rows", () => {
    const insert = dbModule.db.prepare(`
        INSERT INTO commands(
            name, ref_id, payload, status, progress, priority, trigger,
            queue_order, created_at, updated_at, completed_at
        )
        VALUES(
            'DownloadTrack', ?, ?, ?, 0, 0, 0,
            ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00', ?
        )
    `);
    const seedRange = dbModule.db.transaction((
        fromInclusive: number,
        toExclusive: number,
        status: "queued" | "completed",
    ) => {
        for (let index = fromInclusive; index < toExclusive; index += 1) {
            insert.run(
                `scale-${index}`,
                queuePayload(index),
                status,
                (index + 1) * 1024,
                status === "completed" ? "2026-01-02 00:00:00" : null,
            );
        }
    });

    const seedOneThousand = elapsed(() => seedRange(0, 1_000, "queued"));
    const pageAtOneThousand = elapsed(() => (
        queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
            queueModule.DOWNLOAD_COMMAND_NAMES,
            ["queued"],
            50,
            0,
            { orderBy: "execution" },
        )
    ));
    assert.equal(pageAtOneThousand.value.length, 50);
    assert.deepEqual(
        pageAtOneThousand.value.slice(0, 3).map((job) => job.ref_id),
        ["scale-0", "scale-1", "scale-2"],
    );

    const seedTenThousand = elapsed(() => seedRange(1_000, 10_000, "queued"));
    const queuePage = elapsed(() => queryModule.DownloadQueueQueryService.getQueue({
        limit: 50,
        offset: 0,
    }));
    assert.equal(queuePage.value.total, 10_000);
    assert.equal(queuePage.value.items.length, 50);
    assert.deepEqual(
        queuePage.value.items.map((item) => item.queuePosition),
        Array.from({ length: 50 }, (_, index) => index + 1),
    );

    const rankRowsBefore = dbModule.db.prepare(`
        SELECT id, queue_order
        FROM commands
        WHERE status = 'queued'
        ORDER BY id
    `).all() as Array<{ id: number; queue_order: number }>;
    const movingId = rankRowsBefore[5_000].id;
    const changesBefore = dbModule.db.prepare("SELECT total_changes() AS value").get() as { value: number };
    const reorder = elapsed(() => queueModule.CommandQueueManager.reorderPendingJobs(
        [movingId],
        {
            position: "top",
            types: queueModule.DOWNLOAD_COMMAND_NAMES,
        },
    ));
    const changesAfter = dbModule.db.prepare("SELECT total_changes() AS value").get() as { value: number };
    assert.equal(reorder.value, 1);
    // One serialization write plus parking/final rank writes. This guards
    // against regressing to a dense 10,000-row rewrite.
    assert.ok(changesAfter.value - changesBefore.value <= 4);

    const rankRowsAfter = dbModule.db.prepare(`
        SELECT id, queue_order
        FROM commands
        WHERE status = 'queued'
        ORDER BY id
    `).all() as Array<{ id: number; queue_order: number }>;
    const changedRankIds = rankRowsAfter
        .filter((row, index) => row.queue_order !== rankRowsBefore[index].queue_order)
        .map((row) => row.id);
    assert.deepEqual(changedRankIds, [movingId]);

    const firstAfterReorder = queueModule.CommandQueueManager.getNextJobByTypes(
        queueModule.DOWNLOAD_COMMAND_NAMES,
    );
    assert.equal(firstAfterReorder?.id, movingId);

    const seedHistory = elapsed(() => seedRange(10_000, 100_000, "completed"));
    const historyPage = elapsed(() => queryModule.DownloadQueueQueryService.getQueueHistory({
        limit: 50,
        offset: 0,
    }));
    assert.equal(historyPage.value.total, 90_000);
    assert.equal(historyPage.value.items.length, 50);
    assert.equal(historyPage.value.hasMore, true);
    const commandCount = dbModule.db.prepare(
        "SELECT COUNT(*) AS count FROM commands",
    ).get() as { count: number };
    assert.equal(
        commandCount.count,
        100_000,
    );
    const duplicateRankCount = dbModule.db.prepare(`
        SELECT COUNT(*) AS count
        FROM (
            SELECT queue_order
            FROM commands
            WHERE status = 'queued'
            GROUP BY queue_order
            HAVING COUNT(*) > 1
        )
    `).get() as { count: number };
    assert.equal(
        duplicateRankCount.count,
        0,
    );

    const metrics = {
        seed1kMs: Number(seedOneThousand.elapsedMs.toFixed(1)),
        list1kPageMs: Number(pageAtOneThousand.elapsedMs.toFixed(1)),
        seedAdditional9kMs: Number(seedTenThousand.elapsedMs.toFixed(1)),
        queue10kPageMs: Number(queuePage.elapsedMs.toFixed(1)),
        sparseReorder10kMs: Number(reorder.elapsedMs.toFixed(1)),
        seedHistory90kMs: Number(seedHistory.elapsedMs.toFixed(1)),
        history90kPageMs: Number(historyPage.elapsedMs.toFixed(1)),
        heapUsedMiB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    };
    console.log(`[queue-scale] ${JSON.stringify(metrics)}`);
    for (const value of Object.values(metrics)) {
        assert.ok(Number.isFinite(value));
    }
});
