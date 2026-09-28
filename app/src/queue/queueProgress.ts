import type {
  DownloadProgressContract as DownloadProgress,
  QueueStatusContract,
  TaskQueueStatContract,
} from "@contracts/status";
import { applyTrackProgress, mergeTrackProgress } from "@contracts/track-progress";

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

  const pending = sumByStatus("queued");
  const downloading = sumByStatus("started");
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

    const previous = next.byJobId.get(snapshot.jobId);
    const importing = (state?: string) => state === "importPending" || state === "importing";
    // A late download tick cannot move the same command backwards after handoff.
    if (importing(previous?.state) && (snapshot.state === "downloading" || snapshot.state === "queued")) continue;
    const enteringImport = importing(snapshot.state) && !importing(previous?.state);
    const merged = {
      ...previous,
      ...snapshot,
      tracks: enteringImport
        ? snapshot.tracks ?? previous?.tracks?.map(track => ({ ...track, status: track.status === "skipped" ? "skipped" as const : "queued" as const }))
        : mergeTrackProgress(previous?.tracks, snapshot.tracks),
    };
    const providerId = String(merged.providerId || "").trim();

    next.byJobId.set(snapshot.jobId, merged);
    if (providerId.length > 0) {
      next.byProviderId.set(providerId, merged);
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

export type QueueProgressEvent = Partial<DownloadProgress> & {
  jobId?: number;
  commandId?: number;
  providerId?: string;
  type?: DownloadProgress["type"];
  state?: DownloadProgress["state"];
  error?: string | null;
};

export function buildProgressSnapshot(
  data: QueueProgressEvent,
  existing?: DownloadProgress,
): DownloadProgress | null {
  const jobId = Number(data.jobId ?? data.commandId ?? existing?.jobId);
  const providerId = String(data.providerId ?? existing?.providerId ?? "").trim();
  const type = data.type ?? existing?.type;

  if (!Number.isFinite(jobId) || jobId <= 0 || !type || providerId.length === 0) {
    return null;
  }

  const importing = (state?: string) => state === "importPending" || state === "importing";
  const enteringImport = importing(data.state) && !importing(existing?.state);
  const priorPhase = enteringImport ? undefined : existing;
  const sourceTracks = data.tracks ?? (enteringImport
    ? existing?.tracks?.map(track => ({ ...track, status: track.status === "skipped" ? "skipped" as const : "queued" as const }))
    : existing?.tracks);
  const tracks = sourceTracks ? applyTrackProgress(sourceTracks, data) : undefined;

  return {
    jobId,
    providerId,
    type,
    quality: data.quality ?? existing?.quality ?? null,
    title: data.title ?? existing?.title,
    artist: data.artist ?? existing?.artist,
    cover: data.cover ?? existing?.cover ?? null,
    progress: data.progress ?? priorPhase?.progress ?? 0,
    speed: data.speed ?? priorPhase?.speed,
    eta: data.eta ?? priorPhase?.eta,
    totalFiles: data.totalFiles ?? existing?.totalFiles,
    currentFileNum: data.currentFileNum ?? priorPhase?.currentFileNum,
    currentTrack: data.currentTrack ?? priorPhase?.currentTrack,
    currentProviderTrackId: data.currentProviderTrackId ?? priorPhase?.currentProviderTrackId,
    currentTrackNum: data.currentTrackNum ?? priorPhase?.currentTrackNum,
    currentVolumeNum: data.currentVolumeNum ?? priorPhase?.currentVolumeNum,
    trackProgress: data.trackProgress ?? priorPhase?.trackProgress,
    trackStatus: data.trackStatus ?? priorPhase?.trackStatus,
    statusMessage: data.statusMessage ?? (typeof data.error === "string" ? data.error : priorPhase?.statusMessage),
    state: data.state ?? existing?.state ?? "downloading",
    tracks,
    size: data.size ?? existing?.size,
    sizeleft: data.sizeleft ?? priorPhase?.sizeleft,
  };
}
