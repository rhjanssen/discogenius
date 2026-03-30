import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import type {
    ActivityJobContract as ActiveJob,
    CommandStatsContract as CommandStats,
    StatusOverviewContract as StatusOverviewResponse,
    TaskQueueStatContract as TaskQueueStat,
} from "@contracts/status";

export type { ActiveJob, CommandStats, StatusOverviewResponse, TaskQueueStat };

export const statusOverviewQueryKey = ["statusOverview"] as const;

export function useStatusOverview() {
    useDebouncedQueryInvalidation({
        queryKeys: [statusOverviewQueryKey],
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

    const query = useQuery({
        queryKey: statusOverviewQueryKey,
        queryFn: async () => {
            return api.getStatusOverview({ timeoutMs: 8_000 });
        },
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });

    const data = query.data;
    const hasStatusData = Boolean(data);

    return {
        ...query,
        status: data,
        hasStatusData,
        isStatusInitialLoading: query.isLoading && !hasStatusData,
        isStatusUpdating: query.isFetching && hasStatusData,
        hasStatusRefreshError: query.isError,
        statusRefreshErrorMessage: query.error instanceof Error
            ? query.error.message
            : query.error
                ? "Failed to refresh status."
                : null,
        taskQueueStats: data?.taskQueueStats ?? [],
        commandStats: data?.commandStats ?? {},
    };
}

