import type { QueueItemContract } from "@contracts/status";

/** Terminal outcome buckets for queue history filtering. */
export type QueueHistoryOutcomeFilter = "completed" | "warning" | "failed";

/** Library slot / media-kind buckets for queue history filtering. */
export type QueueHistoryMediaKindFilter = "stereo" | "spatial" | "video";

export type QueueHistoryFilters = {
    /** Empty = all outcomes (including cancelled). OR within the set. */
    outcomes: QueueHistoryOutcomeFilter[];
    /** Empty = all media kinds. OR within the set. */
    mediaKinds: QueueHistoryMediaKindFilter[];
};

export const defaultQueueHistoryFilters: QueueHistoryFilters = {
    outcomes: [],
    mediaKinds: [],
};

export const QUEUE_HISTORY_OUTCOME_OPTIONS: ReadonlyArray<{
    value: QueueHistoryOutcomeFilter;
    label: string;
}> = [
    { value: "completed", label: "Completed" },
    { value: "warning", label: "Warning" },
    { value: "failed", label: "Failed" },
];

export const QUEUE_HISTORY_MEDIA_KIND_OPTIONS: ReadonlyArray<{
    value: QueueHistoryMediaKindFilter;
    label: string;
}> = [
    { value: "stereo", label: "Stereo" },
    { value: "spatial", label: "Spatial" },
    { value: "video", label: "Video" },
];

export function getQueueHistoryOutcomeBucket(
    item: Pick<QueueItemContract, "status" | "error" | "outcome">,
): QueueHistoryOutcomeFilter | "other" {
    if (item.status === "failed" || Boolean(item.error)) {
        return "failed";
    }

    if (item.status === "completed" && item.outcome === "completedWithWarning") {
        return "warning";
    }

    if (item.status === "completed") {
        return "completed";
    }

    return "other";
}

export function getQueueHistoryMediaKind(
    item: Pick<QueueItemContract, "type" | "slot">,
): QueueHistoryMediaKindFilter {
    if (item.type === "video") {
        return "video";
    }

    const slot = String(item.slot || "").trim().toLowerCase();
    if (slot === "spatial") {
        return "spatial";
    }
    if (slot === "video") {
        return "video";
    }

    return "stereo";
}

export function countActiveQueueHistoryFilters(filters: QueueHistoryFilters): number {
    return filters.outcomes.length + filters.mediaKinds.length;
}

export function hasActiveQueueHistoryFilters(filters: QueueHistoryFilters): boolean {
    return countActiveQueueHistoryFilters(filters) > 0;
}

/**
 * AND across dimensions; OR within a multi-select dimension.
 * Empty dimension = match all values for that dimension.
 */
export function matchesQueueHistoryFilters(
    item: Pick<QueueItemContract, "status" | "error" | "outcome" | "type" | "slot">,
    filters: QueueHistoryFilters,
): boolean {
    if (filters.outcomes.length > 0) {
        const bucket = getQueueHistoryOutcomeBucket(item);
        if (!filters.outcomes.includes(bucket as QueueHistoryOutcomeFilter)) {
            return false;
        }
    }

    if (filters.mediaKinds.length > 0) {
        const kind = getQueueHistoryMediaKind(item);
        if (!filters.mediaKinds.includes(kind)) {
            return false;
        }
    }

    return true;
}

export function toggleQueueHistoryOutcome(
    filters: QueueHistoryFilters,
    value: QueueHistoryOutcomeFilter,
): QueueHistoryFilters {
    const outcomes = filters.outcomes.includes(value)
        ? filters.outcomes.filter((entry) => entry !== value)
        : [...filters.outcomes, value];
    return { ...filters, outcomes };
}

export function toggleQueueHistoryMediaKind(
    filters: QueueHistoryFilters,
    value: QueueHistoryMediaKindFilter,
): QueueHistoryFilters {
    const mediaKinds = filters.mediaKinds.includes(value)
        ? filters.mediaKinds.filter((entry) => entry !== value)
        : [...filters.mediaKinds, value];
    return { ...filters, mediaKinds };
}
