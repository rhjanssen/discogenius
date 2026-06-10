import { db } from "../../database.js";
import type {
  DownloadProgressContract,
  QueueItemContract,
  QueueListResponseContract,
  QueueStatusContract,
} from "../../contracts/status.js";
import { downloadProcessor } from "./download-processor.js";
import {
  DOWNLOAD_JOB_TYPES,
  DOWNLOAD_OR_IMPORT_JOB_TYPES,
  JobTypes,
  TaskQueueService,
} from "../jobs/queue.js";

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
  providerIds?: string[];
};

type NormalizedQueueDetailsFilters = {
  artistId?: string;
  albumIds: string[];
  providerIds: string[];
};

type QueueMetadata = {
  title?: string | null;
  artist?: string | null;
  cover?: string | null;
  albumId?: string | null;
  albumTitle?: string | null;
  quality?: string | null;
};

const ACTIVE_QUEUE_STATUSES: Array<"pending" | "processing" | "failed"> = ["pending", "processing", "failed"];
const QUEUE_HISTORY_STATUSES: Array<"completed" | "failed" | "cancelled"> = ["completed", "failed", "cancelled"];

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

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

  if (job.type === JobTypes.ImportDownload) {
    const payloadType = getOptionalString(job.payload?.type);
    if (payloadType === "video" || payloadType === "album") {
      return payloadType;
    }
  }

  return "track";
}

function getJobProviderId(job: QueueJobRow): string | null {
  return getOptionalString(job.payload?.providerId)
    ?? getOptionalString(job.payload?.providerId)
    ?? getOptionalString(job.ref_id);
}

function getJobAlbumId(job: QueueJobRow): string | null {
  const payloadAlbumId = getOptionalString(
    job.payload?.album_id
    ?? job.payload?.albumId
    ?? job.payload?.releaseGroupMbid
    ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
  );
  if (payloadAlbumId) {
    return payloadAlbumId;
  }

  const contentType = resolveQueueItemContentType(job);
  const providerId = getJobProviderId(job);

  if (!providerId) {
    return null;
  }

  const providerItemAlbumId = getProviderItemAlbumId(contentType, providerId);
  if (providerItemAlbumId) {
    return providerItemAlbumId;
  }

  if (contentType === "album") {
    return providerId;
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
  const providerId = getJobProviderId(job);

  if (!providerId) {
    return null;
  }

  const providerItemArtistId = getProviderItemArtistId(contentType, providerId);
  if (providerItemArtistId) {
    return providerItemArtistId;
  }

  return null;
}

function getProviderItemEntityTypes(contentType: QueueItemContract["type"]): string[] {
  if (contentType === "album") return ["album"];
  if (contentType === "video") return ["video"];
  return ["track"];
}

function getProviderItemAlbumId(contentType: QueueItemContract["type"], providerId: string): string | null {
  const entityTypes = getProviderItemEntityTypes(contentType);
  const row = db.prepare(`
    SELECT release_group_mbid, release_mbid
    FROM ProviderItems
    WHERE provider_id = ?
      AND entity_type IN (${placeholders(entityTypes)})
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(providerId, ...entityTypes) as {
    release_group_mbid?: string | null;
    release_mbid?: string | null;
  } | undefined;

  return getOptionalString(row?.release_group_mbid) ?? getOptionalString(row?.release_mbid);
}

function getProviderItemArtistId(contentType: QueueItemContract["type"], providerId: string): string | null {
  const entityTypes = getProviderItemEntityTypes(contentType);
  const row = db.prepare(`
    SELECT artist_mbid
    FROM ProviderItems
    WHERE provider_id = ?
      AND entity_type IN (${placeholders(entityTypes)})
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(providerId, ...entityTypes) as { artist_mbid?: string | null } | undefined;

  return getOptionalString(row?.artist_mbid);
}

function parseProviderData(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function pickNestedString(record: Record<string, unknown>, key: string): string | null {
  return getOptionalString(record[key]);
}

function resolveCanonicalAlbumMetadata(input: {
  releaseGroupMbid?: string | null;
  providerId?: string | null;
  slot?: string | null;
}): QueueMetadata | null {
  const releaseGroupMbid = getOptionalString(input.releaseGroupMbid);
  const providerId = getOptionalString(input.providerId);
  if (!releaseGroupMbid && !providerId) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      rg.mbid AS release_group_mbid,
      rg.title AS release_group_title,
      COALESCE(artist.name, local_artist.name) AS artist_name,
      slot.quality AS slot_quality,
      slot.provider_data AS slot_provider_data,
      provider_item.title AS provider_title,
      provider_item.quality AS provider_quality,
      provider_item.asset_id AS provider_asset_id,
      provider_item.data AS provider_data
    FROM Albums rg
    LEFT JOIN ArtistMetadata artist ON artist.mbid = rg.artist_mbid
    LEFT JOIN Artists local_artist ON local_artist.mbid = rg.artist_mbid
    LEFT JOIN ReleaseGroupSlots slot
      ON slot.release_group_mbid = rg.mbid
     AND (? IS NULL OR slot.slot = ?)
     AND (
       ? IS NULL
       OR slot.selected_provider_id = ?
       OR slot.selected_provider_id LIKE ? || ';%'
       OR slot.selected_provider_id LIKE '%;' || ? || ';%'
       OR slot.selected_provider_id LIKE '%;' || ?
     )
    LEFT JOIN ProviderItems provider_item
      ON provider_item.rowid = (
        SELECT candidate.rowid
        FROM ProviderItems candidate
        WHERE candidate.entity_type = 'album'
          AND (
            (? IS NOT NULL AND candidate.provider_id = ?)
            OR candidate.release_group_mbid = rg.mbid
          )
        ORDER BY
          CASE WHEN ? IS NOT NULL AND candidate.provider_id = ? THEN 0 ELSE 1 END,
          CASE candidate.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
          candidate.updated_at DESC,
          candidate.provider_id ASC
        LIMIT 1
      )
    WHERE (? IS NOT NULL AND rg.mbid = ?)
       OR (? IS NOT NULL AND provider_item.provider_id = ?)
    ORDER BY CASE WHEN ? IS NOT NULL AND rg.mbid = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(
    input.slot ?? null,
    input.slot ?? null,
    providerId,
    providerId,
    providerId,
    providerId,
    providerId,
    providerId,
    providerId,
    providerId,
    providerId,
    releaseGroupMbid,
    releaseGroupMbid,
    providerId,
    providerId,
    releaseGroupMbid,
    releaseGroupMbid,
  ) as {
    release_group_mbid?: string | null;
    release_group_title?: string | null;
    artist_name?: string | null;
    slot_quality?: string | null;
    slot_provider_data?: string | null;
    provider_title?: string | null;
    provider_quality?: string | null;
    provider_asset_id?: string | null;
    provider_data?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const slotData = parseProviderData(row.slot_provider_data);
  const providerData = parseProviderData(row.provider_data);
  const slotArtist = parseProviderData(slotData.artist);
  const providerArtist = parseProviderData(providerData.artist);

  return {
    title: row.release_group_title ?? row.provider_title ?? pickNestedString(slotData, "title"),
    artist: row.artist_name
      ?? pickNestedString(slotArtist, "name")
      ?? pickNestedString(providerArtist, "name"),
    cover: row.provider_asset_id
      ?? pickNestedString(slotData, "cover")
      ?? pickNestedString(providerData, "cover")
      ?? pickNestedString(providerData, "image_id")
      ?? pickNestedString(providerData, "imageId"),
    albumId: row.release_group_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.slot_quality ?? row.provider_quality ?? pickNestedString(slotData, "quality") ?? pickNestedString(providerData, "quality"),
  };
}

function resolveProviderItemMetadata(input: {
  contentType: QueueItemContract["type"];
  providerId?: string | null;
}): QueueMetadata | null {
  const providerId = getOptionalString(input.providerId);
  if (!providerId) {
    return null;
  }

  const entityTypes = getProviderItemEntityTypes(input.contentType);
  const row = db.prepare(`
    SELECT
      provider_item.entity_type,
      provider_item.title,
      provider_item.version,
      provider_item.quality,
      provider_item.asset_id,
      provider_item.data,
      provider_item.release_group_mbid,
      provider_item.release_mbid,
      release_group.title AS release_group_title,
      COALESCE(artist.name, local_artist.name) AS artist_name,
      track.title AS track_title,
      recording.title AS recording_title
    FROM ProviderItems provider_item
    LEFT JOIN Albums release_group ON release_group.mbid = provider_item.release_group_mbid
    LEFT JOIN ArtistMetadata artist ON artist.mbid = provider_item.artist_mbid
    LEFT JOIN Artists local_artist ON local_artist.mbid = provider_item.artist_mbid
    LEFT JOIN Tracks track ON track.mbid = provider_item.track_mbid
    LEFT JOIN Recordings recording
      ON recording.id = provider_item.recording_id
       OR recording.mbid = provider_item.recording_mbid
    WHERE provider_item.provider_id = ?
      AND provider_item.entity_type IN (${placeholders(entityTypes)})
    ORDER BY provider_item.updated_at DESC
    LIMIT 1
  `).get(providerId, ...entityTypes) as {
    entity_type?: string | null;
    title?: string | null;
    version?: string | null;
    quality?: string | null;
    asset_id?: string | null;
    data?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    release_group_title?: string | null;
    artist_name?: string | null;
    track_title?: string | null;
    recording_title?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const data = parseProviderData(row.data);
  const dataArtist = parseProviderData(data.artist);
  const canonicalTitle = input.contentType === "album"
    ? row.release_group_title
    : row.track_title ?? row.recording_title;
  const providerTitle = row.title
    ? row.version && !row.title.toLowerCase().includes(row.version.toLowerCase())
      ? `${row.title} (${row.version})`
      : row.title
    : null;

  return {
    title: canonicalTitle ?? providerTitle ?? pickNestedString(data, "title"),
    artist: row.artist_name ?? pickNestedString(dataArtist, "name") ?? pickNestedString(data, "artist_name"),
    cover: row.asset_id ?? pickNestedString(data, "cover") ?? pickNestedString(data, "image_id") ?? pickNestedString(data, "imageId"),
    albumId: row.release_group_mbid ?? row.release_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.quality ?? pickNestedString(data, "quality"),
  };
}

function normalizeQueueDetailsFilters(filters: QueueDetailsFilters): NormalizedQueueDetailsFilters {
  return {
    artistId: getOptionalString(filters.artistId) ?? undefined,
    albumIds: normalizeDistinctIdentifiers(filters.albumIds),
    providerIds: normalizeDistinctIdentifiers(filters.providerIds),
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

  if (filters.providerIds.length > 0) {
    const providerId = getJobProviderId(job);
    if (!providerId || !filters.providerIds.includes(providerId)) {
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

function getPendingDownloadQueuePositionsForIds(jobIds: readonly number[]): Map<number, number> {
  const queuePositionById = new Map<number, number>();
  if (jobIds.length === 0) {
    return queuePositionById;
  }

  const typePlaceholders = DOWNLOAD_JOB_TYPES.map(() => "?").join(",");
  const idPlaceholders = jobIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      target.id,
      1 + (
        SELECT COUNT(*)
        FROM job_queue candidate
        WHERE candidate.status = 'pending'
          AND candidate.type IN (${typePlaceholders})
          AND (
            COALESCE(candidate.queue_order, 2147483647) < COALESCE(target.queue_order, 2147483647)
            OR (
              COALESCE(candidate.queue_order, 2147483647) = COALESCE(target.queue_order, 2147483647)
              AND candidate.created_at < target.created_at
            )
            OR (
              COALESCE(candidate.queue_order, 2147483647) = COALESCE(target.queue_order, 2147483647)
              AND candidate.created_at = target.created_at
              AND candidate.id < target.id
            )
          )
      ) AS queuePosition
    FROM job_queue target
    WHERE target.status = 'pending'
      AND target.id IN (${idPlaceholders})
  `).all(...DOWNLOAD_JOB_TYPES, ...jobIds) as Array<{ id: number; queuePosition: number }>;

  for (const row of rows) {
    queuePositionById.set(Number(row.id), Number(row.queuePosition));
  }

  return queuePositionById;
}

function buildLogicalHistoryQuery(): { whereSql: string; params: unknown[] } {
  const typeSql = placeholders(DOWNLOAD_OR_IMPORT_JOB_TYPES);
  const statusSql = placeholders(QUEUE_HISTORY_STATUSES);
  const downloadTypeSql = placeholders(DOWNLOAD_JOB_TYPES);

  return {
    whereSql: `
      jq.type IN (${typeSql})
      AND jq.status IN (${statusSql})
      AND NOT (
        jq.type IN (${downloadTypeSql})
        AND EXISTS (
          SELECT 1
          FROM job_queue import_job
          WHERE import_job.type = ?
            AND import_job.status IN (${statusSql})
            AND CAST(json_extract(import_job.payload, '$.originalJobId') AS INTEGER) = jq.id
        )
      )
    `,
    params: [
      ...DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ...QUEUE_HISTORY_STATUSES,
      ...DOWNLOAD_JOB_TYPES,
      JobTypes.ImportDownload,
      ...QUEUE_HISTORY_STATUSES,
    ],
  };
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

  const providerId = item.providerId ?? "";
  if (!providerId) {
    return null;
  }

  return {
    jobId: item.id,
    providerId,
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
    const total = TaskQueueService.countJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ACTIVE_QUEUE_STATUSES,
    );
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_JOB_TYPES,
      ACTIVE_QUEUE_STATUSES,
      params.limit,
      params.offset,
      { orderBy: "live_activity" },
    ) as unknown as QueueJobRow[];

    const queuePositionById = getPendingDownloadQueuePositionsForIds(
      jobs
        .filter((job) => job.status === "pending" && DOWNLOAD_JOB_TYPES.includes(job.type as typeof DOWNLOAD_JOB_TYPES[number]))
        .map((job) => job.id),
    );
    const items = jobs.map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + jobs.length < total,
    };
  }

  static getQueueHistory(params: { limit: number; offset: number }): QueueListResponseContract {
    const logicalHistory = buildLogicalHistoryQuery();
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM job_queue jq
      WHERE ${logicalHistory.whereSql}
    `).get(...logicalHistory.params) as { count?: number } | undefined;
    const total = Number(totalRow?.count || 0);

    const rows = db.prepare(`
      SELECT jq.id
      FROM job_queue jq
      WHERE ${logicalHistory.whereSql}
      ORDER BY
        jq.completed_at DESC,
        jq.updated_at DESC,
        jq.started_at DESC,
        jq.created_at DESC,
        jq.id DESC
      LIMIT ? OFFSET ?
    `).all(...logicalHistory.params, params.limit, params.offset) as Array<{ id: number }>;
    const jobs = rows
      .map((row) => TaskQueueService.getById(row.id))
      .filter((job) => job !== null) as unknown as QueueJobRow[];

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
      ACTIVE_QUEUE_STATUSES,
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
      ACTIVE_QUEUE_STATUSES,
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
    const providerId = getJobProviderId(job);

    let title = getOptionalString(job.payload?.title)
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
      ?? job.payload?.releaseGroupMbid
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
    );
    let albumTitle = getOptionalString(
      job.payload?.album_title
      ?? job.payload?.albumTitle
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumTitle,
    );
    let quality = getOptionalString(job.payload?.quality);
    const slot = getOptionalString(job.payload?.slot)
      ?? getOptionalString(job.payload?.librarySlot)
      ?? null;

    const canonicalMetadata = resolveCanonicalAlbumMetadata({
      releaseGroupMbid: albumId,
      providerId,
      slot,
    });
    const providerItemMetadata = resolveProviderItemMetadata({
      contentType,
      providerId,
    });
    const offerMetadata = canonicalMetadata ?? providerItemMetadata;
    if (offerMetadata) {
      title ||= offerMetadata.title ?? undefined;
      artist ||= offerMetadata.artist ?? undefined;
      if (cover === null) cover = offerMetadata.cover ?? null;
      albumId ||= offerMetadata.albumId ?? null;
      albumTitle ||= offerMetadata.albumTitle ?? null;
      quality ||= offerMetadata.quality ?? null;
    }

    return {
      id: job.id,
      providerId,
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
      slot,
    };
  }
}
