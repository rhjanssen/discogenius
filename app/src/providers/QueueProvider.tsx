import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useGlobalEvents, GlobalEventPayload } from "@/hooks/useGlobalEvents";
import { dispatchActivityRefresh } from "@/utils/appEvents";

export interface QueueItem {
  id: number;
  url: string;
  type: string;
  quality?: string | null;
  stage?: 'download' | 'import';
  tidalId: string | null;
  path: string | null;
  status: 'pending' | 'processing' | 'downloading' | 'completed' | 'failed';
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  title?: string;
  artist?: string;
  cover?: string | null;
  album_id?: string | null;
  album_title?: string | null;
  currentFileNum?: number;
  totalFiles?: number;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
  statusMessage?: string;
  speed?: string;
  eta?: string;
  size?: number;
  sizeleft?: number;
  state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
  tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];
}

export interface DownloadProgress {
  jobId: number;
  tidalId: string;
  type: string;
  title?: string;
  artist?: string;
  cover?: string | null;
  progress: number;
  speed?: string;
  eta?: string;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
  currentFileNum?: number;
  totalFiles?: number;
  statusMessage?: string;
  state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
  size?: number;
  sizeleft?: number;
  tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];
}

interface QueueContextType {
  queue: QueueItem[];
  loading: boolean;
  stats: {
    pending: number;
    downloading: number;
    completed: number;
    failed: number;
    total: number;
  };
  progress: Map<number, DownloadProgress>;
  isPaused: boolean;
  getProgress: (jobId: number) => DownloadProgress | undefined;
  addToQueue: (url: string, type: string, tidalId?: string) => Promise<void>;
  processItem: (id: number) => Promise<void>;
  retryItem: (id: number) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  clearCompleted: () => Promise<void>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  refreshQueue: () => Promise<void>;
}

const buildProgressFromQueueItem = (item: QueueItem): DownloadProgress | undefined => {
  const derivedState = item.state
    ?? (item.status === 'failed'
      ? (item.stage === 'import' ? 'importFailed' : 'failed')
      : item.stage === 'import'
        ? (item.status === 'processing' || item.status === 'downloading' ? 'importing' : 'importPending')
        : item.status === 'completed'
          ? 'completed'
          : item.status === 'processing' || item.status === 'downloading'
            ? 'downloading'
            : 'queued');

  const hasPersistedState =
    item.currentFileNum !== undefined ||
    item.totalFiles !== undefined ||
    item.currentTrack !== undefined ||
    item.trackProgress !== undefined ||
    item.trackStatus !== undefined ||
    item.statusMessage !== undefined ||
    item.state !== undefined ||
    (Array.isArray(item.tracks) && item.tracks.length > 0);

  if (!hasPersistedState && item.progress <= 0 && item.status === 'pending' && item.stage !== 'import') {
    return undefined;
  }

  return {
    jobId: item.id,
    tidalId: item.tidalId ?? '',
    type: item.type,
    title: item.title,
    artist: item.artist,
    cover: item.cover ?? null,
    progress: item.progress ?? 0,
    currentFileNum: item.currentFileNum,
    totalFiles: item.totalFiles,
    currentTrack: item.currentTrack,
    trackProgress: item.trackProgress,
    trackStatus: item.trackStatus,
    statusMessage: item.statusMessage ?? (item.stage === 'import' && derivedState === 'importPending' ? 'Waiting to import' : undefined),
    speed: item.speed,
    eta: item.eta,
    size: item.size,
    sizeleft: item.sizeleft,
    state: derivedState,
    tracks: item.tracks,
  };
};

const mergeRecoveredProgress = (existing: DownloadProgress | undefined, recovered: DownloadProgress): DownloadProgress => {
  if (!existing) {
    return recovered;
  }

  const keepLiveProgress =
    (existing.state === 'downloading' && recovered.state === 'downloading') ||
    (existing.state === 'importing' && recovered.state === 'importing');

  return {
    ...existing,
    ...recovered,
    progress: keepLiveProgress ? Math.max(existing.progress ?? 0, recovered.progress ?? 0) : recovered.progress,
    currentFileNum: keepLiveProgress
      ? Math.max(existing.currentFileNum ?? 0, recovered.currentFileNum ?? 0) || recovered.currentFileNum || existing.currentFileNum
      : recovered.currentFileNum,
    trackProgress: keepLiveProgress && existing.trackProgress !== undefined && recovered.trackProgress !== undefined
      ? Math.max(existing.trackProgress, recovered.trackProgress)
      : recovered.trackProgress ?? existing.trackProgress,
    speed: recovered.speed ?? existing.speed,
    eta: recovered.eta ?? existing.eta,
    size: recovered.size ?? existing.size,
    sizeleft: recovered.sizeleft ?? existing.sizeleft,
    tracks: recovered.tracks ?? existing.tracks,
  };
};

// eslint-disable-next-line react-refresh/only-export-components
export const QueueContext = createContext<QueueContextType | undefined>(undefined);

export const QueueProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Map<number, DownloadProgress>>(new Map());
  const [isPaused, setIsPaused] = useState(false);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isUnmountedRef = useRef(false);
  const isManualCloseRef = useRef(false);
  const sseReconnectAttempts = useRef(0);
  const queueBackoffRef = useRef(10000);
  const queueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuePageSize = 100;

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const fetchQueue = useCallback(async () => {
    try {
      const serverItems: QueueItem[] = [];
      let offset = 0;

      while (true) {
        const data: any = await api.getQueue({ limit: queuePageSize, offset });
        const pageItems: QueueItem[] = Array.isArray(data) ? data : (data?.items || []);
        serverItems.push(...pageItems);

        if (Array.isArray(data) || !data?.hasMore || pageItems.length === 0) {
          break;
        }

        offset += pageItems.length;
      }

      setQueue(serverItems);
      setProgress(prev => {
        const next = new Map<number, DownloadProgress>();

        for (const item of serverItems) {
          const recovered = buildProgressFromQueueItem(item);
          const existing = prev.get(item.id);

          if (recovered) {
            next.set(item.id, mergeRecoveredProgress(existing, recovered));
            continue;
          }

          if (existing && (item.status === 'processing' || item.status === 'downloading')) {
            next.set(item.id, existing);
          }
        }

        return next;
      });

      queueBackoffRef.current = 10000; // reset on success
    } catch (error: any) {
      console.error('Error fetching queue:', error);
      queueBackoffRef.current = Math.min(queueBackoffRef.current * 2, 30000);
      queueTimerRef.current = setTimeout(fetchQueue, queueBackoffRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  // Use the global event stream to know when to refetch the full queue
  // or apply optimistic updates when jobs are added/removed.
  const lastGlobalEvent = useGlobalEvents(['job.added', 'job.updated', 'job.deleted', 'queue.cleared']);

  useEffect(() => {
    if (lastGlobalEvent) {
      // We could optimistically mutate `queue` here based on lastGlobalEvent.data
      // but for simplicity and correctness, catching a job mutation event
      // just triggers a background refetch
      fetchQueue();
    }
  }, [lastGlobalEvent, fetchQueue]);

  // Set up SSE for real-time progress
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
          // Successful event = reset reconnect counter
          sseReconnectAttempts.current = 0;
          switch (event) {
            case 'progress':
              setProgress(prev => {
                const next = new Map(prev);
                next.set(data.jobId, data);
                return next;
              });
              // Update queue item progress
              setQueue(prev => prev.map(item =>
                item.id === data.jobId
                  ? {
                    ...item,
                    progress: data.progress,
                    status: 'downloading' as const,
                    currentFileNum: data.currentFileNum,
                    totalFiles: data.totalFiles,
                    currentTrack: data.currentTrack,
                    trackProgress: data.trackProgress,
                    trackStatus: data.trackStatus,
                    statusMessage: data.statusMessage,
                    state: data.state,
                    speed: data.speed,
                    eta: data.eta,
                    size: data.size,
                    sizeleft: data.sizeleft,
                    tracks: data.tracks,
                  }
                  : item
              ));
              break;
            case 'started':
              setQueue(prev => prev.map(item =>
                item.id === data.jobId
                  ? { ...item, status: 'downloading' as const, progress: 0 }
                  : item
              ));
              dispatchActivityRefresh();
              break;
            case 'completed':
              setProgress(prev => {
                const next = new Map(prev);
                next.delete(data.jobId);
                return next;
              });
              setQueue(prev => prev.filter(item => item.id !== data.jobId));
              toastRef.current({
                title: "Download completed",
                description: data.title || "Track downloaded successfully",
              });
              dispatchActivityRefresh();
              break;
            case 'failed':
              setProgress(prev => {
                const next = new Map(prev);
                const previous = next.get(data.jobId);
                next.set(data.jobId, {
                  ...previous,
                  ...data,
                  progress: previous?.progress ?? data.progress ?? 0,
                  state: 'failed',
                  statusMessage: data.error || previous?.statusMessage,
                  tracks: previous?.tracks
                    ? previous.tracks.map(track => ({
                      ...track,
                      status: track.status === 'completed' || track.status === 'skipped' ? track.status : 'error',
                    }))
                    : data.tracks,
                });
                return next;
              });
              setQueue(prev => prev.map(item =>
                item.id === data.jobId
                  ? {
                    ...item,
                    status: 'failed' as const,
                    error: data.error,
                    statusMessage: data.error || item.statusMessage,
                    state: 'failed',
                    tracks: data.tracks ?? item.tracks,
                  }
                  : item
              ));
              toastRef.current({
                title: "Download failed",
                description: data.error || "An error occurred",
                variant: "destructive",
              });
              dispatchActivityRefresh();
              break;
            case 'queue-status':
              setIsPaused(data.isPaused);
              break;
            case 'status':
              setIsPaused(data.isPaused || false);
              break;
          }
        },
        (error) => {
          // Ignore expected errors caused by intentional close during re-init/unmount.
          if (isManualCloseRef.current || isUnmountedRef.current) {
            isManualCloseRef.current = false;
            return;
          }

          console.error('Progress stream error:', error);
          // Close to prevent native auto-reconnect storm
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          // Reconnect with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, sseReconnectAttempts.current), 30000);
          sseReconnectAttempts.current++;
          sseReconnectTimer = setTimeout(() => {
            if (!isUnmountedRef.current) {
              setupProgressStream();
            }
          }, delay);
        }
      );
    };

    setupProgressStream();
    fetchQueue();

    return () => {
      isUnmountedRef.current = true;
      if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      if (eventSourceRef.current) {
        isManualCloseRef.current = true;
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [fetchQueue]);

  const addToQueue = async (url: string, type: string, tidalId?: string) => {
    try {
      await api.addToQueue(url, type, tidalId);
      toastRef.current({
        title: "Added to queue",
        description: "Download will start automatically",
      });
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error adding to queue:', error);
      toastRef.current({
        title: "Failed to add to queue",
        description: error.message,
        variant: "destructive",
      });
      throw error;
    }
  };

  const processItem = async (id: number) => {
    try {
      await api.processQueueItem(id);
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error processing item:', error);
      toastRef.current({
        title: "Failed to start download",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const retryItem = async (id: number) => {
    try {
      const response = await api.retryQueueItem(id);
      setProgress(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      toastRef.current({
        title: response.action === 'queue-redownload' ? "Download queued" : "Retry queued",
        description: response.message,
      });
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error retrying item:', error);
      toastRef.current({
        title: "Failed to retry",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const deleteItem = async (id: number) => {
    try {
      await api.deleteQueueItem(id);
      setProgress(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error deleting item:', error);
      toastRef.current({
        title: "Failed to delete item",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const clearCompleted = async () => {
    try {
      await api.clearCompleted();
      setQueue(prev => prev.filter(item => item.status !== 'failed'));
      setProgress(prev => {
        const next = new Map(prev);
        for (const [id, state] of next.entries()) {
          if (state.state === 'failed' || state.state === 'completed') {
            next.delete(id);
          }
        }
        return next;
      });
      toastRef.current({
        title: "Queue cleared",
        description: "Finished downloads removed",
      });
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error clearing completed:', error);
      toastRef.current({
        title: "Failed to clear queue",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const pauseQueue = async () => {
    try {
      await api.pauseQueue();
      toastRef.current({
        title: "Queue paused",
        description: "Processing stopped",
      });
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error pausing queue:', error);
      toastRef.current({
        title: "Failed to pause queue",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const resumeQueue = async () => {
    try {
      await api.resumeQueue();
      toastRef.current({
        title: "Queue resumed",
        description: "Processing started",
      });
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error resuming queue:', error);
      toastRef.current({
        title: "Failed to resume queue",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const stats = {
    pending: Array.isArray(queue) ? queue.filter(item => item.status === 'pending').length : 0,
    downloading: Array.isArray(queue) ? queue.filter(item => item.status === 'downloading').length : 0,
    completed: Array.isArray(queue) ? queue.filter(item => item.status === 'completed').length : 0,
    failed: Array.isArray(queue) ? queue.filter(item => item.status === 'failed').length : 0,
    total: Array.isArray(queue) ? queue.length : 0,
  };

  const getProgress = (jobId: number): DownloadProgress | undefined => {
    return progress.get(jobId);
  };

  return (
    <QueueContext.Provider
      value={{
        queue,
        loading,
        stats,
        progress,
        isPaused,
        getProgress,
        addToQueue,
        processItem,
        retryItem,
        deleteItem,
        clearCompleted,
        pauseQueue,
        resumeQueue,
        refreshQueue: fetchQueue,
      }}
    >
      {children}
    </QueueContext.Provider>
  );
};
