import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import type { ActivityJobContract } from "@contracts/status";

const PENDING_TASKS_PAGE_SIZE = 100;

export const pendingTasksQueryKey = ["pendingTasks"] as const;

export function usePendingTasks() {
  useDebouncedQueryInvalidation({
    queryKeys: [pendingTasksQueryKey],
    globalEvents: [
      "job.added",
      "job.updated",
      "job.deleted",
      "queue.cleared",
      "config.updated",
      "file.added",
      "file.deleted",
      "file.upgraded",
    ],
    windowEvents: [ACTIVITY_REFRESH_EVENT],
    debounceMs: 500,
  });

  const query = useInfiniteQuery({
    queryKey: pendingTasksQueryKey,
    queryFn: async ({ pageParam }) => api.getPendingTasks({
      limit: PENDING_TASKS_PAGE_SIZE,
      offset: Number(pageParam || 0),
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (
      lastPage.hasMore
        ? lastPage.offset + lastPage.items.length
        : undefined
    ),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const pages = query.data?.pages ?? [];
  const items = Array.from(new Map(
    pages
      .flatMap((page) => page.items)
      .map((item) => [String(item.id), item] as const),
  ).values()) as ActivityJobContract[];
  const total = pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0;

  return {
    ...query,
    pendingTasks: items,
    pendingTaskTotal: total,
    hasMorePendingTasks: Boolean(query.hasNextPage),
    isLoadingMorePendingTasks: query.isFetchingNextPage,
    loadMorePendingTasks: query.fetchNextPage,
  };
}
