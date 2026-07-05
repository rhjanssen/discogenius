import { api } from "@/services/api";
import { ignoreProgressTickEvents, useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { QueueItemContract } from "@contracts/status";
import { useEffect, useMemo, useRef, useState } from "react";

export const queueFeedQueryKey = ["queue"] as const;

const QUEUE_PAGE_SIZE = 50;
const QUEUE_FEED_TIMEOUT_MS = 45_000;
const QUEUE_POLL_TIMEOUT_MS = 4_000;

type UseQueueOptions = {
  enabled?: boolean;
};

export function useQueue({ enabled = true }: UseQueueOptions = {}) {
  const activeRefreshInFlightRef = useRef(false);
  const [polledFirstPage, setPolledFirstPage] = useState<{
    items: QueueItemContract[];
    total: number;
    fetchedAt: number;
  } | null>(null);
  const query = useDashboardInfiniteFeed<QueueItemContract>({
    queryKey: queueFeedQueryKey,
    pageSize: QUEUE_PAGE_SIZE,
    timeoutMs: QUEUE_FEED_TIMEOUT_MS,
    refreshErrorFallbackMessage: "Failed to refresh queue.",
    fetchPage: ({ limit, offset }) => api.getQueue({ limit, offset }),
    getItemId: (item) => item.id,
    // Structural changes arrive via SSE events (filtered below); the interval
    // is only a fallback for missed events, so it doesn't need to be tight.
    refetchIntervalMs: 1_000,
    refetchOnMount: "always",
    globalEventFilter: ignoreProgressTickEvents,
    enabled,
  });
  const queueTotal = query.total;
  const refetchQueue = query.refetch;

  useEffect(() => {
    if (!enabled || !query.hasData) {
      return;
    }

    const timer = window.setInterval(() => {
      if (activeRefreshInFlightRef.current) {
        return;
      }

      activeRefreshInFlightRef.current = true;
      void api.getQueue({ limit: QUEUE_PAGE_SIZE, offset: 0, timeoutMs: QUEUE_POLL_TIMEOUT_MS })
        .then((page) => {
          setPolledFirstPage({
            items: page.items,
            total: page.total,
            fetchedAt: Date.now(),
          });
          void refetchQueue();
        })
        .finally(() => {
          activeRefreshInFlightRef.current = false;
        });
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [enabled, query.hasData, refetchQueue]);

  const queueItems = useMemo(() => {
    if (!polledFirstPage || query.dataUpdatedAt > polledFirstPage.fetchedAt) {
      return query.items;
    }

    const firstPageIds = new Set(polledFirstPage.items.map((item) => item.id));
    const loadedItemsAfterFirstPage = query.items.slice(QUEUE_PAGE_SIZE);
    return [
      ...polledFirstPage.items,
      ...loadedItemsAfterFirstPage.filter((item) => !firstPageIds.has(item.id)),
    ];
  }, [polledFirstPage, query.dataUpdatedAt, query.items]);
  const mergedQueueTotal = polledFirstPage && query.dataUpdatedAt <= polledFirstPage.fetchedAt
    ? polledFirstPage.total
    : queueTotal;

  return {
    ...query,
    queueItems,
    queueTotal: mergedQueueTotal,
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
