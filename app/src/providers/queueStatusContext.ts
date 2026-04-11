import { createContext } from "react";
import type { DownloadProgress, QueueStatsSummary } from "@/queue/queueProgress";

export type QueueStatusContextType = {
  loading: boolean;
  stats: QueueStatsSummary;
  isPaused: boolean;
  progressByJobId: Map<number, DownloadProgress>;
  progressByTidalId: Map<string, DownloadProgress>;
  getProgress: (jobId: number) => DownloadProgress | undefined;
  getProgressByTidalId: (tidalId: string) => DownloadProgress | undefined;
  addToQueue: (url: string, type: string, tidalId?: string) => Promise<void>;
  processItem: (id: number) => Promise<void>;
  retryItem: (id: number) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  reorderItems: (
    params: { jobIds: number[]; beforeJobId?: number; afterJobId?: number },
    options?: { refresh?: boolean; dispatchActivity?: boolean },
  ) => Promise<void>;
  clearCompleted: () => Promise<void>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  refreshQueueStatus: () => Promise<void>;
};

export const QueueStatusContext = createContext<QueueStatusContextType | undefined>(undefined);
