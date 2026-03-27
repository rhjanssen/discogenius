import {
  expectArray,
  expectBoolean,
  expectIdentifierString,
  expectNullableString,
  expectNumber,
  expectOptionalBoolean,
  expectOptionalNumber,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";

export type QueueItemStatusContract = "pending" | "processing" | "downloading" | "completed" | "failed" | "cancelled";
export type QueueStageContract = "download" | "import";
export type DownloadTrackStatusContract = "queued" | "downloading" | "completed" | "error" | "skipped";
export type DownloadStateContract =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "paused"
  | "importPending"
  | "importing"
  | "importFailed";
export type DownloadContentTypeContract = "track" | "video" | "album" | "playlist";

export interface DownloadTrackProgressContract {
  title: string;
  trackNum?: number;
  status: DownloadTrackStatusContract;
}

export interface QueueItemContract {
  id: number;
  url: string | null;
  type: DownloadContentTypeContract;
  queuePosition?: number;
  quality?: string | null;
  stage?: QueueStageContract;
  tidalId: string | null;
  path: string | null;
  status: QueueItemStatusContract;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  title?: string;
  artist?: string;
  cover?: string | null;
  album_id?: string | null;
  album_title?: string | null;
  currentFileNum?: number;
  totalFiles?: number;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: DownloadTrackStatusContract;
  statusMessage?: string;
  speed?: string;
  eta?: string;
  size?: number;
  sizeleft?: number;
  state?: DownloadStateContract;
  tracks?: DownloadTrackProgressContract[];
}

export interface QueueListResponseContract {
  items: QueueItemContract[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface TaskQueueStatContract {
  type: string;
  status: string;
  count: number;
}

export interface QueueStatusContract {
  isPaused: boolean;
  processing: boolean;
  currentJobId?: number;
  currentTidalId?: string;
  currentType?: string;
  stats?: TaskQueueStatContract[];
}

export interface DownloadProgressContract {
  jobId: number;
  tidalId: string;
  type: DownloadContentTypeContract;
  quality?: string | null;
  title?: string;
  artist?: string;
  cover?: string | null;
  progress: number;
  speed?: string;
  eta?: string;
  currentFile?: string;
  totalFiles?: number;
  currentFileNum?: number;
  currentTrack?: string;
  trackProgress?: number;
  trackStatus?: DownloadTrackStatusContract;
  statusMessage?: string;
  state?: DownloadStateContract;
  tracks?: DownloadTrackProgressContract[];
  size?: number;
  sizeleft?: number;
}

export interface DownloadStartedEventContract {
  jobId: number;
  tidalId: string;
  type: DownloadContentTypeContract;
  quality?: string | null;
  title?: string;
  artist?: string;
  cover?: string | null;
}

export interface DownloadCompletedEventContract extends DownloadStartedEventContract {
  path?: string;
}

export interface DownloadFailedEventContract extends DownloadStartedEventContract {
  error: string;
}

export interface ActivityJobContract {
  id: number | string;
  type: string;
  description: string;
  queuePosition?: number;
  progress?: number;
  startTime: number;
  endTime?: number;
  status?: string;
  error?: string;
  trigger?: number;
  payload?: unknown;
}

export interface ActivityListResponseContract {
  items: ActivityJobContract[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface CommandStatsBucketContract {
  pending?: number;
  processing?: number;
  failed?: number;
}

export interface CommandStatsContract {
  downloads?: CommandStatsBucketContract;
  scans?: CommandStatsBucketContract;
  other?: CommandStatsBucketContract;
}

export interface RunningCommandContract {
  id: number;
  type: string;
  name: string;
  isExclusive: boolean;
  isTypeExclusive: boolean;
  requiresDiskAccess: boolean;
}

export interface RateLimitMetricsContract {
  currentIntervalMs: number;
  consecutiveSuccesses: number;
  recent429Rate: string;
  rateLimitUntil?: string | null;
}

export interface ActivitySummaryContract {
  pending: number;
  processing: number;
  history: number;
}

export interface StatusOverviewContract {
  activity: ActivitySummaryContract;
  taskQueueStats: TaskQueueStatContract[];
  commandStats: CommandStatsContract;
  runningCommands?: RunningCommandContract[];
  rateLimitMetrics?: RateLimitMetricsContract;
}

function parseDownloadTrackProgressContract(value: unknown, index: number, label: string): DownloadTrackProgressContract {
  const record = expectRecord(value, `${label}[${index}]`);
  const status = expectString(record.status, `${label}[${index}].status`);
  if (!["queued", "downloading", "completed", "error", "skipped"].includes(status)) {
    throw new Error(`${label}[${index}].status must be a known download track status`);
  }

  return {
    title: expectString(record.title, `${label}[${index}].title`),
    trackNum: expectOptionalNumber(record.trackNum, `${label}[${index}].trackNum`),
    status: status as DownloadTrackStatusContract,
  };
}

function parseTaskQueueStatContract(value: unknown, index: number): TaskQueueStatContract {
  const label = `taskQueueStats[${index}]`;
  const record = expectRecord(value, label);
  return {
    type: expectString(record.type, `${label}.type`),
    status: expectString(record.status, `${label}.status`),
    count: expectNumber(record.count, `${label}.count`),
  };
}

function parseQueueItemContract(value: unknown, index: number): QueueItemContract {
  const label = `queue.items[${index}]`;
  const record = expectRecord(value, label);
  const type = expectString(record.type, `${label}.type`);
  const status = expectString(record.status, `${label}.status`);
  const stage = record.stage === undefined ? undefined : expectString(record.stage, `${label}.stage`);
  const trackStatus = record.trackStatus === undefined ? undefined : expectString(record.trackStatus, `${label}.trackStatus`);
  const state = record.state === undefined ? undefined : expectString(record.state, `${label}.state`);

  return {
    id: expectNumber(record.id, `${label}.id`),
    url: expectNullableString(record.url, `${label}.url`) ?? null,
    type: type as DownloadContentTypeContract,
    queuePosition: expectOptionalNumber(record.queuePosition, `${label}.queuePosition`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    stage: stage as QueueStageContract | undefined,
    tidalId: expectNullableString(record.tidalId, `${label}.tidalId`) ?? null,
    path: expectNullableString(record.path, `${label}.path`) ?? null,
    status: status as QueueItemStatusContract,
    progress: expectNumber(record.progress, `${label}.progress`),
    error: expectNullableString(record.error, `${label}.error`) ?? null,
    created_at: expectString(record.created_at, `${label}.created_at`),
    updated_at: expectString(record.updated_at, `${label}.updated_at`),
    started_at: expectNullableString(record.started_at, `${label}.started_at`),
    completed_at: expectNullableString(record.completed_at, `${label}.completed_at`),
    title: expectOptionalString(record.title, `${label}.title`),
    artist: expectOptionalString(record.artist, `${label}.artist`),
    cover: expectNullableString(record.cover, `${label}.cover`),
    album_id: expectNullableString(record.album_id, `${label}.album_id`),
    album_title: expectNullableString(record.album_title, `${label}.album_title`),
    currentFileNum: expectOptionalNumber(record.currentFileNum, `${label}.currentFileNum`),
    totalFiles: expectOptionalNumber(record.totalFiles, `${label}.totalFiles`),
    currentTrack: expectOptionalString(record.currentTrack, `${label}.currentTrack`),
    trackProgress: expectOptionalNumber(record.trackProgress, `${label}.trackProgress`),
    trackStatus: trackStatus as DownloadTrackStatusContract | undefined,
    statusMessage: expectOptionalString(record.statusMessage, `${label}.statusMessage`),
    speed: expectOptionalString(record.speed, `${label}.speed`),
    eta: expectOptionalString(record.eta, `${label}.eta`),
    size: expectOptionalNumber(record.size, `${label}.size`),
    sizeleft: expectOptionalNumber(record.sizeleft, `${label}.sizeleft`),
    state: state as DownloadStateContract | undefined,
    tracks: record.tracks === undefined
      ? undefined
      : expectArray(record.tracks, `${label}.tracks`, (item, trackIndex) =>
        parseDownloadTrackProgressContract(item, trackIndex, `${label}.tracks`)),
  };
}

function parseActivityJobContract(value: unknown, index: number, label: string): ActivityJobContract {
  const record = expectRecord(value, `${label}[${index}]`);
  return {
    id: typeof record.id === "number" ? record.id : expectIdentifierString(record.id, `${label}[${index}].id`),
    type: expectString(record.type, `${label}[${index}].type`),
    description: expectString(record.description, `${label}[${index}].description`),
    queuePosition: expectOptionalNumber(record.queuePosition, `${label}[${index}].queuePosition`),
    progress: expectOptionalNumber(record.progress, `${label}[${index}].progress`),
    startTime: expectNumber(record.startTime, `${label}[${index}].startTime`),
    endTime: expectOptionalNumber(record.endTime, `${label}[${index}].endTime`),
    status: expectOptionalString(record.status, `${label}[${index}].status`),
    error: expectOptionalString(record.error, `${label}[${index}].error`),
    trigger: expectOptionalNumber(record.trigger, `${label}[${index}].trigger`),
    payload: record.payload,
  };
}

function parseCommandStatsBucketContract(value: unknown, label: string): CommandStatsBucketContract {
  const record = expectRecord(value, label);
  return {
    pending: expectOptionalNumber(record.pending, `${label}.pending`),
    processing: expectOptionalNumber(record.processing, `${label}.processing`),
    failed: expectOptionalNumber(record.failed, `${label}.failed`),
  };
}

function parseRunningCommandContract(value: unknown, index: number): RunningCommandContract {
  const label = `runningCommands[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectNumber(record.id, `${label}.id`),
    type: expectString(record.type, `${label}.type`),
    name: expectString(record.name, `${label}.name`),
    isExclusive: expectBoolean(record.isExclusive, `${label}.isExclusive`),
    isTypeExclusive: expectBoolean(record.isTypeExclusive, `${label}.isTypeExclusive`),
    requiresDiskAccess: expectBoolean(record.requiresDiskAccess, `${label}.requiresDiskAccess`),
  };
}

function parseRateLimitMetricsContract(value: unknown): RateLimitMetricsContract {
  const record = expectRecord(value, "rateLimitMetrics");
  return {
    currentIntervalMs: expectNumber(record.currentIntervalMs, "rateLimitMetrics.currentIntervalMs"),
    consecutiveSuccesses: expectNumber(record.consecutiveSuccesses, "rateLimitMetrics.consecutiveSuccesses"),
    recent429Rate: expectString(record.recent429Rate, "rateLimitMetrics.recent429Rate"),
    rateLimitUntil: expectNullableString(record.rateLimitUntil, "rateLimitMetrics.rateLimitUntil"),
  };
}

function parseActivitySummaryContract(value: unknown): ActivitySummaryContract {
  const record = expectRecord(value, "activity");
  return {
    pending: expectNumber(record.pending, "activity.pending"),
    processing: expectNumber(record.processing, "activity.processing"),
    history: expectNumber(record.history, "activity.history"),
  };
}

export function parseQueueListResponseContract(value: unknown): QueueListResponseContract {
  const record = expectRecord(value, "queue");
  return {
    items: expectArray(record.items, "queue.items", parseQueueItemContract),
    total: expectNumber(record.total, "queue.total"),
    limit: expectNumber(record.limit, "queue.limit"),
    offset: expectNumber(record.offset, "queue.offset"),
    hasMore: expectBoolean(record.hasMore, "queue.hasMore"),
  };
}

export function parseQueueStatusContract(value: unknown): QueueStatusContract {
  const record = expectRecord(value, "queueStatus");
  return {
    isPaused: expectBoolean(record.isPaused, "queueStatus.isPaused"),
    processing: expectBoolean(record.processing, "queueStatus.processing"),
    currentJobId: expectOptionalNumber(record.currentJobId, "queueStatus.currentJobId"),
    currentTidalId: expectOptionalString(record.currentTidalId, "queueStatus.currentTidalId"),
    currentType: expectOptionalString(record.currentType, "queueStatus.currentType"),
    stats: record.stats === undefined ? undefined : expectArray(record.stats, "queueStatus.stats", parseTaskQueueStatContract),
  };
}

export function parseActivityListResponseContract(value: unknown): ActivityListResponseContract {
  const record = expectRecord(value, "activityList");
  return {
    items: expectArray(record.items, "activityList.items", (item, index) =>
      parseActivityJobContract(item, index, "activityList.items")),
    total: expectNumber(record.total, "activityList.total"),
    limit: expectNumber(record.limit, "activityList.limit"),
    offset: expectNumber(record.offset, "activityList.offset"),
    hasMore: expectBoolean(record.hasMore, "activityList.hasMore"),
  };
}

export function parseDownloadProgressContract(value: unknown): DownloadProgressContract {
  const record = expectRecord(value, "downloadProgress");
  const type = expectString(record.type, "downloadProgress.type");
  const trackStatus = record.trackStatus === undefined ? undefined : expectString(record.trackStatus, "downloadProgress.trackStatus");
  const state = record.state === undefined ? undefined : expectString(record.state, "downloadProgress.state");

  return {
    jobId: expectNumber(record.jobId, "downloadProgress.jobId"),
    tidalId: expectIdentifierString(record.tidalId, "downloadProgress.tidalId"),
    type: type as DownloadContentTypeContract,
    quality: expectNullableString(record.quality, "downloadProgress.quality"),
    title: expectOptionalString(record.title, "downloadProgress.title"),
    artist: expectOptionalString(record.artist, "downloadProgress.artist"),
    cover: expectNullableString(record.cover, "downloadProgress.cover"),
    progress: expectNumber(record.progress, "downloadProgress.progress"),
    speed: expectOptionalString(record.speed, "downloadProgress.speed"),
    eta: expectOptionalString(record.eta, "downloadProgress.eta"),
    currentFile: expectOptionalString(record.currentFile, "downloadProgress.currentFile"),
    totalFiles: expectOptionalNumber(record.totalFiles, "downloadProgress.totalFiles"),
    currentFileNum: expectOptionalNumber(record.currentFileNum, "downloadProgress.currentFileNum"),
    currentTrack: expectOptionalString(record.currentTrack, "downloadProgress.currentTrack"),
    trackProgress: expectOptionalNumber(record.trackProgress, "downloadProgress.trackProgress"),
    trackStatus: trackStatus as DownloadTrackStatusContract | undefined,
    statusMessage: expectOptionalString(record.statusMessage, "downloadProgress.statusMessage"),
    state: state as DownloadStateContract | undefined,
    tracks: record.tracks === undefined
      ? undefined
      : expectArray(record.tracks, "downloadProgress.tracks", (item, index) =>
        parseDownloadTrackProgressContract(item, index, "downloadProgress.tracks")),
    size: expectOptionalNumber(record.size, "downloadProgress.size"),
    sizeleft: expectOptionalNumber(record.sizeleft, "downloadProgress.sizeleft"),
  };
}

function parseDownloadStartedBase(value: unknown, label: string): DownloadStartedEventContract {
  const record = expectRecord(value, label);
  const type = expectString(record.type, `${label}.type`);
  return {
    jobId: expectNumber(record.jobId, `${label}.jobId`),
    tidalId: expectIdentifierString(record.tidalId, `${label}.tidalId`),
    type: type as DownloadContentTypeContract,
    quality: expectNullableString(record.quality, `${label}.quality`),
    title: expectOptionalString(record.title, `${label}.title`),
    artist: expectOptionalString(record.artist, `${label}.artist`),
    cover: expectNullableString(record.cover, `${label}.cover`),
  };
}

export function parseDownloadStartedEventContract(value: unknown): DownloadStartedEventContract {
  return parseDownloadStartedBase(value, "downloadStarted");
}

export function parseDownloadCompletedEventContract(value: unknown): DownloadCompletedEventContract {
  const parsed = parseDownloadStartedBase(value, "downloadCompleted");
  const record = expectRecord(value, "downloadCompleted");
  return {
    ...parsed,
    path: expectOptionalString(record.path, "downloadCompleted.path"),
  };
}

export function parseDownloadFailedEventContract(value: unknown): DownloadFailedEventContract {
  const parsed = parseDownloadStartedBase(value, "downloadFailed");
  const record = expectRecord(value, "downloadFailed");
  return {
    ...parsed,
    error: expectString(record.error, "downloadFailed.error"),
  };
}

export function parseStatusOverviewContract(value: unknown): StatusOverviewContract {
  const record = expectRecord(value, "statusOverview");
  return {
    activity: parseActivitySummaryContract(record.activity),
    taskQueueStats: expectArray(record.taskQueueStats, "statusOverview.taskQueueStats", parseTaskQueueStatContract),
    commandStats: record.commandStats === undefined
      ? {}
      : (() => {
        const stats = expectRecord(record.commandStats, "statusOverview.commandStats");
        return {
          downloads: stats.downloads === undefined ? undefined : parseCommandStatsBucketContract(stats.downloads, "statusOverview.commandStats.downloads"),
          scans: stats.scans === undefined ? undefined : parseCommandStatsBucketContract(stats.scans, "statusOverview.commandStats.scans"),
          other: stats.other === undefined ? undefined : parseCommandStatsBucketContract(stats.other, "statusOverview.commandStats.other"),
        };
      })(),
    runningCommands: record.runningCommands === undefined
      ? undefined
      : expectArray(record.runningCommands, "statusOverview.runningCommands", parseRunningCommandContract),
    rateLimitMetrics: record.rateLimitMetrics === undefined
      ? undefined
      : parseRateLimitMetricsContract(record.rateLimitMetrics),
  };
}
