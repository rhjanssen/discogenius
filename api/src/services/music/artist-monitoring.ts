import { CommandTrigger } from "../commands/command-trigger.js";
import { db } from "../../database.js";
import { invalidateReleaseGroupDownloadStatus, updateArtistDownloadStatus } from "../download/download-state.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { unmonitorAlbumInLibraries } from "./library-album-monitoring.js";
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

function materializeLibraryArtistMonitoring(artistId: string, monitored: boolean): void {
    const identity = db.prepare(`
        SELECT
          canonical.id AS canonical_artist_id,
          canonical.mbid,
          local.path
        FROM Artists local
        JOIN ArtistMetadata canonical ON canonical.mbid = local.mbid
        WHERE CAST(local.id AS TEXT) = ?
        LIMIT 1
    `).get(artistId) as {
        canonical_artist_id: number;
        mbid: string;
        path?: string | null;
    } | undefined;
    if (!identity) {
        return;
    }

    const managedArtistId = (db.prepare(`
        INSERT INTO ManagedArtists (artist_id, path, metadata_status, updated_at)
        VALUES (?, ?, 'verified', CURRENT_TIMESTAMP)
        ON CONFLICT(artist_id) DO UPDATE SET
          path = COALESCE(excluded.path, ManagedArtists.path),
          metadata_status = excluded.metadata_status,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
    `).get(identity.canonical_artist_id, identity.path ?? null) as { id: number }).id;

    db.prepare(`
        INSERT INTO LibraryArtists (
          library_id, managed_artist_id, monitored, credited_scope, updated_at
        )
        SELECT
          library.id,
          ?,
          ?,
          'release_and_track_credit',
          CURRENT_TIMESTAMP
        FROM Libraries library
        WHERE library.enabled = 1
        ON CONFLICT(library_id, managed_artist_id) DO UPDATE SET
          monitored = excluded.monitored,
          updated_at = CURRENT_TIMESTAMP
    `).run(managedArtistId, monitored ? 1 : 0);
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
            materializeLibraryArtistMonitoring(artistId, true);
            return artistResult.changes;
        }

        db.prepare(`
            UPDATE LibraryArtists
            SET monitored = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE managed_artist_id IN (
              SELECT managed.id
              FROM ManagedArtists managed
              JOIN ArtistMetadata canonical ON canonical.id = managed.artist_id
              JOIN Artists local ON local.mbid = canonical.mbid
              WHERE CAST(local.id AS TEXT) = ?
            )
        `).run(artistId);

        // Unmonitoring the Artist withdraws the Albums scoped to it. The Album
        // row goes rather than gaining a "monitored = 0" flag, and its monitored
        // Editions go with it. A locked Album survives both steps.
        const scopedAlbums = `
            SELECT DISTINCT
              library_release.library_id AS library_id,
              release.release_group_id AS release_group_id
            FROM LibraryEditions library_release
            JOIN AlbumEditions release ON release.id = library_release.edition_id
            JOIN LibraryEditionScopes scope
              ON scope.library_edition_id = library_release.id
            JOIN LibraryArtists library_artist
              ON library_artist.id = scope.library_artist_id
            JOIN ManagedArtists managed
              ON managed.id = library_artist.managed_artist_id
            JOIN ArtistMetadata canonical ON canonical.id = managed.artist_id
            JOIN Artists local ON local.mbid = canonical.mbid
            WHERE CAST(local.id AS TEXT) = ?
        `;
        const withdrawn = db.prepare(`
            SELECT library_id, release_group_id FROM (${scopedAlbums}) scoped
            WHERE COALESCE((
              SELECT locked FROM LibraryAlbums
              WHERE library_id = scoped.library_id
                AND release_group_id = scoped.release_group_id
            ), 0) = 0
        `).all(artistId) as Array<{ library_id: number; release_group_id: number }>;
        for (const album of withdrawn) {
            unmonitorAlbumInLibraries(db, album.release_group_id, [album.library_id], {
                actor: "automation",
            });
        }

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

async function ensurePendingMusicBrainzArtist(artistId: string, artistName?: string): Promise<string | null> {
    if (!isMusicBrainzMbid(artistId)) {
        return null;
    }

    const existing = db.prepare("SELECT id, name, picture, cover_image_url FROM Artists WHERE id = ? OR mbid = ? LIMIT 1")
        .get(artistId, artistId) as { id: string | number; name?: string | null; picture?: string | null; cover_image_url?: string | null } | undefined;
    if (existing?.id != null && (existing.picture || existing.cover_image_url)) {
        return String(existing.id);
    }

    const cachedMetadata = db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = ? LIMIT 1")
        .get(artistId) as { name?: string | null } | undefined;
    const resolvedName = String(artistName || existing?.name || cachedMetadata?.name || "").trim();
    if (!resolvedName) {
        return null;
    }

    try {
        const localArtistId = await RefreshArtistService.upsertMusicBrainzArtist(artistId, { monitorArtist: false });
        db.prepare(`
            UPDATE Artists
            SET user_date_added = COALESCE(user_date_added, CURRENT_TIMESTAMP)
            WHERE id = ?
        `).run(localArtistId);
        return localArtistId;
    } catch (error) {
        console.warn(`[Artists] Failed to hydrate MusicBrainz artist ${artistId} before monitoring:`, error);
    }

    if (existing?.id != null) {
        return String(existing.id);
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

    const pendingArtistId = await ensurePendingMusicBrainzArtist(artistId, options.artistName);
    if (pendingArtistId) {
        artistId = pendingArtistId;
    } else {
        await RefreshArtistService.refreshArtistMetadata(artistId, { monitorArtist: true });
    }

    const changes = applyArtistMonitoringState(artistId, true);
    if (changes === 0) {
        throw new Error(`Artist ${artistId} not found`);
    }

    const commandId = queueArtistMonitoringIntake({
        artistId,
        artistName: options.artistName,
        priority: options.priority,
        trigger: options.trigger,
    });

    return {
        artist: loadArtistWithEffectiveMonitor(artistId),
        commandId,
    };
}

export async function setArtistMonitoredState(options: {
    artistId: string;
    artistName?: string;
    monitored: boolean;
    priority?: number;
    trigger?: number;
}): Promise<{ artist: ArtistMonitorRow | undefined; monitored: boolean; commandId: number } | null> {
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
            commandId: result.commandId,
        };
    }

    const changes = applyArtistMonitoringState(options.artistId, false);
    if (changes === 0) {
        return null;
    }

    return {
        artist: loadArtistWithEffectiveMonitor(options.artistId),
        monitored: false,
        commandId: -1,
    };
}

export async function queueArtistRefreshScan(artistId: string, options?: { forceUpdate?: boolean }) {
    let artist = loadArtistWithEffectiveMonitor(artistId);
    if (!artist) {
        await RefreshArtistService.refreshArtistMetadata(artistId);
        artist = loadArtistWithEffectiveMonitor(artistId);
        if (!artist) {
            return null;
        }
    }

    const commandId = queueArtistWorkflow({
        artistId,
        artistName: String(artist.name || "").trim(),
        workflow: "refresh-scan",
        forceUpdate: Boolean(options?.forceUpdate),
        trigger: CommandTrigger.Manual,
    });

    return {
        artist,
        commandId,
    };
}
