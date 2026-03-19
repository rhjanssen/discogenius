import { db } from "../database.js";
import { getArtistWorkflowLabel } from "./artist-workflow.js";
import { Job, JobTypes, TaskQueueService } from "./queue.js";

const PENDING_ACTIVITY_JOB_TYPES = [
    JobTypes.RefreshArtist,
    JobTypes.ScanAlbum,
    JobTypes.ScanPlaylist,
    JobTypes.RefreshMetadata,
    JobTypes.ApplyCuration,
    JobTypes.DownloadMissing,
    JobTypes.CheckUpgrades,
    JobTypes.CurateArtist,
    JobTypes.RescanFolders,
    JobTypes.Housekeeping,
    JobTypes.ConfigPrune,
    JobTypes.ApplyRenames,
    JobTypes.ApplyRetags,
] as const;

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

export const buildDescription = (job: Job): string => {
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
            try {
                const row = db.prepare(`SELECT name FROM artists WHERE id = ?`).get(tidalId) as any;
                const resolved = String(row?.name || "").trim();
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
            try {
                const row = db.prepare(`
                    SELECT a.title, a.version, ar.name as artist_name
                    FROM albums a
                    LEFT JOIN artists ar ON ar.id = a.artist_id
                    WHERE a.id = ?
                `).get(tidalId) as any;
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
            const row = db.prepare(`
                SELECT a.title, a.version, ar.name as artist_name
                FROM albums a
                LEFT JOIN artists ar ON ar.id = a.artist_id
                WHERE a.id = ?
            `).get(tidalId) as any;
            const albumTitle = formatAlbumTitle(row?.title || payload.title || "Unknown", row?.version || null);
            const artistName = row?.artist_name || payload.artist || "Unknown";
            return `${albumTitle} by ${artistName}`;
        }

        if (job.type === "DownloadTrack") {
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
            const row = db.prepare(`
                SELECT m.title, ar.name as artist_name
                FROM media m
                LEFT JOIN artists ar ON ar.id = m.artist_id
                WHERE m.id = ? AND m.type = 'Music Video'
            `).get(tidalId) as any;
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

export const mapJob = (job: Job) => {
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
        description: buildDescription(job),
        progress: Number(job.progress || 0),
        startTime: parseSqliteDate(job.started_at) ?? parseSqliteDate(job.created_at) ?? Date.now(),
        endTime: parseSqliteDate(job.completed_at),
        status: job.status === "processing" ? "running" : job.status,
        error: job.error,
        trigger: job.trigger ?? 0,
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
        .map(mapJob);
}

export function getQueuedCommands(limit: number = 100) {
    const pendingJobs = TaskQueueService.listJobsByTypesAndStatuses(PENDING_ACTIVITY_JOB_TYPES, ["pending"], limit, 0);
    return sortJobsByTriggerThenTimeDesc(pendingJobs)
        .slice(0, limit)
        .map(mapJob);
}

export function getCommandHistory(limit: number = 50, offset: number = 0) {
    return TaskQueueService.getHistory(limit, offset).map(mapJob);
}
