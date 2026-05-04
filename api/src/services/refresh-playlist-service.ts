import { db } from "../database.js";
import { getPlaylist, getPlaylistTracks } from "./providers/tidal/tidal.js";
import { RefreshAlbumService } from "./refresh-album-service.js";

type PlaylistTrackValidationState = "valid" | "empty" | "partial" | "malformed";

interface PlaylistTrackValidationEntry {
    trackId: number;
    position: number;
    albumId: string | null;
}

interface PlaylistTrackValidationResult {
    state: PlaylistTrackValidationState;
    expectedTrackCount: number;
    remoteItemCount: number;
    tracks: PlaylistTrackValidationEntry[];
    reason?: string;
}

function parsePlaylistTrackId(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function resolvePlaylistAlbumId(track: Record<string, unknown>): string | null {
    if (track.album_id !== null && track.album_id !== undefined) {
        return String(track.album_id);
    }

    if (track.albumId !== null && track.albumId !== undefined) {
        return String(track.albumId);
    }

    const albumObj = track.album;
    if (albumObj && typeof albumObj === "object") {
        const albumId = (albumObj as { id?: unknown }).id;
        if (albumId !== null && albumId !== undefined) {
            return String(albumId);
        }
    }

    return null;
}

export function validatePlaylistTrackPayload(
    expectedTrackCountRaw: unknown,
    payload: unknown,
): PlaylistTrackValidationResult {
    const expectedTrackCount = Number.parseInt(String(expectedTrackCountRaw ?? 0), 10);
    if (!Number.isFinite(expectedTrackCount) || expectedTrackCount < 0) {
        return {
            state: "malformed",
            expectedTrackCount: 0,
            remoteItemCount: 0,
            tracks: [],
            reason: `invalid expected track count: ${expectedTrackCountRaw}`,
        };
    }

    if (!Array.isArray(payload)) {
        return {
            state: "malformed",
            expectedTrackCount,
            remoteItemCount: 0,
            tracks: [],
            reason: "playlist payload was not an array",
        };
    }

    const remoteItemCount = payload.length;
    if (expectedTrackCount === 0 && remoteItemCount === 0) {
        return {
            state: "empty",
            expectedTrackCount,
            remoteItemCount,
            tracks: [],
        };
    }

    if (remoteItemCount === 0) {
        return {
            state: "partial",
            expectedTrackCount,
            remoteItemCount,
            tracks: [],
            reason: "playlist track payload was empty",
        };
    }

    const tracks: PlaylistTrackValidationEntry[] = [];
    let parseFailures = 0;

    for (let index = 0; index < payload.length; index += 1) {
        const rawEntry = payload[index];
        const candidate = rawEntry && typeof rawEntry === "object" && "item" in rawEntry
            ? (rawEntry as { item?: unknown }).item
            : rawEntry;

        if (!candidate || typeof candidate !== "object") {
            parseFailures += 1;
            continue;
        }

        const track = candidate as Record<string, unknown>;
        const trackId = parsePlaylistTrackId(track.id);
        if (!trackId) {
            parseFailures += 1;
            continue;
        }

        tracks.push({
            trackId,
            position: index,
            albumId: resolvePlaylistAlbumId(track),
        });
    }

    if (tracks.length === 0) {
        return {
            state: "malformed",
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `no parseable track ids in ${remoteItemCount} payload item(s)`,
        };
    }

    if (parseFailures > 0) {
        return {
            state: "partial",
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `${parseFailures} payload item(s) missing a parseable track id`,
        };
    }

    if (remoteItemCount !== expectedTrackCount) {
        return {
            state: "partial",
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `metadata expected ${expectedTrackCount} track(s) but payload returned ${remoteItemCount}`,
        };
    }

    return {
        state: "valid",
        expectedTrackCount,
        remoteItemCount,
        tracks,
    };
}

export class RefreshPlaylistService {
    static async scan(playlistId: string, options?: { forceUpdate?: boolean }): Promise<void> {
        console.log(`[RefreshPlaylistService] scan for ${playlistId}`);

        const forceUpdate = options?.forceUpdate === true;
        const tidalPlaylist = await getPlaylist(playlistId);
        if (!tidalPlaylist) {
            console.warn(`[RefreshPlaylistService] Playlist ${playlistId} not found on TIDAL`);
            return;
        }

        const resolvedPlaylistUuid = String(tidalPlaylist.uuid || playlistId);
        const playlistTrackResponse = await getPlaylistTracks(playlistId);
        const validation = validatePlaylistTrackPayload(tidalPlaylist.numberOfTracks, playlistTrackResponse);

        if (validation.state === "malformed") {
            const reason = validation.reason || "invalid payload";
            console.warn(`[RefreshPlaylistService] Playlist ${playlistId}: malformed track payload (${reason})`);
            throw new Error(`[RefreshPlaylistService] Playlist ${playlistId} failed fail-closed validation: ${reason}`);
        }

        if (validation.state === "partial") {
            const reason = validation.reason || "partial payload coverage";
            console.warn(`[RefreshPlaylistService] Playlist ${playlistId}: partial track payload (${reason})`);
            throw new Error(`[RefreshPlaylistService] Playlist ${playlistId} fail-closed: ${reason}`);
        }

        const upsertPlaylistMetadata = db.prepare(`
            INSERT INTO playlists (
                uuid, tidal_id, title, description, creator_name, creator_id,
                cover_id, square_cover_id, num_tracks, num_videos, duration,
                created, last_updated, type, public_playlist, monitored, downloaded,
                user_date_added, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(uuid) DO UPDATE SET
                tidal_id = excluded.tidal_id,
                title = excluded.title,
                description = excluded.description,
                creator_name = excluded.creator_name,
                creator_id = excluded.creator_id,
                cover_id = excluded.cover_id,
                square_cover_id = excluded.square_cover_id,
                num_tracks = excluded.num_tracks,
                num_videos = excluded.num_videos,
                duration = excluded.duration,
                created = excluded.created,
                last_updated = excluded.last_updated,
                type = excluded.type,
                public_playlist = excluded.public_playlist,
                last_scanned = CURRENT_TIMESTAMP
        `);

        const playlistMetadataValues = [
            resolvedPlaylistUuid,
            String(tidalPlaylist.uuid || playlistId),
            tidalPlaylist.title || "Unknown Playlist",
            tidalPlaylist.description || null,
            tidalPlaylist.creator?.name || null,
            tidalPlaylist.creator?.id != null ? String(tidalPlaylist.creator.id) : null,
            tidalPlaylist.image || null,
            tidalPlaylist.squareImage || null,
            Number(tidalPlaylist.numberOfTracks || 0),
            Number(tidalPlaylist.numberOfVideos || 0),
            Number(tidalPlaylist.duration || 0),
            tidalPlaylist.created || null,
            tidalPlaylist.lastUpdated || null,
            tidalPlaylist.type || "PLAYLIST",
            tidalPlaylist.publicPlaylist ? 1 : 0,
        ];

        const deletePlaylistTracks = db.prepare("DELETE FROM playlist_tracks WHERE playlist_uuid = ?");

        const writeEmptyPlaylist = db.transaction(() => {
            upsertPlaylistMetadata.run(...playlistMetadataValues);
            deletePlaylistTracks.run(resolvedPlaylistUuid);
        });

        if (validation.state === "empty") {
            writeEmptyPlaylist();
            console.log(`[RefreshPlaylistService] Playlist ${playlistId}: remote playlist is empty; local playlist tracks cleared`);
            return;
        }

        const tracks = validation.tracks;
        console.log(`[RefreshPlaylistService] Fetched ${tracks.length} tracks for playlist ${playlistId}`);

        const albumIds = new Set<string>();
        for (const track of tracks) {
            if (track.albumId) {
                albumIds.add(track.albumId);
            }
        }

        for (const albumId of albumIds) {
            try {
                await RefreshAlbumService.scanShallow(albumId, {
                    forceUpdate,
                    includeSimilarAlbums: false,
                    seedSimilarAlbums: false,
                });
            } catch (error) {
                console.warn(`[RefreshPlaylistService] Failed to scan album ${albumId} for playlist ${playlistId}:`, error);
            }
        }

        const mediaExists = db.prepare("SELECT 1 FROM media WHERE id = ? LIMIT 1");
        const missingLocalTrackIds = new Set<number>();

        for (const track of tracks) {
            const exists = mediaExists.get(track.trackId);
            if (!exists) {
                missingLocalTrackIds.add(track.trackId);
            }
        }

        if (missingLocalTrackIds.size > 0) {
            console.warn(
                `[RefreshPlaylistService] Playlist ${playlistId}: fail-closed partial local coverage (${missingLocalTrackIds.size} missing local media row(s))`,
            );
            throw new Error(
                `[RefreshPlaylistService] Playlist ${playlistId} fail-closed: missing ${missingLocalTrackIds.size} local media row(s) for remote track ids`,
            );
        }

        const insertPlaylistTrack = db.prepare(
            "INSERT INTO playlist_tracks (playlist_uuid, track_id, position) VALUES (?, ?, ?)",
        );

        const writePlaylistMembership = db.transaction((entries: PlaylistTrackValidationEntry[]) => {
            upsertPlaylistMetadata.run(...playlistMetadataValues);
            deletePlaylistTracks.run(resolvedPlaylistUuid);
            for (const entry of entries) {
                insertPlaylistTrack.run(resolvedPlaylistUuid, entry.trackId, entry.position);
            }
        });

        writePlaylistMembership(tracks);
        console.log(`[RefreshPlaylistService] Playlist ${playlistId}: full replace path (${tracks.length} tracks)`);
        console.log(`[RefreshPlaylistService] scan complete for ${playlistId}`);
    }
}
