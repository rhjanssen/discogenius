import { db } from "../database.js";
import {
    getCommandTypesForQueueCategory,
    type CommandQueueCategory,
} from "./command-registry.js";
import { getArtistWorkflowLabel } from "./artist-workflow.js";
import {
    countHistoryEvents,
    listHistoryEventFeedItems,
    type HistoryEventFeedItem,
    type HistoryEventType,
} from "./history-events.js";
import { Job, JobType, JobTypes, TaskQueueService } from "./queue.js";

const ALL_ACTIVITY_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
type ActivityStatus = typeof ALL_ACTIVITY_STATUSES[number];

const DEFAULT_ACTIVITY_CATEGORIES: readonly CommandQueueCategory[] = ["downloads", "scans", "other"];

function normalizeStatusFilterValue(status: string): ActivityStatus | null {
    if (status === "running") {
        return "processing";
    }

    return (ALL_ACTIVITY_STATUSES as readonly string[]).includes(status)
        ? status as ActivityStatus
        : null;
}

function getActivityTypesByCategories(categories: readonly CommandQueueCategory[]) {
    const seen = new Set<JobType>();
    const ordered: JobType[] = [];

    for (const category of categories) {
        const types = getCommandTypesForQueueCategory(category);
        for (const type of types) {
            if (seen.has(type)) {
                continue;
            }
            seen.add(type);
            ordered.push(type);
        }
    }

    return ordered;
}

function normalizeStatuses(statuses?: readonly string[]) {
    if (!statuses || statuses.length === 0) {
        return [...ALL_ACTIVITY_STATUSES] as ActivityStatus[];
    }

    const requested = new Set(statuses
        .map((value) => normalizeStatusFilterValue(value))
        .filter((value): value is ActivityStatus => value != null));

    return ALL_ACTIVITY_STATUSES.filter((status) => requested.has(status));
}

type ArtistLookupValue = string | null;
type AlbumLookupValue = { title: string | null; version: string | null; artistName: string | null } | null;
type TrackLookupValue = {
    trackTitle: string | null;
    trackVersion: string | null;
    albumTitle: string | null;
    albumVersion: string | null;
    artistName: string | null;
} | null;
type VideoLookupValue = { title: string | null; artistName: string | null } | null;

interface DescriptionLookupContext {
    artistNameById: Map<string, ArtistLookupValue>;
    albumById: Map<string, AlbumLookupValue>;
    trackById: Map<string, TrackLookupValue>;
    videoById: Map<string, VideoLookupValue>;
}

function createDescriptionLookupContext(): DescriptionLookupContext {
    return {
        artistNameById: new Map<string, ArtistLookupValue>(),
        albumById: new Map<string, AlbumLookupValue>(),
        trackById: new Map<string, TrackLookupValue>(),
        videoById: new Map<string, VideoLookupValue>(),
    };
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
    if (values.length === 0) {
        return [];
    }

    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

function loadMissingArtistNames(ids: readonly string[], context: DescriptionLookupContext): void {
    const missingIds = ids.filter((id) => !context.artistNameById.has(id));
    if (missingIds.length === 0) {
        return;
    }

    for (const chunk of chunkValues(missingIds, 200)) {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id, name FROM artists WHERE id IN (${placeholders})`).all(...chunk) as Array<{
            id: string;
            name: string | null;
        }>;

        const foundIds = new Set<string>();
        for (const row of rows) {
            foundIds.add(String(row.id));
            const normalized = String(row.name || "").trim();
            context.artistNameById.set(String(row.id), normalized || null);
        }

        for (const id of chunk) {
            if (!foundIds.has(id)) {
                context.artistNameById.set(id, null);
            }
        }
    }
}

function loadMissingAlbums(ids: readonly string[], context: DescriptionLookupContext): void {
    const missingIds = ids.filter((id) => !context.albumById.has(id));
    if (missingIds.length === 0) {
        return;
    }

    for (const chunk of chunkValues(missingIds, 200)) {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT a.id, a.title, a.version, ar.name as artist_name
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE a.id IN (${placeholders})
        `).all(...chunk) as Array<{
            id: string;
            title: string | null;
            version: string | null;
            artist_name: string | null;
        }>;

        const foundIds = new Set<string>();
        for (const row of rows) {
            const id = String(row.id);
            foundIds.add(id);
            context.albumById.set(id, {
                title: row.title,
                version: row.version,
                artistName: row.artist_name,
            });
        }

        for (const id of chunk) {
            if (!foundIds.has(id)) {
                context.albumById.set(id, null);
            }
        }
    }
}

function loadMissingTracks(ids: readonly string[], context: DescriptionLookupContext): void {
    const missingIds = ids.filter((id) => !context.trackById.has(id));
    if (missingIds.length === 0) {
        return;
    }

    for (const chunk of chunkValues(missingIds, 200)) {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT
                m.id,
                m.title as track_title,
                m.version as track_version,
                a.title as album_title,
                a.version as album_version,
                ar.name as artist_name
            FROM media m
            LEFT JOIN albums a ON a.id = m.album_id
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE m.id IN (${placeholders})
        `).all(...chunk) as Array<{
            id: string;
            track_title: string | null;
            track_version: string | null;
            album_title: string | null;
            album_version: string | null;
            artist_name: string | null;
        }>;

        const foundIds = new Set<string>();
        for (const row of rows) {
            const id = String(row.id);
            foundIds.add(id);
            context.trackById.set(id, {
                trackTitle: row.track_title,
                trackVersion: row.track_version,
                albumTitle: row.album_title,
                albumVersion: row.album_version,
                artistName: row.artist_name,
            });
        }

        for (const id of chunk) {
            if (!foundIds.has(id)) {
                context.trackById.set(id, null);
            }
        }
    }
}

function loadMissingVideos(ids: readonly string[], context: DescriptionLookupContext): void {
    const missingIds = ids.filter((id) => !context.videoById.has(id));
    if (missingIds.length === 0) {
        return;
    }

    for (const chunk of chunkValues(missingIds, 200)) {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT m.id, m.title, ar.name as artist_name
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
            WHERE m.id IN (${placeholders}) AND m.type = 'Music Video'
        `).all(...chunk) as Array<{
            id: string;
            title: string | null;
            artist_name: string | null;
        }>;

        const foundIds = new Set<string>();
        for (const row of rows) {
            const id = String(row.id);
            foundIds.add(id);
            context.videoById.set(id, {
                title: row.title,
                artistName: row.artist_name,
            });
        }

        for (const id of chunk) {
            if (!foundIds.has(id)) {
                context.videoById.set(id, null);
            }
        }
    }
}

function collectDescriptionLookupIds(
    jobs: ReadonlyArray<Pick<Job, "type" | "ref_id" | "payload">>,
): {
    artistIds: string[];
    albumIds: string[];
    trackIds: string[];
    videoIds: string[];
} {
    const artistIds = new Set<string>();
    const albumIds = new Set<string>();
    const trackIds = new Set<string>();
    const videoIds = new Set<string>();

    for (const job of jobs) {
        const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
            ? job.payload as Record<string, unknown>
            : {};

        const refId = String(
            job.ref_id
            || payload.tidalId
            || payload.artistId
            || payload.albumId
            || "",
        ).trim();

        if (!refId) {
            continue;
        }

        if (job.type === JobTypes.RefreshArtist || job.type === JobTypes.CurateArtist || job.type === JobTypes.RescanFolders) {
            artistIds.add(refId);
        }

        if (job.type === JobTypes.ScanAlbum || job.type === JobTypes.DownloadAlbum) {
            albumIds.add(refId);
        }

        if (job.type === JobTypes.DownloadTrack) {
            trackIds.add(refId);
        }

        if (job.type === JobTypes.DownloadVideo) {
            videoIds.add(refId);
        }
    }

    return {
        artistIds: [...artistIds],
        albumIds: [...albumIds],
        trackIds: [...trackIds],
        videoIds: [...videoIds],
    };
}

function preloadDescriptionLookups(
    jobs: ReadonlyArray<Pick<Job, "type" | "ref_id" | "payload">>,
    context: DescriptionLookupContext,
): void {
    const ids = collectDescriptionLookupIds(jobs);
    loadMissingArtistNames(ids.artistIds, context);
    loadMissingAlbums(ids.albumIds, context);
    loadMissingTracks(ids.trackIds, context);
    loadMissingVideos(ids.videoIds, context);
}

export const formatAlbumTitle = (title: string, version?: string | null) => {
    const base = title || "Unknown Album";
    const normalizedVersion = (version || "").trim();
    if (!normalizedVersion) return base;
    if (base.toLowerCase().includes(normalizedVersion.toLowerCase())) return base;
    return `${base} (${normalizedVersion})`;
};

export const formatTrackTitle = (title: string, version?: string | null) => {
    const base = title || "Unknown Track";
    const normalizedVersion = (version || "").trim();
    if (!normalizedVersion) return base;
    if (base.toLowerCase().includes(normalizedVersion.toLowerCase())) return base;
    return `${base} (${normalizedVersion})`;
};

export const buildDescription = (job: Job, context?: DescriptionLookupContext): string => {
    const payload = job.payload || {};
    if (payload.description) return payload.description;

    const tidalId = job.ref_id || payload?.tidalId || payload?.artistId || payload?.albumId || null;
    const workflowLabel = getArtistWorkflowLabel(payload.workflow);
    const resolveArtistName = () => {
        const direct = String(payload.artistName || "").trim();
        if (direct && direct.toLowerCase() !== "unknown artist") {
            return direct;
        }

        if (tidalId) {
            if (context?.artistNameById.has(tidalId)) {
                const cached = String(context.artistNameById.get(tidalId) || "").trim();
                if (cached && cached.toLowerCase() !== "unknown artist") {
                    return cached;
                }
                return "";
            }

            try {
                const row = db.prepare(`SELECT name FROM artists WHERE id = ?`).get(tidalId) as any;
                const resolved = String(row?.name || "").trim();
                context?.artistNameById.set(tidalId, resolved || null);
                if (resolved && resolved.toLowerCase() !== "unknown artist") {
                    return resolved;
                }
            } catch { /* ignore */ }
        }

        return "";
    };

    if (job.type === "RefreshArtist") {
        const artistName = resolveArtistName();
        if (artistName) return workflowLabel ? `${workflowLabel}: ${artistName}` : artistName;
        return workflowLabel || "Artist refresh";
    }

    if (job.type === "ScanAlbum") {
        if (payload.albumTitle && payload.artistName) {
            return `${formatAlbumTitle(payload.albumTitle, payload.albumVersion)} by ${payload.artistName}`;
        }
        if (tidalId) {
            const cached = context?.albumById.get(tidalId);
            if (cached !== undefined) {
                if (cached?.title) {
                    const albumTitle = formatAlbumTitle(cached.title, cached.version);
                    return cached.artistName ? `${albumTitle} by ${cached.artistName}` : albumTitle;
                }
                return "Unknown Album";
            }

            try {
                const row = db.prepare(`
                    SELECT a.title, a.version, ar.name as artist_name
                    FROM albums a
                    LEFT JOIN artists ar ON ar.id = a.artist_id
                    WHERE a.id = ?
                `).get(tidalId) as any;
                context?.albumById.set(tidalId, row?.title ? {
                    title: row.title,
                    version: row.version,
                    artistName: row.artist_name,
                } : null);
                if (row?.title) {
                    const albumTitle = formatAlbumTitle(row.title, row.version);
                    return row.artist_name ? `${albumTitle} by ${row.artist_name}` : albumTitle;
                }
            } catch { /* ignore */ }
        }
        return "Unknown Album";
    }

    if (job.type === "ScanPlaylist") {
        return payload.playlistName || "Playlist";
    }

    if (job.type === "RefreshMetadata") {
        return payload.expectedArtists
            ? `Metadata refresh for ${payload.expectedArtists} managed artist(s)`
            : (payload.target || "Metadata refresh");
    }

    if (job.type === "ApplyCuration") {
        return payload.expectedArtists
            ? `Curation for ${payload.expectedArtists} managed artist(s)`
            : "Curation";
    }

    if (job.type === "DownloadMissing") {
        return "Queueing monitored missing downloads";
    }

    if (job.type === "CheckUpgrades") {
        return "Checking monitored library upgrades";
    }

    if (job.type === "CurateArtist") {
        const artistName = resolveArtistName();
        if (artistName) return workflowLabel ? `${workflowLabel}: ${artistName}` : `Curate Artist: ${artistName}`;
        return workflowLabel ? `${workflowLabel}: Curate artist` : "Curate Artist";
    }

    if (job.type === "RescanFolders") {
        if (payload?.addNewArtists) {
            return "Scanning library root folders";
        }
        const artistName = resolveArtistName();
        if (artistName) return workflowLabel ? `${workflowLabel}: ${artistName}` : artistName;
        return workflowLabel || "Rescan folders";
    }

    if (job.type === "ConfigPrune") {
        return "Library cleanup";
    }

    if (job.type === "ApplyRenames") {
        return "Applying library rename plan";
    }

    if (job.type === "ApplyRetags") {
        return "Applying audio retag plan";
    }

    if (job.type === "Housekeeping") {
        return "Housekeeping";
    }

    if (job.type === "ImportDownload") {
        const resolved = payload?.resolved || {};
        const itemType = payload?.type || null;
        const title = resolved?.title || payload?.title || "Unknown";
        const artist = resolved?.artist || payload?.artist || "";
        const albumTitle = payload?.albumTitle || payload?.album || "";

        if (itemType === "album") {
            return artist ? `${title} by ${artist}` : title;
        }

        if (itemType === "track") {
            const subject = albumTitle
                ? `${title} on ${albumTitle}${artist ? ` by ${artist}` : ""}`
                : `${title}${artist ? ` by ${artist}` : ""}`;
            return subject;
        }

        if (itemType === "video") {
            return artist ? `${title} by ${artist}` : title;
        }

        if (payload?.files?.length) {
            return `Files: ${payload.files.length} item(s)`;
        }
    }

    if (job.type === "DownloadAlbum" && payload.title && payload.artist) {
        return `${payload.title} by ${payload.artist}`;
    }
    if (job.type === "DownloadTrack" && payload.title && payload.artist && (payload.albumTitle || payload.album)) {
        return `${payload.title} on ${payload.albumTitle || payload.album} by ${payload.artist}`;
    }
    if (job.type === "DownloadVideo" && payload.title && payload.artist) {
        return `${payload.title} by ${payload.artist}`;
    }

    if (!tidalId) return payload.title || job.type;

    try {
        if (job.type === "DownloadAlbum") {
            const cached = tidalId ? context?.albumById.get(tidalId) : undefined;
            if (cached !== undefined) {
                const albumTitle = formatAlbumTitle(cached?.title || payload.title || "Unknown", cached?.version || null);
                const artistName = cached?.artistName || payload.artist || "Unknown";
                return `${albumTitle} by ${artistName}`;
            }

            const row = db.prepare(`
                SELECT a.title, a.version, ar.name as artist_name
                FROM albums a
                LEFT JOIN artists ar ON ar.id = a.artist_id
                WHERE a.id = ?
            `).get(tidalId) as any;
            if (tidalId) {
                context?.albumById.set(tidalId, row?.title ? {
                    title: row.title,
                    version: row.version,
                    artistName: row.artist_name,
                } : null);
            }
            const albumTitle = formatAlbumTitle(row?.title || payload.title || "Unknown", row?.version || null);
            const artistName = row?.artist_name || payload.artist || "Unknown";
            return `${albumTitle} by ${artistName}`;
        }

        if (job.type === "DownloadTrack") {
            const cached = tidalId ? context?.trackById.get(tidalId) : undefined;
            if (cached !== undefined) {
                const trackTitle = cached?.trackTitle
                    ? formatTrackTitle(cached.trackTitle, cached.trackVersion || null)
                    : (payload.title || "Unknown Track");
                const albumTitle = cached?.albumTitle
                    ? formatAlbumTitle(cached.albumTitle, cached.albumVersion || null)
                    : (payload.albumTitle || payload.album || "Unknown Album");
                const artistName = cached?.artistName || payload.artist || "Unknown";
                return `${trackTitle} on ${albumTitle} by ${artistName}`;
            }

            const row = db.prepare(`
                SELECT
                    m.title as track_title,
                    m.version as track_version,
                    a.title as album_title,
                    a.version as album_version,
                    ar.name as artist_name
                FROM media m
                LEFT JOIN albums a ON a.id = m.album_id
                LEFT JOIN artists ar ON ar.id = a.artist_id
                WHERE m.id = ?
            `).get(tidalId) as any;
            if (tidalId) {
                context?.trackById.set(tidalId, row?.track_title ? {
                    trackTitle: row.track_title,
                    trackVersion: row.track_version,
                    albumTitle: row.album_title,
                    albumVersion: row.album_version,
                    artistName: row.artist_name,
                } : null);
            }
            const trackTitle = row?.track_title
                ? formatTrackTitle(row.track_title, row?.track_version || null)
                : (payload.title || "Unknown Track");
            const albumTitle = row?.album_title
                ? formatAlbumTitle(row.album_title, row?.album_version || null)
                : (payload.albumTitle || payload.album || "Unknown Album");
            const artistName = row?.artist_name || payload.artist || "Unknown";
            return `${trackTitle} on ${albumTitle} by ${artistName}`;
        }

        if (job.type === "DownloadVideo") {
            const cached = tidalId ? context?.videoById.get(tidalId) : undefined;
            if (cached !== undefined) {
                const title = cached?.title || payload.title || "Unknown Video";
                const artistName = cached?.artistName || payload.artist || "Unknown";
                return `${title} by ${artistName}`;
            }

            const row = db.prepare(`
                SELECT m.title, ar.name as artist_name
                FROM media m
                LEFT JOIN artists ar ON ar.id = m.artist_id
                WHERE m.id = ? AND m.type = 'Music Video'
            `).get(tidalId) as any;
            if (tidalId) {
                context?.videoById.set(tidalId, row?.title ? {
                    title: row.title,
                    artistName: row.artist_name,
                } : null);
            }
            const title = row?.title || payload.title || "Unknown Video";
            const artistName = row?.artist_name || payload.artist || "Unknown";
            return `${title} by ${artistName}`;
        }
    } catch {
        // ignore lookup failures
    }

    return payload.title || job.type;
};

const parseSqliteDate = (value: unknown) => {
    if (!value) return undefined;
    if (typeof value === "string") {
        if (value.includes("Z") || value.includes("T")) return new Date(value).getTime();
        return new Date(value.replace(" ", "T") + "Z").getTime();
    }
    if (typeof value === "number" || value instanceof Date) {
        return new Date(value).getTime();
    }
    return undefined;
};

export const mapJob = (job: Job, options: { queuePosition?: number; descriptionContext?: DescriptionLookupContext } = {}) => {
    const payload = job.payload && typeof job.payload === "object"
        ? {
            tidalId: job.ref_id || job.payload.tidalId,
            type: job.payload.type,
            title: job.payload.title,
            artist: job.payload.artist,
            albumTitle: job.payload.albumTitle || job.payload.album,
            playlistName: job.payload.playlistName,
            artistName: job.payload.artistName,
            reason: job.payload.reason,
            files: Array.isArray(job.payload.files) ? job.payload.files : undefined,
            originalJobId: job.payload.originalJobId,
            resolved: job.payload.resolved
                ? {
                    title: job.payload.resolved.title,
                    artist: job.payload.resolved.artist,
                    cover: job.payload.resolved.cover,
                }
                : undefined,
        }
        : undefined;

    return {
        id: job.id,
        type: job.type,
        description: buildDescription(job, options.descriptionContext),
        progress: Number(job.progress || 0),
        startTime: parseSqliteDate(job.started_at) ?? parseSqliteDate(job.created_at) ?? Date.now(),
        endTime: parseSqliteDate(job.completed_at),
        status: job.status === "processing" ? "running" : job.status,
        error: job.error,
        trigger: job.trigger ?? 0,
        queuePosition: options.queuePosition,
        payload,
    };
};

const sortJobsByTriggerThenTimeDesc = (jobs: Job[]) => {
    return jobs.sort((left, right) => {
        const leftTrigger = left.trigger ?? 0;
        const rightTrigger = right.trigger ?? 0;
        if (leftTrigger !== rightTrigger) return rightTrigger - leftTrigger;

        const leftTime = parseSqliteDate(left.created_at) || 0;
        const rightTime = parseSqliteDate(right.created_at) || 0;
        return rightTime - leftTime;
    });
};

export function getActiveCommands(limit: number = 100) {
    const activeJobs = TaskQueueService.listJobs("%", "processing", limit);
    return sortJobsByTriggerThenTimeDesc(activeJobs)
        .slice(0, limit)
        .map((job) => mapJob(job));
}

export function getCommandHistory(limit: number = 50, offset: number = 0) {
    return TaskQueueService.getHistory(limit, offset).map((job) => mapJob(job));
}

export interface ActivityQuery {
    limit?: number;
    offset?: number;
    statuses?: readonly ActivityStatus[];
    categories?: readonly CommandQueueCategory[];
    types?: readonly string[];
}

export interface ActivityPage {
    items: ReturnType<typeof mapJob>[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}

export interface ActivitySummary {
    pending: number;
    processing: number;
    history: number;
}

export type ActivityEventLevel = "info" | "warning" | "error";
export type ActivityEventSource = "task" | "history";

export interface ActivityEventLogItem {
    id: string;
    time: number;
    level: ActivityEventLevel;
    component: string;
    message: string;
    source: ActivityEventSource;
}

export interface ActivityEventsPage {
    items: ActivityEventLogItem[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}

function getPendingQueuePositionsForIds(types: readonly JobType[], pendingIds: readonly number[]): Map<number, number> {
    const queuePositionById = new Map<number, number>();
    if (types.length === 0 || pendingIds.length === 0) {
        return queuePositionById;
    }

    const typePlaceholders = types.map(() => "?").join(",");
    const idPlaceholders = pendingIds.map(() => "?").join(",");
    const rows = db.prepare(`
        SELECT
            target.id,
            1 + (
                SELECT COUNT(*)
                FROM job_queue candidate
                WHERE candidate.status = 'pending'
                  AND candidate.type IN (${typePlaceholders})
                  AND (
                    candidate.priority > target.priority
                    OR (
                        candidate.priority = target.priority
                        AND COALESCE(candidate.trigger, 0) > COALESCE(target.trigger, 0)
                    )
                    OR (
                        candidate.priority = target.priority
                        AND COALESCE(candidate.trigger, 0) = COALESCE(target.trigger, 0)
                        AND COALESCE(candidate.queue_order, 2147483647) < COALESCE(target.queue_order, 2147483647)
                    )
                    OR (
                        candidate.priority = target.priority
                        AND COALESCE(candidate.trigger, 0) = COALESCE(target.trigger, 0)
                        AND COALESCE(candidate.queue_order, 2147483647) = COALESCE(target.queue_order, 2147483647)
                        AND candidate.created_at < target.created_at
                    )
                    OR (
                        candidate.priority = target.priority
                        AND COALESCE(candidate.trigger, 0) = COALESCE(target.trigger, 0)
                        AND COALESCE(candidate.queue_order, 2147483647) = COALESCE(target.queue_order, 2147483647)
                        AND candidate.created_at = target.created_at
                        AND candidate.id < target.id
                    )
                  )
            ) AS queuePosition
        FROM job_queue target
        WHERE target.status = 'pending'
          AND target.id IN (${idPlaceholders})
    `).all(...types, ...pendingIds) as Array<{ id: number; queuePosition: number }>;

    for (const row of rows) {
        queuePositionById.set(Number(row.id), Number(row.queuePosition));
    }

    return queuePositionById;
}

type TaskEventProjectionRow = {
    id: number;
    type: JobType;
    payload: unknown;
    status: ActivityStatus;
    progress: number;
    trigger: number | null;
    error: string | null;
    ref_id: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
};

function parseTaskPayload(raw: unknown): Record<string, unknown> {
    if (!raw) {
        return {};
    }

    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }

    if (typeof raw !== "string") {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function toTaskEventTimestamp(job: TaskEventProjectionRow): number {
    return parseSqliteDate(job.completed_at) ?? parseSqliteDate(job.started_at) ?? parseSqliteDate(job.created_at) ?? 0;
}

function getTaskEventLevel(status: ActivityStatus): ActivityEventLevel {
    if (status === "failed") {
        return "error";
    }

    if (status === "cancelled") {
        return "warning";
    }

    return "info";
}

function getTaskEventMessage(job: TaskEventProjectionRow, context?: DescriptionLookupContext): string {
    const description = buildDescription({
        ...job,
        trigger: job.trigger ?? 0,
        payload: parseTaskPayload(job.payload),
    } as unknown as Job, context);

    if (job.status === "pending") {
        return `Queued: ${description}`;
    }

    if (job.status === "processing") {
        return `Running: ${description}`;
    }

    if (job.status === "completed") {
        return `Completed: ${description}`;
    }

    if (job.status === "cancelled") {
        return `Cancelled: ${description}`;
    }

    if (job.status === "failed") {
        const normalizedError = String(job.error || "").trim();
        return normalizedError
            ? `Failed: ${description} (${normalizedError})`
            : `Failed: ${description}`;
    }

    return description;
}

function getHistoryEventLevel(eventType: HistoryEventType): ActivityEventLevel {
    if (eventType === "DownloadFailed") {
        return "error";
    }

    if (eventType === "AlbumImportIncomplete" || eventType === "DownloadIgnored" || eventType === "Unknown") {
        return "warning";
    }

    return "info";
}

function toHistoryEventMessage(eventType: HistoryEventType, sourceTitle: string | null): string {
    const title = String(sourceTitle || "").trim();
    return title ? `${eventType}: ${title}` : eventType;
}

function compareEventItemsDesc(left: ActivityEventLogItem, right: ActivityEventLogItem): number {
    if (left.time !== right.time) {
        return right.time - left.time;
    }

    if (left.source !== right.source) {
        return left.source === "task" ? -1 : 1;
    }

    const leftNumericId = Number.parseInt(left.id.split(":")[1] || "0", 10);
    const rightNumericId = Number.parseInt(right.id.split(":")[1] || "0", 10);
    if (Number.isFinite(leftNumericId) && Number.isFinite(rightNumericId) && leftNumericId !== rightNumericId) {
        return rightNumericId - leftNumericId;
    }

    return right.id.localeCompare(left.id);
}

function listTaskEventProjectionRows(limit: number, offset: number = 0): TaskEventProjectionRow[] {
    const categories = DEFAULT_ACTIVITY_CATEGORIES;
    const types = getActivityTypesByCategories(categories);
    if (types.length === 0) {
        return [];
    }

    const statusPlaceholders = ALL_ACTIVITY_STATUSES.map(() => "?").join(",");
    const typePlaceholders = types.map(() => "?").join(",");
    const rows = db.prepare(`
        SELECT
            id,
            type,
            payload,
            status,
            progress,
            trigger,
            error,
            ref_id,
            created_at,
            started_at,
            completed_at
        FROM job_queue
        WHERE type IN (${typePlaceholders})
          AND status IN (${statusPlaceholders})
        ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
        LIMIT ?
                OFFSET ?
    `).all(...types, ...ALL_ACTIVITY_STATUSES, limit, offset) as TaskEventProjectionRow[];

    return rows;
}

function mapTaskEventRows(rows: readonly TaskEventProjectionRow[], context: DescriptionLookupContext): ActivityEventLogItem[] {
    preloadDescriptionLookups(rows.map((row) => ({
        type: row.type,
        ref_id: row.ref_id,
        payload: parseTaskPayload(row.payload),
    })) as Array<Pick<Job, "type" | "ref_id" | "payload">>, context);

    return rows.map((job): ActivityEventLogItem => ({
        id: `task:${job.id}`,
        time: toTaskEventTimestamp(job),
        level: getTaskEventLevel(job.status),
        component: `task.${job.type}`,
        message: getTaskEventMessage(job, context),
        source: "task",
    }));
}

function mapHistoryEventRows(rows: readonly HistoryEventFeedItem[]): ActivityEventLogItem[] {
    return rows.map((item): ActivityEventLogItem => ({
        id: `history:${item.id}`,
        time: parseSqliteDate(item.date) ?? 0,
        level: getHistoryEventLevel(item.eventType),
        component: `history.${item.eventType}`,
        message: toHistoryEventMessage(item.eventType, item.sourceTitle),
        source: "history",
    }));
}

export function getActivityEventsPage(options: { limit?: number; offset?: number } = {}): ActivityEventsPage {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);

    const taskTypes = getActivityTypesByCategories(DEFAULT_ACTIVITY_CATEGORIES);
    const taskTotal = taskTypes.length > 0
        ? TaskQueueService.countJobsByTypesAndStatuses(taskTypes, [...ALL_ACTIVITY_STATUSES])
        : 0;
    const historyTotal = countHistoryEvents();

    const total = taskTotal + historyTotal;
    if (offset >= total) {
        return {
            items: [],
            total,
            limit,
            offset,
            hasMore: false,
        };
    }

    const chunkSize = Math.max(limit, 128);
    const descriptionContext = createDescriptionLookupContext();

    let taskOffset = 0;
    let taskIndex = 0;
    let taskBatch: ActivityEventLogItem[] = [];

    let historyOffset = 0;
    let historyIndex = 0;
    let historyBatch: ActivityEventLogItem[] = [];

    const refillTaskBatch = () => {
        while (taskIndex >= taskBatch.length && taskOffset < taskTotal) {
            const rows = listTaskEventProjectionRows(chunkSize, taskOffset);
            taskOffset += rows.length;
            taskBatch = mapTaskEventRows(rows, descriptionContext);
            taskIndex = 0;
            if (rows.length === 0) {
                taskOffset = taskTotal;
                break;
            }
        }
    };

    const refillHistoryBatch = () => {
        while (historyIndex >= historyBatch.length && historyOffset < historyTotal) {
            const rows = listHistoryEventFeedItems(chunkSize, historyOffset);
            historyOffset += rows.length;
            historyBatch = mapHistoryEventRows(rows);
            historyIndex = 0;
            if (rows.length === 0) {
                historyOffset = historyTotal;
                break;
            }
        }
    };

    const merged: ActivityEventLogItem[] = [];
    let mergedOffset = 0;

    while (merged.length < limit) {
        refillTaskBatch();
        refillHistoryBatch();

        const nextTask = taskIndex < taskBatch.length ? taskBatch[taskIndex] : null;
        const nextHistory = historyIndex < historyBatch.length ? historyBatch[historyIndex] : null;

        if (!nextTask && !nextHistory) {
            break;
        }

        const takeTask = nextTask && (!nextHistory || compareEventItemsDesc(nextTask, nextHistory) <= 0);
        const nextItem = takeTask ? nextTask! : nextHistory!;

        if (takeTask) {
            taskIndex += 1;
        } else {
            historyIndex += 1;
        }

        if (mergedOffset < offset) {
            mergedOffset += 1;
            continue;
        }

        merged.push(nextItem);
    }

    return {
        items: merged,
        total,
        limit,
        offset,
        hasMore: offset + merged.length < total,
    };
}

export function getActivityPage(query: ActivityQuery = {}): ActivityPage {
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const offset = Math.max(0, query.offset ?? 0);
    const statuses = normalizeStatuses(query.statuses);
    const categories = query.categories && query.categories.length > 0
        ? query.categories
        : DEFAULT_ACTIVITY_CATEGORIES;

    const categoryTypes = getActivityTypesByCategories(categories);
    const filteredTypes: JobType[] = query.types && query.types.length > 0
        ? categoryTypes.filter((type) => query.types?.includes(type))
        : categoryTypes;

    if (statuses.length === 0 || filteredTypes.length === 0) {
        return {
            items: [],
            total: 0,
            limit,
            offset,
            hasMore: false,
        };
    }

    const orderBy = statuses.length === 1 && statuses[0] === "pending"
        ? "execution"
        : "created_desc";
    const total = TaskQueueService.countJobsByTypesAndStatuses(filteredTypes, statuses);
    const jobs = TaskQueueService.listJobsByTypesAndStatuses(filteredTypes, statuses, limit, offset, {
        orderBy,
    });
    const pendingQueuePositionById = statuses.includes("pending")
        ? getPendingQueuePositionsForIds(
            filteredTypes,
            jobs.filter((job) => job.status === "pending").map((job) => job.id),
        )
        : new Map<number, number>();
    const descriptionContext = createDescriptionLookupContext();
    preloadDescriptionLookups(jobs, descriptionContext);

    return {
        items: jobs.map((job) => mapJob(job, {
            queuePosition: pendingQueuePositionById.get(job.id),
            descriptionContext,
        })),
        total,
        limit,
        offset,
        hasMore: offset + jobs.length < total,
    };
}

export function getActivitySummary(categories: readonly CommandQueueCategory[] = DEFAULT_ACTIVITY_CATEGORIES): ActivitySummary {
    const types = getActivityTypesByCategories(categories);
    if (types.length === 0) {
        return {
            pending: 0,
            processing: 0,
            history: 0,
        };
    }

    return {
        pending: TaskQueueService.countJobsByTypesAndStatuses(types, ["pending"]),
        processing: TaskQueueService.countJobsByTypesAndStatuses(types, ["processing"]),
        history: TaskQueueService.countJobsByTypesAndStatuses(types, ["completed", "failed", "cancelled"]),
    };
}

export const ACTIVITY_FILTERS = {
    statuses: ALL_ACTIVITY_STATUSES,
    categories: ["downloads", "scans", "other"] as const,
};
