import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";

export interface ActiveJob {
    id: number | string;
    type: string;
    description: string;
    startTime: number;
    endTime?: number;
    status?: string;
    error?: string;
    trigger?: number;
    payload?: unknown;
}

export interface TaskQueueStat {
    type: string;
    status: string;
    count: number;
}

export interface CommandStats {
    downloads?: { pending?: number; processing?: number; failed?: number };
    scans?: { pending?: number; processing?: number; failed?: number };
    other?: { pending?: number; processing?: number; failed?: number };
}

export interface StatusOverviewResponse {
    activeJobs: ActiveJob[];
    queuedJobs: ActiveJob[];
    jobHistory: ActiveJob[];
    taskQueueStats: TaskQueueStat[];
    commandStats: CommandStats;
    runningCommands?: unknown[];
    rateLimitMetrics?: unknown;
}

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
            return await api.request("/status") as StatusOverviewResponse;
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