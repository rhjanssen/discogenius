import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { ActivityJobContract } from "@contracts/status";

export const queueHistoryFeedQueryKey = ["queueHistoryFeed"] as const;

const QUEUE_HISTORY_PAGE_SIZE = 25;
const QUEUE_HISTORY_CATEGORIES = ["downloads"] as const;
const QUEUE_HISTORY_STATUSES = ["completed", "failed", "cancelled"] as const;

type UseQueueHistoryFeedOptions = {
    enabled?: boolean;
};

export function useQueueHistoryFeed({ enabled = true }: UseQueueHistoryFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<ActivityJobContract>({
        queryKey: queueHistoryFeedQueryKey,
        pageSize: QUEUE_HISTORY_PAGE_SIZE,
        refreshErrorFallbackMessage: "Failed to refresh queue history.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getActivity({
            limit,
            offset,
            statuses: [...QUEUE_HISTORY_STATUSES],
            categories: [...QUEUE_HISTORY_CATEGORIES],
            timeoutMs,
        }),
        getItemId: (item) => item.id,
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