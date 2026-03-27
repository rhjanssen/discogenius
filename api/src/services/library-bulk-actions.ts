import { db } from "../database.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";
import { updateAlbumDownloadStatus, updateArtistDownloadStatus, updateArtistDownloadStatusFromMedia } from "./download-state.js";
import { CurationService } from "./curation-service.js";
import { JobTypes, TaskQueueService } from "./queue.js";

export const LIBRARY_BULK_ENTITIES = ["artist", "album", "track", "video"] as const;
export const LIBRARY_BULK_ACTIONS = ["monitor", "unmonitor", "lock", "unlock", "download"] as const;

export type LibraryBulkEntity = typeof LIBRARY_BULK_ENTITIES[number];
export type LibraryBulkAction = typeof LIBRARY_BULK_ACTIONS[number];
export type LibraryBulkItemStatus = "updated" | "queued" | "missing" | "unsupported" | "noop";

export interface LibraryBulkActionItemResult {
    id: string;
    status: LibraryBulkItemStatus;
    jobId?: number;
    message?: string;
}

export interface LibraryBulkActionResult {
    entity: LibraryBulkEntity;
    action: LibraryBulkAction;
    requested: number;
    matched: number;
    updated: number;
    queued: number;
    missing: number;
    unsupported: number;
    items: LibraryBulkActionItemResult[];
}

type EntityRow = {
    id: string | number;
    name?: string | null;
    title?: string | null;
    album_title?: string | null;
    album_version?: string | null;
    album_cover?: string | null;
    album_quality?: string | null;
    artist_id?: string | number | null;
    album_id?: string | number | null;
    monitor?: number | boolean | null;
    monitor_lock?: number | boolean | null;
    version?: string | null;
    quality?: string | null;
    cover?: string | null;
    artist_name?: string | null;
};

function uniqueIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean)));
}

function buildPlaceholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}

function toNumberId(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized ? normalized : null;
}

function makeSummary(entity: LibraryBulkEntity, action: LibraryBulkAction, ids: string[]): LibraryBulkActionResult {
    return {
        entity,
        action,
        requested: ids.length,
        matched: 0,
        updated: 0,
        queued: 0,
        missing: 0,
        unsupported: 0,
        items: [],
    };
}

function fetchRows(query: string, params: string[]): EntityRow[] {
    return db.prepare(query).all(...params) as EntityRow[];
}

function refreshAlbums(albumIds: string[]) {
    for (const albumId of uniqueIds(albumIds)) {
        updateAlbumDownloadStatus(albumId);
    }
}

function refreshArtists(artistIds: string[]) {
    for (const artistId of uniqueIds(artistIds)) {
        updateArtistDownloadStatus(artistId);
    }
}

function refreshArtistsFromMedia(mediaIds: string[]) {
    for (const mediaId of uniqueIds(mediaIds)) {
        updateArtistDownloadStatusFromMedia(mediaId);
    }
}

function applyArtistMonitorState(artistIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const artistPlaceholders = buildPlaceholders(artistIds.length);
    const albumArtistPlaceholders = buildPlaceholders(artistIds.length);
    const mediaArtistPlaceholders = buildPlaceholders(artistIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE artists
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${artistPlaceholders})
        `).run(nextStatus, nextStatus, ...artistIds);

        db.prepare(`
            UPDATE albums
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE (
                artist_id IN (${artistPlaceholders})
                OR id IN (
                    SELECT album_id
                    FROM album_artists
                    WHERE artist_id IN (${albumArtistPlaceholders})
                )
            )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, ...artistIds, ...artistIds);

        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE type != 'Music Video'
              AND album_id IN (
                  SELECT id
                  FROM albums
                  WHERE artist_id IN (${artistPlaceholders})
                     OR id IN (
                        SELECT album_id
                        FROM album_artists
                        WHERE artist_id IN (${albumArtistPlaceholders})
                     )
              )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, ...artistIds, ...artistIds);

        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE type = 'Music Video'
              AND artist_id IN (${mediaArtistPlaceholders})
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, ...artistIds);
    });

    tx();
}

function applyAlbumMonitorState(albumIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const albumPlaceholders = buildPlaceholders(albumIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE albums
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${albumPlaceholders})
        `).run(nextStatus, nextStatus, ...albumIds);

        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE album_id IN (${albumPlaceholders})
              AND type != 'Music Video'
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, ...albumIds);
    });

    tx();
}

function applyTrackMonitorState(trackIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const trackPlaceholders = buildPlaceholders(trackIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${trackPlaceholders})
              AND album_id IS NOT NULL
              AND type != 'Music Video'
        `).run(nextStatus, nextStatus, ...trackIds);
    });

    tx();
}

function applyVideoMonitorState(videoIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const videoPlaceholders = buildPlaceholders(videoIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${videoPlaceholders})
              AND type = 'Music Video'
        `).run(nextStatus, nextStatus, ...videoIds);
    });

    tx();
}

function applyAlbumLockState(albumIds: string[], locked: boolean): void {
    const nextStatus = locked ? 1 : 0;
    const albumPlaceholders = buildPlaceholders(albumIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE albums
            SET monitor_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE id IN (${albumPlaceholders})
        `).run(nextStatus, nextStatus, ...albumIds);

        db.prepare(`
            UPDATE media
            SET monitor_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE album_id IN (${albumPlaceholders})
              AND type != 'Music Video'
        `).run(nextStatus, nextStatus, ...albumIds);
    });

    tx();
}

function applyTrackLockState(trackIds: string[], locked: boolean): void {
    const nextStatus = locked ? 1 : 0;
    const trackPlaceholders = buildPlaceholders(trackIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE media
            SET monitor_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE id IN (${trackPlaceholders})
              AND album_id IS NOT NULL
              AND type != 'Music Video'
        `).run(nextStatus, nextStatus, ...trackIds);
    });

    tx();
}

function applyVideoLockState(videoIds: string[], locked: boolean): void {
    const nextStatus = locked ? 1 : 0;
    const videoPlaceholders = buildPlaceholders(videoIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE media
            SET monitor_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE id IN (${videoPlaceholders})
              AND type = 'Music Video'
        `).run(nextStatus, nextStatus, ...videoIds);
    });

    tx();
}

function queueAlbumDownloads(albumIds: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const albumId of albumIds) {
        const album = db.prepare(`
            SELECT a.id, a.title, a.version, a.cover, a.quality, ar.name as artist_name
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE a.id = ?
        `).get(albumId) as EntityRow | undefined;

        if (!album) {
            continue;
        }

        const albumArtists = db.prepare(`
            SELECT a.name
            FROM album_artists aa
            JOIN artists a ON a.id = aa.artist_id
            WHERE aa.album_id = ?
        `).all(albumId) as Array<{ name?: string | null }>;
        const artistNames = albumArtists.map((row) => String(row.name || "").trim()).filter(Boolean);
        const title = String(album.title || "Unknown Album").trim();
        const version = String(album.version || "").trim();
        const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
            ? `${title} (${version})`
            : title;
        const primaryArtist = String(album.artist_name || artistNames[0] || "Unknown").trim() || "Unknown";

        const jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
            url: `https://listen.tidal.com/album/${albumId}`,
            type: "album",
            tidalId: albumId,
            title: displayTitle,
            artist: primaryArtist,
            artists: artistNames,
            cover: album.cover || null,
            quality: album.quality || null,
            description: `${displayTitle} by ${primaryArtist}`,
        }, albumId);

        if (jobId > 0) {
            queuedJobIds.push(jobId);
        }
    }

    return queuedJobIds;
}

function queueTrackDownloads(trackIds: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const trackId of trackIds) {
        const track = db.prepare(`
            SELECT
                m.id,
                m.title,
                m.version,
                m.quality,
                a.title as album_title,
                a.version as album_version,
                a.cover as album_cover,
                a.quality as album_quality,
                ar.name as artist_name
            FROM media m
            LEFT JOIN albums a ON a.id = m.album_id
            LEFT JOIN artists ar ON ar.id = m.artist_id
            WHERE m.id = ? AND m.album_id IS NOT NULL AND m.type != 'Music Video'
        `).get(trackId) as EntityRow | undefined;

        if (!track) {
            continue;
        }

        const title = String(track.title || "Unknown Track").trim();
        const version = String(track.version || "").trim();
        const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
            ? `${title} (${version})`
            : title;
        const albumTitle = String(track.album_title || "Unknown Album").trim();
        const albumVersion = String(track.album_version || "").trim();
        const displayAlbumTitle = albumVersion && !albumTitle.toLowerCase().includes(albumVersion.toLowerCase())
            ? `${albumTitle} (${albumVersion})`
            : albumTitle;
        const artistName = String(track.artist_name || "Unknown").trim() || "Unknown";

        const jobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
            url: `https://listen.tidal.com/track/${trackId}`,
            type: "track",
            tidalId: trackId,
            title: displayTitle,
            artist: artistName,
            cover: track.album_cover || null,
            quality: track.quality || track.album_quality || null,
            artists: [artistName],
            albumId: String(track.album_id || ""),
            albumTitle: displayAlbumTitle,
            description: `${displayTitle} on ${displayAlbumTitle} by ${artistName}`,
        }, trackId);

        if (jobId > 0) {
            queuedJobIds.push(jobId);
        }
    }

    return queuedJobIds;
}

function queueVideoDownloads(videoIds: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const videoId of videoIds) {
        const video = db.prepare(`
            SELECT
                m.id,
                m.title,
                m.quality,
                ar.name as artist_name,
                a.cover as album_cover
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
            LEFT JOIN albums a ON a.id = m.album_id
            WHERE m.id = ? AND m.type = 'Music Video'
        `).get(videoId) as EntityRow | undefined;

        if (!video) {
            continue;
        }

        const title = String(video.title || "Unknown Video").trim();
        const artistName = String(video.artist_name || "Unknown").trim() || "Unknown";

        const jobId = TaskQueueService.addJob(JobTypes.DownloadVideo, {
            url: `https://listen.tidal.com/video/${videoId}`,
            type: "video",
            tidalId: videoId,
            title,
            artist: artistName,
            cover: video.album_cover || null,
            quality: video.quality || null,
            artists: [artistName],
            description: `${title} by ${artistName}`,
        }, videoId);

        if (jobId > 0) {
            queuedJobIds.push(jobId);
        }
    }

    return queuedJobIds;
}

function markUnsupported(result: LibraryBulkActionResult, ids: string[], message: string): LibraryBulkActionResult {
    for (const id of ids) {
        result.items.push({
            id,
            status: "unsupported",
            message,
        });
        result.unsupported += 1;
    }

    return result;
}

export class LibraryBulkActionService {
    static async apply(entity: LibraryBulkEntity, action: LibraryBulkAction, ids: string[]): Promise<LibraryBulkActionResult> {
        const normalizedIds = uniqueIds(ids);
        const result = makeSummary(entity, action, normalizedIds);

        if (normalizedIds.length === 0) {
            return result;
        }

        switch (entity) {
            case "artist":
                return this.applyArtistAction(result, normalizedIds, action);
            case "album":
                return this.applyAlbumAction(result, normalizedIds, action);
            case "track":
                return this.applyTrackAction(result, normalizedIds, action);
            case "video":
                return this.applyVideoAction(result, normalizedIds, action);
            default:
                return result;
        }
    }

    private static async applyArtistAction(result: LibraryBulkActionResult, ids: string[], action: LibraryBulkAction): Promise<LibraryBulkActionResult> {
        const rows = fetchRows(
            `SELECT id, name FROM artists WHERE id IN (${buildPlaceholders(ids.length)})`,
            ids,
        );
        const rowsById = new Map(rows.map((row) => [String(row.id), row]));
        const foundIds = rows.map((row) => String(row.id));
        result.matched = foundIds.length;

        for (const id of ids) {
            if (!rowsById.has(id)) {
                result.items.push({ id, status: "missing", message: "Artist not found" });
                result.missing += 1;
            }
        }

        if (foundIds.length === 0) {
            return result;
        }

        if (action === "download") {
            for (const row of rows) {
                const artistId = String(row.id);
                const queueCounts = await CurationService.queueMonitoredItems(artistId);
                const jobCount = queueCounts.albums + queueCounts.tracks + queueCounts.videos;
                result.items.push({
                    id: artistId,
                    status: jobCount > 0 ? "queued" : "noop",
                    message: jobCount > 0
                        ? `Queued ${jobCount} monitored item${jobCount === 1 ? "" : "s"}`
                        : "No monitored items were queued",
                });
                result.queued += jobCount;
                if (jobCount === 0) {
                    result.updated += 1;
                }
            }

            return result;
        }

        if (action === "lock" || action === "unlock") {
            return markUnsupported(result, foundIds, "Artist locking is not supported");
        }

        const monitored = action === "monitor";
        applyArtistMonitorState(foundIds, monitored);

        const albumRows = fetchRows(
            `
                SELECT DISTINCT CAST(a.id AS TEXT) AS id
                FROM albums a
                LEFT JOIN album_artists aa ON aa.album_id = a.id
                WHERE a.artist_id IN (${buildPlaceholders(foundIds.length)})
                   OR aa.artist_id IN (${buildPlaceholders(foundIds.length)})
            `,
            [...foundIds, ...foundIds],
        );

        refreshAlbums(albumRows.map((row) => String(row.id)));
        refreshArtists(foundIds);

        if (monitored) {
            for (const row of rows) {
                const artistId = String(row.id);
                const jobId = queueArtistMonitoringIntake({
                    artistId,
                    artistName: String(row.name || "").trim() || `Artist ${artistId}`,
                    priority: 1,
                    trigger: 1,
                });

                result.items.push({
                    id: artistId,
                    status: "queued",
                    jobId,
                    message: "Monitoring enabled and intake queued",
                });
                result.queued += jobId > 0 ? 1 : 0;
                result.updated += 1;
            }
            return result;
        }

        for (const id of foundIds) {
            result.items.push({
                id,
                status: "updated",
                message: monitored ? "Artist monitoring enabled" : "Artist monitoring disabled",
            });
            result.updated += 1;
        }

        return result;
    }

    private static applyAlbumAction(result: LibraryBulkActionResult, ids: string[], action: LibraryBulkAction): LibraryBulkActionResult {
        const rows = fetchRows(
            `SELECT id FROM albums WHERE id IN (${buildPlaceholders(ids.length)})`,
            ids,
        );
        const foundIds = rows.map((row) => String(row.id));
        const foundSet = new Set(foundIds);
        result.matched = foundIds.length;

        for (const id of ids) {
            if (!foundSet.has(id)) {
                result.items.push({ id, status: "missing", message: "Album not found" });
                result.missing += 1;
            }
        }

        if (foundIds.length === 0) {
            return result;
        }

        if (action === "download") {
            const jobIds = queueAlbumDownloads(foundIds);
            const jobIdSet = new Set(jobIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: jobIdSet.size > 0 ? "queued" : "noop",
                    message: "Album download queued",
                });
            }
            result.queued += jobIds.length;
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyAlbumMonitorState(foundIds, action === "monitor");
            refreshAlbums(foundIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "monitor" ? "Album monitoring enabled" : "Album monitoring disabled",
                });
                result.updated += 1;
            }
            return result;
        }

        if (action === "lock" || action === "unlock") {
            applyAlbumLockState(foundIds, action === "lock");
            refreshAlbums(foundIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "lock" ? "Album locked" : "Album unlocked",
                });
                result.updated += 1;
            }
            return result;
        }

        return result;
    }

    private static applyTrackAction(result: LibraryBulkActionResult, ids: string[], action: LibraryBulkAction): LibraryBulkActionResult {
        const rows = fetchRows(
            `SELECT id, album_id FROM media WHERE id IN (${buildPlaceholders(ids.length)}) AND album_id IS NOT NULL AND type != 'Music Video'`,
            ids,
        );
        const foundIds = rows.map((row) => String(row.id));
        const foundSet = new Set(foundIds);
        result.matched = foundIds.length;

        for (const id of ids) {
            if (!foundSet.has(id)) {
                result.items.push({ id, status: "missing", message: "Track not found" });
                result.missing += 1;
            }
        }

        if (foundIds.length === 0) {
            return result;
        }

        if (action === "download") {
            const jobIds = queueTrackDownloads(foundIds);
            result.queued += jobIds.length;
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "queued",
                    message: "Track download queued",
                });
            }
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyTrackMonitorState(foundIds, action === "monitor");
            refreshAlbums(Array.from(new Set(rows.map((row) => toNumberId(row.album_id)).filter((value): value is string => value !== null))));
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "monitor" ? "Track monitoring enabled" : "Track monitoring disabled",
                });
                result.updated += 1;
            }
            return result;
        }

        if (action === "lock" || action === "unlock") {
            applyTrackLockState(foundIds, action === "lock");
            refreshAlbums(Array.from(new Set(rows.map((row) => toNumberId(row.album_id)).filter((value): value is string => value !== null))));
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "lock" ? "Track locked" : "Track unlocked",
                });
                result.updated += 1;
            }
            return result;
        }

        return result;
    }

    private static applyVideoAction(result: LibraryBulkActionResult, ids: string[], action: LibraryBulkAction): LibraryBulkActionResult {
        const rows = fetchRows(
            `SELECT id, artist_id FROM media WHERE id IN (${buildPlaceholders(ids.length)}) AND type = 'Music Video'`,
            ids,
        );
        const foundIds = rows.map((row) => String(row.id));
        const foundSet = new Set(foundIds);
        result.matched = foundIds.length;

        for (const id of ids) {
            if (!foundSet.has(id)) {
                result.items.push({ id, status: "missing", message: "Video not found" });
                result.missing += 1;
            }
        }

        if (foundIds.length === 0) {
            return result;
        }

        if (action === "download") {
            const jobIds = queueVideoDownloads(foundIds);
            result.queued += jobIds.length;
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "queued",
                    message: "Video download queued",
                });
            }
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyVideoMonitorState(foundIds, action === "monitor");
            refreshArtistsFromMedia(foundIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "monitor" ? "Video monitoring enabled" : "Video monitoring disabled",
                });
                result.updated += 1;
            }
            return result;
        }

        if (action === "lock" || action === "unlock") {
            applyVideoLockState(foundIds, action === "lock");
            refreshArtistsFromMedia(foundIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: "updated",
                    message: action === "lock" ? "Video locked" : "Video unlocked",
                });
                result.updated += 1;
            }
            return result;
        }

        return result;
    }
}
