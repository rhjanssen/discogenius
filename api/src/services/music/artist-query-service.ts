import { db } from "../../database.js";
import {
    getArtistDownloadStats,
    getArtistDownloadStatsMap,
    getReleaseGroupDownloadStatsMap,
} from "../download/download-state.js";
import { hydrateTrackRows } from "./track-query-service.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { loadArtistWithEffectiveMonitor, type ArtistMonitorRow } from "./artist-monitoring.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { shouldRefreshArtist } from "../config/refresh-policy.js";
import { ArtistStatisticsService } from "./artist-statistics-service.js";
import type { ArtistContract, ArtistsListResponseContract } from "../../contracts/catalog.js";
import {
    albumCoverLocalUrl,
    albumProviderArtworkCandidatesFromRow,
    providerArtworkIdFromCandidates,
    imageContainerFromImagesColumn,
    mapArtistArtworkToLocalUrl,
    videoCoverLocalUrl,
} from "../metadata/media-cover-service.js";
import { getConfigSection } from "../config/config.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");

function artistArtworkUrl(artistMbid: unknown, ...values: unknown[]): string | null {
    return mapArtistArtworkToLocalUrl({
        artistMbid: artistMbid == null ? null : String(artistMbid),
        sourceUrls: values.map((value) => value == null ? null : String(value)),
    });
}

export interface ArtistListQuery {
    limit: number;
    offset: number;
    search?: string;
    sort?: string;
    dir?: string;
    monitored?: boolean;
    includeDownloadStats?: boolean;
    includeCounts?: boolean;
}

export interface ArtistActivitySnapshot {
    scanning: boolean;
    curating: boolean;
    downloading: boolean;
    libraryScan: boolean;
    totalActive: number;
    jobs: Array<{ id: number; type: string; status: string }>;
}

type ArtistCountRow = {
    artist_id: string;
    cnt: number;
    monitored_cnt: number;
};

function buildArtistReleaseGroupCountMap(artistMbids: string[]): Map<string, ArtistCountRow> {
    const result = new Map<string, ArtistCountRow>();
    if (artistMbids.length === 0) {
        return result;
    }

    const distinctMbids = Array.from(new Set(artistMbids));
    const placeholders = distinctMbids.map(() => "?").join(",");
    const rows = db.prepare(`
        WITH artist_scope AS (
            SELECT artist_mbid, mbid AS release_group_mbid
            FROM Albums
            WHERE artist_mbid IN (${placeholders})

            UNION

            SELECT artist_mbid, release_group_mbid
            FROM ArtistReleaseGroups
            WHERE artist_mbid IN (${placeholders})
        ),
        slot_state AS (
            SELECT release_group_mbid,
                   MAX(CASE WHEN monitored = 1 THEN 1 ELSE 0 END) AS monitored
            FROM ReleaseGroupSlots
            WHERE slot IN ('stereo', 'spatial')
            GROUP BY release_group_mbid
        )
        SELECT scope.artist_mbid AS artist_id,
               COUNT(*) AS cnt,
               SUM(CASE WHEN COALESCE(slot_state.monitored, 0) = 1 THEN 1 ELSE 0 END) AS monitored_cnt
        FROM artist_scope scope
        LEFT JOIN slot_state ON slot_state.release_group_mbid = scope.release_group_mbid
        GROUP BY scope.artist_mbid
    `).all(...distinctMbids, ...distinctMbids) as ArtistCountRow[];

    for (const row of rows) {
        result.set(String(row.artist_id), {
            artist_id: String(row.artist_id),
            cnt: Number(row.cnt || 0),
            monitored_cnt: Number(row.monitored_cnt || 0),
        });
    }

    return result;
}

function buildArtistTrackCountMap(artistMbids: string[]): Map<string, ArtistCountRow> {
    const result = new Map<string, ArtistCountRow>();
    if (artistMbids.length === 0) {
        return result;
    }

    const distinctMbids = Array.from(new Set(artistMbids));
    const placeholders = distinctMbids.map(() => "?").join(",");
    const rows = db.prepare(`
        WITH artist_scope AS (
            SELECT artist_mbid, mbid AS release_group_mbid
            FROM Albums
            WHERE artist_mbid IN (${placeholders})

            UNION

            SELECT artist_mbid, release_group_mbid
            FROM ArtistReleaseGroups
            WHERE artist_mbid IN (${placeholders})
        ),
        slot_state AS (
            SELECT release_group_mbid,
                   MAX(CASE WHEN monitored = 1 THEN 1 ELSE 0 END) AS monitored
            FROM ReleaseGroupSlots
            WHERE slot IN ('stereo', 'spatial')
            GROUP BY release_group_mbid
        ),
        artist_tracks AS (
            SELECT DISTINCT scope.artist_mbid,
                   track.mbid,
                   COALESCE(slot_state.monitored, 0) AS monitored
            FROM artist_scope scope
            JOIN AlbumReleases release ON release.release_group_mbid = scope.release_group_mbid
            JOIN Tracks track ON track.release_mbid = release.mbid
            LEFT JOIN slot_state ON slot_state.release_group_mbid = scope.release_group_mbid
        )
        SELECT artist_mbid AS artist_id,
               COUNT(*) AS cnt,
               SUM(CASE WHEN monitored = 1 THEN 1 ELSE 0 END) AS monitored_cnt
        FROM artist_tracks
        GROUP BY artist_mbid
    `).all(...distinctMbids, ...distinctMbids) as ArtistCountRow[];

    for (const row of rows) {
        result.set(String(row.artist_id), {
            artist_id: String(row.artist_id),
            cnt: Number(row.cnt || 0),
            monitored_cnt: Number(row.monitored_cnt || 0),
        });
    }

    return result;
}

function hasArtistIdentityGap(artist: ArtistMonitorRow): boolean {
    const artistName = String(artist.name ?? "").trim();
    return !artistName || artistName === "Unknown Artist" || artist.artist_types == null;
}

function artistMusicBrainzId(artist: ArtistMonitorRow | undefined, fallbackArtistId: string): string | null {
    const mbid = String(artist?.mbid || "").trim();
    if (MUSICBRAINZ_MBID_RE.test(mbid)) {
        return mbid;
    }

    return MUSICBRAINZ_MBID_RE.test(fallbackArtistId) ? fallbackArtistId : null;
}

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasArtistArtworkGap(artist: ArtistMonitorRow): boolean {
    return !artistArtworkUrl(artist.mbid, artist.picture, artist.cover_image_url);
}

function shouldHydrateArtistDisplayMetadata(artist: ArtistMonitorRow | undefined, artistId: string): boolean {
    if (!artist || !artistMusicBrainzId(artist, artistId)) {
        return false;
    }

    if (hasArtistIdentityGap(artist)) {
        return true;
    }

    if (!hasArtistArtworkGap(artist)) {
        return false;
    }

    return shouldRefreshArtist({
        artistId,
        lastScanned: typeof artist.musicbrainz_last_checked === "string"
            ? artist.musicbrainz_last_checked
            : null,
    });
}

async function hydrateArtistDisplayMetadataIfNeeded(
    artistId: string,
    artist: ArtistMonitorRow | undefined,
): Promise<ArtistMonitorRow | undefined> {
    if (!shouldHydrateArtistDisplayMetadata(artist, artistId)) {
        return artist;
    }

    const mbid = artistMusicBrainzId(artist, artistId);
    if (!mbid) {
        return artist;
    }

    try {
        await RefreshArtistService.upsertMusicBrainzArtist(mbid, {
            monitorArtist: Boolean(artist?.effective_monitor),
        });
        return loadArtistWithEffectiveMonitor(artistId) || loadArtistWithEffectiveMonitor(mbid) || artist;
    } catch (error) {
        console.warn(`[ArtistQueryService] Failed to hydrate display metadata for ${artistId}:`, error);
        return artist;
    }
}

function shouldHydrateArtistShallow(artist: ArtistMonitorRow | undefined, artistId: string): boolean {
    if (!artist) {
        return true;
    }

    if (hasArtistIdentityGap(artist) || artist.bio_text == null) {
        return true;
    }

    return shouldRefreshArtist({
        artistId,
        lastScanned: typeof artist.last_scanned === "string" ? artist.last_scanned : null,
    });
}

function shouldHydrateArtistPage(artist: ArtistMonitorRow | undefined, artistId: string): boolean {
    if (!artist) {
        return true;
    }

    if (shouldHydrateArtistShallow(artist, artistId)) {
        return true;
    }

    if (RefreshArtistService.needsInitialRefresh(artistId)) {
        return true;
    }

    return shouldRefreshArtist({
        artistId,
        lastScanned: typeof artist.last_scanned === "string" ? artist.last_scanned : null,
    });
}

function parseJsonStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || "").trim()).filter(Boolean);
    }

    try {
        const parsed = JSON.parse(String(value || "[]"));
        return Array.isArray(parsed)
            ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function normalizeTopTrackGroupKey(value: unknown): string {
    return String(value || "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function mergeQualityTags(...groups: Array<unknown>): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const group of groups) {
        const values = Array.isArray(group) ? group : group ? [group] : [];
        for (const value of values) {
            const quality = String(value || "").trim();
            const key = quality.toUpperCase();
            if (!quality || seen.has(key)) {
                continue;
            }
            seen.add(key);
            merged.push(quality);
        }
    }
    return merged.sort((a, b) => Number(isSpatialAudioQuality(a)) - Number(isSpatialAudioQuality(b)));
}

function topTrackRepresentativeScore(track: any): number {
    let score = 0;
    if (track.is_downloaded || track.downloaded) score += 100;
    if (track.preview_provider_track_id) score += 40;
    if (Array.isArray(track.files) && track.files.length > 0) score += 20;
    if (track.quality && !isSpatialAudioQuality(track.quality)) score += 10;
    if (track.album?.cover_id || track.album_cover || track.cover_url) score += 2;
    return score;
}

function mergeTopTrackRows(tracks: any[]): any[] {
    const grouped = new Map<string, any>();
    const order: string[] = [];

    for (const track of tracks) {
        const key = normalizeTopTrackGroupKey(track.title) || String(track.id);
        const existing = grouped.get(key);
        if (!existing) {
            grouped.set(key, { ...track });
            order.push(key);
            continue;
        }

        const useIncoming = topTrackRepresentativeScore(track) > topTrackRepresentativeScore(existing);
        const representative = useIncoming ? { ...track } : { ...existing };
        const fallback = useIncoming ? existing : track;
        const mergedQualityTags = mergeQualityTags(existing.qualityTags, existing.quality, track.qualityTags, track.quality);
        const mergedFiles = [
            ...(Array.isArray(existing.files) ? existing.files : []),
            ...(Array.isArray(track.files) ? track.files : []),
        ];

        grouped.set(key, {
            ...fallback,
            ...representative,
            quality: representative.quality || mergedQualityTags[0] || fallback.quality || null,
            qualityTags: mergedQualityTags,
            downloaded: Boolean(existing.downloaded || track.downloaded || existing.is_downloaded || track.is_downloaded),
            is_downloaded: Boolean(existing.is_downloaded || track.is_downloaded || existing.downloaded || track.downloaded),
            preview_provider: representative.preview_provider || fallback.preview_provider || null,
            preview_provider_track_id: representative.preview_provider_track_id || fallback.preview_provider_track_id || null,
            files: mergedFiles.length > 0 ? mergedFiles : representative.files,
        });
    }

    return order.map((key) => grouped.get(key)).filter(Boolean);
}

function normalizeReleaseGroupPrimaryType(value: unknown): string {
    const normalized = String(value || "Album").trim().toUpperCase();
    if (normalized === "EP") return "EP";
    if (normalized === "SINGLE") return "SINGLE";
    if (normalized === "BROADCAST") return "BROADCAST";
    if (normalized === "OTHER") return "OTHER";
    return "ALBUM";
}

function releaseGroupBucket(row: any): keyof typeof RELEASE_GROUP_BUCKETS {
    const secondaryTypes = parseJsonStringArray(row.secondary_types).map((type) => type.toLowerCase());
    if (secondaryTypes.includes("live")) return "LIVE";
    if (secondaryTypes.includes("compilation")) return "COMPILATION";
    if (secondaryTypes.includes("soundtrack")) return "SOUNDTRACK";
    if (secondaryTypes.includes("remix")) return "REMIX";
    if (secondaryTypes.includes("dj-mix")) return "DJ_MIX";
    if (secondaryTypes.includes("mixtape/street")) return "MIXTAPE";
    if (secondaryTypes.includes("demo")) return "DEMO";

    const primaryType = normalizeReleaseGroupPrimaryType(row.primary_type);
    if (primaryType === "EP") return "EP";
    if (primaryType === "SINGLE") return "SINGLE";
    if (primaryType === "BROADCAST") return "BROADCAST";
    if (primaryType === "OTHER") return "OTHER";
    return "ALBUM";
}


function mapReleaseGroupCard(row: Record<string, any>, options: {
    artistId: string;
    artistName: string;
    includeSpatial: boolean;
    downloadStats?: { downloadedPercent?: number; isDownloaded?: boolean };
}): any {
    const bucketKey = releaseGroupBucket(row);
    const primaryType = normalizeReleaseGroupPrimaryType(row.primary_type);
    const providerCandidates = albumProviderArtworkCandidatesFromRow(row);
    const providerCover = providerArtworkIdFromCandidates(providerCandidates, "album")
        || row.stereo_cover || row.spatial_cover
        || null;
    const coverUrl = albumCoverLocalUrl({
        albumMbid: row.mbid,
        images: imageContainerFromImagesColumn(row.images),
    });

    return {
        id: String(row.mbid),
        title: row.title,
        cover: coverUrl,
        cover_id: coverUrl,
        cover_art_url: coverUrl,
        provider_cover_id: providerCover,
        artist_id: options.artistId,
        artist_name: options.artistName,
        mb_release_group_id: String(row.mbid),
        release_date: row.first_release_date || null,
        type: primaryType,
        album_type: primaryType,
        group_type: primaryType === "EP" || primaryType === "SINGLE" ? "EPSANDSINGLES" : "ALBUMS",
        explicit: Boolean(row.explicit),
        quality: row.selected_quality || null,
        selected_provider_id: row.selected_provider_id || null,
        stereo_provider_id: row.stereo_provider_id || null,
        stereo_release_mbid: row.stereo_release_mbid || null,
        stereo_quality: row.stereo_quality || null,
        stereo_match_status: row.stereo_match_status || null,
        stereo_match_method: row.stereo_match_method || null,
        spatial_provider_id: options.includeSpatial ? row.spatial_provider_id || null : null,
        spatial_release_mbid: options.includeSpatial ? row.spatial_release_mbid || null : null,
        spatial_quality: options.includeSpatial ? row.spatial_quality || null : null,
        spatial_match_status: options.includeSpatial ? row.spatial_match_status || null : null,
        spatial_match_method: options.includeSpatial ? row.spatial_match_method || null : null,
        is_monitored: Boolean(row.wanted),
        downloaded: options.downloadStats?.downloadedPercent ?? 0,
        is_downloaded: options.downloadStats?.isDownloaded ?? false,
        monitored_lock: Boolean(row.stereo_monitor_lock || row.spatial_monitor_lock),
        module: bucketKey,
        source: "musicbrainz",
    };
}

function mapReleaseGroupCardForArtistPage(row: Record<string, any>, options: {
    artistId: string;
    artistName: string;
    includeSpatial: boolean;
    downloadStats?: { downloadedPercent?: number; isDownloaded?: boolean };
}): any {
    const card = mapReleaseGroupCard(row, options);
    const coverUrl = card.cover_art_url;

    return {
        ...card,
        cover: coverUrl,
        cover_id: coverUrl,
        cover_art_url: coverUrl,
    };
}

const RELEASE_GROUP_BUCKETS = {
    ALBUM: "ARTIST_ALBUMS",
    EP: "ARTIST_EPS",
    SINGLE: "ARTIST_SINGLES",
    LIVE: "ARTIST_LIVE_ALBUMS",
    COMPILATION: "ARTIST_COMPILATIONS",
    SOUNDTRACK: "ARTIST_SOUNDTRACKS",
    DEMO: "ARTIST_DEMOS",
    REMIX: "ARTIST_REMIXES",
    DJ_MIX: "ARTIST_DJ_MIXES",
    MIXTAPE: "ARTIST_MIXTAPES",
    BROADCAST: "ARTIST_BROADCASTS",
    OTHER: "ARTIST_OTHER_RELEASES",
} as const;

const duplicateProviderArtistPredicate = `NOT (
    a.mbid IS NOT NULL
    AND TRIM(CAST(a.mbid AS TEXT)) != ''
    AND CAST(a.id AS TEXT) != CAST(a.mbid AS TEXT)
    AND EXISTS (
        SELECT 1
        FROM Artists canonical_artist
        WHERE canonical_artist.mbid = a.mbid
          AND CAST(canonical_artist.id AS TEXT) = CAST(canonical_artist.mbid AS TEXT)
    )
)`;

export class ArtistQueryService {
    static listArtists(input: ArtistListQuery): ArtistsListResponseContract {
        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const sortParam = input.sort || "name";
        const sortDir = (input.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
        const monitoredFilter = input.monitored;
        const includeDownloadStats = input.includeDownloadStats !== false;
        const includeCounts = input.includeCounts !== false;

        let query = `
      SELECT a.*,
        CASE WHEN ${managedArtistPredicate} THEN 1 ELSE 0 END as effective_monitor
      FROM Artists a
    `;
        let countQuery = "SELECT COUNT(*) as total FROM Artists a";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = [duplicateProviderArtistPredicate];

        if (search) {
            where.push("a.name LIKE ?");
            const searchParam = `%${search}%`;
            params.push(searchParam);
            countParams.push(searchParam);
        }

        if (monitoredFilter !== undefined) {
            where.push(monitoredFilter ? managedArtistPredicate : `NOT ${managedArtistPredicate}`);
        }

        if (where.length) {
            const whereClause = ` WHERE ${where.join(" AND ")}`;
            query += whereClause;
            countQuery += whereClause;
        }

        const orderBy = (() => {
            switch (sortParam) {
                case "popularity":
                    return ` ORDER BY COALESCE(a.popularity, 0) ${sortDir}, a.name ASC, a.id ASC`;
                case "scannedAt":
                    return ` ORDER BY (a.last_scanned IS NULL) ASC, a.last_scanned ${sortDir}, a.id ASC`;
                case "addedAt":
                case "releaseDate":
                    return ` ORDER BY (a.user_date_added IS NULL) ASC, a.user_date_added ${sortDir}, a.id ASC`;
                case "name":
                default:
                    return ` ORDER BY a.name ${sortDir}, a.id ASC`;
            }
        })();

        query += `${orderBy} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const artists = db.prepare(query).all(...params) as any[];
        const totalResult = db.prepare(countQuery).get(...countParams) as { total: number };
        const artistIds = artists.map((artist) => String(artist.id)).filter(Boolean);
        // Read precomputed statistics only — never compute on the request thread.
        // Statistics are (re)computed off the main thread by the command workers
        // as artists are scanned/curated (see the *-handlers refresh calls); the
        // ArtistStatistics table persists, so the list endpoint stays fast.
        // Missing rows surface as 0 until the owning artist's next worker refresh.
        const artistStatisticsById = includeCounts
            ? ArtistStatisticsService.getStatisticsMap(artistIds)
            : new Map();
        const artistDownloadStats = includeDownloadStats
            ? getArtistDownloadStatsMap(artistIds)
            : null;

        return {
            items: artists.map((artist) => {
                const artistId = String(artist.id);
                const statistics = artistStatisticsById.get(artistId);
                const resolvedArtistPicture = artistArtworkUrl(artist.mbid, artist.picture, artist.cover_image_url);
                const countFields = includeCounts
                    ? {
                        album_count: Number(statistics?.album_count || 0),
                        monitored_album_count: Number(statistics?.monitored_album_count || 0),
                        track_count: Number(statistics?.track_count || 0),
                        monitored_track_count: Number(statistics?.monitored_track_count || 0),
                    }
                    : {};

                return {
                    ...artist,
                    picture: resolvedArtistPicture,
                    cover_image_url: artistArtworkUrl(artist.mbid, artist.cover_image_url),
                    ...countFields,
                    downloaded: includeDownloadStats
                        ? artistDownloadStats?.get(artistId)?.downloadedPercent ?? 0
                        : Number(artist.downloaded ?? 0),
                    is_monitored: Boolean(artist.effective_monitor),
                    is_downloaded: includeDownloadStats
                        ? artistDownloadStats?.get(artistId)?.isDownloaded ?? false
                        : false,
                };
            }),
            total: totalResult.total,
            limit,
            offset,
            hasMore: offset + artists.length < totalResult.total,
        };
    }

    static async getArtistById(artistId: string): Promise<ArtistContract | null> {
        let artist = loadArtistWithEffectiveMonitor(artistId);

        // Cold-load: seed basic canonical metadata for artists not yet in the DB
        // (e.g. navigating from search results). Skip re-scanning existing artists
        // — staleness refresh is the scheduler's job.
        if (!artist) {
            try {
                await RefreshArtistService.refreshArtistMetadata(artistId, { includeSimilarArtists: false, seedSimilarArtists: false });
                artist = loadArtistWithEffectiveMonitor(artistId);
            } catch { /* TIDAL lookup failed — fall through to 404 */ }
        }

        if (!artist) {
            return null;
        }
        artist = await hydrateArtistDisplayMetadataIfNeeded(artistId, artist);
        if (!artist) {
            return null;
        }

        const artistDownloadStats = getArtistDownloadStats(artistId);
        const biography = artist.bio_text == null
            ? (artist.biography == null ? null : String(artist.biography))
            : String(artist.bio_text);

        return {
            id: String(artist.id),
            name: artist.name ?? "Unknown Artist",
            picture: artistArtworkUrl(artist.mbid, artist.picture, artist.cover_image_url),
            cover_image_url: artistArtworkUrl(artist.mbid, artist.cover_image_url),
            last_scanned: artist.last_scanned == null ? null : String(artist.last_scanned),
            bio: biography,
            biography,
            album_count: Number(artist.album_count ?? 0),
            downloaded: artistDownloadStats.downloadedPercent,
            is_monitored: Boolean(artist.effective_monitor),
            is_downloaded: artistDownloadStats.isDownloaded,
        };
    }

    static getArtistAlbums(artistId: string): any[] {
        const artist = loadArtistWithEffectiveMonitor(artistId);
        const artistMbid = artist?.mbid ? String(artist.mbid) : "";
        if (!artist || !artistMbid) {
            return [];
        }

        const rows = db.prepare(`
      SELECT
        rg.*,
        COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
        COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
        COALESCE(stereo.quality, spatial.quality) AS selected_quality,
        stereo.selected_provider AS stereo_provider,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.selected_release_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        stereo.match_method AS stereo_match_method,
        stereo.cover AS stereo_cover,
        stereo.monitored_lock AS stereo_monitor_lock,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.selected_release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        spatial.match_method AS spatial_match_method,
        spatial.cover AS spatial_cover,
        spatial.monitored_lock AS spatial_monitor_lock,
        album_offer.asset_id AS provider_asset_id,
        album_offer.cover AS provider_cover,
        CASE
          WHEN stereo.id IS NULL AND spatial.id IS NULL THEN 0
          WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1
          ELSE 0
        END AS wanted
      FROM Albums rg
      LEFT JOIN ReleaseGroupSlots stereo
        ON stereo.release_group_mbid = rg.mbid
       AND stereo.slot = 'stereo'
      LEFT JOIN ReleaseGroupSlots spatial
        ON spatial.release_group_mbid = rg.mbid
       AND spatial.slot = 'spatial'
      LEFT JOIN ProviderItems album_offer
        ON album_offer.entity_type = 'album'
       AND album_offer.provider = COALESCE(stereo.selected_provider, spatial.selected_provider)
       AND CAST(album_offer.provider_id AS TEXT) = CAST(COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS TEXT)
      WHERE rg.artist_mbid = ?
         OR EXISTS (
           SELECT 1
           FROM ArtistReleaseGroups scope
           WHERE scope.release_group_mbid = rg.mbid
             AND scope.artist_mbid = ?
         )
      ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date DESC, rg.title ASC
    `).all(artistMbid, artistMbid) as any[];

        const downloadStats = getReleaseGroupDownloadStatsMap(rows.map((row) => row.mbid));

        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        return rows.map((row) => mapReleaseGroupCard(row, {
            artistId: String(artist.id),
            artistName: String(artist.name || "Unknown Artist"),
            includeSpatial,
            downloadStats: downloadStats.get(String(row.mbid)),
        }));
    }

    static getArtistActivity(artistId: string): ArtistActivitySnapshot {
        const artist = loadArtistWithEffectiveMonitor(artistId);
        const artistMbid = artist?.mbid ? String(artist.mbid) : artistId;
        const directJobs = db.prepare(`
      SELECT id, name, status, ref_id, created_at, started_at
      FROM commands
      WHERE ref_id = ? AND status IN ('queued', 'started')
    `).all(artistId) as any[];

        const releaseGroupJobs = db.prepare(`
      SELECT jq.id, jq.name, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM commands jq
      INNER JOIN Albums rg
        ON rg.mbid = jq.ref_id
        OR rg.mbid = json_extract(jq.payload, '$.releaseGroupMbid')
      WHERE rg.artist_mbid = ?
        AND jq.name IN ('RefreshAlbum', 'ScanAlbum', 'DownloadAlbum', 'ImportDownload')
        AND jq.status IN ('queued', 'started')
    `).all(artistMbid) as any[];

        const trackDownloadJobs = db.prepare(`
      SELECT jq.id, jq.name, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM commands jq
      INNER JOIN Tracks track
        ON CAST(track.id AS TEXT) = CAST(jq.ref_id AS TEXT)
        OR track.mbid = jq.ref_id
        OR track.mbid = json_extract(jq.payload, '$.canonicalTrackMbid')
        OR CAST(track.id AS TEXT) = CAST(json_extract(jq.payload, '$.canonicalTrackId') AS TEXT)
      INNER JOIN AlbumReleases release
        ON release.mbid = track.release_mbid
      INNER JOIN Albums rg
        ON rg.mbid = release.release_group_mbid
      WHERE rg.artist_mbid = ?
        AND jq.name IN ('DownloadTrack', 'ImportDownload')
        AND jq.status IN ('queued', 'started')
    `).all(artistMbid) as any[];

        const videoDownloadJobs = db.prepare(`
      SELECT jq.id, jq.name, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM commands jq
      INNER JOIN Recordings recording
        ON CAST(recording.id AS TEXT) = CAST(jq.ref_id AS TEXT)
        OR CAST(recording.id AS TEXT) = CAST(json_extract(jq.payload, '$.canonicalRecordingId') AS TEXT)
        OR recording.mbid = json_extract(jq.payload, '$.canonicalRecordingMbid')
      WHERE recording.is_video = 1
        AND (
          recording.artist_mbid = ?
          OR CAST(recording.artist_metadata_id AS TEXT) = CAST(? AS TEXT)
        )
        AND jq.name IN ('DownloadVideo', 'ImportDownload')
        AND jq.status IN ('queued', 'started')
    `).all(artistMbid, artist?.id ? String(artist.id) : artistId) as any[];

        const libraryRescanJob = db.prepare(`
      SELECT id, name, status, ref_id, created_at, started_at
      FROM commands
      WHERE name = 'RescanFolders'
        AND json_extract(payload, '$.addNewArtists') = 1
        AND status IN ('queued', 'started')
      LIMIT 1
    `).get() as any | undefined;

        const allJobs = new Map<number, any>();
        for (const job of [...directJobs, ...releaseGroupJobs, ...trackDownloadJobs, ...videoDownloadJobs]) {
            allJobs.set(job.id, job);
        }
        if (libraryRescanJob) {
            allJobs.set(libraryRescanJob.id, libraryRescanJob);
        }

        const jobs = Array.from(allJobs.values());

        return {
            scanning: jobs.some((job) => job.name === "RefreshArtist" || job.name === "RefreshAlbum" || job.name === "ScanAlbum"),
            curating: jobs.some((job) => job.name === "CurateArtist"),
            downloading: jobs.some((job) => job.name.startsWith("Download") || job.name === "ImportDownload"),
            libraryScan: jobs.some((job) => job.name === "RescanFolders"),
            totalActive: jobs.length,
            jobs: jobs.map((job) => ({ id: job.id, type: job.name, status: job.status })),
        };
    }

    static async getArtistDetail(id: string): Promise<any | null> {
        let existing = loadArtistWithEffectiveMonitor(id);

        if (!existing) {
            try {
                await RefreshArtistService.refreshArtistMetadata(id, { includeSimilarArtists: false, seedSimilarArtists: false });
                existing = loadArtistWithEffectiveMonitor(id);
            } catch { /* TIDAL lookup failed */ }
        }

        if (!existing) {
            return null;
        }

        const artist = db.prepare(`
      SELECT * FROM Artists WHERE id = ?
    `).get(id) as any;

        if (!artist) {
            return null;
        }

        const albums = this.getArtistAlbums(id);

        const grouped: Record<string, any[]> = {
            ARTIST_ALBUMS: [],
            ARTIST_EPS: [],
            ARTIST_SINGLES: [],
            ARTIST_COMPILATIONS: [],
            ARTIST_LIVE_ALBUMS: [],
            ARTIST_APPEARS_ON: [],
            ARTIST_REMIXES: [],
            ARTIST_SOUNDTRACKS: [],
            ARTIST_DEMOS: [],
            ARTIST_DJ_MIXES: [],
            ARTIST_MIXTAPES: [],
            ARTIST_BROADCASTS: [],
            ARTIST_OTHER_RELEASES: [],
        };

        for (const album of albums) {
            const moduleName = RELEASE_GROUP_BUCKETS[album.module as keyof typeof RELEASE_GROUP_BUCKETS]
                || (album.type === "SINGLE" ? "ARTIST_SINGLES"
                    : album.type === "EP" ? "ARTIST_EPS"
                        : "ARTIST_ALBUMS");

            if (!grouped[moduleName]) {
                grouped[moduleName] = [];
            }
            grouped[moduleName].push(album);
        }

        return { artist, albums: grouped };
    }

    static async getArtistPage(
        artistId: string,
        options: {
            includeReleaseGroups?: boolean;
            includeTracks?: boolean;
            includeVideos?: boolean;
            includeStatistics?: boolean;
        } = {},
    ): Promise<any | null> {
        const includeReleaseGroups = options.includeReleaseGroups !== false;
        const includeTracks = options.includeTracks !== false;
        const includeVideos = options.includeVideos !== false;
        const includeStatistics = options.includeStatistics !== false;
        let artist = loadArtistWithEffectiveMonitor(artistId);

        // Cold-load: seed basic canonical metadata for not-yet-added artists so
        // search-result navigation works.  Existing artists are returned as-is;
        // staleness refresh is the scheduler's job.
        if (!artist) {
            try {
                await RefreshArtistService.refreshArtistMetadata(artistId, { includeSimilarArtists: false, seedSimilarArtists: false });
                artist = loadArtistWithEffectiveMonitor(artistId);
            } catch { /* TIDAL lookup failed */ }
        }

        if (!artist) {
            return null;
        }
        artist = await hydrateArtistDisplayMetadataIfNeeded(artistId, artist);
        if (!artist) {
            return null;
        }
        const needsEnrichment = shouldHydrateArtistPage(artist, artistId);

        // Scope to this artist's video recordings via a UNION of the two
        // artist-link columns — each branch uses a covering index
        // (artist_metadata_id, is_video) / (artist_mbid, is_video). The prior
        // form filtered `is_video = 1 AND (CAST(...) = ? OR ...)`, whose CAST +
        // OR-join to ArtistMetadata forced a scan of EVERY artist's videos on
        // every artist-page load. All rows here belong to `artist`, so the
        // ArtistMetadata join is gone and id/name are bound directly.
        const videos = includeVideos ? db.prepare(`
         WITH artist_videos(id) AS (
           SELECT id FROM Recordings WHERE is_video = 1 AND artist_metadata_id = @artistMetadataId
           UNION
           SELECT id FROM Recordings WHERE is_video = 1 AND artist_mbid = @artistMbid
         ),
         provider_video_candidate_ids(recording_id, provider_rowid) AS MATERIALIZED (
           SELECT artist_videos.id, provider_item.rowid
           FROM artist_videos
           CROSS JOIN ProviderItems provider_item INDEXED BY idx_provider_items_recording_id
           WHERE provider_item.recording_id = artist_videos.id
             AND provider_item.entity_type = 'video'

           UNION

           SELECT artist_videos.id, provider_item.rowid
           FROM artist_videos
           JOIN Recordings recording ON recording.id = artist_videos.id
           CROSS JOIN ProviderItems provider_item INDEXED BY idx_provider_items_entity_recording
           WHERE recording.mbid IS NOT NULL
             AND provider_item.entity_type = 'video'
             AND provider_item.recording_mbid = recording.mbid
         ),
         provider_videos AS (
           SELECT
             candidates.recording_id,
             provider_item.provider,
             provider_item.provider_id,
             provider_item.duration,
             provider_item.release_date,
             provider_item.version,
             provider_item.explicit,
             provider_item.quality,
             provider_item.asset_id,
             provider_item.provider_url,
             provider_item.popularity,
             ROW_NUMBER() OVER (
               PARTITION BY candidates.recording_id
               ORDER BY COALESCE(provider_item.match_confidence, 0) DESC,
                        provider_item.updated_at DESC,
                        provider_item.provider_id ASC
             ) AS rank
           FROM provider_video_candidate_ids candidates
           CROSS JOIN ProviderItems provider_item
           WHERE provider_item.rowid = candidates.provider_rowid
         ),
         downloaded_videos(recording_id) AS (
           SELECT DISTINCT artist_videos.id
           FROM artist_videos
           CROSS JOIN TrackFiles file INDEXED BY idx_track_files_recording_id
           WHERE file.file_type = 'video'
             AND file.recording_id = artist_videos.id

           UNION

           SELECT DISTINCT artist_videos.id
           FROM artist_videos
           JOIN Recordings recording ON recording.id = artist_videos.id
           CROSS JOIN TrackFiles file INDEXED BY idx_track_files_canonical_recording_type
           WHERE recording.mbid IS NOT NULL
             AND file.file_type = 'video'
             AND file.canonical_recording_mbid = recording.mbid

           UNION

           SELECT DISTINCT provider_video.recording_id
           FROM provider_videos provider_video
           CROSS JOIN TrackFiles file INDEXED BY idx_track_files_provider_resource
           WHERE provider_video.rank = 1
             AND file.file_type = 'video'
             AND file.provider = provider_video.provider
             AND file.provider_entity_type = 'video'
             AND CAST(file.provider_id AS TEXT) = CAST(provider_video.provider_id AS TEXT)
         )
         SELECT
           CAST(recording.id AS TEXT) AS id,
           recording.title,
           COALESCE(
             CASE
               WHEN COALESCE(recording.length_ms, 0) > 0
               THEN CAST(ROUND(recording.length_ms / 1000.0) AS INT)
               ELSE NULL
             END,
             provider_item.duration,
             0
           ) AS duration,
           COALESCE(recording.release_date, provider_item.release_date) AS release_date,
           provider_item.version,
           provider_item.explicit,
           COALESCE(provider_item.quality, 'MP4_1080P') AS quality,
           COALESCE(recording.cover_image_id, provider_item.asset_id) AS cover,
           recording.cover_image_url AS cover_art_url,
           provider_item.provider_url AS url,
           CAST(COALESCE(recording.artist_metadata_id, @artistIdNum) AS TEXT) AS artist_id,
           @artistName AS artist_name,
           COALESCE(recording.monitored, 0) AS monitored,
           COALESCE(recording.monitored_lock, 0) AS monitored_lock,
           recording.updated_at AS last_scanned,
           MAX(
             COALESCE(CAST(recording.popularity AS REAL), 0),
             COALESCE(CAST(provider_item.popularity AS REAL), 0)
           ) AS video_popularity,
           CASE WHEN downloaded_video.recording_id IS NOT NULL THEN 1 ELSE 0 END AS is_downloaded
         FROM Recordings recording
         JOIN artist_videos av ON av.id = recording.id
         LEFT JOIN provider_videos provider_item
           ON provider_item.recording_id = recording.id
          AND provider_item.rank = 1
         LEFT JOIN downloaded_videos downloaded_video
           ON downloaded_video.recording_id = recording.id
         ORDER BY COALESCE(video_popularity, 0) DESC, (COALESCE(recording.release_date, provider_item.release_date) IS NULL) ASC, COALESCE(recording.release_date, provider_item.release_date) DESC, recording.title ASC, recording.id ASC
       `).all({
            artistMetadataId: Number(artist.id) || -1,
            artistMbid: String(artist.mbid || artistId),
            artistIdNum: Number(artist.id) || null,
            artistName: (artist as any).name ?? null,
        }) as any[] : [];
        const musicBrainzReleaseGroups = includeReleaseGroups && artist.mbid
            ? db.prepare(`
         SELECT
           rg.*,
           COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
           COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
           COALESCE(stereo.quality, spatial.quality) AS selected_quality,
           stereo.selected_provider AS stereo_provider,
           stereo.selected_provider_id AS stereo_provider_id,
           stereo.selected_release_mbid AS stereo_release_mbid,
           stereo.quality AS stereo_quality,
           stereo.match_status AS stereo_match_status,
           stereo.match_method AS stereo_match_method,
           stereo.cover AS stereo_cover,
           stereo.monitored_lock AS stereo_monitor_lock,
           spatial.selected_provider AS spatial_provider,
           spatial.selected_provider_id AS spatial_provider_id,
           spatial.selected_release_mbid AS spatial_release_mbid,
           spatial.quality AS spatial_quality,
           spatial.match_status AS spatial_match_status,
           spatial.match_method AS spatial_match_method,
           spatial.cover AS spatial_cover,
           spatial.monitored_lock AS spatial_monitor_lock,
           album_offer.asset_id AS provider_asset_id,
           album_offer.cover AS provider_cover,
           CASE
             WHEN stereo.id IS NULL AND spatial.id IS NULL THEN 0
             WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1
             ELSE 0
           END AS wanted,
           rg.images
         FROM Albums rg
         LEFT JOIN ReleaseGroupSlots stereo
           ON stereo.release_group_mbid = rg.mbid
          AND stereo.slot = 'stereo'
         LEFT JOIN ReleaseGroupSlots spatial
           ON spatial.release_group_mbid = rg.mbid
          AND spatial.slot = 'spatial'
         -- Selected provider album offer supplies the artwork fallback
         -- (asset_id/cover) when the slot has no cached cover yet.
         LEFT JOIN ProviderItems album_offer
           ON album_offer.entity_type = 'album'
          AND album_offer.provider = COALESCE(stereo.selected_provider, spatial.selected_provider)
          AND CAST(album_offer.provider_id AS TEXT) = CAST(COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS TEXT)
         -- OR rg.mbid IN (subquery), instead of OR EXISTS(...), keeps both
         -- branches index-searchable so SQLite OR-optimizes rather than
         -- scanning Albums.
         WHERE rg.artist_mbid = ?
            OR rg.mbid IN (
              SELECT scope.release_group_mbid
              FROM ArtistReleaseGroups scope
              WHERE scope.artist_mbid = ?
            )
         ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date DESC, rg.title ASC
       `).all(artist.mbid, artist.mbid) as any[]
            : [];

        // Similar artists were a provider-exclusive feature (TIDAL's getSimilarArtists);
        // MusicBrainz/Servarr Metadata Server has no similar-artist concept and Lidarr has no such
        // section, so the feature was removed during the provider-table retirement.

        const topTracks = includeTracks ? db.prepare(`
      -- Rank cheaply, materialize the <=100 survivors, then enrich the whole
      -- set through indexed joins. Correlated provider/file lookups here used
      -- to execute once per survivor and could still stall an artist page for
      -- minutes even after the initial LIMIT.
      WITH artist_rgs(mbid) AS (
        SELECT mbid FROM Albums WHERE artist_mbid = ?
        UNION
        SELECT release_group_mbid FROM ArtistReleaseGroups WHERE artist_mbid = ?
      ),
      artist_releases(mbid) AS (
        SELECT ar.mbid
        FROM AlbumReleases ar
        JOIN artist_rgs ON ar.release_group_mbid = artist_rgs.mbid
      ),
      dedup AS (
        SELECT
          track.mbid AS track_mbid,
          COALESCE(rel.date, rg.first_release_date) AS release_date,
          COALESCE(am.popularity, 0) AS popularity,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(track.recording_mbid, track.mbid)
            ORDER BY
              COALESCE(rel.date, rg.first_release_date) ASC,
              track.mbid ASC
          ) AS recording_rank
        FROM Tracks track
        JOIN AlbumReleases rel ON rel.mbid = track.release_mbid
        JOIN Albums rg ON rg.mbid = rel.release_group_mbid
        LEFT JOIN ArtistMetadata am ON am.mbid = rg.artist_mbid
        WHERE track.release_mbid IN (SELECT mbid FROM artist_releases)
      ),
      top AS (
        SELECT track_mbid, release_date, popularity
        FROM dedup
        WHERE recording_rank = 1
        ORDER BY popularity DESC, release_date DESC, track_mbid ASC
        LIMIT 100
      ),
      top_tracks AS MATERIALIZED (
        SELECT
          top.popularity,
          track.mbid AS id,
          track.id AS track_row_id,
          track.title,
          track.length_ms,
          track.position,
          track.medium_position,
          track.recording_mbid,
          track.release_mbid,
          track.updated_at,
          release.date AS release_date,
          release_group.mbid AS release_group_mbid,
          release_group.title AS release_group_title,
          release_group.first_release_date,
          artist_metadata.name AS artist_name,
          artist_metadata.mbid AS artist_mbid,
          recording.length_ms AS recording_length_ms,
          recording.id AS recording_row_id,
          recording.credits AS recording_credits
        FROM top
        JOIN Tracks track ON track.mbid = top.track_mbid
        JOIN AlbumReleases release ON release.mbid = track.release_mbid
        JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
        LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.mbid = release_group.artist_mbid
        LEFT JOIN Recordings recording ON recording.mbid = track.recording_mbid
      ),
      provider_track_candidate_ids(track_id, provider_rowid) AS MATERIALIZED (
        SELECT top_tracks.id, provider_item.rowid
        FROM top_tracks
        CROSS JOIN ProviderItems provider_item INDEXED BY idx_provider_items_recording_id
        WHERE top_tracks.recording_row_id IS NOT NULL
          AND provider_item.recording_id = top_tracks.recording_row_id
          AND provider_item.entity_type = 'track'
      ),
      provider_tracks AS (
        SELECT
          candidates.track_id,
          provider_item.provider,
          provider_item.provider_id,
          provider_item.duration,
          provider_item.explicit,
          provider_item.quality,
          ROW_NUMBER() OVER (
            PARTITION BY candidates.track_id
            ORDER BY
              CASE provider_item.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
              provider_item.updated_at DESC,
              provider_item.provider_id ASC
          ) AS rank
        FROM provider_track_candidate_ids candidates
        CROSS JOIN ProviderItems provider_item
        WHERE provider_item.rowid = candidates.provider_rowid
      ),
      provider_albums AS (
        SELECT
          top_tracks.id AS track_id,
          provider_item.asset_id,
          ROW_NUMBER() OVER (
            PARTITION BY top_tracks.id
            ORDER BY
              CASE provider_item.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
              provider_item.updated_at DESC,
              provider_item.provider_id ASC
          ) AS rank
        FROM top_tracks
        JOIN ProviderItems provider_item
          ON provider_item.entity_type = 'album'
         AND provider_item.release_group_mbid = top_tracks.release_group_mbid
      ),
      selected_slots AS (
        SELECT
          top_tracks.id AS track_id,
          slot.quality,
          slot.monitored_lock,
          ROW_NUMBER() OVER (
            PARTITION BY top_tracks.id
            ORDER BY CASE slot.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
          ) AS rank
        FROM top_tracks
        JOIN ReleaseGroupSlots slot
          ON slot.release_group_mbid = top_tracks.release_group_mbid
         AND slot.selected_release_mbid = top_tracks.release_mbid
      ),
      primary_files AS (
        SELECT
          top_tracks.id AS track_id,
          file.quality,
          ROW_NUMBER() OVER (
            PARTITION BY top_tracks.id
            ORDER BY CASE file.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END, file.id ASC
          ) AS rank
        FROM top_tracks
        CROSS JOIN TrackFiles file INDEXED BY idx_track_files_canonical_track_type
        WHERE file.canonical_track_mbid = top_tracks.id
          AND file.file_type = 'track'
      ),
      quality_values(track_id, quality) AS (
        SELECT top_tracks.id, slot.quality
        FROM top_tracks
        JOIN ReleaseGroupSlots slot
          ON slot.release_group_mbid = top_tracks.release_group_mbid
         AND slot.selected_release_mbid = top_tracks.release_mbid
        WHERE slot.quality IS NOT NULL AND TRIM(slot.quality) != ''
        UNION
        SELECT candidates.track_id, provider_item.quality
        FROM provider_track_candidate_ids candidates
        CROSS JOIN ProviderItems provider_item
        WHERE provider_item.quality IS NOT NULL AND TRIM(provider_item.quality) != ''
          AND provider_item.rowid = candidates.provider_rowid
        UNION
        SELECT top_tracks.id, file.quality
        FROM top_tracks
        CROSS JOIN TrackFiles file INDEXED BY idx_track_files_canonical_track_type
        WHERE file.canonical_track_mbid = top_tracks.id
          AND file.quality IS NOT NULL AND TRIM(file.quality) != ''
      ),
      quality_tags AS (
        SELECT track_id, GROUP_CONCAT(quality) AS tags
        FROM quality_values
        GROUP BY track_id
      ),
      monitored_groups AS (
        SELECT DISTINCT top_tracks.release_group_mbid
        FROM top_tracks
        JOIN ReleaseGroupSlots slot
          ON slot.release_group_mbid = top_tracks.release_group_mbid
         AND slot.monitored = 1
      ),
      downloaded_tracks(track_id) AS (
        SELECT DISTINCT top_tracks.id
        FROM top_tracks
        CROSS JOIN TrackFiles file INDEXED BY idx_track_files_canonical_track_type
        WHERE file.file_type = 'track'
          AND file.canonical_track_mbid = top_tracks.id
        UNION
        SELECT DISTINCT top_tracks.id
        FROM top_tracks
        CROSS JOIN TrackFiles file INDEXED BY idx_track_files_canonical_recording_type
        WHERE top_tracks.recording_mbid IS NOT NULL
          AND file.file_type = 'track'
          AND file.canonical_recording_mbid = top_tracks.recording_mbid
      )
      SELECT
        top_tracks.id,
        top_tracks.release_group_mbid AS album_id,
        top_tracks.title,
        NULL AS version,
        COALESCE(
          ROUND(COALESCE(top_tracks.length_ms, top_tracks.recording_length_ms, provider_track.duration, 0) / 1000.0),
          0
        ) AS duration,
        top_tracks.position AS track_number,
        top_tracks.medium_position AS volume_number,
        COALESCE(provider_track.explicit, 0) AS explicit,
        COALESCE(provider_track.quality, selected_slot.quality, primary_file.quality, '') AS quality,
        quality_tags.tags AS quality_tags,
        CASE WHEN monitored_groups.release_group_mbid IS NOT NULL THEN 1 ELSE 0 END AS is_monitored,
        COALESCE(selected_slot.monitored_lock, 0) AS monitored_lock,
        top_tracks.popularity AS popularity,
        top_tracks.release_group_title AS album_title,
        provider_album.asset_id AS album_cover,
        top_tracks.artist_name,
        top_tracks.artist_mbid AS artist_id,
        top_tracks.recording_credits,
        COALESCE(top_tracks.release_date, top_tracks.first_release_date) AS release_date,
        top_tracks.updated_at AS last_scanned,
        top_tracks.updated_at AS created_at,
        top_tracks.updated_at AS updated_at,
        provider_track.provider AS preview_provider,
        provider_track.provider_id AS preview_provider_track_id,
        top_tracks.id AS musicbrainz_track_id,
        top_tracks.recording_mbid AS musicbrainz_recording_id,
        top_tracks.release_mbid AS musicbrainz_release_id,
        CASE WHEN downloaded_tracks.track_id IS NOT NULL THEN 1 ELSE 0 END AS is_downloaded
      FROM top_tracks
      LEFT JOIN provider_tracks provider_track ON provider_track.track_id = top_tracks.id AND provider_track.rank = 1
      LEFT JOIN provider_albums provider_album ON provider_album.track_id = top_tracks.id AND provider_album.rank = 1
      LEFT JOIN selected_slots selected_slot ON selected_slot.track_id = top_tracks.id AND selected_slot.rank = 1
      LEFT JOIN primary_files primary_file ON primary_file.track_id = top_tracks.id AND primary_file.rank = 1
      LEFT JOIN quality_tags ON quality_tags.track_id = top_tracks.id
      LEFT JOIN monitored_groups ON monitored_groups.release_group_mbid = top_tracks.release_group_mbid
      LEFT JOIN downloaded_tracks ON downloaded_tracks.track_id = top_tracks.id
      ORDER BY popularity DESC, release_date DESC, id ASC
    `).all(String(artist.mbid || artistId), String(artist.mbid || artistId)) as any[] : [];

        const releaseGroupDownloadStats = getReleaseGroupDownloadStatsMap(musicBrainzReleaseGroups.map((album) => album.mbid));
        const artistDownloadStats = includeStatistics
            ? getArtistDownloadStats(artistId)
            : { downloadedPercent: 0, isDownloaded: false };

        const modules: Record<string, any[]> = {
            ARTIST_ALBUMS: [],
            ARTIST_EPS: [],
            ARTIST_SINGLES: [],
            ARTIST_COMPILATIONS: [],
            ARTIST_APPEARS_ON: [],
            ARTIST_LIVE_ALBUMS: [],
            ARTIST_REMIXES: [],
            ARTIST_SOUNDTRACKS: [],
            ARTIST_DEMOS: [],
            ARTIST_DJ_MIXES: [],
            ARTIST_MIXTAPES: [],
            ARTIST_BROADCASTS: [],
            ARTIST_OTHER_RELEASES: [],
        };

        // Exclude raw provider albums from modules to restrict discography entirely to MusicBrainz release groups.

        const includeSpatial = getConfigSection("filtering").include_spatial === true;
        const releaseGroupCards = musicBrainzReleaseGroups.map((row) => mapReleaseGroupCardForArtistPage(row, {
            artistId: String(artist.id),
            artistName: String(artist.name || "Unknown Artist"),
            includeSpatial,
            downloadStats: releaseGroupDownloadStats.get(String(row.mbid)),
        }));

        for (const releaseGroup of releaseGroupCards) {
            const bucket = RELEASE_GROUP_BUCKETS[releaseGroup.module as keyof typeof RELEASE_GROUP_BUCKETS] || "ARTIST_ALBUMS";
            modules[bucket].push(releaseGroup);
        }

        const hydratedTopTracks = mergeTopTrackRows(hydrateTrackRows(topTracks).map((track, index) => {
            const sourceTrack = topTracks[index];

            return {
                ...track,
                qualityTags: mergeQualityTags(track.qualityTags, sourceTrack?.quality_tags, sourceTrack?.quality),
                album: {
                    id: track.album_id == null ? null : String(track.album_id),
                    title: sourceTrack?.album_title || null,
                    cover_id: sourceTrack?.album_cover || null,
                },
            };
        }));

        const rows: any[] = [];

        const pushAlbumModule = (title: string, items: any[], type = "ALBUM") => {
            if (items.length === 0) return;
            rows.push({ modules: [{ type, title, items }] });
        };

        if (topTracks.length > 0) {
            rows.push({
                modules: [{
                    type: "TRACK_LIST",
                    title: "Top Tracks",
                    items: hydratedTopTracks,
                }],
            });
        }

        pushAlbumModule("Albums", modules.ARTIST_ALBUMS, "ALBUM");
        pushAlbumModule("EPs", modules.ARTIST_EPS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "EP");
        pushAlbumModule("Singles", modules.ARTIST_SINGLES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "SINGLE");
        pushAlbumModule("Live Albums", modules.ARTIST_LIVE_ALBUMS, "LIVE");
        pushAlbumModule("Compilations", modules.ARTIST_COMPILATIONS, "COMPILATION");
        pushAlbumModule("Soundtracks", modules.ARTIST_SOUNDTRACKS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "SOUNDTRACK");
        pushAlbumModule("Remixes", modules.ARTIST_REMIXES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "REMIX");
        pushAlbumModule("DJ Mixes", modules.ARTIST_DJ_MIXES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "DJ_MIX");
        pushAlbumModule("Mixtapes", modules.ARTIST_MIXTAPES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "MIXTAPE");
        pushAlbumModule("Demos", modules.ARTIST_DEMOS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "DEMO");
        pushAlbumModule("Broadcasts", modules.ARTIST_BROADCASTS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "BROADCAST");
        pushAlbumModule("Other Releases", modules.ARTIST_OTHER_RELEASES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "OTHER");
        pushAlbumModule("Appears On", modules.ARTIST_APPEARS_ON, "APPEARS_ON");

        if (videos.length > 0) {
            rows.push({
                modules: [{
                    type: "VIDEO_LIST",
                    title: "Videos",
                    items: videos.map((video) => {
                        const coverArtUrl = videoCoverLocalUrl(video.id) ?? video.cover_art_url ?? null;
                        return {
                            ...video,
                            cover_id: video.cover || null,
                            cover_art_url: coverArtUrl,
                            quality: video.quality || "MP4_1080P",
                            monitored_lock: Boolean(video.monitored_lock),
                            is_monitored: Boolean(video.monitored),
                            downloaded: video.is_downloaded ? 1 : 0,
                            is_downloaded: Boolean(video.is_downloaded),
                        };
                    }),
                }],
            });
        }

        const bio = artist.bio_text || null;
        const artistFiles = LibraryFilesService.resolveExistingFiles(db.prepare(`
      SELECT id AS id,
        COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
        file_type AS file_type,
        file_path AS file_path,
        relative_path AS relative_path,
        NULL AS filename,
        extension AS extension,
        NULL AS quality,
        library_root AS library_root,
        NULL AS file_size,
        NULL AS bitrate,
        NULL AS sample_rate,
        NULL AS bit_depth,
        NULL AS codec,
        NULL AS duration
      FROM MetadataFiles
      WHERE artist_id = ?
        AND canonical_release_group_mbid IS NULL
        AND canonical_release_mbid IS NULL
        AND canonical_track_mbid IS NULL
        AND canonical_recording_mbid IS NULL
        AND file_type IN ('cover', 'bio')

      UNION ALL

      SELECT id AS id,
        COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
        file_type AS file_type,
        file_path AS file_path,
        relative_path AS relative_path,
        NULL AS filename,
        extension AS extension,
        NULL AS quality,
        library_root AS library_root,
        NULL AS file_size,
        NULL AS bitrate,
        NULL AS sample_rate,
        NULL AS bit_depth,
        NULL AS codec,
        NULL AS duration
      FROM ExtraFiles
      WHERE artist_id = ?
        AND canonical_release_group_mbid IS NULL
        AND canonical_release_mbid IS NULL
        AND canonical_track_mbid IS NULL
        AND canonical_recording_mbid IS NULL
        AND file_type IN ('cover', 'bio')
      ORDER BY file_type ASC, id ASC
    `).all(artistId, artistId) as any[]);

        return {
            artist: {
                ...artist,
                picture: artistArtworkUrl(artist.mbid, artist.picture, artist.cover_image_url),
                cover_image_url: artistArtworkUrl(artist.mbid, artist.cover_image_url),
                bio,
                files: artistFiles,
                downloaded: artistDownloadStats.downloadedPercent,
                is_monitored: Boolean(artist.effective_monitor),
                is_downloaded: artistDownloadStats.isDownloaded,
            },
            rows,
            needs_scan: !artist.last_scanned || needsEnrichment,
            album_count: releaseGroupCards.length,
            monitored_album_count: releaseGroupCards.filter((album) => album.is_monitored).length,
        };
    }
}
