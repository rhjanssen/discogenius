export type ReorderableQueueItem = {
    id: number;
    status: string;
    stage?: string;
};

export type ReorderableQueueGroup = {
    id: string;
    items: ReorderableQueueItem[];
};

export type GroupMoveAction = "top" | "up" | "down" | "bottom";

export type QueueReorderRequest = {
    jobIds: number[];
    beforeJobId?: number;
    afterJobId?: number;
    position?: "top" | "bottom";
};

export function getMovablePendingJobIds(items: ReorderableQueueItem[]): number[] {
    return items
        .filter((item) => item.status === "queued" && item.stage !== "import")
        .map((item) => item.id);
}

export function getGroupFirstJobId(group: ReorderableQueueGroup): number | undefined {
    return getMovablePendingJobIds(group.items)[0];
}

export function getGroupLastJobId(group: ReorderableQueueGroup): number | undefined {
    return getMovablePendingJobIds(group.items).at(-1);
}

export function flattenPendingGroupJobIds(groups: ReorderableQueueGroup[]): number[] {
    return groups.flatMap((group) => getMovablePendingJobIds(group.items));
}

export function buildSingleGroupMoveRequest(
    groups: ReorderableQueueGroup[],
    movingGroupId: string,
    action: GroupMoveAction,
): QueueReorderRequest | null {
    const currentIndex = groups.findIndex((group) => group.id === movingGroupId);
    if (currentIndex < 0) {
        return null;
    }

    const movingGroup = groups[currentIndex];
    const jobIds = getMovablePendingJobIds(movingGroup.items);
    if (jobIds.length === 0) {
        return null;
    }

    if (action === "top") {
        // The server resolves the authoritative first pending item. The first
        // UI page is not the whole queue and must never be used as that edge.
        return { jobIds, position: "top" };
    }

    if (action === "up") {
        if (currentIndex <= 0) {
            return null;
        }

        const targetJobId = getGroupFirstJobId(groups[currentIndex - 1]);
        return targetJobId ? { jobIds, beforeJobId: targetJobId } : null;
    }

    if (action === "down") {
        if (currentIndex >= groups.length - 1) {
            return null;
        }

        const targetJobId = getGroupLastJobId(groups[currentIndex + 1]);
        return targetJobId ? { jobIds, afterJobId: targetJobId } : null;
    }

    // The locally loaded last group may only be row 50 of a 10,000-row queue.
    return { jobIds, position: "bottom" };
}

export function buildBulkEdgeMoveRequest(
    groups: ReorderableQueueGroup[],
    movingGroupIds: string[],
    action: "top" | "bottom",
): QueueReorderRequest | null {
    const movingGroupIdSet = new Set(movingGroupIds);
    const selectedGroups = groups.filter((group) => movingGroupIdSet.has(group.id));
    if (selectedGroups.length === 0) {
        return null;
    }

    const jobIds = flattenPendingGroupJobIds(selectedGroups);
    return jobIds.length > 0 ? { jobIds, position: action } : null;
}
