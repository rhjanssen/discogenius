import { db } from "../../database.js";
import { getReleaseGroupDownloadStatsMap } from "../download/download-state.js";
import {
    MusicBrainzReleaseGroupReadService,
    normalizeMusicBrainzReleaseGroupAlbum,
} from "../metadata/musicbrainz-release-group-read-service.js";
import type { AlbumTrackContract, AlbumVersionContract, SimilarAlbumContract } from "../../contracts/media.js";
import type { AlbumContract, AlbumsListResponseContract } from "../../contracts/catalog.js";
import type { AlbumPageContract } from "../../contracts/pages.js";
import { getConfigSection } from "../config/config.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { AlbumLibraryIndexService } from "./album-library-index-service.js";
import { MusicBrainzArtistCreditService, type CanonicalAlbumArtist } from "../metadata/musicbrainz-artist-credit-service.js";
const releaseGroupMonitoredExpression = `
        CASE WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1 ELSE 0 END
`;
const releaseGroupMonitoredLockedExpression = `
        CASE WHEN COALESCE(stereo.monitored_lock, 0) = 1 OR COALESCE(spatial.monitored_lock, 0) = 1 THEN 1 ELSE 0 END
`;

function selectedProviderAlbumExpressionForFilter(libraryFilter: string): string {
    if (libraryFilter === "spatial") return "spatial.selected_provider_id";
    if (libraryFilter === "stereo") return "stereo.selected_provider_id";
    return "COALESCE(stereo.selected_provider_id, spatial.selected_provider_id)";
}

function getFullyDownloadedReleaseGroupMbids(libraryFilter: string): string[] {
    // Start from existing files, not from every missing track in the catalog.
    // The former stays proportional to the user's library; the old nested
    // NOT-EXISTS predicate walked millions of Tracks once per candidate album
    // and could wedge the API for minutes when filtering for Not Downloaded.
    const slotPredicate = libraryFilter === "spatial"
        ? "AND rgs.slot = 'spatial'"
        : libraryFilter === "stereo"
            ? "AND rgs.slot = 'stereo'"
            : "AND rgs.slot IN ('stereo', 'spatial')";
    const candidates = db.prepare(`
      WITH file_releases(library_slot, release_mbid) AS (
        SELECT lf.library_slot, track.release_mbid
        FROM TrackFiles lf
        JOIN Tracks track ON track.id = lf.track_id
        WHERE lf.file_type = 'track' AND lf.track_id IS NOT NULL

        UNION

        SELECT lf.library_slot, track.release_mbid
        FROM TrackFiles lf
        JOIN Tracks track ON track.mbid = lf.canonical_track_mbid
        WHERE lf.file_type = 'track'
          AND lf.track_id IS NULL
          AND lf.canonical_track_mbid IS NOT NULL

        UNION

        SELECT lf.library_slot, track.release_mbid
        FROM TrackFiles lf
        JOIN Tracks track ON track.recording_mbid = lf.canonical_recording_mbid
        WHERE lf.file_type = 'track'
          AND lf.track_id IS NULL
          AND lf.canonical_track_mbid IS NULL
          AND lf.canonical_recording_mbid IS NOT NULL
      )
      SELECT DISTINCT rgs.release_group_mbid
      FROM file_releases file_release
      JOIN ReleaseGroupSlots rgs
        ON rgs.selected_release_mbid = file_release.release_mbid
       AND rgs.slot = file_release.library_slot
      WHERE rgs.selected_release_mbid IS NOT NULL
        ${slotPredicate}
    `).all() as Array<{ release_group_mbid: string }>;
    if (candidates.length === 0) return [];

    const slot = libraryFilter === "spatial" ? "spatial" : libraryFilter === "stereo" ? "stereo" : null;
    const stats = getReleaseGroupDownloadStatsMap(
        candidates.map((row) => row.release_group_mbid),
        slot,
    );
    return candidates
        .map((row) => String(row.release_group_mbid))
        .filter((mbid) => stats.get(mbid)?.isDownloaded === true);
}

function sanitizeQualityTag(value: string | null | undefined, includeSpatial: boolean): string {
    const quality = String(value || "").trim();
    if (!quality) {
        return "";
    }
    return includeSpatial || !isSpatialAudioQuality(quality) ? quality : "";
}

function sanitizeQualityTags(values: string[] | undefined, includeSpatial: boolean): string[] {
    const seen = new Set<string>();
    return (values || [])
        .map((quality) => sanitizeQualityTag(quality, includeSpatial))
        .filter((quality) => {
            const key = quality.toUpperCase();
            if (!quality || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function sanitizeAlbumTrack(track: AlbumTrackContract, includeSpatial: boolean): AlbumTrackContract {
    if (includeSpatial) {
        return track;
    }

    const qualityTags = sanitizeQualityTags(track.qualityTags, includeSpatial);
    const quality = sanitizeQualityTag(track.quality, includeSpatial) || qualityTags[0] || "";
    const files = track.files.map((file) => {
        const fileQuality = sanitizeQualityTag(file.quality, includeSpatial);
        return fileQuality === file.quality ? file : { ...file, quality: fileQuality || null };
    });

    return {
        ...track,
        quality,
        qualityTags,
        files,
    };
}

function sanitizeAlbumSpatialFields(album: AlbumContract, includeSpatial: boolean): AlbumContract {
    if (includeSpatial) {
        return album;
    }

    const quality = sanitizeQualityTag(album.quality, includeSpatial)
        || sanitizeQualityTag(album.stereo_quality, includeSpatial)
        || null;

    return {
        ...album,
        quality,
        spatial_provider: null,
        spatial_provider_id: null,
        spatial_quality: null,
        spatial_match_status: null,
        spatial_release_mbid: null,
        selected_provider: album.stereo_provider || null,
        selected_provider_id: album.stereo_provider_id || null,
        selected_release_mbid: album.stereo_release_mbid || null,
    };
}

function sanitizeAlbumVersionSpatialFields(version: AlbumVersionContract, includeSpatial: boolean): AlbumVersionContract {
    if (includeSpatial) {
        return version;
    }

    return {
        ...version,
        quality: sanitizeQualityTag(version.quality, includeSpatial) || sanitizeQualityTag(version.stereo_quality, includeSpatial) || null,
        spatial_provider_id: null,
        spatial_quality: null,
    };
}

const releaseGroupPopularityExpression = `
        MAX(
            COALESCE(rg.popularity, 0),
            COALESCE(CAST(stereo_provider_item.popularity AS REAL), 0),
            COALESCE(CAST(spatial_provider_item.popularity AS REAL), 0)
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

function buildReleaseGroupDetailsSelect(whereClause: string, selectedProviderAlbumExpression: string): string {
    return `
      SELECT
        rg.id,
        rg.mbid,
        rg.artist_mbid,
        rg.title,
        rg.primary_type,
        rg.first_release_date,
        rg.images,
        rg.popularity AS canonical_popularity,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitored AS artist_monitor,
        ${releaseGroupMonitoredExpression} AS wanted,
        ${releaseGroupMonitoredLockedExpression} AS monitored_lock,
        COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
        ${selectedProviderAlbumExpression} AS selected_provider_id,
        ${selectedProviderAlbumExpression === "spatial.selected_provider_id"
            ? "spatial.quality"
            : selectedProviderAlbumExpression === "stereo.selected_provider_id"
                ? "stereo.quality"
                : "COALESCE(stereo.quality, spatial.quality)"} AS selected_quality,
        stereo.selected_provider AS stereo_provider,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.selected_release_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        stereo.cover AS stereo_cover,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.selected_release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        spatial.cover AS spatial_cover,
        ${releaseGroupPopularityExpression} AS popularity
      FROM Albums rg
      LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN ReleaseGroupSlots stereo
        ON stereo.release_group_id = rg.id
       AND stereo.slot = 'stereo'
      LEFT JOIN ReleaseGroupSlots spatial
        ON spatial.release_group_id = rg.id
       AND spatial.slot = 'spatial'
      LEFT JOIN ProviderItems stereo_provider_item
        ON stereo_provider_item.provider = stereo.selected_provider
       AND stereo_provider_item.entity_type = 'album'
       AND stereo_provider_item.provider_id = stereo.selected_provider_id
      LEFT JOIN ProviderItems spatial_provider_item
        ON spatial_provider_item.provider = spatial.selected_provider
       AND spatial_provider_item.entity_type = 'album'
       AND spatial_provider_item.provider_id = spatial.selected_provider_id
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
            return ` ORDER BY popularity ${sortDir}, rg.title ASC, rg.mbid ASC`;
        case "releaseDate":
        default:
            return ` ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date ${sortDir}, rg.title ASC, rg.mbid ASC`;
    }
}

function getAlbumLibraryIndexOrderBy(sortParam: string | undefined, sortDir: "ASC" | "DESC"): string {
    switch (sortParam) {
        case "name":
            return ` ORDER BY library_album.title ${sortDir}, library_album.release_group_id ASC`;
        case "scannedAt":
            return ` ORDER BY (library_album.album_updated_at IS NULL) ASC, library_album.album_updated_at ${sortDir}, library_album.title ASC, library_album.release_group_id ASC`;
        case "popularity":
            return ` ORDER BY library_album.popularity ${sortDir}, library_album.title ASC, library_album.release_group_id ASC`;
        case "releaseDate":
        default:
            return ` ORDER BY (library_album.first_release_date IS NULL) ASC, library_album.first_release_date ${sortDir}, library_album.title ASC, library_album.release_group_id ASC`;
    }
}

function normalizeReleaseGroupListRow(
    row: any,
    downloadedPercent: number,
    isDownloaded: boolean,
    albumArtists?: CanonicalAlbumArtist[],
): AlbumContract {
    const album = normalizeMusicBrainzReleaseGroupAlbum(row, null, undefined, albumArtists);
    const monitored = Boolean(row.wanted);
    const includeSpatial = getConfigSection("filtering").include_spatial === true;

    return {
        ...album,
        quality: row.selected_quality || null,
        is_monitored: monitored,
        monitored_lock: Boolean(row.monitored_lock),
        downloaded: downloadedPercent,
        is_downloaded: isDownloaded,
        stereo_provider_id: row.stereo_provider_id || null,
        stereo_quality: row.stereo_quality || null,
        stereo_match_status: row.stereo_match_status || null,
        spatial_provider_id: includeSpatial ? row.spatial_provider_id || null : null,
        spatial_quality: includeSpatial ? row.spatial_quality || null : null,
        spatial_match_status: includeSpatial ? row.spatial_match_status || null : null,
        selected_provider_id: row.selected_provider_id || null,
        source: "musicbrainz",
        popularity: Number(row.popularity || 0),
    } as AlbumContract;
}

export class AlbumQueryService {
    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        if (AlbumLibraryIndexService.isReady()) {
            return this.listAlbumsFromIndex(input);
        }

        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const monitoredFilter = input.monitored;
        const downloadedFilter = input.downloaded;
        const libraryFilter = input.libraryFilter || "all";
        const selectedProviderAlbumExpression = selectedProviderAlbumExpressionForFilter(libraryFilter);
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = [
            `rg.id IN (
              SELECT context.release_group_id
              FROM ArtistReleaseGroupCuration context
              WHERE context.included = 1
                AND context.release_group_id IS NOT NULL
                AND context.source_artist_mbid IN (SELECT mbid FROM Artists WHERE monitored = 1)
            )`,
            "rg.artist_mbid IN (SELECT mbid FROM Artists WHERE mbid IS NOT NULL)",
        ];

        if (search) {
            where.push("(rg.title LIKE ? OR a.name LIKE ?)");
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
        }

        if (monitoredFilter !== undefined) {
            where.push(`${releaseGroupMonitoredExpression} = ?`);
            params.push(monitoredFilter ? 1 : 0);
            countParams.push(monitoredFilter ? 1 : 0);
        }

        if (downloadedFilter !== undefined) {
            const downloadedReleaseGroupMbids = getFullyDownloadedReleaseGroupMbids(libraryFilter);
            if (downloadedReleaseGroupMbids.length === 0) {
                if (downloadedFilter) where.push("0 = 1");
            } else {
                const marks = downloadedReleaseGroupMbids.map(() => "?").join(", ");
                where.push(`rg.mbid ${downloadedFilter ? "IN" : "NOT IN"} (${marks})`);
                params.push(...downloadedReleaseGroupMbids);
                countParams.push(...downloadedReleaseGroupMbids);
            }
        }

        if (libraryFilter === "spatial") {
            where.push(getConfigSection("filtering").include_spatial === true
                ? "spatial.selected_provider_id IS NOT NULL"
                : "0 = 1");
        } else if (libraryFilter === "stereo") {
            where.push("stereo.selected_provider_id IS NOT NULL");
        }

        if (input.locked === true) {
            where.push(`${releaseGroupMonitoredLockedExpression} = 1`);
        } else if (input.locked === false) {
            where.push(`${releaseGroupMonitoredLockedExpression} = 0`);
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        // Page the small identity set before enriching it with provider rows and
        // large artwork payloads. Applying those joins to every curated album
        // made a 50-row library page take several seconds on a mature catalog.
        const candidatePopularityExpression = `MAX(
          COALESCE(rg.popularity, 0),
          COALESCE(stereo.popularity, 0),
          COALESCE(spatial.popularity, 0)
        )`;
        const candidateQuery = `
          SELECT rg.id, rg.mbid, ${candidatePopularityExpression} AS popularity
          FROM Albums rg
          LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN ReleaseGroupSlots stereo
            ON stereo.release_group_id = rg.id AND stereo.slot = 'stereo'
          LEFT JOIN ReleaseGroupSlots spatial
            ON spatial.release_group_id = rg.id AND spatial.slot = 'spatial'
          ${whereClause}
          ${getReleaseGroupOrderBy(input.sort, sortDir)}
          LIMIT ? OFFSET ?
        `;
        const candidates = db.prepare(candidateQuery).all(...params, limit, offset) as Array<{ id: number; mbid: string }>;
        const candidateIds = candidates.map((row) => row.id);
        const candidateMbids = candidates.map((row) => String(row.mbid));
        const candidateMarks = candidateIds.map(() => "?").join(", ");
        const detailRows = candidateMbids.length === 0 ? [] : db.prepare(`
          ${buildReleaseGroupDetailsSelect(`WHERE rg.id IN (${candidateMarks})`, selectedProviderAlbumExpression)}
        `).all(...candidateIds) as any[];
        const detailByMbid = new Map(detailRows.map((row) => [String(row.mbid), row]));
        const rows = candidateMbids
            .map((mbid) => detailByMbid.get(mbid))
            .filter((row): row is any => row != null);
        const releaseGroupMbids = rows
            .map((row) => row.mbid == null ? null : String(row.mbid))
            .filter((value): value is string => Boolean(value));
        const downloadStats = getReleaseGroupDownloadStatsMap(
            releaseGroupMbids,
            libraryFilter === "spatial" ? "spatial" : libraryFilter === "stereo" ? "stereo" : null,
        );

        const albumArtists = MusicBrainzArtistCreditService.getAlbumArtistsMap(releaseGroupMbids);

        const countQuery = `
          SELECT COUNT(*) AS count
          FROM Albums rg
          LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN ReleaseGroupSlots stereo
            ON stereo.release_group_id = rg.id
           AND stereo.slot = 'stereo'
          LEFT JOIN ReleaseGroupSlots spatial
            ON spatial.release_group_id = rg.id
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
                    releaseGroupMbid ? albumArtists.get(releaseGroupMbid) : undefined,
                );
            }),
            total: count,
            limit,
            offset,
            hasMore: offset + rows.length < count,
        };
    }

    private static listAlbumsFromIndex(input: AlbumListQuery): AlbumsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const libraryFilter = input.libraryFilter || "all";
        const selectedProviderAlbumExpression = selectedProviderAlbumExpressionForFilter(libraryFilter);
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where = ["library_album.included = 1"];

        if (input.search) {
            where.push("(library_album.title LIKE ? OR artist.name LIKE ?)");
            const searchParam = `%${input.search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
        }

        if (input.monitored !== undefined) {
            where.push("library_album.monitored = ?");
            params.push(input.monitored ? 1 : 0);
            countParams.push(input.monitored ? 1 : 0);
        }

        if (input.downloaded !== undefined) {
            const downloadedReleaseGroupMbids = getFullyDownloadedReleaseGroupMbids(libraryFilter);
            if (downloadedReleaseGroupMbids.length === 0) {
                if (input.downloaded) where.push("0 = 1");
            } else {
                const marks = downloadedReleaseGroupMbids.map(() => "?").join(", ");
                where.push(`album.mbid ${input.downloaded ? "IN" : "NOT IN"} (${marks})`);
                params.push(...downloadedReleaseGroupMbids);
                countParams.push(...downloadedReleaseGroupMbids);
            }
        }

        if (input.locked !== undefined) {
            where.push("library_album.monitored_lock = ?");
            params.push(input.locked ? 1 : 0);
            countParams.push(input.locked ? 1 : 0);
        }

        if (libraryFilter === "spatial") {
            where.push(getConfigSection("filtering").include_spatial === true
                ? "library_album.has_spatial_provider = 1"
                : "0 = 1");
        } else if (libraryFilter === "stereo") {
            where.push("library_album.has_stereo_provider = 1");
        }

        const whereClause = `WHERE ${where.join(" AND ")}`;
        // The projection is self-contained for the normal library view. Keep
        // catalog joins out of the hot count/page path unless a filter truly
        // needs a field that is not projected.
        const fromClause = `
          FROM AlbumLibraryIndex library_album
          ${input.downloaded !== undefined ? "JOIN Albums album ON album.id = library_album.release_group_id" : ""}
          ${input.search ? "LEFT JOIN Artists artist ON artist.mbid = library_album.artist_mbid" : ""}
        `;
        const candidates = db.prepare(`
          SELECT library_album.release_group_id AS id
          ${fromClause}
          ${whereClause}
          ${getAlbumLibraryIndexOrderBy(input.sort, sortDir)}
          LIMIT ? OFFSET ?
        `).all(...params, limit, offset) as Array<{ id: number }>;

        const candidateIds = candidates.map((row) => row.id);
        const candidateMarks = candidateIds.map(() => "?").join(", ");
        const detailRows = candidateIds.length === 0 ? [] : db.prepare(`
          ${buildReleaseGroupDetailsSelect(`WHERE rg.id IN (${candidateMarks})`, selectedProviderAlbumExpression)}
        `).all(...candidateIds) as any[];
        const detailById = new Map(detailRows.map((row) => [Number(row.id), row]));
        const rows = candidates
            .map((candidate) => detailById.get(candidate.id))
            .filter((row): row is any => row != null);
        const releaseGroupMbids = rows
            .map((row) => row.mbid == null ? null : String(row.mbid))
            .filter((value): value is string => Boolean(value));
        const downloadStats = getReleaseGroupDownloadStatsMap(
            releaseGroupMbids,
            libraryFilter === "spatial" ? "spatial" : libraryFilter === "stereo" ? "stereo" : null,
        );

        const albumArtists = MusicBrainzArtistCreditService.getAlbumArtistsMap(releaseGroupMbids);
        const count = Number((db.prepare(`
          SELECT COUNT(*) AS count
          ${fromClause}
          ${whereClause}
        `).get(...countParams) as { count?: number } | undefined)?.count || 0);

        return {
            items: rows.map((row) => {
                const releaseGroupMbid = row.mbid == null ? null : String(row.mbid);
                const stats = releaseGroupMbid ? downloadStats.get(releaseGroupMbid) : null;
                return normalizeReleaseGroupListRow(
                    row,
                    stats?.downloadedPercent ?? 0,
                    stats?.isDownloaded ?? false,
                    releaseGroupMbid ? albumArtists.get(releaseGroupMbid) : undefined,
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
        const tracks = await MusicBrainzReleaseGroupReadService.getTracks(albumId);
        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        return tracks.map((track) => sanitizeAlbumTrack(track, includeSpatial));
    }

    static async getAlbumPage(albumId: string): Promise<AlbumPageContract | null> {
        const page = await MusicBrainzReleaseGroupReadService.getPage(albumId);
        if (!page) return null;

        const includeSpatial = getConfigSection("filtering").include_spatial === true;

        return {
            ...page,
            album: sanitizeAlbumSpatialFields(page.album, includeSpatial),
            tracks: page.tracks.map((track) => sanitizeAlbumTrack(track, includeSpatial)),
            otherVersions: page.otherVersions.map((version) => sanitizeAlbumVersionSpatialFields(version, includeSpatial)),
        };
    }

    static getSimilarAlbums(_albumId: string): SimilarAlbumContract[] {
        return [];
    }

    static async getAlbumVersions(albumId: string): Promise<AlbumVersionContract[]> {
        return MusicBrainzReleaseGroupReadService.getVersions(albumId);
    }
}
