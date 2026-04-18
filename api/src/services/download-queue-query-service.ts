import { db } from "../database.js";
import type {
  DownloadProgressContract,
  QueueItemContract,
  QueueListResponseContract,
  QueueStatusContract,
} from "../contracts/status.js";
import { downloadProcessor } from "./download-processor.js";
import {
  DOWNLOAD_JOB_TYPES,
  DOWNLOAD_OR_IMPORT_JOB_TYPES,
  JobTypes,
  TaskQueueService,
} from "./queue.js";

type QueueJobRow = {
  id: number;
  type: string;
  status: string;
  ref_id?: string | null;
  payload?: Record<string, unknown>;
  progress?: number;
  error?: string | null;
  created_at: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

type QueueDetailsFilters = {
  artistId?: string;
  albumIds?: string[];
  tidalIds?: string[];
};

type NormalizedQueueDetailsFilters = {
  artistId?: string;
  albumIds: string[];
  tidalIds: string[];
};

function getOptionalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function normalizeDistinctIdentifiers(values?: readonly string[] | null): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => getOptionalString(value))
        .filter((value): value is string => value !== null),
    ),
  );
}

function resolveQueueItemContentType(job: QueueJobRow): QueueItemContract["type"] {
  if (job.type === JobTypes.DownloadVideo) {
    return "video";
  }

  if (job.type === JobTypes.DownloadAlbum) {
    return "album";
  }

  if (job.type === JobTypes.DownloadPlaylist) {
    return "playlist";
  }

  if (job.type === JobTypes.ImportDownload) {
    const payloadType = getOptionalString(job.payload?.type);
    if (payloadType === "video" || payloadType === "album" || payloadType === "playlist") {
      return payloadType;
    }
  }

  return "track";
}

function getJobTidalId(job: QueueJobRow): string | null {
  return getOptionalString(job.ref_id) ?? getOptionalString(job.payload?.tidalId);
}

function getJobAlbumId(job: QueueJobRow): string | null {
  const payloadAlbumId = getOptionalString(
    job.payload?.album_id
    ?? job.payload?.albumId
    ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
  );
  if (payloadAlbumId) {
    return payloadAlbumId;
  }

  const contentType = resolveQueueItemContentType(job);
  const tidalId = getJobTidalId(job);

  if (!tidalId) {
    return null;
  }

  if (contentType === "album") {
    return tidalId;
  }

  if (contentType === "track" || contentType === "video") {
    const row = db.prepare(`
      SELECT album_id
      FROM media
      WHERE id = ?
    `).get(tidalId) as { album_id?: string | number | null } | undefined;

    return getOptionalString(row?.album_id);
  }

  return null;
}

function getJobArtistId(job: QueueJobRow): string | null {
  const payloadArtistId = getOptionalString(
    job.payload?.artist_id
    ?? job.payload?.artistId
    ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.artistId,
  );
  if (payloadArtistId) {
    return payloadArtistId;
  }

  const contentType = resolveQueueItemContentType(job);
  const tidalId = getJobTidalId(job);

  if (!tidalId) {
    return null;
  }

  if (contentType === "album") {
    const row = db.prepare(`
      SELECT artist_id
      FROM albums
      WHERE id = ?
    `).get(tidalId) as { artist_id?: string | number | null } | undefined;

    return getOptionalString(row?.artist_id);
  }

  if (contentType === "track" || contentType === "video") {
    const row = db.prepare(`
      SELECT artist_id
      FROM media
      WHERE id = ?
    `).get(tidalId) as { artist_id?: string | number | null } | undefined;

    return getOptionalString(row?.artist_id);
  }

  return null;
}

function normalizeQueueDetailsFilters(filters: QueueDetailsFilters): NormalizedQueueDetailsFilters {
  return {
    artistId: getOptionalString(filters.artistId) ?? undefined,
    albumIds: normalizeDistinctIdentifiers(filters.albumIds),
    tidalIds: normalizeDistinctIdentifiers(filters.tidalIds),
  };
}

function matchesQueueDetails(job: QueueJobRow, filters: NormalizedQueueDetailsFilters): boolean {
  if (filters.artistId && getJobArtistId(job) !== filters.artistId) {
    return false;
  }

  if (filters.albumIds.length > 0) {
    const albumId = getJobAlbumId(job);
    if (!albumId || !filters.albumIds.includes(albumId)) {
      return false;
    }
  }

  if (filters.tidalIds.length > 0) {
    const tidalId = getJobTidalId(job);
    if (!tidalId || !filters.tidalIds.includes(tidalId)) {
      return false;
    }
  }

  return true;
}

function buildQueuePositionById(): Map<number, number> {
  const pendingDownloadJobs = TaskQueueService.listJobsByTypesAndStatuses(
    DOWNLOAD_JOB_TYPES,
    ["pending"],
    TaskQueueService.countJobsByTypesAndStatuses(DOWNLOAD_JOB_TYPES, ["pending"]),
    0,
    { orderBy: "queue_order" },
  ) as unknown as QueueJobRow[];

  return new Map<number, number>(
    pendingDownloadJobs.map((job, index) => [job.id, index + 1]),
  );
}

function buildProgressFromQueueItem(item: QueueItemContract): DownloadProgressContract | null {
  const derivedState = item.state
    ?? (item.status === "failed"
      ? (item.stage === "import" ? "importFailed" : "failed")
      : item.stage === "import"
        ? (item.status === "processing" || item.status === "downloading" ? "importing" : "importPending")
        : item.status === "completed"
          ? "completed"
          : item.status === "processing" || item.status === "downloading"
            ? "downloading"
            : "queued");

  const hasPersistedState =
    item.currentFileNum !== undefined ||
    item.totalFiles !== undefined ||
    item.currentTrack !== undefined ||
    item.trackProgress !== undefined ||
    item.trackStatus !== undefined ||
    item.statusMessage !== undefined ||
    item.state !== undefined ||
    (Array.isArray(item.tracks) && item.tracks.length > 0);

  if (!hasPersistedState && item.progress <= 0 && item.status === "pending" && item.stage !== "import") {
    return null;
  }

  const tidalId = item.tidalId ?? "";
  if (!tidalId) {
    return null;
  }

  return {
    jobId: item.id,
    tidalId,
    type: item.type,
    quality: item.quality ?? null,
    title: item.title,
    artist: item.artist,
    cover: item.cover ?? null,
    progress: item.progress ?? 0,
    speed: item.speed,
    eta: item.eta,
    totalFiles: item.totalFiles,
    currentFileNum: item.currentFileNum,
    currentTrack: item.currentTrack,
    trackProgress: item.trackProgress,
    trackStatus: item.trackStatus,
    statusMessage: item.statusMessage ?? (item.stage === "import" && derivedState === "importPending" ? "Waiting to import" : undefined),
    state: derivedState,
    tracks: item.tracks,
    size: item.size,
    sizeleft: item.sizeleft,
  };
}

export class DownloadQueueQueryService {
  static getQueueStatus(): QueueStatusContract {
    const status = downloadProcessor.getStatus();
    const stats = TaskQueueService.getStats() as QueueStatusContract["stats"];

    return {
      ...status,
      stats,
    };
  }

  static getQueue(params: { limit: number; offset: number }): QueueListResponseContract {
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ["pending", "processing"],
      5000,
      0,
      { orderBy: "queue_order" },
    ) as unknown as QueueJobRow[];

    const queuePositionById = buildQueuePositionById();
    const total = jobs.length;
    const items = jobs
      .slice(params.offset, params.offset + params.limit)
      .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + items.length < total,
    };
  }

  static getQueueHistory(params: { limit: number; offset: number }): QueueListResponseContract {
    const statuses: Array<"completed" | "failed" | "cancelled"> = ["completed", "failed", "cancelled"];
    const total = TaskQueueService.countJobsByTypesAndStatuses(DOWNLOAD_OR_IMPORT_JOB_TYPES, statuses);
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      statuses,
      params.limit,
      params.offset,
      { orderBy: "history" },
    ) as unknown as QueueJobRow[];

    return {
      items: jobs.map((job) => this.mapDownloadQueueJob(job)),
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + jobs.length < total,
    };
  }

  static getQueueDetails(filters: QueueDetailsFilters): QueueItemContract[] {
    const normalizedFilters = normalizeQueueDetailsFilters(filters);
    const queuePositionById = buildQueuePositionById();
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ["pending", "processing"],
      5000,
      0,
      { orderBy: "queue_order" },
    ) as unknown as QueueJobRow[];

    return jobs
      .filter((job) => matchesQueueDetails(job, normalizedFilters))
      .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));
  }

  static getActiveProgressSnapshots(): DownloadProgressContract[] {
    const queuePositionById = buildQueuePositionById();
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ["pending", "processing"],
      5000,
      0,
      { orderBy: "queue_order" },
    ) as unknown as QueueJobRow[];

    return jobs
      .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)))
      .map((item) => buildProgressFromQueueItem(item))
      .filter((item): item is DownloadProgressContract => item !== null);
  }

  static mapDownloadQueueJob(job: QueueJobRow, queuePosition?: number): QueueItemContract {
    const downloadState = (job.payload?.downloadState as Record<string, unknown> | undefined) ?? {};
    const contentType = resolveQueueItemContentType(job);
    const tidalId = getJobTidalId(job);

    let title = getOptionalString(job.payload?.title)
      ?? getOptionalString(job.payload?.playlistName)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.title)
      ?? undefined;
    let artist = getOptionalString(job.payload?.artist)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.artist)
      ?? undefined;
    let cover = getOptionalString(job.payload?.cover)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.cover);
    let albumId = getOptionalString(
      job.payload?.album_id
      ?? job.payload?.albumId
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
    );
    let albumTitle = getOptionalString(
      job.payload?.album_title
      ?? job.payload?.albumTitle
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumTitle,
    );
    let quality = getOptionalString(job.payload?.quality);

    if (tidalId && (!title || !artist || cover === null || albumId === null || albumTitle === null || quality === null)) {
      try {
        if (contentType === "album") {
          const row = db.prepare(`
            SELECT a.title, a.cover, ar.name as artist_name, a.id as album_id, a.quality
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE a.id = ?
          `).get(tidalId) as {
            title?: string;
            cover?: string | null;
            artist_name?: string;
            album_id?: string | number;
            quality?: string | null;
          } | undefined;

          title ||= row?.title;
          artist ||= row?.artist_name;
          if (cover === null) cover = row?.cover ?? null;
          albumId ||= getOptionalString(row?.album_id);
          albumTitle ||= row?.title ?? null;
          quality ||= row?.quality ?? null;
        } else if (contentType === "video") {
          const row = db.prepare(`
            SELECT m.title, ar.name as artist_name, m.cover as video_cover, a.id as album_id, a.title as album_title, m.quality
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
            LEFT JOIN albums a ON a.id = m.album_id
            WHERE m.id = ? AND m.type = 'Music Video'
          `).get(tidalId) as {
            title?: string;
            artist_name?: string;
            video_cover?: string | null;
            album_id?: string | number;
            album_title?: string | null;
            quality?: string | null;
          } | undefined;

          title ||= row?.title;
          artist ||= row?.artist_name;
          if (cover === null) cover = row?.video_cover ?? null;
          albumId ||= getOptionalString(row?.album_id);
          albumTitle ||= row?.album_title ?? null;
          quality ||= row?.quality ?? null;
        } else if (contentType === "playlist") {
          const row = db.prepare(`
            SELECT p.title, p.square_cover_id, p.cover_id
            FROM playlists p
            WHERE p.tidal_id = ? OR p.uuid = ?
          `).get(tidalId, tidalId) as {
            title?: string;
            square_cover_id?: string | null;
            cover_id?: string | null;
          } | undefined;

          title ||= row?.title;
          if (cover === null) cover = row?.square_cover_id ?? row?.cover_id ?? null;
        } else {
          const row = db.prepare(`
            SELECT m.title, m.version as version, ar.name as artist_name, a.cover as album_cover, a.id as album_id, a.title as album_title, m.quality
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
            LEFT JOIN albums a ON a.id = m.album_id
            WHERE m.id = ?
          `).get(tidalId) as {
            title?: string;
            version?: string | null;
            artist_name?: string;
            album_cover?: string | null;
            album_id?: string | number;
            album_title?: string | null;
            quality?: string | null;
          } | undefined;

          if (!title) {
            const baseTitle = row?.title;
            const version = (row?.version || "").trim();
            title = baseTitle && version && !baseTitle.toLowerCase().includes(version.toLowerCase())
              ? `${baseTitle} (${version})`
              : baseTitle;
          }

          artist ||= row?.artist_name;
          if (cover === null) cover = row?.album_cover ?? null;
          albumId ||= getOptionalString(row?.album_id);
          albumTitle ||= row?.album_title ?? null;
          quality ||= row?.quality ?? null;
        }
      } catch {
        // ignore metadata lookup failures for queue surfaces
      }
    }

    return {
      id: job.id,
      tidalId,
      type: contentType,
      status: job.status as QueueItemContract["status"],
      stage: job.type === JobTypes.ImportDownload ? "import" : "download",
      progress: (typeof downloadState.progress === "number" && Number.isFinite(downloadState.progress))
        ? downloadState.progress
        : (typeof job.progress === "number" && Number.isFinite(job.progress) ? job.progress : 0),
      error: getOptionalString(job.error) ?? null,
      created_at: job.created_at || new Date().toISOString(),
      updated_at: job.updated_at || job.created_at || new Date().toISOString(),
      started_at: job.started_at ?? null,
      completed_at: job.completed_at ?? null,
      url: getOptionalString(job.payload?.url) ?? null,
      path: getOptionalString(job.payload?.path) ?? null,
      title: title || "Unknown",
      artist: artist || "Unknown",
      cover: cover ?? null,
      quality: quality ?? null,
      album_id: albumId ?? null,
      album_title: albumTitle ?? null,
      currentFileNum: typeof downloadState.currentFileNum === "number" ? downloadState.currentFileNum : undefined,
      totalFiles: typeof downloadState.totalFiles === "number" ? downloadState.totalFiles : undefined,
      currentTrack: getOptionalString(downloadState.currentTrack) ?? undefined,
      trackProgress: typeof downloadState.trackProgress === "number" ? downloadState.trackProgress : undefined,
      trackStatus: getOptionalString(downloadState.trackStatus) as QueueItemContract["trackStatus"] | undefined,
      statusMessage: getOptionalString(downloadState.statusMessage) ?? undefined,
      state: getOptionalString(downloadState.state) as QueueItemContract["state"] | undefined,
      speed: getOptionalString(downloadState.speed) ?? undefined,
      eta: getOptionalString(downloadState.eta) ?? undefined,
      size: typeof downloadState.size === "number" ? downloadState.size : undefined,
      sizeleft: typeof downloadState.sizeleft === "number" ? downloadState.sizeleft : undefined,
      tracks: Array.isArray(downloadState.tracks)
        ? downloadState.tracks as QueueItemContract["tracks"]
        : undefined,
      queuePosition,
    };
  }
}
