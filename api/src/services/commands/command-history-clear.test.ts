import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareActiveSchemaEnv } from "../../test-support/active-schema-fixture.js";
prepareActiveSchemaEnv("history-clear");
const { db, initDatabase } = await import("../../database.js");
initDatabase();
const { CommandQueueManager } = await import("./command-queue-manager.js");
const { getCommandHistory } = await import("./command-history.js");

test("artwork preference intent survives activity history projection with its outcome description", () => {
    const id = Number(db.prepare("INSERT INTO commands (name, payload, status) VALUES ('ConfigPrune', ?, 'completed')")
        .run(JSON.stringify({ refreshArtworkPreference: true, description: "Artwork preference applied to 2/2 catalog item(s)" })).lastInsertRowid);
    const item = getCommandHistory(100).find(row => row.id === id);
    assert.equal(item?.payload?.refreshArtworkPreference, true);
    assert.equal(item?.description, "Artwork preference applied to 2/2 catalog item(s)");
});

test("clearing audited history retains new failures and retried jobs", () => {
    const insert = db.prepare("INSERT INTO commands (name, payload, status) VALUES ('CheckHealth', '{}', ?)");
    const old = Number(insert.run("failed").lastInsertRowid);
    const retried = Number(insert.run("queued").lastInsertRowid);
    const cutoff = Number(insert.run("completed").lastInsertRowid);
    const recent = Number(insert.run("failed").lastInsertRowid);
    CommandQueueManager.clearFinishedByTypes(["CheckHealth"], cutoff);
    assert.equal(CommandQueueManager.get(old), null);
    assert.equal(CommandQueueManager.get(cutoff), null);
    assert.equal(CommandQueueManager.get(retried)?.status, "queued");
    assert.equal(CommandQueueManager.get(recent)?.status, "failed");
    assert.throws(() => CommandQueueManager.clearFinishedByTypes(["CheckHealth"], -1));
});
