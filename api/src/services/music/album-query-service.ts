import { db } from "../../database.js";
import { getReleaseGroupDownloadStatsMap, getAlbumLocalQualitiesMap } from "../download/download-state.js";
import {
    MusicBrainzReleaseGroupReadService,
    normalizeMusicBrainzReleaseGroupAlbum,
} from "../metadata/musicbrainz-release-group-read-service.js";
import type { AlbumTrackContract, AlbumVersionContract } from "../../contracts/media.js";
import type { AlbumContract, AlbumsListResponseContract } from "../../contracts/catalog.js";
import type { AlbumPageContract } from "../../contracts/pages.js";
import { getAlbumAssociatedVideos } from "./video-query-service.js";
import { getConfigSection } from "../config/config.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { MusicBrainzArtistCreditService, type CanonicalAlbumArtist } from "../metadata/musicbrainz-artist-credit-service.js";
import { qualityTierSqlCondition } from "../../utils/quality-tier-sql.js";
import {
    CURATED_LIBRARY_RELEASE_GROUPS_SQL,
    pagedReleaseGroupIdsSql,
    planQualityExpression,
    releaseGroupLibraryStateCte,
} from "./release-group-library-state-sql.js";
import { libraryArtistMonitoredSelectSql } from "./managed-artists.js";

const releaseGroupMonitoredExpression = `
        CASE WHEN stereo.monitored = 1 OR spatial.monitored = 1 THEN 1 ELSE 0 END
`;
const releaseGroupMonitoredLockedExpression = `
        CASE WHEN stereo.monitored_lock = 1 OR spatial.monitored_lock = 1 THEN 1 ELSE 0 END
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
    const libraryClassPredicate = libraryFilter === "spatial"
        ? `AND EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          )`
        : libraryFilter === "stereo"
            ? `AND NOT EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              )`
            : "";
    const candidates = db.prepare(`
      SELECT DISTINCT release_group.mbid AS release_group_mbid
      FROM TrackFiles library_file
      JOIN Libraries library
        ON library.id = library_file.library_id
       AND library.enabled = 1
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      JOIN LibraryEditions library_release
        ON library_release.library_id = library_file.library_id
       AND library_release.edition_id = library_file.album_edition_id
      JOIN AlbumEditions release
        ON release.id = library_release.edition_id
      JOIN Albums release_group
        ON release_group.id = release.release_group_id
      WHERE library_file.file_type = 'track'
        ${libraryClassPredicate}
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
    const remoteOffers = (track.remoteOffers || []).filter((offer) => offer.slot !== "spatial");

    return {
        ...track,
        quality,
        qualityTags,
        remoteOffers,
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
        spatial_provider_url: null,
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
            COALESCE(stereo.popularity, 0),
            COALESCE(spatial.popularity, 0)
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
    /** Filter to albums whose selected offer is from this provider (e.g. "tidal"). */
    provider?: string;
    /** Filter to albums whose selected offer is in this quality tier (MAX/HIGH/NORMAL/LOW). */
    qualityTier?: string;
    sort?: string;
    dir?: string;
}

/** Library-class aliases the provider/quality filter should test. */
function filterLibraryStateAliases(libraryFilter: string): string[] {
    if (libraryFilter === "spatial") return ["spatial"];
    if (libraryFilter === "stereo") return ["stereo"];
    return ["stereo", "spatial"];
}

function selectedQualityExpression(selectedProviderAlbumExpression: string): string {
    const stereoQuality = planQualityExpression("stereo.selected_plan_id");
    const spatialQuality = planQualityExpression("spatial.selected_plan_id");
    if (selectedProviderAlbumExpression === "spatial.selected_provider_id") return spatialQuality;
    if (selectedProviderAlbumExpression === "stereo.selected_provider_id") return stereoQuality;
    return `COALESCE(${stereoQuality}, ${spatialQuality})`;
}

function buildReleaseGroupDetailsSelect(wantedGroupsSql: string, selectedProviderAlbumExpression: string): string {
    const stereoQuality = planQualityExpression("stereo.selected_plan_id");
    const spatialQuality = planQualityExpression("spatial.selected_plan_id");
    return `
      ${releaseGroupLibraryStateCte(wantedGroupsSql)}
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
        ${libraryArtistMonitoredSelectSql("a")} AS artist_monitor,
        ${releaseGroupMonitoredExpression} AS wanted,
        ${releaseGroupMonitoredLockedExpression} AS monitored_lock,
        COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
        ${selectedProviderAlbumExpression} AS selected_provider_id,
        ${selectedQualityExpression(selectedProviderAlbumExpression)} AS selected_quality,
        stereo.selected_provider AS stereo_provider,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.provider_url AS stereo_provider_url,
        stereo.selected_release_mbid AS stereo_release_mbid,
        ${stereoQuality} AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        stereo.match_relation AS stereo_plan_relation,
        stereo.plan_composition AS stereo_plan_composition,
        stereo.plan_coverage AS stereo_plan_coverage,
        stereo.plan_target_track_count AS stereo_plan_target_track_count,
        stereo.cover AS stereo_cover,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.provider_url AS spatial_provider_url,
        spatial.selected_release_mbid AS spatial_release_mbid,
        ${spatialQuality} AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        spatial.match_relation AS spatial_plan_relation,
        spatial.plan_composition AS spatial_plan_composition,
        spatial.plan_coverage AS spatial_plan_coverage,
        spatial.plan_target_track_count AS spatial_plan_target_track_count,
        spatial.cover AS spatial_cover,
        ${releaseGroupPopularityExpression} AS popularity
      FROM wanted_groups
      JOIN Albums rg ON rg.id = wanted_groups.id
      LEFT JOIN ArtistMetadata a ON a.mbid = rg.artist_mbid
      LEFT JOIN library_state stereo
        ON stereo.release_group_id = rg.id
       AND stereo.library_class = 'stereo'
      LEFT JOIN library_state spatial
        ON spatial.release_group_id = rg.id
       AND spatial.library_class = 'spatial'
    `;
}

function albumListNeedsLibraryState(input: AlbumListQuery): boolean {
    const libraryFilter = input.libraryFilter || "all";
    if (libraryFilter === "spatial" || libraryFilter === "stereo") return true;
    if (input.locked !== undefined) return true;
    if (String(input.provider || "").trim()) return true;
    if (String(input.qualityTier || "").trim()) return true;
    return false;
}

function monitoredLibraryExistsSql(albumAlias: string): string {
    return `EXISTS (
      SELECT 1
      FROM LibraryAlbums library_group
      JOIN Libraries library
        ON library.id = library_group.library_id
       AND library.enabled = 1
      WHERE library_group.release_group_id = ${albumAlias}.id
    )`;
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

function getAlbumMembershipOrderBy(sortParam: string | undefined, sortDir: "ASC" | "DESC"): string {
    switch (sortParam) {
        case "name":
            return ` ORDER BY album.title ${sortDir}, album.id ASC`;
        case "scannedAt":
            return ` ORDER BY (album.updated_at IS NULL) ASC, album.updated_at ${sortDir}, album.title ASC, album.id ASC`;
        case "popularity":
            return ` ORDER BY COALESCE(album.popularity, 0) ${sortDir}, album.title ASC, album.id ASC`;
        case "releaseDate":
        default:
            return ` ORDER BY (album.first_release_date IS NULL) ASC, album.first_release_date ${sortDir}, album.title ASC, album.id ASC`;
    }
}

function normalizeReleaseGroupListRow(
    row: any,
    downloadStats: { downloadedPercent: number; isDownloaded: boolean; totalTracks: number; downloadedTracks: number },
    albumArtists?: CanonicalAlbumArtist[],
    localQualityData?: { majorityQuality: string | null; localQualities: string[] },
): AlbumContract {
    const album = normalizeMusicBrainzReleaseGroupAlbum(row, null, undefined, albumArtists);
    const monitored = Boolean(row.wanted);
    const includeSpatial = getConfigSection("filtering").include_spatial === true;

    return {
        ...album,
        quality: row.selected_quality || null,
        local_quality: localQualityData?.majorityQuality || (downloadStats.isDownloaded ? row.selected_quality : null) || null,
        local_qualities: localQualityData?.localQualities || [],
        is_monitored: monitored,
        monitored_lock: Boolean(row.monitored_lock),
        downloaded: downloadStats.downloadedPercent,
        is_downloaded: downloadStats.isDownloaded,
        // library stats: files on disk / tracks on the selected release(s).
        track_file_count: downloadStats.downloadedTracks,
        track_count: downloadStats.totalTracks,
        stereo_provider: row.stereo_provider || null,
        stereo_provider_id: row.stereo_provider_id || null,
        stereo_provider_url: row.stereo_provider_url || null,
        stereo_quality: row.stereo_quality || null,
        stereo_match_status: row.stereo_match_status || null,
        stereo_plan_relation: row.stereo_plan_relation || null,
        stereo_plan_composition: row.stereo_plan_composition || null,
        stereo_plan_coverage: row.stereo_plan_coverage == null ? null : Number(row.stereo_plan_coverage),
        stereo_plan_target_track_count: row.stereo_plan_target_track_count == null
            ? null
            : Number(row.stereo_plan_target_track_count),
        stereo_release_mbid: row.stereo_release_mbid || null,
        spatial_provider: includeSpatial ? row.spatial_provider || null : null,
        spatial_provider_id: includeSpatial ? row.spatial_provider_id || null : null,
        spatial_provider_url: includeSpatial ? row.spatial_provider_url || null : null,
        spatial_quality: includeSpatial ? row.spatial_quality || null : null,
        spatial_match_status: includeSpatial ? row.spatial_match_status || null : null,
        spatial_plan_relation: includeSpatial ? row.spatial_plan_relation || null : null,
        spatial_plan_composition: includeSpatial ? row.spatial_plan_composition || null : null,
        spatial_plan_coverage: !includeSpatial || row.spatial_plan_coverage == null
            ? null
            : Number(row.spatial_plan_coverage),
        spatial_plan_target_track_count: !includeSpatial || row.spatial_plan_target_track_count == null
            ? null
            : Number(row.spatial_plan_target_track_count),
        spatial_release_mbid: includeSpatial ? row.spatial_release_mbid || null : null,
        selected_provider: row.selected_provider || row.stereo_provider || null,
        selected_provider_id: row.selected_provider_id || null,
        source: "musicbrainz",
        popularity: Number(row.popularity || 0),
    } as AlbumContract;
}

export class AlbumQueryService {
    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        // Page from the catalog we actually store (monitored artists plus
        // credited associates), then overlay LibraryAlbums for per-library
        // status. Monitoring cannot live on Albums because it is per library.
        // Membership is only a fast path for the default monitored=true filter;
        // unmonitored / "all" must still list catalog rows without a LibraryAlbums
        // row. Provider/quality filters need the plan-state join.
        const hasProviderQualityFilter = Boolean(String(input.provider || "").trim() || String(input.qualityTier || "").trim());
        if (!hasProviderQualityFilter && input.monitored === true) {
            return this.listAlbumsFromMembership(input);
        }

        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const monitoredFilter = input.monitored;
        const downloadedFilter = input.downloaded;
        const libraryFilter = input.libraryFilter || "all";
        const selectedProviderAlbumExpression = selectedProviderAlbumExpressionForFilter(libraryFilter);
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const needsLibraryState = albumListNeedsLibraryState(input);
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = [
            "rg.artist_mbid IN (SELECT mbid FROM ArtistMetadata WHERE mbid IS NOT NULL)",
        ];

        if (search) {
            where.push("(rg.title LIKE ? OR a.name LIKE ?)");
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
        }

        // Overlay only: omit the predicate when the caller wants every stored
        // album. Default library UI still sends monitored=true.
        if (monitoredFilter === false) {
            if (needsLibraryState) {
                where.push(`${releaseGroupMonitoredExpression} = 0`);
            } else {
                where.push(`NOT ${monitoredLibraryExistsSql("rg")}`);
            }
        } else if (monitoredFilter === true) {
            if (needsLibraryState) {
                where.push(`${releaseGroupMonitoredExpression} = 1`);
            } else {
                where.push(monitoredLibraryExistsSql("rg"));
            }
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

        const providerFilter = String(input.provider || "").trim();
        const qualityTierFilter = String(input.qualityTier || "").trim();
        const slotAliases = filterLibraryStateAliases(libraryFilter);
        const tierConditions = qualityTierFilter
            ? slotAliases
                .map((alias) => ({
                    alias,
                    condition: qualityTierSqlCondition(
                        planQualityExpression(`${alias}.selected_plan_id`),
                        qualityTierFilter,
                    ),
                }))
                .filter((entry): entry is { alias: string; condition: string } => entry.condition != null)
            : [];

        if (providerFilter && tierConditions.length > 0) {
            // Provider and quality describe one offer. Keep both predicates on
            // the same slot so an Apple Atmos offer cannot combine with a TIDAL
            // MAX stereo offer and incorrectly satisfy Apple + MAX.
            where.push(`(${tierConditions
                .map(({ alias, condition }) => `(${alias}.selected_provider = ? AND ${condition})`)
                .join(" OR ")})`);
            for (const _ of tierConditions) {
                params.push(providerFilter);
                countParams.push(providerFilter);
            }
        } else {
            if (providerFilter) {
                where.push(`(${slotAliases.map((alias) => `${alias}.selected_provider = ?`).join(" OR ")})`);
                for (const _ of slotAliases) {
                    params.push(providerFilter);
                    countParams.push(providerFilter);
                }
            }
            // A recognised tier with no matching slot expression matches
            // nothing; an unrecognised tier is ignored.
            if (tierConditions.length > 0) {
                where.push(`(${tierConditions.map(({ condition }) => condition).join(" OR ")})`);
            }
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        // Page identity first, then enrich the 50-row page. Ranking used to
        // materialize every LibraryAlbums row and compute headline quality
        // against AcquisitionPlanTracks before throwing most of it away.
        const libraryStateCte = needsLibraryState
            ? releaseGroupLibraryStateCte(CURATED_LIBRARY_RELEASE_GROUPS_SQL)
            : "";
        const candidatePopularityExpression = needsLibraryState
            ? `MAX(
          COALESCE(rg.popularity, 0),
          COALESCE(stereo.popularity, 0),
          COALESCE(spatial.popularity, 0)
        )`
            : "COALESCE(rg.popularity, 0)";
        const candidateFrom = needsLibraryState
            ? `FROM Albums rg
          LEFT JOIN ArtistMetadata a ON a.mbid = rg.artist_mbid
          LEFT JOIN library_state stereo
            ON stereo.release_group_id = rg.id AND stereo.library_class = 'stereo'
          LEFT JOIN library_state spatial
            ON spatial.release_group_id = rg.id AND spatial.library_class = 'spatial'`
            : `FROM Albums rg
          LEFT JOIN ArtistMetadata a ON a.mbid = rg.artist_mbid`;
        const candidateQuery = `
          ${libraryStateCte}
          SELECT rg.id, rg.mbid, ${candidatePopularityExpression} AS popularity
          ${candidateFrom}
          ${whereClause}
          ${getReleaseGroupOrderBy(input.sort, sortDir)}
          LIMIT ? OFFSET ?
        `;
        const candidates = db.prepare(candidateQuery).all(...params, limit, offset) as Array<{ id: number; mbid: string }>;
        const candidateIds = candidates.map((row) => row.id);
        const candidateMbids = candidates.map((row) => String(row.mbid));
        const candidateMarks = candidateIds.map(() => "?").join(", ");
        const detailRows = candidateMbids.length === 0 ? [] : db.prepare(`
          ${buildReleaseGroupDetailsSelect(pagedReleaseGroupIdsSql(candidateMarks), selectedProviderAlbumExpression)}
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
        const localQualitiesMap = getAlbumLocalQualitiesMap(releaseGroupMbids);

        const countQuery = `
          ${libraryStateCte}
          SELECT COUNT(*) AS count
          ${candidateFrom}
          ${whereClause}
        `;
        const { count } = db.prepare(countQuery).get(...countParams) as { count: number };

        return {
            items: rows.map((row) => {
                const releaseGroupMbid = row.mbid == null ? null : String(row.mbid);
                const stats = releaseGroupMbid ? downloadStats.get(releaseGroupMbid) : null;
                return normalizeReleaseGroupListRow(
                    row,
                    {
                        downloadedPercent: stats?.downloadedPercent ?? 0,
                        isDownloaded: stats?.isDownloaded ?? false,
                        totalTracks: stats?.totalTracks ?? 0,
                        downloadedTracks: stats?.downloadedTracks ?? 0,
                    },
                    releaseGroupMbid ? albumArtists.get(releaseGroupMbid) : undefined,
                    releaseGroupMbid ? localQualitiesMap.get(releaseGroupMbid) : undefined,
                );
            }),
            total: count,
            limit,
            offset,
            hasMore: offset + rows.length < count,
        };
    }

    private static listAlbumsFromMembership(input: AlbumListQuery): AlbumsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const libraryFilter = input.libraryFilter || "all";
        const selectedProviderAlbumExpression = selectedProviderAlbumExpressionForFilter(libraryFilter);
        const sortDir = (input.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where = ["1 = 1"];
        const having: string[] = [];

        if (input.search) {
            where.push("(album.title LIKE ? OR artist.name LIKE ?)");
            const searchParam = `%${input.search}%`;
            params.push(searchParam, searchParam);
            countParams.push(searchParam, searchParam);
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

        if (input.locked === true) {
            having.push("MAX(library_group.locked) = 1");
        } else if (input.locked === false) {
            having.push("MAX(library_group.locked) = 0");
        }

        if (libraryFilter === "spatial") {
            if (getConfigSection("filtering").include_spatial !== true) {
                where.push("0 = 1");
            } else {
                having.push("MAX(library_class.is_spatial) = 1");
            }
        } else if (libraryFilter === "stereo") {
            having.push("MAX(CASE WHEN library_class.is_spatial = 0 THEN 1 ELSE 0 END) = 1");
        }

        const whereClause = `WHERE ${where.join(" AND ")}`;
        const havingClause = having.length > 0 ? `HAVING ${having.join(" AND ")}` : "";
        const fromClause = `
          FROM LibraryAlbums library_group
          JOIN (
            SELECT
              library.id AS library_id,
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 1 ELSE 0 END AS is_spatial
            FROM Libraries library
            JOIN quality_profiles quality_profile
              ON quality_profile.id = library.quality_profile_id
            WHERE library.enabled = 1
          ) library_class
            ON library_class.library_id = library_group.library_id
          JOIN Albums album ON album.id = library_group.release_group_id
          ${input.search ? "LEFT JOIN ArtistMetadata artist ON artist.mbid = album.artist_mbid" : ""}
        `;
        const candidates = db.prepare(`
          SELECT album.id AS id
          ${fromClause}
          ${whereClause}
          GROUP BY album.id
          ${havingClause}
          ${getAlbumMembershipOrderBy(input.sort, sortDir)}
          LIMIT ? OFFSET ?
        `).all(...params, limit, offset) as Array<{ id: number }>;

        const candidateIds = candidates.map((row) => row.id);
        const candidateMarks = candidateIds.map(() => "?").join(", ");
        const detailRows = candidateIds.length === 0 ? [] : db.prepare(`
          ${buildReleaseGroupDetailsSelect(pagedReleaseGroupIdsSql(candidateMarks), selectedProviderAlbumExpression)}
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
        const localQualitiesMap = getAlbumLocalQualitiesMap(releaseGroupMbids);
        const count = Number((db.prepare(`
          SELECT COUNT(*) AS count
          FROM (
            SELECT album.id
            ${fromClause}
            ${whereClause}
            GROUP BY album.id
            ${havingClause}
          )
        `).get(...countParams) as { count?: number } | undefined)?.count || 0);

        return {
            items: rows.map((row) => {
                const releaseGroupMbid = row.mbid == null ? null : String(row.mbid);
                const stats = releaseGroupMbid ? downloadStats.get(releaseGroupMbid) : null;
                return normalizeReleaseGroupListRow(
                    row,
                    {
                        downloadedPercent: stats?.downloadedPercent ?? 0,
                        isDownloaded: stats?.isDownloaded ?? false,
                        totalTracks: stats?.totalTracks ?? 0,
                        downloadedTracks: stats?.downloadedTracks ?? 0,
                    },
                    releaseGroupMbid ? albumArtists.get(releaseGroupMbid) : undefined,
                    releaseGroupMbid ? localQualitiesMap.get(releaseGroupMbid) : undefined,
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

    /** Complete canonical tracks of one Edition — never trimmed to provider coverage. */
    static async getEditionTracks(albumId: string, editionId: number): Promise<AlbumTrackContract[]> {
        const tracks = await MusicBrainzReleaseGroupReadService.getEditionTracks(albumId, editionId);
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
            associatedVideos: getAlbumAssociatedVideos(albumId),
        };
    }

    static async getAlbumVersions(albumId: string): Promise<AlbumVersionContract[]> {
        return MusicBrainzReleaseGroupReadService.getVersions(albumId);
    }
}
