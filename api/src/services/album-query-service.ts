import { db } from "../database.js";
import { getAlbumDownloadStats, getAlbumDownloadStatsMap } from "./download-state.js";
import { scanAlbumBasic } from "./scanner.js";
import type { AlbumVersionContract, SimilarAlbumContract } from "../contracts/media.js";
import type { AlbumContract, AlbumsListResponseContract } from "../contracts/catalog.js";

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

export class AlbumQueryService {
    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const monitoredFilter = input.monitored;
        const downloadedFilter = input.downloaded;
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
        const queryAlbum = () => db.prepare(`
      SELECT albums.*, artists.name as artist_name
      FROM albums
      LEFT JOIN artists ON albums.artist_id = artists.id
      WHERE albums.id = ?
    `).get(albumId) as any;

        let album = queryAlbum();

        if (!album) {
            await scanAlbumBasic(albumId);
            album = queryAlbum();
        }

        if (!album) {
            return null;
        }

        const downloadStats = getAlbumDownloadStats(albumId);
        return normalizeAlbumRow(album, downloadStats.downloadedPercent, downloadStats.isDownloaded);
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
