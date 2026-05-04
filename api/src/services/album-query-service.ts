import { db } from "../database.js";
import { getAlbumDownloadStats, getAlbumDownloadStatsMap } from "./download-state.js";
import { hydrateTrackRows, type TrackRow } from "./track-query-service.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { lidarrMetadataService } from "./metadata/lidarr-metadata-service.js";
import type { AlbumTrackContract, AlbumVersionContract, SimilarAlbumContract } from "../contracts/media.js";
import type { AlbumContract, AlbumsListResponseContract } from "../contracts/catalog.js";
import type { AlbumPageContract } from "../contracts/pages.js";

const albumDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM media m
    WHERE m.album_id = albums.id
      AND m.type != 'Music Video'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM media m
    WHERE m.album_id = albums.id
      AND m.type != 'Music Video'
      AND NOT EXISTS (
        SELECT 1
        FROM library_files lf
        WHERE lf.media_id = m.id
          AND lf.file_type = 'track'
      )
  )
`;

export interface AlbumListQuery {
    limit: number;
    offset: number;
    search?: string;
    monitored?: boolean;
    downloaded?: boolean;
    locked?: boolean;
    libraryFilter?: string;
    sort?: string;
    dir?: string;
}

function normalizeAlbumRow(album: any, downloadedPercent: number, isDownloaded: boolean): AlbumContract {
    return {
        ...album,
        cover_id: album.cover,
        album_type: album.type,
        is_monitored: Boolean(album.monitor),
        downloaded: downloadedPercent,
        is_downloaded: isDownloaded,
    };
}

function queryAlbumRow(albumId: string): any | null {
    return db.prepare(`
      SELECT
        albums.*,
        artists.name as artist_name,
        artists.picture as artist_picture,
        artists.cover_image_url as artist_cover_image_url
      FROM albums
      LEFT JOIN artists ON albums.artist_id = artists.id
      WHERE albums.id = ?
    `).get(albumId) as any | null;
}

function getAlbumTrackRows(albumId: string): TrackRow[] {
    return db.prepare(`
      SELECT
        m.*, 
        a.title as album_title,
        a.cover as album_cover,
        ar.name as artist_name
      FROM media m
      LEFT JOIN albums a ON a.id = m.album_id
      LEFT JOIN artists ar ON ar.id = m.artist_id
      WHERE m.album_id = ? AND m.type != 'Music Video'
      ORDER BY m.volume_number ASC, m.track_number ASC, m.id ASC
    `).all(albumId) as TrackRow[];
}

function queryMusicBrainzReleaseGroup(releaseGroupMbid: string): any | null {
    return db.prepare(`
      SELECT
        rg.*,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitor AS artist_monitor
      FROM mb_release_groups rg
      LEFT JOIN artists a ON a.mbid = rg.artist_mbid
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid) as any | null;
}

function selectPreferredMusicBrainzRelease(releaseGroupMbid: string): any | null {
    return db.prepare(`
      SELECT
        r.*,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM mb_mediums m
            WHERE m.release_mbid = r.mbid
              AND LOWER(COALESCE(m.format, '')) LIKE '%digital%'
          ) THEN 1 ELSE 0
        END AS digital_score
      FROM mb_releases r
      WHERE r.release_group_mbid = ?
      ORDER BY
        digital_score DESC,
        CASE LOWER(COALESCE(r.status, '')) WHEN 'official' THEN 0 ELSE 1 END ASC,
        COALESCE(r.track_count, 0) DESC,
        (r.date IS NULL) ASC,
        r.date DESC,
        r.mbid ASC
      LIMIT 1
    `).get(releaseGroupMbid) as any | null;
}

function coverArtArchiveReleaseGroupUrl(mbid: string | null | undefined): string | null {
    const trimmed = String(mbid || "").trim();
    return trimmed ? `https://coverartarchive.org/release-group/${trimmed}/front-500` : null;
}

async function ensureMusicBrainzReleaseGroupHydrated(releaseGroupMbid: string): Promise<any | null> {
    const releaseGroup = queryMusicBrainzReleaseGroup(releaseGroupMbid);
    if (!releaseGroup) {
        return null;
    }

    const releaseCount = db.prepare("SELECT COUNT(*) AS count FROM mb_releases WHERE release_group_mbid = ?")
        .get(releaseGroupMbid) as { count: number } | undefined;

    if (Number(releaseCount?.count || 0) === 0) {
        try {
            await lidarrMetadataService.syncReleaseGroup(releaseGroupMbid, releaseGroup.artist_mbid);
        } catch (error) {
            console.warn(`[AlbumQueryService] Failed to hydrate Lidarr album ${releaseGroupMbid}:`, error);
        }
    }

    return queryMusicBrainzReleaseGroup(releaseGroupMbid);
}

function normalizeMusicBrainzAlbum(releaseGroup: any, release: any | null, providerCoverUrl?: string | null): AlbumContract {
    const primaryType = String(releaseGroup.primary_type || "Album").trim().toUpperCase();
    const artistId = releaseGroup.local_artist_id == null
        ? String(releaseGroup.artist_mbid)
        : String(releaseGroup.local_artist_id);
    const artistName = String(releaseGroup.local_artist_name || "Unknown Artist");
    let coverUrl: string | null = null;

    try {
        if (releaseGroup.data) {
            const albumData = typeof releaseGroup.data === "string" ? JSON.parse(releaseGroup.data) : releaseGroup.data;
            coverUrl = lidarrMetadataService.getAlbumImageUrl(albumData);
        }
    } catch {
        // ignore parsing errors
    }

    if (!coverUrl) {
        coverUrl = providerCoverUrl ?? coverArtArchiveReleaseGroupUrl(releaseGroup.mbid);
    }

    return {
        id: String(releaseGroup.mbid),
        title: String(releaseGroup.title || release?.title || "Unknown Album"),
        cover_id: coverUrl,
        cover: coverUrl,
        cover_art_url: coverUrl,
        vibrant_color: null,
        release_date: release?.date || releaseGroup.first_release_date || null,
        type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        album_type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        quality: null,
        is_monitored: Boolean(releaseGroup.artist_monitor),
        is_downloaded: false,
        downloaded: 0,
        artist_id: artistId,
        artist_name: artistName,
        include_in_monitoring: 1,
        excluded_reason: null,
        filtered_out: 0,
        filtered_reason: null,
        redundant_of: null,
        redundant: null,
        monitor: releaseGroup.artist_monitor ? 1 : 0,
        monitor_lock: 0,
        monitor_locked: false,
        module: primaryType,
        group_type: primaryType,
    };
}

function getMusicBrainzTrackRows(releaseMbid: string, releaseGroupMbid: string, albumTitle: string, artistName: string): AlbumTrackContract[] {
    const rows = db.prepare(`
      SELECT
        t.mbid,
        t.title,
        t.number,
        t.position,
        t.medium_position,
        t.length_ms
      FROM mb_tracks t
      WHERE t.release_mbid = ?
      ORDER BY t.medium_position ASC, t.position ASC
    `).all(releaseMbid) as any[];

    return rows.map((track) => ({
        id: String(track.mbid),
        title: String(track.title || "Unknown Track"),
        version: null,
        duration: Math.round(Number(track.length_ms || 0) / 1000),
        track_number: Number(track.position || 0),
        volume_number: Number(track.medium_position || 1),
        quality: "MusicBrainz",
        artist_name: artistName,
        album_title: albumTitle,
        downloaded: false,
        is_downloaded: false,
        is_monitored: true,
        monitor: 1,
        monitor_lock: 0,
        monitor_locked: false,
        explicit: false,
        album_id: releaseGroupMbid,
        files: [],
    }));
}

export class AlbumQueryService {
    private static async ensureAlbumRow(albumId: string): Promise<any | null> {
        const album = queryAlbumRow(albumId);

        if (album) {
            return album;
        }

        if (queryMusicBrainzReleaseGroup(albumId)) {
            return null;
        }

        try {
            await RefreshAlbumService.scanShallow(albumId, {
                includeSimilarAlbums: true,
                seedSimilarAlbums: false,
            });
        } catch {
            // Cold-load fallback only; return null below if the album still isn't available.
        }

        return queryAlbumRow(albumId);
    }

    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const monitoredFilter = input.monitored;
        const downloadedFilter = input.downloaded;
        const lockedFilter = input.locked;
        const libraryFilter = input.libraryFilter || "all";
        const sortParam = input.sort || "releaseDate";
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

        let query = `
      SELECT albums.*, artists.name as artist_name 
      FROM albums 
      LEFT JOIN artists ON albums.artist_id = artists.id
    `;
        let countQuery = `
      SELECT COUNT(*) as count
      FROM albums
      LEFT JOIN artists ON albums.artist_id = artists.id
    `;
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = [];

        if (search) {
            where.push(`(albums.title LIKE ? OR artists.name LIKE ?)`);
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
        }

        if (monitoredFilter !== undefined) {
            where.push(`albums.monitor = ?`);
            params.push(monitoredFilter ? 1 : 0);
            countParams.push(monitoredFilter ? 1 : 0);
        }

        if (downloadedFilter !== undefined) {
            where.push(downloadedFilter ? albumDownloadedPredicate : `NOT (${albumDownloadedPredicate})`);
        }

        if (lockedFilter !== undefined) {
            where.push(`COALESCE(albums.monitor_lock, 0) = ?`);
            params.push(lockedFilter ? 1 : 0);
            countParams.push(lockedFilter ? 1 : 0);
        }

        if (libraryFilter === "atmos") {
            where.push(`UPPER(COALESCE(albums.quality, '')) = 'DOLBY_ATMOS'`);
        } else if (libraryFilter === "stereo") {
            where.push(`UPPER(COALESCE(albums.quality, '')) <> 'DOLBY_ATMOS'`);
        }

        if (where.length) {
            const whereClause = ` WHERE ${where.join(" AND ")}`;
            query += whereClause;
            countQuery += whereClause;
        }

        const orderBy = (() => {
            switch (sortParam) {
                case "name":
                    return ` ORDER BY albums.title ${sortDir}, albums.id ASC`;
                case "popularity":
                    return ` ORDER BY COALESCE(albums.popularity, 0) ${sortDir}, albums.release_date DESC, albums.id ASC`;
                case "scannedAt":
                    return ` ORDER BY (albums.last_scanned IS NULL) ASC, albums.last_scanned ${sortDir}, albums.id ASC`;
                case "releaseDate":
                default:
                    return ` ORDER BY (albums.release_date IS NULL) ASC, albums.release_date ${sortDir}, albums.id ASC`;
            }
        })();

        query += `${orderBy} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const albums = db.prepare(query).all(...params) as any[];
        const downloadStats = getAlbumDownloadStatsMap(albums.map((album) => album.id));
        const items = albums.map((album) => {
            const stats = downloadStats.get(String(album.id));
            return normalizeAlbumRow(album, stats?.downloadedPercent ?? 0, stats?.isDownloaded ?? false);
        });
        const { count } = db.prepare(countQuery).get(...countParams) as { count: number };

        return {
            items,
            total: count,
            limit,
            offset,
            hasMore: offset + albums.length < count,
        };
    }

    static async getAlbum(albumId: string): Promise<any | null> {
        const album = await this.ensureAlbumRow(albumId);

        if (!album) {
            const releaseGroup = await ensureMusicBrainzReleaseGroupHydrated(albumId);
            if (releaseGroup) {
                return normalizeMusicBrainzAlbum(releaseGroup, selectPreferredMusicBrainzRelease(albumId));
            }
            return null;
        }

        const downloadStats = getAlbumDownloadStats(albumId);
        return normalizeAlbumRow(album, downloadStats.downloadedPercent, downloadStats.isDownloaded);
    }

    static async getAlbumTracks(albumId: string): Promise<AlbumTrackContract[]> {
        const album = await this.ensureAlbumRow(albumId);

        if (!album) {
            const releaseGroup = await ensureMusicBrainzReleaseGroupHydrated(albumId);
            const release = releaseGroup ? selectPreferredMusicBrainzRelease(albumId) : null;
            if (releaseGroup && release) {
                const normalizedAlbum = normalizeMusicBrainzAlbum(releaseGroup, release);
                return getMusicBrainzTrackRows(release.mbid, albumId, normalizedAlbum.title, normalizedAlbum.artist_name);
            }
            return [];
        }

        const tracks = getAlbumTrackRows(albumId);

        return hydrateTrackRows(tracks);
    }

    static async getAlbumPage(albumId: string): Promise<AlbumPageContract | null> {
        const albumRow = await this.ensureAlbumRow(albumId);

        if (!albumRow) {
            const releaseGroup = await ensureMusicBrainzReleaseGroupHydrated(albumId);
            const release = releaseGroup ? selectPreferredMusicBrainzRelease(albumId) : null;
            if (releaseGroup) {
                const album = normalizeMusicBrainzAlbum(releaseGroup, release);
                return {
                    album,
                    tracks: release
                        ? getMusicBrainzTrackRows(release.mbid, albumId, album.title, album.artist_name)
                        : [],
                    similarAlbums: [],
                    otherVersions: [],
                    artistPicture: releaseGroup.artist_picture != null ? String(releaseGroup.artist_picture) : null,
                    artistCoverImageUrl: releaseGroup.artist_cover_image_url ?? null,
                };
            }
            return null;
        }

        const downloadStats = getAlbumDownloadStats(albumId);
        const album = normalizeAlbumRow(
            albumRow,
            downloadStats.downloadedPercent,
            downloadStats.isDownloaded,
        );

        return {
            album,
            tracks: hydrateTrackRows(getAlbumTrackRows(albumId)),
            similarAlbums: this.getSimilarAlbums(albumId),
            otherVersions: this.getAlbumVersions(albumId),
            artistPicture: albumRow.artist_picture != null ? String(albumRow.artist_picture) : null,
            artistCoverImageUrl: albumRow.artist_cover_image_url ?? null,
        };
    }

    static getSimilarAlbums(albumId: string): SimilarAlbumContract[] {
        const similarAlbums = db.prepare(`
      SELECT
        a.id,
        a.title, a.cover, a.cover as cover_id,
        a.release_date, a.type, a.type as album_type,
        a.explicit,
        COALESCE(a.popularity, 0) as popularity,
        a.quality,
        a.artist_id,
        ar.name as artist_name,
        a.monitor as is_monitored
      FROM similar_albums sa
      JOIN albums a ON sa.similar_album_id = a.id
      LEFT JOIN artists ar ON a.artist_id = ar.id
      WHERE sa.album_id = ?
      ORDER BY COALESCE(a.popularity, 0) DESC, sa.created_at ASC, a.id ASC
      LIMIT 20
    `).all(albumId) as any[];

        return similarAlbums.map((album) => ({
            id: String(album.id),
            title: album.title,
            cover_id: album.cover_id != null ? String(album.cover_id) : null,
            artist_name: album.artist_name,
            release_date: album.release_date ?? null,
            popularity: Number(album.popularity ?? 0),
            quality: album.quality ?? null,
            explicit: Boolean(album.explicit),
            is_monitored: Boolean(album.is_monitored),
        }));
    }

    static getAlbumVersions(albumId: string): AlbumVersionContract[] {
        const albumVersion = db.prepare(`
      SELECT version_group_id
      FROM album_artists
      WHERE album_id = ?
        AND version_group_id IS NOT NULL
      LIMIT 1
    `).get(albumId) as { version_group_id: number } | undefined;

        if (!albumVersion?.version_group_id) {
            return [];
        }

        const otherVersions = db.prepare(`
      SELECT DISTINCT
        a.id,
        a.title, a.cover, a.cover as cover_id,
        a.release_date, a.type, a.type as album_type,
        a.quality,
        a.version, a.explicit,
        a.artist_id,
        ar.name as artist_name,
        a.monitor as is_monitored
      FROM album_artists aa
      JOIN albums a ON aa.album_id = a.id
      LEFT JOIN artists ar ON a.artist_id = ar.id
      WHERE aa.version_group_id = ?
        AND a.id != ?
      ORDER BY a.release_date DESC, a.quality DESC
    `).all(albumVersion.version_group_id, albumId) as any[];

        return otherVersions.map((album) => ({
            id: String(album.id),
            title: album.title,
            cover_id: album.cover_id != null ? String(album.cover_id) : null,
            artist_name: album.artist_name,
            release_date: album.release_date ?? null,
            quality: album.quality ?? null,
            version: album.version ?? null,
            explicit: Boolean(album.explicit),
            is_monitored: Boolean(album.is_monitored),
        }));
    }
}
