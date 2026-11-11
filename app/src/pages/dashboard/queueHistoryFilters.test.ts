import { describe, expect, it } from "vitest";
import {
    countActiveQueueHistoryFilters,
    defaultQueueHistoryFilters,
    getQueueHistoryMediaKind,
    getQueueHistoryOutcomeBucket,
    matchesQueueHistoryFilters,
    toggleQueueHistoryMediaKind,
    toggleQueueHistoryOutcome,
    type QueueHistoryFilters,
} from "./queueHistoryFilters";

describe("queueHistoryFilters", () => {
    it("classifies outcomes from status and downloadState outcome", () => {
        expect(getQueueHistoryOutcomeBucket({ status: "completed", error: null, outcome: "ok" })).toBe("completed");
        expect(getQueueHistoryOutcomeBucket({ status: "completed", error: null })).toBe("completed");
        expect(getQueueHistoryOutcomeBucket({
            status: "completed",
            error: null,
            outcome: "completedWithWarning",
        })).toBe("warning");
        expect(getQueueHistoryOutcomeBucket({ status: "failed", error: "boom" })).toBe("failed");
        expect(getQueueHistoryOutcomeBucket({ status: "completed", error: "late error" })).toBe("failed");
        expect(getQueueHistoryOutcomeBucket({ status: "cancelled", error: null })).toBe("other");
    });

    it("derives media kind from type and slot", () => {
        expect(getQueueHistoryMediaKind({ type: "video", slot: null })).toBe("video");
        expect(getQueueHistoryMediaKind({ type: "album", slot: "spatial" })).toBe("spatial");
        expect(getQueueHistoryMediaKind({ type: "track", slot: "stereo" })).toBe("stereo");
        expect(getQueueHistoryMediaKind({ type: "album", slot: null })).toBe("stereo");
        expect(getQueueHistoryMediaKind({ type: "album", slot: "video" })).toBe("video");
    });

    it("ANDs dimensions and ORs within a multi-select dimension", () => {
        const warningSpatial = {
            status: "completed" as const,
            error: null,
            outcome: "completedWithWarning" as const,
            type: "album" as const,
            slot: "spatial",
        };
        const failedStereo = {
            status: "failed" as const,
            error: "nope",
            type: "album" as const,
            slot: "stereo",
        };
        const completedVideo = {
            status: "completed" as const,
            error: null,
            outcome: "ok" as const,
            type: "video" as const,
            slot: null,
        };

        const warningOrFailed: QueueHistoryFilters = {
            outcomes: ["warning", "failed"],
            mediaKinds: [],
        };
        expect(matchesQueueHistoryFilters(warningSpatial, warningOrFailed)).toBe(true);
        expect(matchesQueueHistoryFilters(failedStereo, warningOrFailed)).toBe(true);
        expect(matchesQueueHistoryFilters(completedVideo, warningOrFailed)).toBe(false);

        const warningAndSpatial: QueueHistoryFilters = {
            outcomes: ["warning"],
            mediaKinds: ["spatial"],
        };
        expect(matchesQueueHistoryFilters(warningSpatial, warningAndSpatial)).toBe(true);
        expect(matchesQueueHistoryFilters(failedStereo, warningAndSpatial)).toBe(false);

        expect(matchesQueueHistoryFilters(completedVideo, defaultQueueHistoryFilters)).toBe(true);
    });

    it("toggles filter chips and counts active selections", () => {
        let filters = defaultQueueHistoryFilters;
        filters = toggleQueueHistoryOutcome(filters, "failed");
        filters = toggleQueueHistoryMediaKind(filters, "video");
        expect(countActiveQueueHistoryFilters(filters)).toBe(2);
        filters = toggleQueueHistoryOutcome(filters, "failed");
        expect(filters.outcomes).toEqual([]);
        expect(countActiveQueueHistoryFilters(filters)).toBe(1);
    });
});
