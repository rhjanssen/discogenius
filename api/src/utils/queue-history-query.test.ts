import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQueueHistoryFilters } from "./queue-history-query.js";

test("parseQueueHistoryFilters accepts empty query as no restriction", () => {
    const result = parseQueueHistoryFilters({});
    assert.ok(!("error" in result));
    assert.deepEqual(result.value, { outcomes: [], mediaKinds: [] });
});

test("parseQueueHistoryFilters parses outcome and slot CSV aliases", () => {
    const result = parseQueueHistoryFilters({
        outcomes: "completed,warning,error",
        mediaKinds: "stereo,spatial,video",
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.value.outcomes, ["completed", "warning", "failed"]);
    assert.deepEqual(result.value.mediaKinds, ["stereo", "spatial", "video"]);
});

test("parseQueueHistoryFilters rejects unsupported values", () => {
    const badOutcome = parseQueueHistoryFilters({ outcome: "running" });
    assert.ok("error" in badOutcome);
    assert.equal(badOutcome.error.error, "Invalid outcome filter");

    const badSlot = parseQueueHistoryFilters({ slot: "atmos" });
    assert.ok("error" in badSlot);
    assert.equal(badSlot.error.error, "Invalid media kind filter");
});
