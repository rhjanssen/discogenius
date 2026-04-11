import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { QueueItemContract } from "@contracts/status";

export const queueFeedQueryKey = ["queue"] as const;

const QUEUE_PAGE_SIZE = 100;

type UseQueueOptions = {
  enabled?: boolean;
};

export function useQueue({ enabled = true }: UseQueueOptions = {}) {
  const query = useDashboardInfiniteFeed<QueueItemContract>({
    queryKey: queueFeedQueryKey,
    pageSize: QUEUE_PAGE_SIZE,
    refreshErrorFallbackMessage: "Failed to refresh queue.",
    fetchPage: ({ limit, offset }) => api.getQueue({ limit, offset }),
    getItemId: (item) => item.id,
    enabled,
  });

  return {
    ...query,
    queueItems: query.items,
    queueTotal: query.total,
    hasMoreQueueItems: Boolean(query.hasNextPage),
    isLoadingMoreQueueItems: query.isFetchingNextPage,
    loadMoreQueueItems: query.fetchNextPage,
    hasQueueData: query.hasData,
    isQueueInitialLoading: query.isInitialLoading,
    isQueueUpdating: query.isUpdating,
    hasQueueRefreshError: query.hasRefreshError,
    queueRefreshErrorMessage: query.refreshErrorMessage,
  };
}
