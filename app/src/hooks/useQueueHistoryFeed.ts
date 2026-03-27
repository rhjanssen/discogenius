import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { QueueItemContract } from "@contracts/status";

export const queueHistoryFeedQueryKey = ["queueHistoryFeed"] as const;

const QUEUE_HISTORY_PAGE_SIZE = 25;

type UseQueueHistoryFeedOptions = {
    enabled?: boolean;
};

export function useQueueHistoryFeed({ enabled = true }: UseQueueHistoryFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<QueueItemContract>({
        queryKey: queueHistoryFeedQueryKey,
        pageSize: QUEUE_HISTORY_PAGE_SIZE,
        refreshErrorFallbackMessage: "Failed to refresh queue history.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getQueueHistory({ limit, offset, timeoutMs }),
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