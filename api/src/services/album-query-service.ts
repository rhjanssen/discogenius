import { db } from "../database.js";
import { getReleaseGroupDownloadStatsMap } from "./download-state.js";
import {
    MusicBrainzReleaseGroupReadService,
    normalizeMusicBrainzReleaseGroupAlbum,
} from "./musicbrainz-release-group-read-service.js";
import type { AlbumTrackContract, AlbumVersionContract, SimilarAlbumContract } from "../contracts/media.js";
import type { AlbumContract, AlbumsListResponseContract } from "../contracts/catalog.js";
import type { AlbumPageContract } from "../contracts/pages.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");

function selectedProviderAlbumExpressionForFilter(libraryFilter: string): string {
    if (libraryFilter === "spatial") return "spatial.selected_provider_id";
    if (libraryFilter === "stereo") return "stereo.selected_provider_id";
    return "COALESCE(stereo.selected_provider_id, spatial.selected_provider_id)";
}

function releaseGroupDownloadedPredicate(libraryFilter: string): string {
    const selectedReleaseExpression = libraryFilter === "spatial"
        ? "spatial.selected_release_mbid"
        : libraryFilter === "stereo"
            ? "stereo.selected_release_mbid"
            : "COALESCE(stereo.selected_release_mbid, spatial.selected_release_mbid)";
    const slotFilter = libraryFilter === "spatial"
        ? "AND lf.library_slot = 'spatial'"
        : libraryFilter === "stereo"
            ? "AND lf.library_slot = 'stereo'"
            : "AND COALESCE(lf.library_slot, 'stereo') IN ('stereo', 'spatial')";

    return `
  ${selectedReleaseExpression} IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM mb_tracks t
    WHERE t.release_mbid = ${selectedReleaseExpression}
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mb_tracks t
    WHERE t.release_mbid = ${selectedReleaseExpression}
      AND NOT EXISTS (
        SELECT 1
        FROM library_files lf
        WHERE lf.canonical_track_mbid = t.mbid
          AND lf.file_type = 'track'
          ${slotFilter}
      )
  )
`;
}

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

function buildReleaseGroupSelect(whereClause: string, selectedProviderAlbumExpression: string): string {
    return `
      SELECT
        rg.*,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitor AS artist_monitor,
        COALESCE(stereo.wanted, spatial.wanted, a.monitor, 0) AS wanted,
        ${selectedProviderAlbumExpression} AS selected_provider_id,
        ${selectedProviderAlbumExpression === "spatial.selected_provider_id"
            ? "spatial.quality"
            : selectedProviderAlbumExpression === "stereo.selected_provider_id"
                ? "stereo.quality"
                : "COALESCE(stereo.quality, spatial.quality)"} AS selected_quality,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status
      FROM mb_release_groups rg
      LEFT JOIN artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN release_group_slots stereo
        ON stereo.release_group_mbid = rg.mbid
       AND stereo.slot = 'stereo'
      LEFT JOIN release_group_slots spatial
        ON spatial.release_group_mbid = rg.mbid
       AND spatial.slot = 'spatial'
      ${whereClause}
    `;
}

function getReleaseGroupOrderBy(sortParam: string | undefined, sortDir: "ASC" | "DESC"): string {
    switch (sortParam) {
        case "name":
            return ` ORDER BY rg.title ${sortDir}, rg.mbid ASC`;
        case "scannedAt":
            return ` ORDER BY (rg.updated_at IS NULL) ASC, rg.updated_at ${sortDir}, rg.mbid ASC`;
        case "popularity":
        case "releaseDate":
        default:
            return ` ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date ${sortDir}, rg.title ASC, rg.mbid ASC`;
    }
}

function normalizeReleaseGroupListRow(row: any, downloadedPercent: number, isDownloaded: boolean): AlbumContract {
    const album = normalizeMusicBrainzReleaseGroupAlbum(row, null);
    const monitored = Boolean(row.wanted);

    return {
        ...album,
        quality: row.selected_quality || null,
        is_monitored: monitored,
        monitor: monitored ? 1 : 0,
        downloaded: downloadedPercent,
        is_downloaded: isDownloaded,
        stereo_provider_id: row.stereo_provider_id || null,
        stereo_quality: row.stereo_quality || null,
        stereo_match_status: row.stereo_match_status || null,
        spatial_provider_id: row.spatial_provider_id || null,
        spatial_quality: row.spatial_quality || null,
        spatial_match_status: row.spatial_match_status || null,
        selected_provider_id: row.selected_provider_id || null,
        source: "musicbrainz",
    } as AlbumContract;
}

export class AlbumQueryService {
    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const monitoredFilter = input.monitored;
        const downloadedFilter = input.downloaded;
        const libraryFilter = input.libraryFilter || "all";
        const selectedProviderAlbumExpression = selectedProviderAlbumExpressionForFilter(libraryFilter);
        const selectedDownloadedPredicate = releaseGroupDownloadedPredicate(libraryFilter);
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = ["a.id IS NOT NULL", managedArtistPredicate];

        if (search) {
            where.push("(rg.title LIKE ? OR a.name LIKE ?)");
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
        }

        if (monitoredFilter !== undefined) {
            where.push("COALESCE(stereo.wanted, spatial.wanted, a.monitor, 0) = ?");
            params.push(monitoredFilter ? 1 : 0);
            countParams.push(monitoredFilter ? 1 : 0);
        }

        if (downloadedFilter !== undefined) {
            where.push(downloadedFilter
                ? selectedDownloadedPredicate
                : `NOT (${selectedDownloadedPredicate})`);
        }

        if (libraryFilter === "spatial") {
            where.push("spatial.selected_provider_id IS NOT NULL");
        } else if (libraryFilter === "stereo") {
            where.push("stereo.selected_provider_id IS NOT NULL");
        }

        if (input.locked === true) {
            where.push("0 = 1");
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const query = `
          ${buildReleaseGroupSelect(whereClause, selectedProviderAlbumExpression)}
          ${getReleaseGroupOrderBy(input.sort, sortDir)}
          LIMIT ? OFFSET ?
        `;
        const rows = db.prepare(query).all(...params, limit, offset) as any[];
        const releaseGroupMbids = rows
            .map((row) => row.mbid == null ? null : String(row.mbid))
            .filter((value): value is string => Boolean(value));
        const downloadStats = getReleaseGroupDownloadStatsMap(
            releaseGroupMbids,
            libraryFilter === "spatial" ? "spatial" : libraryFilter === "stereo" ? "stereo" : null,
        );

        const countQuery = `
          SELECT COUNT(*) AS count
          FROM mb_release_groups rg
          LEFT JOIN artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN release_group_slots stereo
            ON stereo.release_group_mbid = rg.mbid
           AND stereo.slot = 'stereo'
          LEFT JOIN release_group_slots spatial
            ON spatial.release_group_mbid = rg.mbid
           AND spatial.slot = 'spatial'
          ${whereClause}
        `;
        const { count } = db.prepare(countQuery).get(...countParams) as { count: number };

        return {
            items: rows.map((row) => {
                const releaseGroupMbid = row.mbid == null ? null : String(row.mbid);
                const stats = releaseGroupMbid ? downloadStats.get(releaseGroupMbid) : null;
                return normalizeReleaseGroupListRow(
                    row,
                    stats?.downloadedPercent ?? 0,
                    stats?.isDownloaded ?? false,
                );
            }),
            total: count,
            limit,
            offset,
            hasMore: offset + rows.length < count,
        };
    }

    static async getAlbum(albumId: string): Promise<AlbumContract | null> {
        return MusicBrainzReleaseGroupReadService.getAlbum(albumId);
    }

    static async getAlbumTracks(albumId: string): Promise<AlbumTrackContract[]> {
        return MusicBrainzReleaseGroupReadService.getTracks(albumId);
    }

    static async getAlbumPage(albumId: string): Promise<AlbumPageContract | null> {
        return MusicBrainzReleaseGroupReadService.getPage(albumId);
    }

    static getSimilarAlbums(_albumId: string): SimilarAlbumContract[] {
        return [];
    }

    static getAlbumVersions(_albumId: string): AlbumVersionContract[] {
        return [];
    }
}
