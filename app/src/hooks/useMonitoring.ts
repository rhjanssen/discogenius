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
            type: "album" | "video";
            currentStatus: boolean;
        }) => {
            if (type === "video") {
                return api.updateVideo(id, { monitored: !currentStatus });
            }

            // A library-wide Album toggle: every audio library, said out loud.
            return api.monitorAlbum(id, { allLibraries: true }, !currentStatus);
        },
        onSuccess: (_, variables) => {
            const monitored = !variables.currentStatus;
            toast({
                title: `${variables.type} ${monitored ? "monitored" : "unmonitored"}`,
            });
            dispatchMonitorStateChanged({
                type: variables.type,
                providerId: variables.id,
                monitored,
            });
            dispatchLibraryUpdated();
            // Invalidate relevant queries
            queryClient.invalidateQueries({ queryKey: [variables.type, variables.id] });
            queryClient.invalidateQueries({ queryKey: ["albumPage", variables.id] });
            queryClient.invalidateQueries({ queryKey: ["artistPage", variables.id] });
            queryClient.invalidateQueries({ queryKey: ["library"] });
        },
        onError: (error) => {
            toast({
                title: `Error: ${error.message}`,
                variant: "destructive",
            });
        },
    });

    const toggleLock = async ({
        id,
        type,
        isLocked,
    }: {
        id: string;
        type: "album" | "video";
        isLocked: boolean;
    }) => {
        if (type === "video") {
            return api.updateVideo(id, { monitored_lock: !isLocked });
        }

        return api.updateAlbum(id, { monitored_lock: !isLocked }, { allLibraries: true });
    };

    const lockMutation = useMutation({
        mutationFn: toggleLock,
        onSuccess: (_, vars) => {
            toast({
                title: vars.isLocked ? "Item unlocked" : "Item locked",
            });
            dispatchLibraryUpdated();
            queryClient.invalidateQueries({ queryKey: [vars.type, vars.id] });
            queryClient.invalidateQueries({ queryKey: ["albumPage", vars.id] });
            queryClient.invalidateQueries({ queryKey: ["artistPage", vars.id] });
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
