import type {
  DownloadProgressContract as DownloadProgress,
  QueueStatusContract,
  TaskQueueStatContract,
} from "@contracts/status";

export type { DownloadProgress };

export type QueueStatsSummary = {
  pending: number;
  downloading: number;
  completed: number;
  failed: number;
  total: number;
};

type ProgressState = {
  byJobId: Map<number, DownloadProgress>;
  byProviderId: Map<string, DownloadProgress>;
};

const DOWNLOAD_QUEUE_JOB_TYPES = new Set([
  "DownloadAlbum",
  "DownloadTrack",
  "DownloadVideo",
  "ImportDownload",
]);

function cloneProgressState(state: ProgressState): ProgressState {
  return {
    byJobId: new Map(state.byJobId),
    byProviderId: new Map(state.byProviderId),
  };
}

function getRelevantStats(stats?: TaskQueueStatContract[]): TaskQueueStatContract[] {
  return Array.isArray(stats)
    ? stats.filter((stat) => DOWNLOAD_QUEUE_JOB_TYPES.has(String(stat.type || "")))
    : [];
}

export function createEmptyProgressState(): ProgressState {
  return {
    byJobId: new Map(),
    byProviderId: new Map(),
  };
}

export function deriveQueueStats(status?: QueueStatusContract | null): QueueStatsSummary {
  const relevantStats = getRelevantStats(status?.stats);

  const sumByStatus = (jobStatus: string) => relevantStats
    .filter((stat) => stat.status === jobStatus)
    .reduce((sum, stat) => sum + Number(stat.count || 0), 0);

  const pending = sumByStatus("pending");
  const downloading = sumByStatus("processing");
  const completed = sumByStatus("completed");
  const failed = sumByStatus("failed") + sumByStatus("cancelled");

  return {
    pending,
    downloading,
    completed,
    failed,
    total: pending + downloading + completed + failed,
  };
}

export function upsertProgressSnapshots(
  state: ProgressState,
  snapshots: DownloadProgress[],
): ProgressState {
  if (snapshots.length === 0) {
    return state;
  }

  const next = cloneProgressState(state);

  for (const snapshot of snapshots) {
    if (!snapshot || !Number.isFinite(snapshot.jobId) || snapshot.jobId <= 0) {
      continue;
    }

    const providerId = String(snapshot.providerId || "").trim();

    next.byJobId.set(snapshot.jobId, snapshot);
    if (providerId.length > 0) {
      next.byProviderId.set(providerId, snapshot);
    }
  }

  return next;
}

export function removeProgressSnapshot(
  state: ProgressState,
  jobId: number,
  providerId?: string | null,
): ProgressState {
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return state;
  }

  const next = cloneProgressState(state);
  const existing = next.byJobId.get(jobId);
  next.byJobId.delete(jobId);

  const resolvedProviderId = String(providerId || existing?.providerId || "").trim();
  if (resolvedProviderId.length > 0) {
    const current = next.byProviderId.get(resolvedProviderId);
    if (!current || current.jobId === jobId) {
      next.byProviderId.delete(resolvedProviderId);
    }
  }

  return next;
}
