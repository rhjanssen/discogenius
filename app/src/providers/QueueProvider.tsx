import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useGlobalEvents, type GlobalEventPayload, type JobStatusRaw } from "@/hooks/useGlobalEvents";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import type {
  DownloadProgressContract as DownloadProgress,
  QueueItemContract as QueueItem,
} from "@contracts/status";

export type { DownloadProgress, QueueItem };

const QUEUE_FALLBACK_REFRESH_MS = 45_000;
const QUEUE_MISSING_ITEM_GRACE_MS = 15_000;

type LiveQueueEvent = Partial<DownloadProgress> & {
  jobId?: number;
  type?: QueueItem['type'];
  tidalId?: string;
  title?: string;
  artist?: string;
  cover?: string | null;
};

type QueueGlobalJobEventData = {
  type?: unknown;
  status?: JobStatusRaw;
};

const STRUCTURAL_QUEUE_UPDATE_STATUSES = new Set<JobStatusRaw>(['pending', 'completed', 'failed', 'cancelled']);

const getQueueGlobalJobEventData = (data: unknown): QueueGlobalJobEventData | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }

  return data as QueueGlobalJobEventData;
};

const shouldRefreshQueueForGlobalEvent = (
  event: GlobalEventPayload,
  isDownloadQueueJobType: (value: unknown) => boolean,
): boolean => {
  if (event.type === 'queue.cleared' || event.type === 'job.added') {
    return true;
  }

  const jobEventData = getQueueGlobalJobEventData(event.data);
  if (!jobEventData || !isDownloadQueueJobType(jobEventData.type)) {
    return false;
  }

  if (event.type === 'job.deleted') {
    return true;
  }

  if (event.type !== 'job.updated') {
    return false;
  }

  return jobEventData.status !== undefined && STRUCTURAL_QUEUE_UPDATE_STATUSES.has(jobEventData.status);
};

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
  reorderItems: (params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number }) => Promise<void>;
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

const isImportState = (state?: DownloadProgress['state']): boolean =>
  state === 'importPending' || state === 'importing' || state === 'importFailed';

const isActiveLiveState = (state?: DownloadProgress['state']): boolean =>
  state === 'downloading' || state === 'importing';

const isImportQueueItem = (item?: QueueItem | null): boolean =>
  item?.stage === 'import' || isImportState(item?.state);

const resolveLiveQueueStage = (
  state: DownloadProgress['state'] | undefined,
  existing?: QueueItem,
): QueueItem['stage'] =>
  isImportState(state) || isImportQueueItem(existing) ? 'import' : 'download';

const resolveStartedLiveState = (
  data: LiveQueueEvent,
  existingItem?: QueueItem,
  existingProgress?: DownloadProgress,
): DownloadProgress['state'] => {
  if (data.state === 'importPending' || data.state === 'importing') {
    return 'importing';
  }

  if (data.state === 'downloading') {
    return 'downloading';
  }

  return isImportQueueItem(existingItem) || isImportState(existingProgress?.state)
    ? 'importing'
    : 'downloading';
};

const buildLiveProgressSnapshot = (data: LiveQueueEvent, existing?: DownloadProgress): DownloadProgress | null => {
  const jobId = Number(data.jobId ?? existing?.jobId);
  const type = data.type ?? existing?.type;

  if (!Number.isFinite(jobId) || jobId <= 0 || !type) {
    return null;
  }

  return {
    jobId,
    tidalId: data.tidalId ?? existing?.tidalId ?? '',
    type,
    title: data.title ?? existing?.title,
    artist: data.artist ?? existing?.artist,
    cover: data.cover ?? existing?.cover ?? null,
    progress: data.progress ?? existing?.progress ?? 0,
    currentFileNum: data.currentFileNum ?? existing?.currentFileNum,
    totalFiles: data.totalFiles ?? existing?.totalFiles,
    currentTrack: data.currentTrack ?? existing?.currentTrack,
    trackProgress: data.trackProgress ?? existing?.trackProgress,
    trackStatus: data.trackStatus ?? existing?.trackStatus,
    statusMessage: data.statusMessage ?? existing?.statusMessage,
    speed: data.speed ?? existing?.speed,
    eta: data.eta ?? existing?.eta,
    size: data.size ?? existing?.size,
    sizeleft: data.sizeleft ?? existing?.sizeleft,
    state: data.state ?? existing?.state ?? 'downloading',
    tracks: data.tracks ?? existing?.tracks,
  };
};

const buildLiveQueueItem = (data: LiveQueueEvent, existing?: QueueItem): QueueItem | null => {
  const jobId = Number(data.jobId ?? existing?.id);
  const type = data.type ?? existing?.type;

  if (!Number.isFinite(jobId) || jobId <= 0 || !type) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const stage = resolveLiveQueueStage(data.state, existing);

  let status: QueueItem['status'];
  if (data.state === 'failed' || data.state === 'importFailed') {
    status = 'failed';
  } else if (data.state === 'completed') {
    status = 'completed';
  } else if (data.state === 'importPending') {
    status = 'pending';
  } else if (stage === 'import') {
    status = 'processing';
  } else {
    status = 'downloading';
  }

  return {
    id: jobId,
    url: existing?.url ?? null,
    type,
    queuePosition: existing?.queuePosition,
    quality: data.quality ?? existing?.quality ?? null,
    stage,
    tidalId: data.tidalId ?? existing?.tidalId ?? null,
    path: existing?.path ?? null,
    status,
    progress: data.progress ?? existing?.progress ?? 0,
    error: status === 'failed' ? (data.statusMessage ?? existing?.error ?? null) : existing?.error ?? null,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
    started_at: existing?.started_at ?? timestamp,
    completed_at: status === 'completed' ? (existing?.completed_at ?? timestamp) : (existing?.completed_at ?? null),
    title: data.title ?? existing?.title,
    artist: data.artist ?? existing?.artist,
    cover: data.cover ?? existing?.cover ?? null,
    album_id: existing?.album_id ?? (type === 'album' ? (data.tidalId ?? null) : null),
    album_title: existing?.album_title ?? (type === 'album' ? (data.title ?? null) : null),
    currentFileNum: data.currentFileNum ?? existing?.currentFileNum,
    totalFiles: data.totalFiles ?? existing?.totalFiles,
    currentTrack: data.currentTrack ?? existing?.currentTrack,
    trackProgress: data.trackProgress ?? existing?.trackProgress,
    trackStatus: data.trackStatus ?? existing?.trackStatus,
    statusMessage: data.statusMessage ?? existing?.statusMessage,
    speed: data.speed ?? existing?.speed,
    eta: data.eta ?? existing?.eta,
    size: data.size ?? existing?.size,
    sizeleft: data.sizeleft ?? existing?.sizeleft,
    state: data.state ?? existing?.state ?? (stage === 'import' ? 'importing' : 'downloading'),
    tracks: data.tracks ?? existing?.tracks,
  };
};

const mergeMissingLiveQueueItems = (
  serverItems: QueueItem[],
  existingQueue: QueueItem[],
  liveProgress: Map<number, DownloadProgress>,
  seenAtById: Map<number, number>,
): QueueItem[] => {
  if (serverItems.length === 0 && existingQueue.length === 0 && liveProgress.size === 0) {
    return serverItems;
  }

  const now = Date.now();
  const serverIds = new Set(serverItems.map((item) => item.id));
  const optimisticItems = new Map<number, QueueItem>();

  for (const item of existingQueue) {
    if (serverIds.has(item.id)) {
      continue;
    }

    if (item.status === 'completed' || item.status === 'cancelled') {
      continue;
    }

    const live = liveProgress.get(item.id);
    const isLiveQueueState = item.status === 'pending' || item.status === 'downloading' || item.status === 'processing';
    const hasActiveLiveEvidence = Boolean(live && isActiveLiveState(live.state));
    const seenAt = seenAtById.get(item.id) ?? 0;
    const wasSeenRecently = seenAt > 0 && now - seenAt <= QUEUE_MISSING_ITEM_GRACE_MS;

    if (!isLiveQueueState || (!hasActiveLiveEvidence && !wasSeenRecently)) {
      continue;
    }

    optimisticItems.set(item.id, live ? (buildLiveQueueItem(live, item) ?? item) : item);
  }

  for (const [jobId, live] of liveProgress.entries()) {
    if (serverIds.has(jobId) || optimisticItems.has(jobId) || !isActiveLiveState(live.state)) {
      continue;
    }

    const optimisticItem = buildLiveQueueItem(live);
    if (optimisticItem) {
      optimisticItems.set(jobId, optimisticItem);
    }
  }

  return [...optimisticItems.values(), ...serverItems];
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
  const queueRef = useRef<QueueItem[]>([]);
  const progressRef = useRef<Map<number, DownloadProgress>>(new Map());
  const queueSeenAtRef = useRef<Map<number, number>>(new Map());
  const sseReconnectAttempts = useRef(0);
  const queueBackoffRef = useRef(10000);
  const queueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuePageSize = 100;

  const updateQueueState = useCallback((updater: (prev: QueueItem[]) => QueueItem[]) => {
    setQueue(prev => {
      const next = updater(prev);
      queueRef.current = next;
      return next;
    });
  }, []);

  const updateProgressState = useCallback((updater: (prev: Map<number, DownloadProgress>) => Map<number, DownloadProgress>) => {
    setProgress(prev => {
      const next = updater(prev);
      progressRef.current = next;
      return next;
    });
  }, []);

  const markQueueItemsSeen = useCallback((items: Array<{ id: number }>) => {
    if (items.length === 0) {
      return;
    }

    const now = Date.now();
    const next = new Map(queueSeenAtRef.current);
    for (const item of items) {
      next.set(item.id, now);
    }
    queueSeenAtRef.current = next;
  }, []);

  const forgetQueueItems = useCallback((jobIds: number[]) => {
    if (jobIds.length === 0) {
      return;
    }

    const next = new Map(queueSeenAtRef.current);
    for (const jobId of jobIds) {
      next.delete(jobId);
    }
    queueSeenAtRef.current = next;
  }, []);

  const pruneSeenQueueItems = useCallback((jobIds: number[]) => {
    const keepIds = new Set(jobIds);
    const now = Date.now();
    const next = new Map<number, number>();

    for (const [jobId, seenAt] of queueSeenAtRef.current.entries()) {
      if (keepIds.has(jobId) || now - seenAt <= QUEUE_MISSING_ITEM_GRACE_MS) {
        next.set(jobId, seenAt);
      }
    }

    queueSeenAtRef.current = next;
  }, []);

  const isDownloadQueueJobType = useCallback((value: unknown) => {
    const type = String(value || "");
    return type.startsWith("Download") || type === "ImportDownload";
  }, []);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const fetchQueue = useCallback(async () => {
    try {
      const serverItems: QueueItem[] = [];
      let offset = 0;

      while (true) {
        const data = await api.getQueue({ limit: queuePageSize, offset });
        const pageItems = data.items;
        serverItems.push(...pageItems);

        if (!data.hasMore || pageItems.length === 0) {
          break;
        }

        offset += pageItems.length;
      }

      markQueueItemsSeen(serverItems);

      const mergedQueueItems = mergeMissingLiveQueueItems(
        serverItems,
        queueRef.current,
        progressRef.current,
        queueSeenAtRef.current,
      );
      pruneSeenQueueItems(mergedQueueItems.map((item) => item.id));
      queueRef.current = mergedQueueItems;
      setQueue(mergedQueueItems);
      setProgress(prev => {
        const next = new Map<number, DownloadProgress>();
        const serverItemIds = new Set(mergedQueueItems.map((item) => item.id));

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

        for (const [jobId, existing] of prev.entries()) {
          if (serverItemIds.has(jobId) || next.has(jobId)) {
            continue;
          }

          if (isActiveLiveState(existing.state)) {
            next.set(jobId, existing);
          }
        }

        progressRef.current = next;
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
  }, [markQueueItemsSeen, pruneSeenQueueItems]);

  const scheduleQueueRefresh = useCallback((delay = 250) => {
    if (queueRefreshTimerRef.current) {
      clearTimeout(queueRefreshTimerRef.current);
    }

    queueRefreshTimerRef.current = setTimeout(() => {
      queueRefreshTimerRef.current = null;
      void fetchQueue();
    }, delay);
  }, [fetchQueue]);

  const ensureLiveQueueItem = useCallback((data: LiveQueueEvent) => {
    const jobId = Number(data.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      scheduleQueueRefresh(0);
      return false;
    }

    const existing = queueRef.current.find((item) => item.id === jobId);
    const nextItem = buildLiveQueueItem(data, existing);
    if (!nextItem) {
      scheduleQueueRefresh(0);
      return false;
    }

    markQueueItemsSeen([{ id: jobId }]);

    const wasKnown = Boolean(existing);
    setQueue(prev => {
      const existingIndex = prev.findIndex((item) => item.id === jobId);
      if (existingIndex === -1) {
        // Only insert if no item with same jobId exists
        const next = [nextItem, ...prev];
        queueRef.current = next;
        return next;
      }
      // Update existing item in-place
      const next = prev.map((item, index) => index === existingIndex ? { ...item, ...nextItem } : item);
      queueRef.current = next;
      return next;
    });

    if (!wasKnown) {
      scheduleQueueRefresh(0);
    }

    return !wasKnown;
  }, [markQueueItemsSeen, scheduleQueueRefresh]);

  // Use the global event stream to know when to refetch the full queue
  // or apply optimistic updates when jobs are added/removed.
  const lastGlobalEvent = useGlobalEvents(['job.added', 'job.updated', 'job.deleted', 'queue.cleared']);

  useEffect(() => {
    if (!lastGlobalEvent) {
      return;
    }

    if (shouldRefreshQueueForGlobalEvent(lastGlobalEvent, isDownloadQueueJobType)) {
      scheduleQueueRefresh(0);
    }
  }, [isDownloadQueueJobType, lastGlobalEvent, scheduleQueueRefresh]);

  // Set up SSE for real-time progress
  useEffect(() => {
    let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let queueFallbackInterval: ReturnType<typeof setInterval> | null = null;
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
            case 'progress-batch':
              {
                // data is an array of progress updates — process all in one state update
                const batch: LiveQueueEvent[] = Array.isArray(data) ? data : [data];
                let needsActivityRefresh = false;
                for (const item of batch) {
                  if (ensureLiveQueueItem(item)) {
                    needsActivityRefresh = true;
                  }
                }
                if (needsActivityRefresh) {
                  dispatchActivityRefresh();
                }

                // Single progress state update for all jobs
                updateProgressState(prev => {
                  const next = new Map(prev);
                  for (const item of batch) {
                    const snapshot = buildLiveProgressSnapshot(item, prev.get(item.jobId));
                    if (snapshot) {
                      next.set(item.jobId, snapshot);
                    }
                  }
                  return next;
                });

                // Single queue state update for all jobs
                const ts = new Date().toISOString();
                const batchMap = new Map(batch.map(item => [item.jobId, item]));
                updateQueueState(prev => prev.map(queueItem => {
                  const evt = batchMap.get(queueItem.id);
                  if (!evt) return queueItem;
                  const updated = buildLiveQueueItem(evt, queueItem);
                  return updated ? { ...updated, updated_at: ts } : queueItem;
                }));
              }
              break;
            case 'started':
              // Optimistic in-place update + signal re-fetch
              {
                const existingItem = queueRef.current.find((item) => item.id === data.jobId);
                const existingProgress = progressRef.current.get(data.jobId);
                const startedState = resolveStartedLiveState(data, existingItem, existingProgress);
                ensureLiveQueueItem({ ...data, progress: 0, state: startedState });
              }
              scheduleQueueRefresh();
              dispatchActivityRefresh();
              break;
            case 'completed':
              // Optimistic remove + signal re-fetch for ground truth
              updateProgressState(prev => {
                const next = new Map(prev);
                next.delete(data.jobId);
                return next;
              });
              updateQueueState(prev => prev.filter(item => item.id !== data.jobId));
              forgetQueueItems([data.jobId]);
              toastRef.current({
                title: "Download completed",
                description: data.title || "Track downloaded successfully",
              });
              scheduleQueueRefresh();
              dispatchActivityRefresh();
              break;
            case 'failed':
              // Optimistic status patch + signal re-fetch
              updateQueueState(prev => prev.map(item =>
                item.id === data.jobId
                  ? {
                    ...item,
                    status: 'failed' as const,
                    error: data.error,
                    state: data.state || 'failed',
                  }
                  : item
              ));
              toastRef.current({
                title: "Download failed",
                description: data.error || "An error occurred",
                variant: "destructive",
              });
              scheduleQueueRefresh();
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
    queueFallbackInterval = setInterval(() => {
      void fetchQueue();
    }, QUEUE_FALLBACK_REFRESH_MS);

    return () => {
      isUnmountedRef.current = true;
      if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
      if (queueRefreshTimerRef.current) clearTimeout(queueRefreshTimerRef.current);
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      if (queueFallbackInterval) clearInterval(queueFallbackInterval);
      if (eventSourceRef.current) {
        isManualCloseRef.current = true;
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [ensureLiveQueueItem, fetchQueue, forgetQueueItems, scheduleQueueRefresh, updateProgressState, updateQueueState]);

  const addToQueue = async (url: string, type: string, tidalId?: string) => {
    try {
      await api.addToQueue(url, type, tidalId);
      toastRef.current({
        title: "Added to queue",
        description: "Download will start automatically",
      });
      scheduleQueueRefresh();
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
      updateQueueState(prev => prev.map(item =>
        item.id === id && item.status === 'pending'
          ? { ...item, status: 'downloading' as const }
          : item
      ));
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
      updateProgressState(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      toastRef.current({
        title: response.action === 'queue-redownload' ? "Download queued" : "Retry queued",
        description: response.message,
      });
      scheduleQueueRefresh();
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
      updateProgressState(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      updateQueueState(prev => prev.filter(item => item.id !== id));
      forgetQueueItems([id]);
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

  const reorderItems = async (params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number }) => {
    try {
      await api.reorderQueueItems(params);
      await fetchQueue();
      dispatchActivityRefresh();
    } catch (error: any) {
      console.error('Error reordering queue:', error);
      toastRef.current({
        title: "Failed to reorder queue",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const clearCompleted = async () => {
    try {
      await api.clearCompleted();
      updateQueueState(prev => prev.filter(item => !['completed', 'failed', 'cancelled'].includes(item.status)));
      updateProgressState(prev => {
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
      setIsPaused(true);
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
      setIsPaused(false);
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
    downloading: Array.isArray(queue) ? queue.filter(item => item.status === 'downloading' || item.status === 'processing').length : 0,
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
        reorderItems,
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
