import { api } from "@/services/api";
import { ignoreProgressTickEvents, useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { QueueItemContract } from "@contracts/status";
import {
    defaultQueueHistoryFilters,
    type QueueHistoryFilters,
} from "@/pages/dashboard/queueHistoryFilters";

export function queueHistoryFeedQueryKey(filters: QueueHistoryFilters = defaultQueueHistoryFilters) {
    return [
        "queueHistoryFeed",
        {
            outcomes: [...filters.outcomes].sort(),
            mediaKinds: [...filters.mediaKinds].sort(),
        },
    ] as const;
}

const QUEUE_HISTORY_PAGE_SIZE = 10;
const QUEUE_HISTORY_FEED_TIMEOUT_MS = 45_000;

type UseQueueHistoryFeedOptions = {
    enabled?: boolean;
    filters?: QueueHistoryFilters;
};

export function useQueueHistoryFeed({
    enabled = true,
    filters = defaultQueueHistoryFilters,
}: UseQueueHistoryFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<QueueItemContract>({
        queryKey: queueHistoryFeedQueryKey(filters),
        pageSize: QUEUE_HISTORY_PAGE_SIZE,
        timeoutMs: QUEUE_HISTORY_FEED_TIMEOUT_MS,
        refreshErrorFallbackMessage: "Failed to refresh queue history.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getQueueHistory({
            limit,
            offset,
            timeoutMs,
            outcomes: filters.outcomes,
            mediaKinds: filters.mediaKinds,
        }),
        getItemId: (item) => item.id,
        // History only changes on terminal transitions, which arrive as SSE
        // events; the interval is a fallback for missed events.
        refetchIntervalMs: 15_000,
        refetchOnMount: "always",
        globalEventFilter: ignoreProgressTickEvents,
        enabled,
    });

    return {
        ...query,
        queueHistoryItems: query.items,
        queueHistoryTotal: query.total,
        hasMoreQueueHistory: Boolean(query.hasNextPage),
        isLoadingMoreQueueHistory: query.isFetchingNextPage,
        loadMoreQueueHistory: query.fetchNextPage,
        hasQueueHistoryData: query.hasData,
        isQueueHistoryInitialLoading: query.isInitialLoading,
        isQueueHistoryUpdating: query.isUpdating,
        hasQueueHistoryRefreshError: query.hasRefreshError,
        queueHistoryRefreshErrorMessage: query.refreshErrorMessage,
    };
}
