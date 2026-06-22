import { CommandTrigger } from "../commands/command-trigger.js";
import { db } from "../../database.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";
import {
    invalidateArtistDownloadStatus,
    invalidateReleaseGroupDownloadStatus,
    updateArtistDownloadStatus,
} from "../download/download-state.js";
import { CurationService } from "./curation-service.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { getConfigSection } from "../config/config.js";

export const LIBRARY_BULK_ENTITIES = ["artist", "album", "track", "video"] as const;
export const LIBRARY_BULK_ACTIONS = ["monitor", "unmonitor", "lock", "unlock", "download"] as const;

export type LibraryBulkEntity = typeof LIBRARY_BULK_ENTITIES[number];
export type LibraryBulkAction = typeof LIBRARY_BULK_ACTIONS[number];
export type LibraryBulkItemStatus = "updated" | "queued" | "missing" | "unsupported" | "noop";

export interface LibraryBulkActionItemResult {
    id: string;
    status: LibraryBulkItemStatus;
    commandId?: number;
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
    local_id?: string | number | null;
    mbid?: string | null;
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
    artist_mbid?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    recording_mbid?: string | null;
    provider?: string | null;
    provider_id?: string | null;
    provider_title?: string | null;
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

function refreshArtists(artistIds: string[]) {
    for (const artistId of uniqueIds(artistIds)) {
        updateArtistDownloadStatus(artistId);
    }
}

function canonicalRowsByRequestedId(rows: EntityRow[], requestedIds: string[]): Map<string, EntityRow> {
    const rowsByKey = new Map<string, EntityRow>();
    for (const row of rows) {
        for (const key of [row.id, row.local_id, row.mbid]) {
            const normalized = toNumberId(key);
            if (normalized) {
                rowsByKey.set(normalized, row);
            }
        }
    }

    const matched = new Map<string, EntityRow>();
    for (const id of requestedIds) {
        const row = rowsByKey.get(id);
        if (row) {
            matched.set(id, row);
        }
    }

    return matched;
}

function applyReleaseGroupWantedState(releaseGroupMbids: string[], monitored: boolean): void {
    const normalizedReleaseGroupMbids = uniqueIds(releaseGroupMbids);
    if (normalizedReleaseGroupMbids.length === 0) {
        return;
    }

    const includeSpatial = getConfigSection("filtering").include_spatial === true;
    const slots = includeSpatial ? ["stereo", "spatial"] : ["stereo"];
    const wanted = monitored ? 1 : 0;
    const upsert = db.prepare(`
        INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, updated_at)
        SELECT artist_mbid, mbid, ?, ?, CURRENT_TIMESTAMP
        FROM Albums
        WHERE mbid = ?
        ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
          artist_mbid = excluded.artist_mbid,
          monitored = excluded.monitored,
          updated_at = CURRENT_TIMESTAMP
    `);

    const tx = db.transaction(() => {
        for (const releaseGroupMbid of normalizedReleaseGroupMbids) {
            for (const slot of slots) {
                upsert.run(slot, wanted, releaseGroupMbid);
            }
        }
    });

    tx();
}

function applyArtistMonitorState(artistIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const artistPlaceholders = buildPlaceholders(artistIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE Artists
            SET monitored = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${artistPlaceholders})
        `).run(nextStatus, nextStatus, ...artistIds);

        if (!monitored) {
            db.prepare(`
                UPDATE ReleaseGroupSlots
                SET monitored = 0, updated_at = CURRENT_TIMESTAMP
                WHERE artist_mbid IN (
                    SELECT mbid FROM Artists WHERE id IN (${artistPlaceholders})
                )
                  AND COALESCE(monitored_lock, 0) = 0
            `).run(...artistIds);

            db.prepare(`
                UPDATE Recordings
                SET monitored = 0
                WHERE is_video = 1
                  AND artist_mbid IN (
                    SELECT mbid FROM Artists WHERE id IN (${artistPlaceholders})
                  )
                  AND COALESCE(monitored_lock, 0) = 0
            `).run(...artistIds);
        }
    });

    tx();
}

function applyAlbumMonitorState(releaseGroupMbids: string[], monitored: boolean): void {
    applyReleaseGroupWantedState(releaseGroupMbids, monitored);
}

function applyTrackMonitorState(trackIds: string[], monitored: boolean): void {
    const rows = fetchRows(`
        SELECT DISTINCT ar.release_group_mbid AS id
        FROM Tracks t
        JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
        WHERE CAST(t.id AS TEXT) IN (${buildPlaceholders(trackIds.length)})
           OR t.mbid IN (${buildPlaceholders(trackIds.length)})
    `, [...trackIds, ...trackIds]);

    applyReleaseGroupWantedState(rows.map((row) => String(row.id)), monitored);
}

function applyVideoMonitorState(videoIds: string[], monitored: boolean): void {
    const nextStatus = monitored ? 1 : 0;
    const videoPlaceholders = buildPlaceholders(videoIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE Recordings
            SET monitored = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (${videoPlaceholders})
              AND is_video = 1
        `).run(nextStatus, nextStatus, ...videoIds);
    });

    tx();
}

function applyAlbumLockState(releaseGroupMbids: string[], locked: boolean): void {
    const nextStatus = locked ? 1 : 0;
    const albumPlaceholders = buildPlaceholders(releaseGroupMbids.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE ReleaseGroupSlots
            SET monitored_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE release_group_mbid IN (${albumPlaceholders})
        `).run(nextStatus, nextStatus, ...releaseGroupMbids);
    });

    tx();
}

function applyVideoLockState(videoIds: string[], locked: boolean): void {
    const nextStatus = locked ? 1 : 0;
    const videoPlaceholders = buildPlaceholders(videoIds.length);

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE Recordings
            SET monitored_lock = ?,
                locked_at = CASE WHEN ? = 1 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE NULL END
            WHERE id IN (${videoPlaceholders})
              AND is_video = 1
        `).run(nextStatus, nextStatus, ...videoIds);
    });

    tx();
}

function queueAlbumDownloads(releaseGroupMbids: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const releaseGroupMbid of releaseGroupMbids) {
        const selections = db.prepare(`
            SELECT
                rgs.slot,
                rgs.selected_provider,
                rgs.selected_provider_id,
                rgs.quality,
                rgs.provider_data,
                rg.title,
                artist.name AS artist_name
            FROM ReleaseGroupSlots rgs
            JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
            LEFT JOIN ArtistMetadata artist ON artist.mbid = rg.artist_mbid
            WHERE rgs.release_group_mbid = ?
              AND rgs.monitored = 1
              AND rgs.selected_provider IS NOT NULL
              AND rgs.selected_provider_id IS NOT NULL
            ORDER BY CASE rgs.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
        `).all(releaseGroupMbid) as Array<EntityRow & {
            slot?: string | null;
            selected_provider?: string | null;
            selected_provider_id?: string | number | null;
            provider_data?: string | null;
        }>;

        for (const album of selections) {
            if (album.selected_provider_id == null) {
                continue;
            }

            let providerData: any = null;
            try {
                providerData = album.provider_data ? JSON.parse(String(album.provider_data)) : null;
            } catch {
                providerData = null;
            }

            const providerAlbumId = String(album.selected_provider_id);
            const provider = album.selected_provider || "tidal";
            const slot = String(album.slot || "stereo");
            const artistNames = [String(album.artist_name || providerData?.artist?.name || "").trim()].filter(Boolean);
            const title = String(providerData?.title || album.title || "Unknown Album").trim();
            const version = String(providerData?.version || album.version || "").trim();
            const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
                ? `${title} (${version})`
                : title;
            const primaryArtist = String(album.artist_name || artistNames[0] || "Unknown").trim() || "Unknown";

            const commandId = CommandQueueManager.push(CommandNames.DownloadAlbum, {
                url: buildStreamingMediaUrl("album", providerAlbumId, provider as any),
                type: "album",
                provider,
                providerId: providerAlbumId,
                releaseGroupMbid,
                albumId: releaseGroupMbid,
                libraryRoot: slot === "spatial" ? "spatial" : "music",
                slot,
                title: displayTitle,
                artist: primaryArtist,
                artists: artistNames,
                cover: providerData?.cover || album.cover || null,
                quality: album.quality || providerData?.quality || null,
                description: `${displayTitle} by ${primaryArtist} (${slot})`,
            }, `${releaseGroupMbid}:${slot}`);

            if (commandId > 0) {
                queuedJobIds.push(commandId);
            }
        }
    }

    return queuedJobIds;
}

function queueTrackDownloads(trackIds: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const trackId of trackIds) {
        const track = db.prepare(`
            SELECT
                CAST(t.id AS TEXT) AS id,
                t.mbid,
                t.title,
                t.release_mbid,
                t.recording_mbid,
                ar.release_group_mbid,
                album.title AS album_title,
                artist.name AS artist_name,
                pi.provider,
                pi.provider_id,
                pi.title AS provider_title,
                pi.version,
                pi.quality,
                pi.data AS provider_data
            FROM Tracks t
            JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
            JOIN Albums album ON album.mbid = ar.release_group_mbid
            LEFT JOIN ArtistMetadata artist ON artist.mbid = ar.artist_mbid
            LEFT JOIN ProviderItems pi
              ON pi.entity_type IN ('track', 'recording')
             AND (
                pi.track_id = t.id
                OR pi.track_mbid = t.mbid
                OR pi.recording_mbid = t.recording_mbid
             )
            WHERE (CAST(t.id AS TEXT) = ? OR t.mbid = ?)
            ORDER BY
              CASE WHEN pi.provider_id IS NULL THEN 1 ELSE 0 END,
              COALESCE(pi.match_confidence, 0) DESC,
              CASE COALESCE(pi.match_status, '') WHEN 'verified' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
              pi.updated_at DESC
            LIMIT 1
        `).get(trackId, trackId) as EntityRow | undefined;

        if (!track?.provider_id) {
            continue;
        }

        const title = String(track.title || track.provider_title || "Unknown Track").trim();
        const version = String(track.version || "").trim();
        const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
            ? `${title} (${version})`
            : title;
        const albumTitle = String(track.album_title || "Unknown Album").trim();
        const artistName = String(track.artist_name || "Unknown").trim() || "Unknown";

        const commandId = CommandQueueManager.push(CommandNames.DownloadTrack, {
            url: buildStreamingMediaUrl("track", String(track.provider_id)),
            type: "track",
            provider: track.provider || "tidal",
            canonicalTrackId: String(track.id),
            canonicalTrackMbid: track.mbid || null,
            canonicalRecordingMbid: track.recording_mbid || null,
            providerId: String(track.provider_id),
            title: displayTitle,
            artist: artistName,
            cover: track.album_cover || null,
            quality: track.quality || track.album_quality || null,
            artists: [artistName],
            releaseGroupMbid: track.release_group_mbid || undefined,
            releaseMbid: track.release_mbid || null,
            albumTitle,
            description: `${displayTitle} on ${albumTitle} by ${artistName}`,
        }, String(track.id || trackId));

        if (commandId > 0) {
            queuedJobIds.push(commandId);
        }
    }

    return queuedJobIds;
}

function queueVideoDownloads(videoIds: string[]): number[] {
    const queuedJobIds: number[] = [];

    for (const videoId of videoIds) {
        const video = db.prepare(`
            SELECT
                CAST(r.id AS TEXT) AS id,
                r.mbid,
                r.title,
                r.artist_mbid,
                artist.name as artist_name,
                pi.provider,
                pi.provider_id,
                pi.quality,
                pi.title AS provider_title
            FROM Recordings r
            LEFT JOIN ArtistMetadata artist ON artist.mbid = r.artist_mbid
            LEFT JOIN ProviderItems pi
              ON pi.entity_type = 'video'
             AND (
                pi.recording_id = r.id
                OR (r.mbid IS NOT NULL AND pi.recording_mbid = r.mbid)
             )
            WHERE CAST(r.id AS TEXT) = ? AND r.is_video = 1
            ORDER BY
              CASE WHEN pi.provider_id IS NULL THEN 1 ELSE 0 END,
              COALESCE(pi.match_confidence, 0) DESC,
              CASE COALESCE(pi.match_status, '') WHEN 'verified' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
              pi.updated_at DESC
            LIMIT 1
        `).get(videoId) as EntityRow | undefined;

        if (!video?.provider_id) {
            continue;
        }

        const title = String(video.title || video.provider_title || "Unknown Video").trim();
        const artistName = String(video.artist_name || "Unknown").trim() || "Unknown";

        const commandId = CommandQueueManager.push(CommandNames.DownloadVideo, {
            url: buildStreamingMediaUrl("video", String(video.provider_id)),
            type: "video",
            provider: video.provider || "tidal",
            canonicalRecordingId: String(video.id),
            canonicalRecordingMbid: video.mbid || null,
            providerId: String(video.provider_id),
            title,
            artist: artistName,
            cover: video.album_cover || null,
            quality: video.quality || null,
            artists: [artistName],
            description: `${title} by ${artistName}`,
        }, String(video.id || videoId));

        if (commandId > 0) {
            queuedJobIds.push(commandId);
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
            `SELECT id, name FROM Artists WHERE id IN (${buildPlaceholders(ids.length)})`,
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
                SELECT DISTINCT rg.mbid AS id
                FROM Albums rg
                JOIN Artists a ON a.mbid = rg.artist_mbid
                WHERE a.id IN (${buildPlaceholders(foundIds.length)})
            `,
            foundIds,
        );

        for (const releaseGroupMbid of albumRows.map((row) => String(row.id))) {
            invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
        }
        refreshArtists(foundIds);

        if (monitored) {
            for (const row of rows) {
                const artistId = String(row.id);
                const commandId = queueArtistMonitoringIntake({
                    artistId,
                    artistName: String(row.name || "").trim() || `Artist ${artistId}`,
                    priority: 1,
                    trigger: CommandTrigger.Manual,
                });

                result.items.push({
                    id: artistId,
                    status: "queued",
                    commandId,
                    message: "Monitoring enabled and intake queued",
                });
                result.queued += commandId > 0 ? 1 : 0;
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
            `SELECT mbid AS id FROM Albums WHERE mbid IN (${buildPlaceholders(ids.length)})`,
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
            const commandIds = queueAlbumDownloads(foundIds);
            const commandIdSet = new Set(commandIds);
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: commandIdSet.size > 0 ? "queued" : "noop",
                    message: "Album download queued",
                });
            }
            result.queued += commandIds.length;
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyAlbumMonitorState(foundIds, action === "monitor");
            for (const id of foundIds) {
                invalidateReleaseGroupDownloadStatus(id);
            }
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
            for (const id of foundIds) {
                invalidateReleaseGroupDownloadStatus(id);
            }
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
            `
                SELECT
                  CAST(t.id AS TEXT) AS id,
                  CAST(t.id AS TEXT) AS local_id,
                  t.mbid,
                  ar.release_group_mbid,
                  ar.artist_mbid
                FROM Tracks t
                JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
                WHERE CAST(t.id AS TEXT) IN (${buildPlaceholders(ids.length)})
                   OR t.mbid IN (${buildPlaceholders(ids.length)})
            `,
            [...ids, ...ids],
        );
        const rowsByRequestedId = canonicalRowsByRequestedId(rows, ids);
        const foundIds = Array.from(rowsByRequestedId.keys());
        result.matched = foundIds.length;

        for (const id of ids) {
            if (!rowsByRequestedId.has(id)) {
                result.items.push({ id, status: "missing", message: "Track not found" });
                result.missing += 1;
            }
        }

        if (foundIds.length === 0) {
            return result;
        }

        if (action === "download") {
            const commandIds = queueTrackDownloads(foundIds);
            result.queued += commandIds.length;
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: commandIds.length > 0 ? "queued" : "noop",
                    message: commandIds.length > 0 ? "Track download queued" : "No provider offer available for track",
                });
            }
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyTrackMonitorState(foundIds, action === "monitor");
            for (const releaseGroupMbid of uniqueIds(rows.map((row) => String(row.release_group_mbid || "")))) {
                invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
            }
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
            return markUnsupported(result, foundIds, "Track locking is not supported; track availability is derived from the monitored release slot");
        }

        return result;
    }

    private static applyVideoAction(result: LibraryBulkActionResult, ids: string[], action: LibraryBulkAction): LibraryBulkActionResult {
        const rows = fetchRows(
            `
                SELECT
                  CAST(r.id AS TEXT) AS id,
                  CAST(r.id AS TEXT) AS local_id,
                  r.mbid,
                  r.artist_mbid,
                  artist.Id AS artist_id
                FROM Recordings r
                LEFT JOIN ArtistMetadata metadata ON metadata.mbid = r.artist_mbid
                LEFT JOIN Artists artist ON artist.mbid = metadata.mbid
                WHERE CAST(r.id AS TEXT) IN (${buildPlaceholders(ids.length)})
                  AND r.is_video = 1
            `,
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
            const commandIds = queueVideoDownloads(foundIds);
            result.queued += commandIds.length;
            for (const id of foundIds) {
                result.items.push({
                    id,
                    status: commandIds.length > 0 ? "queued" : "noop",
                    message: commandIds.length > 0 ? "Video download queued" : "No provider offer available for video",
                });
            }
            result.updated += foundIds.length;
            return result;
        }

        if (action === "monitor" || action === "unmonitor") {
            applyVideoMonitorState(foundIds, action === "monitor");
            for (const artistId of uniqueIds(rows.map((row) => String(row.artist_id || "")))) {
                invalidateArtistDownloadStatus(artistId);
            }
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
            for (const artistId of uniqueIds(rows.map((row) => String(row.artist_id || "")))) {
                invalidateArtistDownloadStatus(artistId);
            }
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
