import { db } from "../../database.js";
import type {
  DownloadProgressContract,
  QueueItemContract,
  QueueListResponseContract,
  QueueStatusContract,
} from "../../contracts/status.js";
import { downloadProcessor } from "./download-processor.js";
import { downloadEvents } from "./download-events.js";
import {DOWNLOAD_COMMAND_NAMES, DOWNLOAD_OR_IMPORT_COMMAND_NAMES, CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { appEvents, AppEvent } from "../commands/app-events.js";
import {
  albumCoverLocalUrl,
  imageContainerFromImagesColumn,
  renderableProviderArtworkUrl,
  videoCoverLocalUrl,
} from "../metadata/media-cover-service.js";

type QueueJobRow = {
  id: number;
  name: string;
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

type QueueTrackProgress = NonNullable<QueueItemContract["tracks"]>[number];

const ACTIVE_QUEUE_STATUSES: Array<"queued" | "started" | "failed"> = ["queued", "started", "failed"];
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
  if (job.name === CommandNames.DownloadVideo) {
    return "video";
  }

  if (job.name === CommandNames.DownloadAlbum) {
    return "album";
  }

  if (job.name === CommandNames.ImportDownload) {
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

function getOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTrackStatus(value: unknown): QueueTrackProgress["status"] {
  return value === "downloading"
    || value === "completed"
    || value === "error"
    || value === "skipped"
    ? value
    : "queued";
}

function parseDownloadStateTracks(value: unknown): QueueItemContract["tracks"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tracks = value
    .map((track): QueueTrackProgress | null => {
      if (!track || typeof track !== "object") {
        return null;
      }
      const record = track as Record<string, unknown>;
      const title = getOptionalString(record.title);
      if (!title) {
        return null;
      }
      const trackNum = getOptionalNumber(record.trackNum);
      const providerTrackId = getOptionalString(record.providerTrackId);
      return {
        title,
        trackNum: trackNum ?? undefined,
        status: normalizeTrackStatus(record.status),
        ...(providerTrackId ? { providerTrackId } : {}),
      };
    })
    .filter((track): track is QueueTrackProgress => track !== null);

  return tracks.length > 0 ? tracks : undefined;
}

function resetTracksForImport(tracks?: QueueItemContract["tracks"]): QueueItemContract["tracks"] | undefined {
  return tracks?.map((track) => ({
    ...track,
    status: track.status === "skipped" ? "skipped" : "queued",
  }));
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
      rg.images AS release_group_images,
      COALESCE(artist.name, local_artist.name) AS artist_name,
      slot.selected_provider AS selected_provider,
      slot.selected_provider_id AS selected_provider_id,
      slot.quality AS slot_quality,
      slot.provider_artist_name AS slot_provider_artist_name,
      slot.provider_title AS slot_provider_title,
      slot.cover AS slot_cover,
      provider_item.provider_artist_name AS provider_artist_name,
      provider_item.title AS provider_title,
      provider_item.quality AS provider_quality,
      provider_item.cover AS provider_cover,
      provider_item.asset_id AS provider_asset_id
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
    release_group_images?: string | null;
    artist_name?: string | null;
    selected_provider?: string | null;
    selected_provider_id?: string | null;
    slot_quality?: string | null;
    slot_provider_artist_name?: string | null;
    slot_provider_title?: string | null;
    slot_cover?: string | null;
    provider_title?: string | null;
    provider_quality?: string | null;
    provider_cover?: string | null;
    provider_artist_name?: string | null;
    provider_asset_id?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const cover = albumCoverLocalUrl({
    albumMbid: row.release_group_mbid,
    images: imageContainerFromImagesColumn(row.release_group_images),
  });

  return {
    title: row.release_group_title ?? row.slot_provider_title ?? row.provider_title,
    artist: row.artist_name ?? row.slot_provider_artist_name ?? row.provider_artist_name,
    cover: cover ?? row.slot_cover ?? row.provider_cover ?? row.provider_asset_id,
    albumId: row.release_group_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.slot_quality ?? row.provider_quality,
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
      provider_item.provider,
      provider_item.title,
      provider_item.provider_artist_name,
      provider_item.quality,
      provider_item.asset_id,
      provider_item.cover,
      provider_item.release_group_mbid,
      provider_item.release_mbid,
      release_group.title AS release_group_title,
      release_group.images AS release_group_images,
      COALESCE(artist.name, local_artist.name) AS artist_name,
      recording.id AS recording_id,
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
    provider?: string | null;
    title?: string | null;
    provider_artist_name?: string | null;
    quality?: string | null;
    asset_id?: string | null;
    cover?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    release_group_title?: string | null;
    release_group_images?: string | null;
    artist_name?: string | null;
    recording_id?: string | number | null;
    track_title?: string | null;
    recording_title?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const canonicalTitle = input.contentType === "album"
    ? row.release_group_title
    : row.track_title ?? row.recording_title;
  const cover = row.release_group_mbid
    ? albumCoverLocalUrl({
        albumMbid: row.release_group_mbid,
        images: imageContainerFromImagesColumn(row.release_group_images),
      })
    : input.contentType === "video"
      ? videoCoverLocalUrl(row.recording_id)
      : null;

  return {
    title: canonicalTitle ?? row.title,
    artist: row.artist_name ?? row.provider_artist_name,
    cover: cover ?? row.cover ?? row.asset_id,
    albumId: row.release_group_mbid ?? row.release_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.quality,
  };
}

function resolveCanonicalAlbumTracks(input: {
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  slot?: string | null;
}): QueueItemContract["tracks"] | undefined {
  const releaseMbid = getOptionalString(input.releaseMbid);
  const releaseGroupMbid = getOptionalString(input.releaseGroupMbid);
  if (!releaseMbid && !releaseGroupMbid) {
    return undefined;
  }

  const selectedReleaseRow = releaseGroupMbid
    ? db.prepare(`
        SELECT selected_release_mbid
        FROM ReleaseGroupSlots
        WHERE release_group_mbid = ?
          AND (? IS NULL OR slot = ?)
          AND selected_release_mbid IS NOT NULL
        ORDER BY CASE WHEN slot = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(releaseGroupMbid, input.slot ?? null, input.slot ?? null, input.slot ?? null) as { selected_release_mbid?: string | null } | undefined
    : undefined;
  const preferredReleaseMbid = releaseMbid ?? getOptionalString(selectedReleaseRow?.selected_release_mbid);

  const rows = preferredReleaseMbid
    ? db.prepare(`
        SELECT title
        FROM Tracks
        WHERE release_mbid = ?
        ORDER BY medium_position ASC, position ASC, id ASC
      `).all(preferredReleaseMbid) as Array<{ title?: string | null }>
    : db.prepare(`
        SELECT t.title
        FROM AlbumReleases ar
        JOIN Tracks t ON t.release_mbid = ar.mbid
        WHERE ar.release_group_mbid = ?
        ORDER BY ar.date ASC, ar.mbid ASC, t.medium_position ASC, t.position ASC, t.id ASC
      `).all(releaseGroupMbid) as Array<{ title?: string | null }>;

  const tracks = rows
    .map((row, index): QueueTrackProgress | null => {
      const title = getOptionalString(row.title);
      return title ? { title, trackNum: index + 1, status: "queued" } : null;
    })
    .filter((track): track is QueueTrackProgress => track !== null);

  return tracks.length > 0 ? tracks : undefined;
}

function resolveQueueItemTracks(
  job: QueueJobRow,
  downloadState: Record<string, unknown>,
  contentType: QueueItemContract["type"],
  slot?: string | null,
): QueueItemContract["tracks"] | undefined {
  const directTracks = parseDownloadStateTracks(downloadState.tracks);
  if (directTracks) {
    return directTracks;
  }

  if (job.name === CommandNames.ImportDownload) {
    const originalJobId = getOptionalNumber(job.payload?.originalJobId);
    const originalJob = originalJobId ? CommandQueueManager.get(originalJobId) as unknown as QueueJobRow | null : null;
    const originalDownloadState = (originalJob?.payload?.downloadState as Record<string, unknown> | undefined) ?? {};
    const originalTracks = resetTracksForImport(parseDownloadStateTracks(originalDownloadState.tracks));
    if (originalTracks?.length) {
      return originalTracks;
    }

    if (contentType === "album") {
      return resolveCanonicalAlbumTracks({
        releaseGroupMbid: getOptionalString(job.payload?.releaseGroupMbid),
        releaseMbid: getOptionalString(job.payload?.releaseMbid),
        slot,
      });
    }
  }

  return undefined;
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
  // Rank in SQL over ids only — materializing every queued job (payload JSON
  // included) just to number them costs seconds with a large backlog.
  const typePlaceholders = DOWNLOAD_COMMAND_NAMES.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      id,
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(queue_order, 2147483647), created_at, id
      ) AS queuePosition
    FROM commands
    WHERE status = 'queued'
      AND name IN (${typePlaceholders})
  `).all(...DOWNLOAD_COMMAND_NAMES) as Array<{ id: number; queuePosition: number }>;

  return new Map<number, number>(rows.map((row) => [Number(row.id), Number(row.queuePosition)]));
}

function getPendingDownloadQueuePositionsForIds(commandIds: readonly number[]): Map<number, number> {
  const queuePositionById = new Map<number, number>();
  if (commandIds.length === 0) {
    return queuePositionById;
  }

  const typePlaceholders = DOWNLOAD_COMMAND_NAMES.map(() => "?").join(",");
  const idPlaceholders = commandIds.map(() => "?").join(",");
  // One ranked pass over the pending queue. The previous correlated COUNT
  // subquery re-scanned the whole queued set per requested row, which cost
  // seconds per page once the backlog reached tens of thousands of commands.
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(queue_order, 2147483647), created_at, id
        ) AS queuePosition
      FROM commands
      WHERE status = 'queued'
        AND name IN (${typePlaceholders})
    )
    SELECT id, queuePosition
    FROM ranked
    WHERE id IN (${idPlaceholders})
  `).all(...DOWNLOAD_COMMAND_NAMES, ...commandIds) as Array<{ id: number; queuePosition: number }>;

  for (const row of rows) {
    queuePositionById.set(Number(row.id), Number(row.queuePosition));
  }

  return queuePositionById;
}

function buildLogicalHistoryQuery(): { whereSql: string; params: unknown[] } {
  const typeSql = placeholders(DOWNLOAD_OR_IMPORT_COMMAND_NAMES);
  const statusSql = placeholders(QUEUE_HISTORY_STATUSES);
  const downloadTypeSql = placeholders(DOWNLOAD_COMMAND_NAMES);

  return {
    whereSql: `
      jq.name IN (${typeSql})
      AND jq.status IN (${statusSql})
      AND NOT (
        jq.name IN (${downloadTypeSql})
        AND EXISTS (
          SELECT 1
          FROM commands import_job
          WHERE import_job.name = ?
            AND CAST(json_extract(import_job.payload, '$.originalJobId') AS INTEGER) = jq.id
        )
      )
    `,
    params: [
      ...DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
      ...QUEUE_HISTORY_STATUSES,
      ...DOWNLOAD_COMMAND_NAMES,
      CommandNames.ImportDownload,
    ],
  };
}

function buildProgressFromQueueItem(item: QueueItemContract): DownloadProgressContract | null {
  const derivedState = item.state
    ?? (item.status === "failed"
      ? (item.stage === "import" ? "importFailed" : "failed")
      : item.stage === "import"
        ? (item.status === "started" || item.status === "downloading" ? "importing" : "importPending")
        : item.status === "completed"
          ? "completed"
          : item.status === "started" || item.status === "downloading"
            ? "downloading"
            : "queued");

  const hasPersistedState =
    item.currentFileNum !== undefined ||
    item.totalFiles !== undefined ||
    item.currentTrack !== undefined ||
    item.currentProviderTrackId !== undefined ||
    item.currentTrackNum !== undefined ||
    item.currentVolumeNum !== undefined ||
    item.trackProgress !== undefined ||
    item.trackStatus !== undefined ||
    item.statusMessage !== undefined ||
    item.state !== undefined ||
    (Array.isArray(item.tracks) && item.tracks.length > 0);

  if (!hasPersistedState && item.progress <= 0 && item.status === "queued" && item.stage !== "import") {
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
    currentProviderTrackId: item.currentProviderTrackId,
    currentTrackNum: item.currentTrackNum,
    currentVolumeNum: item.currentVolumeNum,
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
  // The dashboard polls queue/history/status every few seconds per client, and
  // each rebuild parses command payloads and runs several queries. Serving a
  // short-lived snapshot collapses concurrent pollers into at most one DB pass
  // per TTL. Structural changes (add/terminal-status/delete/clear/pause) burst
  // the cache; per-second progress ticks intentionally ride the TTL because
  // the SSE progress stream already delivers those live.
  private static readonly SNAPSHOT_TTL_MS = 1_500;
  private static snapshotCache = new Map<string, { value: unknown; at: number }>();
  private static snapshotEventsSubscribed = false;

  static invalidateSnapshots(): void {
    this.snapshotCache.clear();
  }

  private static getSnapshot<T>(key: string, build: () => T): T {
    this.ensureSnapshotInvalidation();

    const now = Date.now();
    const hit = this.snapshotCache.get(key);
    if (hit && now - hit.at < this.SNAPSHOT_TTL_MS) {
      return hit.value as T;
    }

    const value = build();
    if (this.snapshotCache.size > 32) {
      // Pages are keyed by limit/offset; anything beyond a handful of keys is
      // a scripted client. Reset rather than grow unbounded.
      this.snapshotCache.clear();
    }
    this.snapshotCache.set(key, { value, at: now });
    return value;
  }

  private static ensureSnapshotInvalidation(): void {
    if (this.snapshotEventsSubscribed) {
      return;
    }
    this.snapshotEventsSubscribed = true;

    const invalidate = () => this.invalidateSnapshots();

    appEvents.on(AppEvent.COMMAND_ADDED, invalidate);
    appEvents.on(AppEvent.COMMAND_DELETED, invalidate);
    appEvents.on(AppEvent.QUEUE_CLEARED, invalidate);
    appEvents.on(AppEvent.COMMAND_UPDATED, (event) => {
      // Progress ticks arrive as status "started" once per job per second;
      // only genuine transitions need an immediate rebuild.
      if (event.status !== 'started') {
        invalidate();
      }
    });
    downloadEvents.on('queue-status', invalidate);
    downloadEvents.on('started', invalidate);
  }

  static getQueueStatus(): QueueStatusContract {
    const status = downloadProcessor.getStatus();
    const stats = this.getSnapshot('status-stats', () => (
      CommandQueueManager.getStats() as QueueStatusContract["stats"]
    ));

    return {
      ...status,
      stats,
    };
  }

  static getQueue(params: { limit: number; offset: number }): QueueListResponseContract {
    return this.getSnapshot(`queue:${params.limit}:${params.offset}`, () => this.buildQueue(params));
  }

  private static buildQueue(params: { limit: number; offset: number }): QueueListResponseContract {
    const total = CommandQueueManager.countJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
      ACTIVE_QUEUE_STATUSES,
    );
    const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
      DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
      ACTIVE_QUEUE_STATUSES,
      params.limit,
      params.offset,
      { orderBy: "live_activity" },
    ) as unknown as QueueJobRow[];

    const queuePositionById = getPendingDownloadQueuePositionsForIds(
      jobs
        .filter((job) => job.status === "queued" && DOWNLOAD_COMMAND_NAMES.includes(job.name as typeof DOWNLOAD_COMMAND_NAMES[number]))
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
    return this.getSnapshot(`history:${params.limit}:${params.offset}`, () => this.buildQueueHistory(params));
  }

  private static buildQueueHistory(params: { limit: number; offset: number }): QueueListResponseContract {
    const logicalHistory = buildLogicalHistoryQuery();
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM commands jq
      WHERE ${logicalHistory.whereSql}
    `).get(...logicalHistory.params) as { count?: number } | undefined;
    const total = Number(totalRow?.count || 0);

    const rows = db.prepare(`
      SELECT jq.id
      FROM commands jq
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
      .map((row) => CommandQueueManager.get(row.id))
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
    // With a few thousand queued albums the raw listing alone costs ~1.5s of
    // synchronous payload parsing, so repeat polls must share one snapshot.
    const cacheKey = `details:${normalizedFilters.artistId ?? ""}:${normalizedFilters.albumIds.join(",")}:${normalizedFilters.providerIds.join(",")}`;
    return this.getSnapshot(cacheKey, () => {
      const queuePositionById = buildQueuePositionById();
      const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
        DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
        ACTIVE_QUEUE_STATUSES,
        5000,
        0,
        { orderBy: "queue_order" },
      ) as unknown as QueueJobRow[];

      return jobs
        .filter((job) => matchesQueueDetails(job, normalizedFilters))
        .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));
    });
  }

  static getActiveProgressSnapshots(): DownloadProgressContract[] {
    // Initial payload for the SSE progress stream. Only jobs that are actually
    // running belong here — the queue/history endpoints carry everything else.
    // Mapping the whole backlog (mapDownloadQueueJob does per-row lookups) took
    // ~30s of synchronous main-thread work per connection with a few thousand
    // queued albums, which is what made the app unreachable under load.
    return this.getSnapshot('active-progress', () => {
      const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
        DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
        ["started"],
        50,
        0,
        { orderBy: "queue_order" },
      ) as unknown as QueueJobRow[];

      return jobs
        .map((job) => this.mapDownloadQueueJob(job))
        .map((item) => buildProgressFromQueueItem(item))
        .filter((item): item is DownloadProgressContract => item !== null);
    });
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
    const tracks = resolveQueueItemTracks(job, downloadState, contentType, slot);

    // The two resolvers below are heavy per-item joins. They only fill gaps, and
    // queued downloads already carry title/artist/cover in their payload (set at
    // enqueue time). When a full queue is polled, running them for every item is
    // what starves the synchronous event loop under download load — so skip them
    // when the display basics are present and resolve only the cover, cheaply,
    // through the indexed local-cover mapper.
    const hasDisplayBasics = Boolean(title && artist);
    const canonicalMetadata = hasDisplayBasics ? null : resolveCanonicalAlbumMetadata({
      releaseGroupMbid: albumId,
      providerId,
      slot,
    });
    const providerItemMetadata = (!hasDisplayBasics || !cover) ? resolveProviderItemMetadata({
      contentType,
      providerId,
    }) : null;
    // Point album items at the internal media-cover proxy — the same source the
    // library grid, artist page and album page use — instead of the raw provider
    // asset id from the payload. This keeps artwork handling in one place (the
    // backend proxy fetches/caches/resizes) and gives the queue the resized UI
    // image rather than a bare id the frontend can't render.
    if (albumId && contentType === "album") {
      cover = albumCoverLocalUrl({ albumMbid: albumId }) ?? cover;
    }
    const offerMetadata = canonicalMetadata ?? providerItemMetadata;
    if (offerMetadata) {
      title ||= offerMetadata.title ?? undefined;
      artist ||= offerMetadata.artist ?? undefined;
      cover ||= offerMetadata.cover ?? null;
      albumId ||= offerMetadata.albumId ?? null;
      albumTitle ||= offerMetadata.albumTitle ?? null;
      quality ||= offerMetadata.quality ?? null;
    }

    return {
      id: job.id,
      providerId,
      type: contentType,
      status: job.status as QueueItemContract["status"],
      // One command spans download → import; the phase comes from the persisted
      // lifecycle state, not a separate ImportDownload row.
      stage: (job.name === CommandNames.ImportDownload
        || downloadState.state === "importPending"
        || downloadState.state === "importing"
        || downloadState.state === "importFailed")
        ? "import"
        : "download",
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
      cover: renderableProviderArtworkUrl(cover, getOptionalString(job.payload?.provider)),
      quality: quality ?? null,
      album_id: albumId ?? null,
      album_title: albumTitle ?? null,
      currentFileNum: typeof downloadState.currentFileNum === "number" ? downloadState.currentFileNum : undefined,
      totalFiles: typeof downloadState.totalFiles === "number" ? downloadState.totalFiles : undefined,
      currentTrack: getOptionalString(downloadState.currentTrack) ?? undefined,
      currentProviderTrackId: getOptionalString(downloadState.currentProviderTrackId) ?? undefined,
      currentTrackNum: typeof downloadState.currentTrackNum === "number" ? downloadState.currentTrackNum : undefined,
      currentVolumeNum: typeof downloadState.currentVolumeNum === "number" ? downloadState.currentVolumeNum : undefined,
      trackProgress: typeof downloadState.trackProgress === "number" ? downloadState.trackProgress : undefined,
      trackStatus: getOptionalString(downloadState.trackStatus) as QueueItemContract["trackStatus"] | undefined,
      statusMessage: getOptionalString(downloadState.statusMessage) ?? undefined,
      state: getOptionalString(downloadState.state) as QueueItemContract["state"] | undefined,
      speed: getOptionalString(downloadState.speed) ?? undefined,
      eta: getOptionalString(downloadState.eta) ?? undefined,
      size: typeof downloadState.size === "number" ? downloadState.size : undefined,
      sizeleft: typeof downloadState.sizeleft === "number" ? downloadState.sizeleft : undefined,
      tracks,
      queuePosition,
      slot,
    };
  }
}
