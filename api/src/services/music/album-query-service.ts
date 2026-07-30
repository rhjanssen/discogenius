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
import { AlbumLibraryIndexService } from "./album-library-index-service.js";
import { MusicBrainzArtistCreditService, type CanonicalAlbumArtist } from "../metadata/musicbrainz-artist-credit-service.js";
import { qualityTierSqlCondition } from "../../utils/quality-tier-sql.js";

const releaseGroupLibraryStateCte = `
  WITH ranked_library_state AS MATERIALIZED (
    SELECT
      library_group.release_group_id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      ) THEN 'spatial' ELSE 'stereo' END AS library_class,
      MAX(CASE WHEN library_group.monitored = 1 THEN 1 ELSE 0 END) OVER (
        PARTITION BY
          library_group.release_group_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END
      ) AS monitored,
      MAX(CASE WHEN library_group.locked = 1 THEN 1 ELSE 0 END) OVER (
        PARTITION BY
          library_group.release_group_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END
      ) AS monitored_lock,
      release.id AS selected_album_release_id,
      release.mbid AS selected_release_mbid,
      COALESCE(provider_item.provider, plan.provider) AS selected_provider,
      provider_item.id AS selected_provider_item_id,
      provider_item.provider_id AS selected_provider_id,
      provider_item.provider_url,
      (
          SELECT COALESCE(
            NULLIF(TRIM(CASE
              WHEN json_valid(plan_track.source_quality_snapshot)
              THEN json_extract(plan_track.source_quality_snapshot, '$.quality')
              ELSE plan_track.source_quality_snapshot
            END), ''),
            NULLIF(TRIM(variant.provider_quality_label), ''),
            variant.quality_class
          )
          FROM AcquisitionPlanTracks plan_track
          JOIN ProviderItemAudioVariants variant
            ON variant.id = plan_track.provider_audio_variant_id
          WHERE plan_track.plan_id = plan.id
          ORDER BY plan_track.id
          LIMIT 1
      ) AS quality,
      release_match.match_state AS match_status,
      COALESCE(provider_item.artwork_url, provider_item.cover_id) AS cover,
      COALESCE(CAST(provider_item.popularity AS REAL), 0) AS popularity,
      ROW_NUMBER() OVER (
        PARTITION BY
          library_group.release_group_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END
        ORDER BY
          CASE WHEN plan.state = 'current' AND provider_item.id IS NOT NULL THEN 0 ELSE 1 END,
          library_release.updated_at DESC,
          library_release.id DESC,
          library.id ASC
      ) AS state_rank
    FROM LibraryReleaseGroups library_group
    JOIN Libraries library
      ON library.id = library_group.library_id
     AND library.enabled = 1
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    LEFT JOIN LibraryReleases library_release
      ON library_release.library_id = library_group.library_id
     AND EXISTS (
       SELECT 1
       FROM AlbumEditions selected_release
       WHERE selected_release.id = library_release.edition_id
         AND selected_release.release_group_id = library_group.release_group_id
     )
    LEFT JOIN AlbumEditions release
      ON release.id = library_release.edition_id
    LEFT JOIN AcquisitionPlans plan
      ON plan.library_release_id = library_release.id
     AND plan.state = 'current'
    LEFT JOIN AcquisitionPlanSources plan_source
      ON plan_source.plan_id = plan.id
     AND plan_source.id = (
       SELECT preferred_source.id
       FROM AcquisitionPlanSources preferred_source
       WHERE preferred_source.plan_id = plan.id
       ORDER BY
         CASE preferred_source.role WHEN 'primary' THEN 0 ELSE 1 END,
         preferred_source.sort_order,
         preferred_source.id
       LIMIT 1
     )
    LEFT JOIN ProviderEditionMatches release_match
      ON release_match.id = plan_source.provider_edition_match_id
     AND release_match.match_state = 'accepted'
    LEFT JOIN ProviderItems provider_item
      ON provider_item.id = release_match.provider_edition_item_id
     AND (
       provider_item.availability IS NULL
       OR LOWER(CAST(provider_item.availability AS TEXT))
          NOT IN ('0', 'false', 'unavailable', 'no', '')
     )
  ),
  library_state AS MATERIALIZED (
    SELECT *
    FROM ranked_library_state
    WHERE state_rank = 1
  )
`;

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
      JOIN LibraryReleases library_release
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

function buildReleaseGroupDetailsSelect(whereClause: string, selectedProviderAlbumExpression: string): string {
    return `
      ${releaseGroupLibraryStateCte}
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
        stereo_provider_item.provider_url AS stereo_provider_url,
        stereo.selected_release_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        stereo.cover AS stereo_cover,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial_provider_item.provider_url AS spatial_provider_url,
        spatial.selected_release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        spatial.cover AS spatial_cover,
        ${releaseGroupPopularityExpression} AS popularity
      FROM Albums rg
      LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN library_state stereo
        ON stereo.release_group_id = rg.id
       AND stereo.library_class = 'stereo'
      LEFT JOIN library_state spatial
        ON spatial.release_group_id = rg.id
       AND spatial.library_class = 'spatial'
      LEFT JOIN ProviderItems stereo_provider_item
        ON stereo_provider_item.id = stereo.selected_provider_item_id
      LEFT JOIN ProviderItems spatial_provider_item
        ON spatial_provider_item.id = spatial.selected_provider_item_id
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
        stereo_release_mbid: row.stereo_release_mbid || null,
        spatial_provider: includeSpatial ? row.spatial_provider || null : null,
        spatial_provider_id: includeSpatial ? row.spatial_provider_id || null : null,
        spatial_provider_url: includeSpatial ? row.spatial_provider_url || null : null,
        spatial_quality: includeSpatial ? row.spatial_quality || null : null,
        spatial_match_status: includeSpatial ? row.spatial_match_status || null : null,
        spatial_release_mbid: includeSpatial ? row.spatial_release_mbid || null : null,
        selected_provider: row.selected_provider || row.stereo_provider || null,
        selected_provider_id: row.selected_provider_id || null,
        source: "musicbrainz",
        popularity: Number(row.popularity || 0),
    } as AlbumContract;
}

export class AlbumQueryService {
    static listAlbums(input: AlbumListQuery): AlbumsListResponseContract {
        // The materialized index has no provider/quality columns, so provider- or
        // quality-tier-filtered queries (the less common case) use the direct
        // normalized library-state query below.
        const hasProviderQualityFilter = Boolean(String(input.provider || "").trim() || String(input.qualityTier || "").trim());
        if (AlbumLibraryIndexService.isReady() && !hasProviderQualityFilter) {
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

        const providerFilter = String(input.provider || "").trim();
        const qualityTierFilter = String(input.qualityTier || "").trim();
        const slotAliases = filterLibraryStateAliases(libraryFilter);
        const tierConditions = qualityTierFilter
            ? slotAliases
                .map((alias) => ({
                    alias,
                    condition: qualityTierSqlCondition(`${alias}.quality`, qualityTierFilter),
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
        // Page the small identity set before enriching it with provider rows and
        // large artwork payloads. Applying those joins to every curated album
        // made a 50-row library page take several seconds on a mature catalog.
        const candidatePopularityExpression = `MAX(
          COALESCE(rg.popularity, 0),
          COALESCE(stereo.popularity, 0),
          COALESCE(spatial.popularity, 0)
        )`;
        const candidateQuery = `
          ${releaseGroupLibraryStateCte}
          SELECT rg.id, rg.mbid, ${candidatePopularityExpression} AS popularity
          FROM Albums rg
          LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN library_state stereo
            ON stereo.release_group_id = rg.id AND stereo.library_class = 'stereo'
          LEFT JOIN library_state spatial
            ON spatial.release_group_id = rg.id AND spatial.library_class = 'spatial'
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
        const localQualitiesMap = getAlbumLocalQualitiesMap(releaseGroupMbids);

        const countQuery = `
          ${releaseGroupLibraryStateCte}
          SELECT COUNT(*) AS count
          FROM Albums rg
          LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN library_state stereo
            ON stereo.release_group_id = rg.id
           AND stereo.library_class = 'stereo'
          LEFT JOIN library_state spatial
            ON spatial.release_group_id = rg.id
           AND spatial.library_class = 'spatial'
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
        const localQualitiesMap = getAlbumLocalQualitiesMap(releaseGroupMbids);
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
