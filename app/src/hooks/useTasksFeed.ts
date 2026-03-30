import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { ActivityJobContract } from "@contracts/status";

export const tasksFeedQueryKey = ["tasksFeed"] as const;

const TASKS_PAGE_SIZE = 100;

type UseTasksFeedOptions = {
    enabled?: boolean;
};

export function useTasksFeed({ enabled = true }: UseTasksFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<ActivityJobContract>({
        queryKey: tasksFeedQueryKey,
        pageSize: TASKS_PAGE_SIZE,
        refreshErrorFallbackMessage: "Failed to refresh tasks.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getTasks({
            limit,
            offset,
            timeoutMs,
        }),
        getItemId: (item) => item.id,
        enabled,
    });

    return {
        ...query,
        taskItems: query.items,
        taskTotal: query.total,
        hasMoreTasks: Boolean(query.hasNextPage),
        isLoadingMoreTasks: query.isFetchingNextPage,
        loadMoreTasks: query.fetchNextPage,
        hasTaskData: query.hasData,
        isTaskInitialLoading: query.isInitialLoading,
        isTaskUpdating: query.isUpdating,
        hasTaskRefreshError: query.hasRefreshError,
        taskRefreshErrorMessage: query.refreshErrorMessage,
    };
}
