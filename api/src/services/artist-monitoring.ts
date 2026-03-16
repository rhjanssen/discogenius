import { db } from "../database.js";
import { updateAlbumDownloadStatus, updateArtistDownloadStatus } from "./download-state.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { scanArtistBasic } from "./scanner.js";
import { queueArtistWorkflow } from "./artist-workflow.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");
const MONITOR_ARTIST_WORKFLOW = "monitoring-intake" as const;

export type ArtistMonitorRow = Record<string, unknown> & {
    id: string | number;
    name?: string | null;
    picture?: string | null;
    downloaded?: number | null;
    effective_monitor?: number | null;
    last_scanned?: string | null;
    artist_types?: string | null;
};

export function loadArtistWithEffectiveMonitor(artistId: string): ArtistMonitorRow | undefined {
    return db.prepare(`
        SELECT a.*, CASE WHEN ${managedArtistPredicate} THEN 1 ELSE 0 END AS effective_monitor
        FROM artists a
        WHERE a.id = ?
    `).get(artistId) as ArtistMonitorRow | undefined;
}

export function requireArtistName(artistId: string): string {
    const artist = loadArtistWithEffectiveMonitor(artistId);
    const artistName = String(artist?.name || "").trim();

    if (!artistName) {
        throw new Error(`Artist ${artistId} is missing a name`);
    }

    return artistName;
}

function refreshArtistProgress(artistId: string) {
    const albumIds = db.prepare(`
        SELECT DISTINCT al.id
        FROM albums al
        LEFT JOIN album_artists aa ON aa.album_id = al.id
        WHERE al.artist_id = ? OR aa.artist_id = ?
    `).all(artistId, artistId) as Array<{ id: number }>;

    for (const row of albumIds) {
        updateAlbumDownloadStatus(String(row.id));
    }

    updateArtistDownloadStatus(artistId);
}

export function applyArtistMonitoringState(artistId: string, monitored: boolean) {
    const nextStatus = monitored ? 1 : 0;
    const applyChanges = db.transaction(() => {
        const artistResult = db.prepare(`
            UPDATE artists
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id = ?
        `).run(nextStatus, nextStatus, artistId);

        if (monitored) {
            return artistResult.changes;
        }

        db.prepare(`
            UPDATE albums
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE artist_id = ?
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, artistId);

        db.prepare(`
            UPDATE albums
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id IN (
                SELECT album_id FROM album_artists WHERE artist_id = ?
            )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, artistId);

        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE album_id IN (
                SELECT id FROM albums WHERE artist_id = ?
            )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, artistId);

        db.prepare(`
            UPDATE media
            SET monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE type = 'Music Video'
              AND artist_id = ?
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
        `).run(nextStatus, nextStatus, artistId);

        return artistResult.changes;
    });

    const changes = Number(applyChanges() || 0);
    if (changes > 0) {
        refreshArtistProgress(artistId);
    }

    return changes;
}

export function queueArtistMonitoringIntake(options: {
    artistId: string;
    artistName?: string;
    priority?: number;
    trigger?: number;
}) {
    return queueArtistWorkflow({
        artistId: options.artistId,
        artistName: String(options.artistName || "").trim() || requireArtistName(options.artistId),
        workflow: MONITOR_ARTIST_WORKFLOW,
        priority: options.priority,
        trigger: options.trigger,
    });
}

export async function monitorArtistAndQueueIntake(options: {
    artistId: string;
    priority?: number;
    trigger?: number;
}) {
    await scanArtistBasic(options.artistId, { monitorArtist: true });

    const changes = applyArtistMonitoringState(options.artistId, true);
    if (changes === 0) {
        throw new Error(`Artist ${options.artistId} not found`);
    }

    const jobId = queueArtistMonitoringIntake({
        artistId: options.artistId,
        priority: options.priority,
        trigger: options.trigger,
    });

    return {
        artist: loadArtistWithEffectiveMonitor(options.artistId),
        jobId,
    };
}

export async function setArtistMonitoredState(options: {
    artistId: string;
    monitored: boolean;
    priority?: number;
    trigger?: number;
}): Promise<{ artist: ArtistMonitorRow | undefined; monitored: boolean; jobId: number } | null> {
    if (options.monitored) {
        const result = await monitorArtistAndQueueIntake({
            artistId: options.artistId,
            priority: options.priority,
            trigger: options.trigger,
        });

        return {
            artist: result.artist,
            monitored: true,
            jobId: result.jobId,
        };
    }

    const changes = applyArtistMonitoringState(options.artistId, false);
    if (changes === 0) {
        return null;
    }

    return {
        artist: loadArtistWithEffectiveMonitor(options.artistId),
        monitored: false,
        jobId: -1,
    };
}

export async function queueArtistRefreshScan(artistId: string, options?: { forceUpdate?: boolean }) {
    let artist = loadArtistWithEffectiveMonitor(artistId);
    if (!artist) {
        await scanArtistBasic(artistId);
        artist = loadArtistWithEffectiveMonitor(artistId);
        if (!artist) {
            return null;
        }
    }

    const jobId = queueArtistWorkflow({
        artistId,
        artistName: String(artist.name || "").trim(),
        workflow: "refresh-scan",
        forceUpdate: Boolean(options?.forceUpdate),
        trigger: 1,
    });

    return {
        artist,
        jobId,
    };
}