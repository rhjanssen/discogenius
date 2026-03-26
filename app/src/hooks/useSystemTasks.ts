import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import type { SystemTaskContract, UpdateSystemTaskRequestContract } from "@contracts/system-task";

export const systemTasksQueryKey = ["systemTasks"] as const;

export function useSystemTasks() {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const query = useQuery<SystemTaskContract[]>({
        queryKey: systemTasksQueryKey,
        queryFn: async () => api.getSystemTasks(),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });

    const runTaskMutation = useMutation({
        mutationFn: async (taskId: string) => api.runSystemTask(taskId),
        onSuccess: (_, taskId) => {
            toast({
                title: "Task queued",
                description: `Queued ${taskId} to run now.`,
            });
            dispatchActivityRefresh();
            void queryClient.invalidateQueries({ queryKey: systemTasksQueryKey });
        },
        onError: (error: any) => {
            toast({
                title: "Failed to run task",
                description: error?.message || "Please try again.",
                variant: "destructive",
            });
        },
    });

    const updateTaskMutation = useMutation({
        mutationFn: async ({
            taskId,
            updates,
        }: {
            taskId: string;
            updates: UpdateSystemTaskRequestContract;
        }) => api.updateSystemTask(taskId, updates),
        onSuccess: (_, variables) => {
            const title = variables.updates.enabled !== undefined
                ? (variables.updates.enabled ? "Task enabled" : "Task disabled")
                : "Task updated";

            toast({
                title,
            });
            void queryClient.invalidateQueries({ queryKey: systemTasksQueryKey });
        },
        onError: (error: any) => {
            toast({
                title: "Failed to update task",
                description: error?.message || "Please try again.",
                variant: "destructive",
            });
        },
    });

    const tasks = query.data ?? [];
    const scheduledTasks = tasks.filter((task) => task.kind === "scheduled");
    const runnableTasks = tasks.filter((task) => task.canRunNow);
    const manualTasks = tasks.filter((task) => task.kind === "manual");
    const errorMessage = query.error instanceof Error ? query.error.message : query.error ? "Failed to load system tasks." : null;

    return {
        ...query,
        tasks,
        scheduledTasks,
        runnableTasks,
        manualTasks,
        errorMessage,
        isRunningTaskId: runTaskMutation.isPending ? (runTaskMutation.variables ?? null) : null,
        runTask: runTaskMutation.mutateAsync,
        isRunningTask: runTaskMutation.isPending,
        updatingTaskId: updateTaskMutation.isPending ? (updateTaskMutation.variables?.taskId ?? null) : null,
        updateTask: async (taskId: string, updates: UpdateSystemTaskRequestContract) =>
            updateTaskMutation.mutateAsync({ taskId, updates }),
        isUpdatingTask: updateTaskMutation.isPending,
    };
}
