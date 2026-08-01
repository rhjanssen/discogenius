import { describe, expect, it } from "vitest";
import {
    buildBulkEdgeMoveRequest,
    buildSingleGroupMoveRequest,
} from "./queueReorder";

function group(id: string, jobId: number) {
    return {
        id,
        title: id,
        artist: "Queue Artist",
        cover: null,
        type: "track" as const,
        quality: null,
        status: "queued",
        sortIndex: jobId,
        items: [{
            id: jobId,
            status: "queued",
            stage: "download",
        }],
    };
}

describe("QueueTab reorder requests", () => {
    it("uses authoritative server edges for top and bottom", () => {
        const groups = [group("first", 1), group("second", 2), group("loaded-last", 50)];

        expect(buildSingleGroupMoveRequest(groups as any, "second", "top")).toEqual({
            jobIds: [2],
            position: "top",
        });
        expect(buildSingleGroupMoveRequest(groups as any, "loaded-last", "bottom")).toEqual({
            jobIds: [50],
            position: "bottom",
        });
    });

    it("does not derive a bulk bottom anchor from the loaded page", () => {
        const groups = [group("first", 1), group("second", 2), group("loaded-last", 50)];

        expect(buildBulkEdgeMoveRequest(groups as any, ["first", "second"], "bottom")).toEqual({
            jobIds: [1, 2],
            position: "bottom",
        });
    });

    it("keeps adjacent moves anchored to the visible neighbor", () => {
        const groups = [group("first", 1), group("second", 2), group("third", 3)];

        expect(buildSingleGroupMoveRequest(groups as any, "second", "up")).toEqual({
            jobIds: [2],
            beforeJobId: 1,
        });
        expect(buildSingleGroupMoveRequest(groups as any, "second", "down")).toEqual({
            jobIds: [2],
            afterJobId: 3,
        });
    });
});
