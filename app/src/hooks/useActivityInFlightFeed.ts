import { api } from "@/services/api";
import { useDashboardInfiniteFeed } from "@/hooks/useDashboardInfiniteFeed";
import type { ActivityJobContract } from "@contracts/status";

export const activityInFlightFeedQueryKey = ["activityInFlightFeed"] as const;

const ACTIVITY_IN_FLIGHT_PAGE_SIZE = 100;
const ACTIVITY_IN_FLIGHT_CATEGORIES = ["downloads", "scans", "other"] as const;
const ACTIVITY_IN_FLIGHT_STATUSES = ["pending", "processing"] as const;

type UseActivityInFlightFeedOptions = {
    enabled?: boolean;
};

export function useActivityInFlightFeed({ enabled = true }: UseActivityInFlightFeedOptions = {}) {
    const query = useDashboardInfiniteFeed<ActivityJobContract>({
        queryKey: activityInFlightFeedQueryKey,
        pageSize: ACTIVITY_IN_FLIGHT_PAGE_SIZE,
        refreshErrorFallbackMessage: "Failed to refresh in-flight activity.",
        fetchPage: ({ limit, offset, timeoutMs }) => api.getActivity({
            limit,
            offset,
            statuses: [...ACTIVITY_IN_FLIGHT_STATUSES],
            categories: [...ACTIVITY_IN_FLIGHT_CATEGORIES],
            timeoutMs,
        }),
        getItemId: (item) => item.id,
        fallbackRefreshMs: false,
        enabled,
    });

    return {
        ...query,
        inFlightActivityItems: query.items,
    };
}
