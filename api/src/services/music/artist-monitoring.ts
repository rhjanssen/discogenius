import { db } from "../../database.js";
import { invalidateReleaseGroupDownloadStatus, updateArtistDownloadStatus } from "../download/download-state.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { queueArtistIntake, queueArtistWorkflow } from "./artist-workflow.js";
import { isMusicBrainzMbid } from "./refresh-artist-service.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");
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
        FROM Artists a
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
    const releaseGroupMbids = db.prepare(`
        SELECT DISTINCT rg.mbid
        FROM Albums rg
        LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
        WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
    `).all(artistId, artistId) as Array<{ mbid: string }>;

    for (const row of releaseGroupMbids) {
        invalidateReleaseGroupDownloadStatus(String(row.mbid));
    }

    updateArtistDownloadStatus(artistId);
}

export function applyArtistMonitoringState(artistId: string, monitored: boolean) {
    const nextStatus = monitored ? 1 : 0;
    const applyChanges = db.transaction(() => {
        const artistResult = db.prepare(`
            UPDATE Artists
            SET monitored = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
            WHERE id = ?
        `).run(nextStatus, nextStatus, artistId);

        if (monitored) {
            return artistResult.changes;
        }

        db.prepare(`
            UPDATE ReleaseGroupSlots
            SET monitored = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE (monitored_lock = 0 OR monitored_lock IS NULL)
              AND release_group_mbid IN (
                SELECT rg.mbid
                FROM Albums rg
                LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
                WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
              )
        `).run(artistId, artistId);

        db.prepare(`
            UPDATE Recordings
            SET monitored = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE is_video = 1
              AND artist_mbid = ?
              AND (monitored_lock = 0 OR monitored_lock IS NULL)
        `).run(artistId);

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
    return queueArtistIntake({
        artistId: options.artistId,
        artistName: String(options.artistName || "").trim() || requireArtistName(options.artistId),
        monitored: true,
        priority: options.priority,
        trigger: options.trigger,
    });
}

function ensurePendingMusicBrainzArtist(artistId: string, artistName?: string): string | null {
    if (!isMusicBrainzMbid(artistId)) {
        return null;
    }

    const existing = db.prepare("SELECT id FROM Artists WHERE id = ? OR mbid = ? LIMIT 1")
        .get(artistId, artistId) as { id: string | number } | undefined;
    if (existing?.id != null) {
        return String(existing.id);
    }

    const cachedMetadata = db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = ? LIMIT 1")
        .get(artistId) as { name?: string | null } | undefined;
    const resolvedName = String(artistName || cachedMetadata?.name || "").trim();
    if (!resolvedName) {
        return null;
    }

    db.prepare(`
        INSERT INTO Artists (
            id, name, mbid, musicbrainz_status, musicbrainz_match_method,
            monitored, monitored_at, user_date_added
        )
        VALUES (?, ?, ?, 'pending', 'musicbrainz-search-result', 0, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO NOTHING
    `).run(artistId, resolvedName, artistId);
    return artistId;
}

export async function monitorArtistAndQueueIntake(options: {
    artistId: string;
    artistName?: string;
    priority?: number;
    trigger?: number;
}) {
    const existingByMbid = isMusicBrainzMbid(options.artistId)
        ? db.prepare("SELECT id FROM Artists WHERE mbid = ? LIMIT 1").get(options.artistId) as { id: string | number } | undefined
        : undefined;
    let artistId = existingByMbid?.id != null ? String(existingByMbid.id) : options.artistId;

    const pendingArtistId = ensurePendingMusicBrainzArtist(artistId, options.artistName);
    if (pendingArtistId) {
        artistId = pendingArtistId;
    } else {
        await RefreshArtistService.scanBasic(artistId, { monitorArtist: true });
    }

    const changes = applyArtistMonitoringState(artistId, true);
    if (changes === 0) {
        throw new Error(`Artist ${artistId} not found`);
    }

    const jobId = queueArtistMonitoringIntake({
        artistId,
        artistName: options.artistName,
        priority: options.priority,
        trigger: options.trigger,
    });

    return {
        artist: loadArtistWithEffectiveMonitor(artistId),
        jobId,
    };
}

export async function setArtistMonitoredState(options: {
    artistId: string;
    artistName?: string;
    monitored: boolean;
    priority?: number;
    trigger?: number;
}): Promise<{ artist: ArtistMonitorRow | undefined; monitored: boolean; jobId: number } | null> {
    if (options.monitored) {
        const result = await monitorArtistAndQueueIntake({
            artistId: options.artistId,
            artistName: options.artistName,
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
        await RefreshArtistService.scanBasic(artistId);
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
