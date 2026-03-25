import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { dispatchLibraryUpdated, dispatchMonitorStateChanged } from "@/utils/appEvents";
import { useToast } from "@/hooks/useToast";

export const useMonitoring = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const toggleMonitorMutation = useMutation({
        mutationFn: async ({
            id,
            type,
            currentStatus,
        }: {
            id: string;
            type: "artist" | "album" | "track" | "video";
            currentStatus: boolean;
        }) => {
            if (type === "video") {
                return api.updateVideo(id, { monitored: !currentStatus });
            }

            const endpoint =
                type === "artist"
                    ? `/artists/${id}/monitor`
                    : type === "album"
                        ? `/albums/${id}/monitor`
                        : `/tracks/${id}/monitor`;

            return api.request(endpoint, {
                method: "POST",
                body: JSON.stringify({ monitored: !currentStatus }),
            });
        },
        onSuccess: (_, variables) => {
            const monitored = !variables.currentStatus;
            toast({
                title: `${variables.type} ${monitored ? "monitored" : "unmonitored"}`,
            });
            dispatchMonitorStateChanged({
                type: variables.type,
                tidalId: variables.id,
                monitored,
            });
            dispatchLibraryUpdated();
            // Invalidate relevant queries
            queryClient.invalidateQueries({ queryKey: [variables.type, variables.id] });
            queryClient.invalidateQueries({ queryKey: ["library"] });
        },
        onError: (error) => {
            toast({
                title: `Error: ${error.message}`,
                variant: "destructive",
            });
        },
    });

    // Re-implementing Lock properly:
    const toggleLock = async ({
        id,
        type,
        isLocked,
        isMonitored,
    }: {
        id: string;
        type: "artist" | "album" | "track" | "video";
        isLocked: boolean;
        isMonitored: boolean;
    }) => {
        if (type === "artist") {
            throw new Error("Artist lock is not supported");
        }

        if (isLocked) {
            // Unlock
            if (type === "video") {
                return api.updateVideo(id, { monitor_lock: false });
            }
            return api.request(`/${type}s/${id}/reset-override`, { method: "POST" });
        } else {
            // Lock
            if (type === "video") {
                return api.updateVideo(id, { monitor_lock: true });
            }
            const endpoint = isMonitored
                ? `/${type}s/${id}/lock-wanted`
                : `/${type}s/${id}/lock-unwanted`;

            return api.request(endpoint, { method: "POST" });
        }
    };

    const lockMutation = useMutation({
        mutationFn: toggleLock,
        onSuccess: (_, vars) => {
            toast({
                title: vars.isLocked ? "Item unlocked" : "Item locked",
            });
            dispatchLibraryUpdated();
            queryClient.invalidateQueries({ queryKey: [vars.type, vars.id] });
            queryClient.invalidateQueries({ queryKey: ["library"] });
        },
        onError: (err) => {
            toast({
                title: err.message,
                variant: "destructive",
            });
        }
    });

    return {
        toggleMonitor: toggleMonitorMutation.mutate,
        toggleLock: lockMutation.mutate,
        isTogglingMonitor: toggleMonitorMutation.isPending,
        isTogglingLock: lockMutation.isPending
    };
};
