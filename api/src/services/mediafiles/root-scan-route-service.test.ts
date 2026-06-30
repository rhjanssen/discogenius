import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-root-scan-route-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();

const { createRootScanRouteService } = await import("./root-scan-route-service.js");

test("root scan route service queues root scans with route-compatible defaults", () => {
    let queuedOptions: Record<string, unknown> | undefined;
    const service = createRootScanRouteService({
        queueRootScanPass: (options) => {
            queuedOptions = options as Record<string, unknown>;
            return 42;
        },
    });

    const commandId = service.queueRootScan({
        fullProcessing: true,
        monitorArtist: "not-a-boolean",
    });

    assert.equal(commandId, 42);
    assert.deepEqual(queuedOptions, {
        trigger: 1,
        fullProcessing: true,
        addNewArtists: true,
        monitorArtist: undefined,
    });
});
