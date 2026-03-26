import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { ActivityJobContract } from "@contracts/status";

export const activityFeedQueryKey = ["activityFeed"] as const;

const ACTIVITY_PAGE_SIZE = 100;
const ACTIVITY_CATEGORIES = ["downloads", "scans", "other"] as const;
const ACTIVITY_STATUSES = ["completed", "failed", "cancelled"] as const;

type UseActivityFeedOptions = {
    enabled?: boolean;
};

export function useActivityFeed({ enabled = true }: UseActivityFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<ActivityJobContract>({
        queryKey: activityFeedQueryKey,
        pageSize: ACTIVITY_PAGE_SIZE,
        refreshErrorFallbackMessage: "Failed to refresh activity.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getActivity({
            limit,
            offset,
            statuses: [...ACTIVITY_STATUSES],
            categories: [...ACTIVITY_CATEGORIES],
            timeoutMs,
        }),
        getItemId: (item) => item.id,
        enabled,
    });

    return {
        ...query,
        activityItems: query.items,
        activityTotal: query.total,
        hasMoreActivity: Boolean(query.hasNextPage),
        isLoadingMoreActivity: query.isFetchingNextPage,
        loadMoreActivity: query.fetchNextPage,
        hasActivityData: query.hasData,
        isActivityInitialLoading: query.isInitialLoading,
        isActivityUpdating: query.isUpdating,
        hasActivityRefreshError: query.hasRefreshError,
        activityRefreshErrorMessage: query.refreshErrorMessage,
    };
}



