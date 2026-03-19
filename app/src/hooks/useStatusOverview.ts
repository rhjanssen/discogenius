import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";
import type {
  ActivityJobContract as ActiveJob,
  CommandStatsContract as CommandStats,
  StatusOverviewContract as StatusOverviewResponse,
  TaskQueueStatContract as TaskQueueStat,
} from "@contracts/status";

export type { ActiveJob, CommandStats, StatusOverviewResponse, TaskQueueStat };

export const statusOverviewQueryKey = ["statusOverview"] as const;

export function useStatusOverview() {
    const queryClient = useQueryClient();
    const lastGlobalEvent = useGlobalEvents([
        "job.added",
        "job.updated",
        "job.deleted",
        "queue.cleared",
        "config.updated",
        "file.added",
        "file.deleted",
        "file.upgraded",
    ]);

    useEffect(() => {
        if (!lastGlobalEvent) {
            return;
        }

        queryClient.invalidateQueries({ queryKey: statusOverviewQueryKey });
    }, [lastGlobalEvent, queryClient]);

    useEffect(() => {
        const handleRefresh = () => {
            queryClient.invalidateQueries({ queryKey: statusOverviewQueryKey });
        };

        window.addEventListener(ACTIVITY_REFRESH_EVENT, handleRefresh);
        return () => window.removeEventListener(ACTIVITY_REFRESH_EVENT, handleRefresh);
    }, [queryClient]);

    const query = useQuery({
        queryKey: statusOverviewQueryKey,
        queryFn: async () => {
            return api.getStatusOverview();
        },
        staleTime: 5_000,
        refetchInterval: 10_000,
        refetchOnWindowFocus: true,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });

    const data = query.data;

    return {
        ...query,
        status: data,
        activeJobs: data?.activeJobs ?? [],
        queuedJobs: data?.queuedJobs ?? [],
        jobHistory: data?.jobHistory ?? [],
        taskQueueStats: data?.taskQueueStats ?? [],
        commandStats: data?.commandStats ?? {},
    };
}
