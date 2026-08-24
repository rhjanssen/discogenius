import { CommandTrigger } from "../commands/command-trigger.js";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { db } from "../../database.js";
import { invalidateReleaseGroupDownloadStatus, updateArtistDownloadStatus } from "../download/download-state.js";
import {
    addArtistToLibraries,
    isArtistLibraryMonitored,
    loadArtistMetadataIdentity,
    removeArtistFromLibraries,
    resolveEnabledArtistLibraryIds,
    resolveArtistMetadataId,
    setArtistLibraryPolicy,
    type ArtistPolicy,
    type ArtistLibraryMembership,
} from "./managed-artists.js";
import { unmonitorAlbumInLibraries } from "./library-album-monitoring.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { queueArtistIntake, queueArtistWorkflow } from "./artist-workflow.js";
import { isMusicBrainzMbid } from "./refresh-artist-service.js";
import { ArtistStatisticsService } from "./artist-statistics-service.js";

export type ArtistMonitorRow = Record<string, unknown> & {
    id: string;
    artist_metadata_id?: number;
    name?: string | null;
    mbid?: string | null;
    picture?: string | null;
    cover_image_url?: string | null;
    popularity?: number | null;
    overview?: string | null;
    type?: string | null;
    path?: string | null;
    library_origin?: string | null;
    metadata_status?: string | null;
    last_scanned?: string | null;
    added_at?: string | null;
    policy?: ArtistPolicy | null;
    downloaded?: number | null;
    effective_monitor?: number | null;
    artist_types?: string | null;
    memberships: ArtistLibraryMembership[];
};

function identityToMonitorRow(identity: NonNullable<ReturnType<typeof loadArtistMetadataIdentity>>): ArtistMonitorRow {
    return {
        id: String(identity.mbid),
        artist_metadata_id: identity.id,
        name: identity.name,
        mbid: identity.mbid,
        picture: identity.picture,
        cover_image_url: identity.cover_image_url,
        popularity: identity.popularity,
        overview: identity.overview,
        type: identity.type,
        path: identity.path,
        library_origin: identity.library_origin,
        metadata_status: identity.metadata_status,
        last_scanned: identity.last_scanned,
        added_at: identity.added_at,
        policy: identity.policy,
        effective_monitor: identity.in_library,
        artist_types: identity.type ? JSON.stringify([identity.type]) : null,
        memberships: identity.memberships,
    };
}

export function loadArtistWithEffectiveMonitor(artistId: string): ArtistMonitorRow | undefined {
    const identity = loadArtistMetadataIdentity(artistId);
    if (!identity) return undefined;
    return identityToMonitorRow(identity);
}

export function requireArtistName(artistId: string): string {
    const artist = loadArtistWithEffectiveMonitor(artistId);
    const artistName = String(artist?.name || "").trim();

    if (!artistName) {
        throw new Error(`Artist ${artistId} is missing a name`);
    }

    return artistName;
}

function refreshArtistProgress(artistMbid: string) {
    const releaseGroupMbids = db.prepare(`
        SELECT DISTINCT rg.mbid
        FROM Albums rg
        LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
        WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
    `).all(artistMbid, artistMbid) as Array<{ mbid: string }>;

    for (const row of releaseGroupMbids) {
        invalidateReleaseGroupDownloadStatus(String(row.mbid));
    }

    updateArtistDownloadStatus(artistMbid);
}

export function applyArtistMonitoringState(artistId: string, monitored: boolean, libraryIds?: number[]) {
    const scopedLibraryIds = resolveEnabledArtistLibraryIds(libraryIds);
    if (scopedLibraryIds.length === 0) return 0;
    const libraryPlaceholders = scopedLibraryIds.map(() => "?").join(",");
    const applyChanges = db.transaction(() => {
        const metadataId = resolveArtistMetadataId(artistId);
        if (metadataId == null) {
            return 0;
        }
        const identity = loadArtistMetadataIdentity(artistId);
        const artistMbid = identity?.mbid ? String(identity.mbid) : artistId;

        if (monitored) {
            addArtistToLibraries(metadataId, { policy: "all", libraryIds: scopedLibraryIds });
            return 1;
        }

        const affectedAlbums = db.prepare(`
            SELECT DISTINCT
              library_release.library_id AS library_id,
              release.release_group_id AS release_group_id
            FROM LibraryEditions library_release
            JOIN AlbumEditions release ON release.id = library_release.edition_id
            JOIN LibraryEditionScopes scope
              ON scope.library_edition_id = library_release.id
            JOIN LibraryArtists library_artist
              ON library_artist.id = scope.library_artist_id
            WHERE library_artist.artist_metadata_id = ?
              AND library_artist.library_id IN (${libraryPlaceholders})
        `).all(metadataId, ...scopedLibraryIds) as Array<{ library_id: number; release_group_id: number }>;

        db.prepare(`
            DELETE FROM LibraryEditionScopes
            WHERE library_artist_id IN (
              SELECT id FROM LibraryArtists
              WHERE artist_metadata_id = ?
                AND library_id IN (${libraryPlaceholders})
            )
        `).run(metadataId, ...scopedLibraryIds);

        const hasRemainingScope = db.prepare(`
            SELECT 1
            FROM LibraryEditionScopes remaining_scope
            JOIN LibraryEditions remaining_edition
              ON remaining_edition.id = remaining_scope.library_edition_id
            JOIN AlbumEditions remaining_release
              ON remaining_release.id = remaining_edition.edition_id
            WHERE remaining_edition.library_id = ?
              AND remaining_release.release_group_id = ?
            LIMIT 1
        `);
        const automaticallyMonitored = db.prepare(`
            SELECT 1 FROM LibraryAlbums
            WHERE library_id = ?
              AND release_group_id = ?
              AND selection_mode = 'auto'
              AND locked = 0
        `);
        for (const album of affectedAlbums) {
            if (hasRemainingScope.get(album.library_id, album.release_group_id)) continue;
            if (!automaticallyMonitored.get(album.library_id, album.release_group_id)) continue;
            unmonitorAlbumInLibraries(db, album.release_group_id, [album.library_id], { actor: "automation" });
        }

        db.prepare(`
            DELETE FROM LibraryVideos
            WHERE selection_mode = 'auto'
              AND library_id IN (${libraryPlaceholders})
              AND video_recording_id IN (
                SELECT id FROM Recordings WHERE is_video = 1 AND artist_mbid = ?
              )
        `).run(...scopedLibraryIds, artistMbid);

        removeArtistFromLibraries(metadataId, scopedLibraryIds);
        return 1;
    });

    const changes = Number(applyChanges() || 0);
    if (changes > 0) {
        const identity = loadArtistMetadataIdentity(artistId);
        const artistMbid = identity?.mbid ? String(identity.mbid) : artistId;
        refreshArtistProgress(artistMbid);
        ArtistStatisticsService.refresh([artistMbid]);
        emitLibraryUpdated({
            reason: monitored ? "artist-monitored" : "artist-unmonitored",
            artistIds: [artistMbid],
        });
    }

    return changes;
}

export function applyArtistPolicyState(artistId: string, policy: ArtistPolicy, libraryIds?: number[]): number {
    const metadataId = resolveArtistMetadataId(artistId);
    if (metadataId == null) return 0;
    if (!isArtistLibraryMonitored(artistId, libraryIds)) return 0;
    const changes = setArtistLibraryPolicy(metadataId, policy, libraryIds);
    if (changes > 0) {
        const identity = loadArtistMetadataIdentity(artistId);
        emitLibraryUpdated({
            reason: "artist-policy",
            artistIds: [identity?.mbid ? String(identity.mbid) : artistId],
        });
    }
    return changes;
}

export type ArtistLibraryUpdateResult =
    | {
        ok: true;
        artist: ArtistMonitorRow | undefined;
        monitored: boolean;
        policy: ArtistPolicy | null;
        commandId: number;
    }
    | { ok: false; status: 400 | 404 | 409; detail: string };

/**
 * Public artist PATCH semantics: membership (`monitored`) and grab policy are
 * separate. Unmonitor deletes LibraryArtists. Policy `none` pauses on a kept
 * row and never means leave-the-library.
 */
export async function updateArtistLibraryState(options: {
    artistId: string;
    artistName?: string;
    monitored?: boolean;
    policy?: ArtistPolicy;
    priority?: number;
    trigger?: number;
    libraryIds?: number[];
}): Promise<ArtistLibraryUpdateResult> {
    const { artistId, monitored, policy } = options;

    if (monitored === undefined && policy === undefined) {
        const artist = loadArtistWithEffectiveMonitor(artistId);
        return {
            ok: true,
            artist,
            monitored: Boolean(artist?.effective_monitor),
            policy: artist?.policy ?? null,
            commandId: -1,
        };
    }

    if (monitored === false && policy !== undefined) {
        return {
            ok: false,
            status: 400,
            detail: "Cannot set policy while unmonitoring; use policy none to pause without leaving the library",
        };
    }

    let commandId = -1;

    if (monitored !== undefined) {
        const result = await setArtistMonitoredState({
            artistId,
            artistName: options.artistName,
            monitored,
            priority: options.priority,
            trigger: options.trigger,
            libraryIds: options.libraryIds,
        });
        if (!result) {
            return { ok: false, status: 404, detail: "Artist not found" };
        }
        commandId = result.commandId;
    }

    if (policy !== undefined) {
        const identity = loadArtistWithEffectiveMonitor(artistId);
        if (!identity) {
            return { ok: false, status: 404, detail: "Artist not found" };
        }
        if (!isArtistLibraryMonitored(artistId, options.libraryIds)) {
            return {
                ok: false,
                status: 409,
                detail: "Artist is not in the library; monitor before setting policy",
            };
        }
        applyArtistPolicyState(artistId, policy, options.libraryIds);
    }

    const artist = loadArtistWithEffectiveMonitor(artistId);
    if (!artist && monitored === undefined) {
        return { ok: false, status: 404, detail: "Artist not found" };
    }

    return {
        ok: true,
        artist,
        monitored: Boolean(artist?.effective_monitor),
        policy: artist?.policy ?? null,
        commandId,
    };
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

    const existing = loadArtistWithEffectiveMonitor(artistId);
    if (existing?.id && (existing.picture || existing.cover_image_url)) {
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
        return localArtistId;
    } catch (error) {
        console.warn(`[Artists] Failed to hydrate MusicBrainz artist ${artistId} before monitoring:`, error);
    }

    if (existing?.id) {
        return String(existing.id);
    }

    db.prepare(`
        INSERT INTO ArtistMetadata (mbid, name, sort_name, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO NOTHING
    `).run(artistId, resolvedName, resolvedName);
    return artistId;
}

export async function monitorArtistAndQueueIntake(options: {
    artistId: string;
    artistName?: string;
    priority?: number;
    trigger?: number;
    libraryIds?: number[];
}) {
    const existingByMbid = isMusicBrainzMbid(options.artistId)
        ? db.prepare("SELECT mbid FROM ArtistMetadata WHERE mbid = ? LIMIT 1").get(options.artistId) as { mbid: string } | undefined
        : undefined;
    let artistId = existingByMbid?.mbid ? String(existingByMbid.mbid) : options.artistId;

    const pendingArtistId = await ensurePendingMusicBrainzArtist(artistId, options.artistName);
    if (pendingArtistId) {
        artistId = pendingArtistId;
    } else {
        await RefreshArtistService.refreshArtistMetadata(artistId, { monitorArtist: true });
    }

    const changes = applyArtistMonitoringState(artistId, true, options.libraryIds);
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
    libraryIds?: number[];
}): Promise<{ artist: ArtistMonitorRow | undefined; monitored: boolean; commandId: number } | null> {
    if (options.monitored) {
        const result = await monitorArtistAndQueueIntake({
            artistId: options.artistId,
            artistName: options.artistName,
            priority: options.priority,
            trigger: options.trigger,
            libraryIds: options.libraryIds,
        });

        return {
            artist: result.artist,
            monitored: true,
            commandId: result.commandId,
        };
    }

    const changes = applyArtistMonitoringState(options.artistId, false, options.libraryIds);
    if (changes === 0) {
        return null;
    }

    const artist = loadArtistWithEffectiveMonitor(options.artistId);
    return {
        artist,
        monitored: Boolean(artist?.effective_monitor),
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
