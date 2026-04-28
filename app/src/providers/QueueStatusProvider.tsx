import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useGlobalEvents, type GlobalEventPayload, type JobStatusRaw } from "@/hooks/useGlobalEvents";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import {
  QueueStatusContext,
  type AddToQueueOptions,
  type QueueStatusContextType,
} from "@/providers/queueStatusContext";
import {
  createEmptyProgressState,
  deriveQueueStats,
  removeProgressSnapshot,
  upsertProgressSnapshots,
  type DownloadProgress,
  type QueueStatsSummary,
} from "@/queue/queueProgress";

type ProgressState = ReturnType<typeof createEmptyProgressState>;

type QueueGlobalJobEventData = {
  type?: unknown;
  status?: JobStatusRaw;
};

type QueueProgressEvent = Partial<DownloadProgress> & {
  jobId?: number;
  tidalId?: string;
  type?: DownloadProgress["type"];
  state?: DownloadProgress["state"];
  error?: string | null;
};

const DEFAULT_STATS: QueueStatsSummary = {
  pending: 0,
  downloading: 0,
  completed: 0,
  failed: 0,
  total: 0,
};

const STRUCTURAL_QUEUE_UPDATE_STATUSES = new Set<JobStatusRaw>(["pending", "completed", "failed", "cancelled"]);

function getQueueGlobalJobEventData(data: unknown): QueueGlobalJobEventData | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  return data as QueueGlobalJobEventData;
}

function isDownloadQueueJobType(value: unknown): boolean {
  const type = String(value || "");
  return type.startsWith("Download") || type === "ImportDownload";
}

function shouldRefreshQueueStatusForGlobalEvent(event: GlobalEventPayload): boolean {
  if (event.type === "queue.cleared" || event.type === "job.added") {
    return true;
  }

  const jobEventData = getQueueGlobalJobEventData(event.data);
  if (!jobEventData || !isDownloadQueueJobType(jobEventData.type)) {
    return false;
  }

  if (event.type === "job.deleted") {
    return true;
  }

  if (event.type !== "job.updated") {
    return false;
  }

  return jobEventData.status !== undefined && STRUCTURAL_QUEUE_UPDATE_STATUSES.has(jobEventData.status);
}

function buildProgressSnapshot(
  data: QueueProgressEvent,
  existing?: DownloadProgress,
): DownloadProgress | null {
  const jobId = Number(data.jobId ?? existing?.jobId);
  const tidalId = String(data.tidalId ?? existing?.tidalId ?? "").trim();
  const type = data.type ?? existing?.type;

  if (!Number.isFinite(jobId) || jobId <= 0 || !type || tidalId.length === 0) {
    return null;
  }

  return {
    jobId,
    tidalId,
    type,
    quality: data.quality ?? existing?.quality ?? null,
    title: data.title ?? existing?.title,
    artist: data.artist ?? existing?.artist,
    cover: data.cover ?? existing?.cover ?? null,
    progress: data.progress ?? existing?.progress ?? 0,
    speed: data.speed ?? existing?.speed,
    eta: data.eta ?? existing?.eta,
    totalFiles: data.totalFiles ?? existing?.totalFiles,
    currentFileNum: data.currentFileNum ?? existing?.currentFileNum,
    currentTrack: data.currentTrack ?? existing?.currentTrack,
    trackProgress: data.trackProgress ?? existing?.trackProgress,
    trackStatus: data.trackStatus ?? existing?.trackStatus,
    statusMessage: data.statusMessage ?? (typeof data.error === "string" ? data.error : existing?.statusMessage),
    state: data.state ?? existing?.state ?? "downloading",
    tracks: data.tracks ?? existing?.tracks,
    size: data.size ?? existing?.size,
    sizeleft: data.sizeleft ?? existing?.sizeleft,
  };
}

function removeTrackedProgress(state: ProgressState, jobId: number, tidalId?: string | null): ProgressState {
  return removeProgressSnapshot(state, jobId, tidalId);
}

function useQueueStatusContextValue(): QueueStatusContextType {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isUnmountedRef = useRef(false);
  const isManualCloseRef = useRef(false);
  const statusBackoffRef = useRef(10_000);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseReconnectAttemptsRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<QueueStatsSummary>(DEFAULT_STATS);
  const [isPaused, setIsPaused] = useState(false);
  const [progressState, setProgressState] = useState<ProgressState>(createEmptyProgressState);
  const progressStateRef = useRef<ProgressState>(createEmptyProgressState());

  const invalidateQueueQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["queue"] });
    void queryClient.invalidateQueries({ queryKey: ["queueDetails"] });
    void queryClient.invalidateQueries({ queryKey: ["queueHistoryFeed"] });
  }, [queryClient]);

  const updateProgressState = useCallback((updater: (previous: ProgressState) => ProgressState) => {
    const next = updater(progressStateRef.current);
    progressStateRef.current = next;
    setProgressState(next);
  }, []);

  const applyQueueStatus = useCallback((value: Awaited<ReturnType<typeof api.getQueueStatus>>) => {
    setIsPaused(Boolean(value?.isPaused));
    setStats(deriveQueueStats(value));
    statusBackoffRef.current = 10_000;
    setLoading(false);
  }, []);

  const fetchQueueStatus = useCallback(async () => {
    try {
      const nextStatus = await api.getQueueStatus();
      applyQueueStatus(nextStatus);
    } catch (error) {
      console.error("Error fetching queue status:", error);
      statusBackoffRef.current = Math.min(statusBackoffRef.current * 2, 30_000);
      statusTimerRef.current = setTimeout(() => {
        void fetchQueueStatus();
      }, statusBackoffRef.current);
      setLoading(false);
    }
  }, [applyQueueStatus]);

  const scheduleStatusRefresh = useCallback((delay = 250) => {
    if (statusRefreshTimerRef.current) {
      clearTimeout(statusRefreshTimerRef.current);
    }

    statusRefreshTimerRef.current = setTimeout(() => {
      statusRefreshTimerRef.current = null;
      void fetchQueueStatus();
    }, delay);
  }, [fetchQueueStatus]);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    progressStateRef.current = progressState;
  }, [progressState]);

  const lastGlobalEvent = useGlobalEvents(["job.added", "job.updated", "job.deleted", "queue.cleared"]);

  useEffect(() => {
    if (!lastGlobalEvent) {
      return;
    }

    if (shouldRefreshQueueStatusForGlobalEvent(lastGlobalEvent)) {
      scheduleStatusRefresh(0);
    }
  }, [lastGlobalEvent, scheduleStatusRefresh]);

  useEffect(() => {
    let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    isUnmountedRef.current = false;

    const setupProgressStream = () => {
      if (isUnmountedRef.current) {
        return;
      }

      if (eventSourceRef.current) {
        isManualCloseRef.current = true;
        eventSourceRef.current.close();
      }

      isManualCloseRef.current = false;
      eventSourceRef.current = api.createDownloadProgressStream(
        (event, data) => {
          sseReconnectAttemptsRef.current = 0;

          if (event === "status") {
            applyQueueStatus(data);
            return;
          }

          if (event === "queue-status") {
            setIsPaused(Boolean(data?.isPaused));
            return;
          }

          if (event === "progress" || event === "progress-batch") {
            const batch = (Array.isArray(data) ? data : [data])
              .map((item) => buildProgressSnapshot(item))
              .filter((item): item is DownloadProgress => item !== null);

            if (batch.length === 0) {
              return;
            }

            updateProgressState((previous) => upsertProgressSnapshots(previous, batch));
            return;
          }

          if (event === "started") {
            const snapshot = buildProgressSnapshot({
              ...data,
              state: data?.state ?? "downloading",
              progress: data?.progress ?? 0,
            });
            if (snapshot) {
              updateProgressState((previous) => upsertProgressSnapshots(previous, [snapshot]));
            }
            scheduleStatusRefresh(0);
            dispatchActivityRefresh();
            return;
          }

          if (event === "completed") {
            updateProgressState((previous) => removeTrackedProgress(previous, Number(data?.jobId), data?.tidalId));
            scheduleStatusRefresh(0);
            invalidateQueueQueries();
            toastRef.current({
              title: "Download completed",
              description: data?.title || "Track downloaded successfully",
            });
            dispatchActivityRefresh();
            return;
          }

          if (event === "failed") {
            const snapshot = buildProgressSnapshot({
              ...data,
              state: data?.state ?? "failed",
            }, progressStateRef.current.byJobId.get(Number(data?.jobId)));

            if (snapshot) {
              updateProgressState((previous) => upsertProgressSnapshots(previous, [snapshot]));
            }

            scheduleStatusRefresh(0);
            invalidateQueueQueries();
            toastRef.current({
              title: "Download failed",
              description: data?.error || "An error occurred",
              variant: "destructive",
            });
            dispatchActivityRefresh();
          }
        },
        (error) => {
          if (isManualCloseRef.current || isUnmountedRef.current) {
            isManualCloseRef.current = false;
            return;
          }

          console.error("Progress stream error:", error);
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }

          const delay = Math.min(1000 * (2 ** sseReconnectAttemptsRef.current), 30_000);
          sseReconnectAttemptsRef.current += 1;
          sseReconnectTimer = setTimeout(() => {
            if (!isUnmountedRef.current) {
              setupProgressStream();
            }
          }, delay);
        },
      );
    };

    setupProgressStream();
    void fetchQueueStatus();

    return () => {
      isUnmountedRef.current = true;
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (statusRefreshTimerRef.current) clearTimeout(statusRefreshTimerRef.current);
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      if (eventSourceRef.current) {
        isManualCloseRef.current = true;
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [applyQueueStatus, fetchQueueStatus, invalidateQueueQueries, scheduleStatusRefresh, updateProgressState]);

  const addToQueue = useCallback(async (url: string, type: string, tidalId?: string, options?: AddToQueueOptions) => {
    try {
      await api.addToQueue(url, type, tidalId);
      if (!options?.silent) {
        toastRef.current({
          title: options?.successTitle ?? "Added to queue",
          description: options?.successDescription ?? "Download will start automatically",
        });
      }
      scheduleStatusRefresh(0);
      invalidateQueueQueries();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error adding to queue:", error);
      toastRef.current({
        title: "Failed to add to queue",
        description: error.message,
        variant: "destructive",
      });
      throw error;
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh]);

  const processItem = useCallback(async (id: number) => {
    try {
      void id;
      await api.resumeQueue();
      scheduleStatusRefresh(0);
      invalidateQueueQueries();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error processing item:", error);
      toastRef.current({
        title: "Failed to start download",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh]);

  const retryItem = useCallback(async (id: number) => {
    try {
      const response = await api.retryQueueItem(id);
      updateProgressState((previous) => removeTrackedProgress(previous, id));
      toastRef.current({
        title: response.action === "queue-redownload" ? "Download queued" : "Retry queued",
        description: response.message,
      });
      scheduleStatusRefresh(0);
      invalidateQueueQueries();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error retrying item:", error);
      toastRef.current({
        title: "Failed to retry",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh, updateProgressState]);

  const deleteItem = useCallback(async (id: number) => {
    try {
      await api.deleteQueueItem(id);
      updateProgressState((previous) => removeTrackedProgress(previous, id));
      scheduleStatusRefresh(0);
      invalidateQueueQueries();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error deleting item:", error);
      toastRef.current({
        title: "Failed to delete item",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh, updateProgressState]);

  const reorderItems = useCallback(async (
    params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number },
    options?: { refresh?: boolean; dispatchActivity?: boolean },
  ) => {
    try {
      await api.reorderQueueItems(params);
      if (options?.refresh !== false) {
        scheduleStatusRefresh(0);
        invalidateQueueQueries();
      }
      if (options?.dispatchActivity !== false) {
        dispatchActivityRefresh();
      }
    } catch (error: any) {
      console.error("Error reordering queue:", error);
      toastRef.current({
        title: "Failed to reorder queue",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh]);

  const clearCompleted = useCallback(async () => {
    try {
      await api.clearCompleted();
      toastRef.current({
        title: "Queue cleared",
        description: "Finished downloads removed",
      });
      scheduleStatusRefresh(0);
      invalidateQueueQueries();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error clearing completed:", error);
      toastRef.current({
        title: "Failed to clear queue",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [invalidateQueueQueries, scheduleStatusRefresh]);

  const pauseQueue = useCallback(async () => {
    try {
      await api.pauseQueue();
      setIsPaused(true);
      scheduleStatusRefresh(0);
      toastRef.current({
        title: "Queue paused",
        description: "Processing stopped",
      });
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error pausing queue:", error);
      toastRef.current({
        title: "Failed to pause queue",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [scheduleStatusRefresh]);

  const resumeQueue = useCallback(async () => {
    try {
      await api.resumeQueue();
      setIsPaused(false);
      scheduleStatusRefresh(0);
      toastRef.current({
        title: "Queue resumed",
        description: "Processing started",
      });
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error("Error resuming queue:", error);
      toastRef.current({
        title: "Failed to resume queue",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [scheduleStatusRefresh]);

  return useMemo(() => ({
    loading,
    stats,
    isPaused,
    progressByJobId: progressState.byJobId,
    progressByTidalId: progressState.byTidalId,
    getProgress: (jobId: number) => progressState.byJobId.get(jobId),
    getProgressByTidalId: (tidalId: string) => progressState.byTidalId.get(String(tidalId)),
    addToQueue,
    processItem,
    retryItem,
    deleteItem,
    reorderItems,
    clearCompleted,
    pauseQueue,
    resumeQueue,
    refreshQueueStatus: fetchQueueStatus,
  }), [
    addToQueue,
    clearCompleted,
    deleteItem,
    fetchQueueStatus,
    isPaused,
    loading,
    pauseQueue,
    processItem,
    progressState.byJobId,
    progressState.byTidalId,
    reorderItems,
    resumeQueue,
    retryItem,
    stats,
  ]);
}

export function QueueStatusProvider({ children }: { children: React.ReactNode }) {
  const value = useQueueStatusContextValue();

  return (
    <QueueStatusContext.Provider value={value}>
      {children}
    </QueueStatusContext.Provider>
  );
}
