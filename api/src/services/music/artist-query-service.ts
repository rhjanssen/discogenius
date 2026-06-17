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
import { ScanLevel } from "./scan-types.js";
import { shouldRefreshArtist } from "../config/refresh-policy.js";
import type { ArtistContract, ArtistsListResponseContract } from "../../contracts/catalog.js";
import {
    albumProviderArtworkCandidatesFromRow,
    chooseCachedAlbumArtwork,
    chooseCachedProviderArtwork,
    parseJsonObject,
    registerMediaCoverProxyUrl,
    resolveMediaCoverProxyUrl,
} from "../metadata/media-cover-service.js";
import { getConfigSection } from "../config/config.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");

function proxyArtistArtworkUrl(...values: unknown[]): string | null {
    for (const value of values) {
        const text = value == null ? "" : String(value).trim();
        if (!text) {
            continue;
        }

        const resolved = resolveMediaCoverProxyUrl(text);
        if (resolved) {
            return registerMediaCoverProxyUrl(resolved) || resolved;
        }

        if (/^\/MediaCoverProxy\//i.test(text)) {
            continue;
        }

        return registerMediaCoverProxyUrl(text) || text;
    }

    return null;
}

export interface ArtistListQuery {
    limit: number;
    offset: number;
    search?: string;
    sort?: string;
    dir?: string;
    monitored?: boolean;
    includeDownloadStats?: boolean;
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
    if (artistMbids.length === 0) {
        return new Map();
    }

    const placeholders = artistMbids.map(() => "?").join(",");
    const rows = db.prepare(`
        SELECT
            scope.artist_mbid AS artist_id,
            COUNT(DISTINCT scope.release_group_mbid) AS cnt,
            COUNT(DISTINCT CASE
                WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1
                THEN scope.release_group_mbid
                ELSE NULL
            END) AS monitored_cnt
        FROM (
            SELECT artist_mbid, mbid AS release_group_mbid FROM Albums
            UNION
            SELECT artist_mbid, release_group_mbid FROM ArtistReleaseGroups
        ) scope
        LEFT JOIN ReleaseGroupSlots stereo
          ON stereo.release_group_mbid = scope.release_group_mbid
         AND stereo.slot = 'stereo'
        LEFT JOIN ReleaseGroupSlots spatial
          ON spatial.release_group_mbid = scope.release_group_mbid
         AND spatial.slot = 'spatial'
        WHERE scope.artist_mbid IN (${placeholders})
        GROUP BY scope.artist_mbid
    `).all(...artistMbids) as ArtistCountRow[];

    return new Map(rows.map((row) => [String(row.artist_id), row]));
}

function buildArtistTrackCountMap(artistMbids: string[]): Map<string, ArtistCountRow> {
    if (artistMbids.length === 0) {
        return new Map();
    }

    const placeholders = artistMbids.map(() => "?").join(",");
    const rows = db.prepare(`
        SELECT
            scope.artist_mbid AS artist_id,
            COUNT(DISTINCT track.mbid) AS cnt,
            COUNT(DISTINCT CASE
                WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1
                THEN track.mbid
                ELSE NULL
            END) AS monitored_cnt
        FROM (
            SELECT artist_mbid, mbid AS release_group_mbid FROM Albums
            UNION
            SELECT artist_mbid, release_group_mbid FROM ArtistReleaseGroups
        ) scope
        JOIN AlbumReleases release
          ON release.release_group_mbid = scope.release_group_mbid
        JOIN Tracks track
          ON track.release_mbid = release.mbid
        LEFT JOIN ReleaseGroupSlots stereo
          ON stereo.release_group_mbid = scope.release_group_mbid
         AND stereo.slot = 'stereo'
        LEFT JOIN ReleaseGroupSlots spatial
          ON spatial.release_group_mbid = scope.release_group_mbid
         AND spatial.slot = 'spatial'
        WHERE scope.artist_mbid IN (${placeholders})
        GROUP BY scope.artist_mbid
    `).all(...artistMbids) as ArtistCountRow[];

    return new Map(rows.map((row) => [String(row.artist_id), row]));
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
    return !proxyArtistArtworkUrl(artist.picture, artist.cover_image_url);
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

    if (RefreshArtistService.getScanLevel(artistId) < ScanLevel.DEEP) {
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

function parseSelectedProviderData(row: Record<string, any>): { cover?: string | null; explicit?: boolean | number | null } | null {
    const raw = row.stereo_provider_data || row.spatial_provider_data;
    if (!raw) return null;
    try {
        return (typeof raw === "string" ? JSON.parse(raw) : raw) as { cover?: string | null; explicit?: boolean | number | null };
    } catch {
        return null;
    }
}

function mapReleaseGroupCard(row: Record<string, any>, options: {
    artistId: string;
    artistName: string;
    includeSpatial: boolean;
    downloadStats?: { downloadedPercent?: number; isDownloaded?: boolean };
}): any {
    const bucketKey = releaseGroupBucket(row);
    const primaryType = normalizeReleaseGroupPrimaryType(row.primary_type);
    const selectedProviderData = parseSelectedProviderData(row);
    const providerCandidates = albumProviderArtworkCandidatesFromRow(row);
    const providerCover = chooseCachedProviderArtwork(providerCandidates, "album")
        || selectedProviderData?.cover
        || null;
    const coverUrl = chooseCachedAlbumArtwork({
        albumMbid: row.mbid,
        skyHookData: parseJsonObject(row.data),
        providerCandidates,
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
        explicit: Boolean(selectedProviderData?.explicit),
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
        const artistMbids = artists.map((artist) => String(artist.mbid || "")).filter(Boolean);
        const albumCountsByArtistMbid = buildArtistReleaseGroupCountMap(artistMbids);
        const trackCountsByArtistMbid = buildArtistTrackCountMap(artistMbids);
        const artistDownloadStats = includeDownloadStats
            ? getArtistDownloadStatsMap(artistIds)
            : null;

        return {
            items: artists.map((artist) => {
                const artistId = String(artist.id);
                const artistMbid = String(artist.mbid || "");
                const albumCounts = artistMbid ? albumCountsByArtistMbid.get(artistMbid) : undefined;
                const trackCounts = artistMbid ? trackCountsByArtistMbid.get(artistMbid) : undefined;
                const resolvedArtistPicture = proxyArtistArtworkUrl(artist.picture, artist.cover_image_url);

                return {
                    ...artist,
                    picture: resolvedArtistPicture,
                    cover_image_url: proxyArtistArtworkUrl(artist.cover_image_url),
                    album_count: Number(albumCounts?.cnt || 0),
                    monitored_album_count: Number(albumCounts?.monitored_cnt || 0),
                    track_count: Number(trackCounts?.cnt || 0),
                    monitored_track_count: Number(trackCounts?.monitored_cnt || 0),
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
                await RefreshArtistService.scanBasic(artistId, { includeSimilarArtists: false, seedSimilarArtists: false });
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
            picture: proxyArtistArtworkUrl(artist.picture, artist.cover_image_url),
            cover_image_url: proxyArtistArtworkUrl(artist.cover_image_url),
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
        stereo.provider_data AS stereo_provider_data,
        stereo.monitored_lock AS stereo_monitor_lock,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.selected_release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        spatial.match_method AS spatial_match_method,
        spatial.provider_data AS spatial_provider_data,
        spatial.monitored_lock AS spatial_monitor_lock,
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
      SELECT id, type, status, ref_id, created_at, started_at
      FROM job_queue
      WHERE ref_id = ? AND status IN ('pending', 'processing')
    `).all(artistId) as any[];

        const releaseGroupJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
      INNER JOIN Albums rg
        ON rg.mbid = jq.ref_id
        OR rg.mbid = json_extract(jq.payload, '$.releaseGroupMbid')
      WHERE rg.artist_mbid = ?
        AND jq.type IN ('RefreshAlbum', 'ScanAlbum', 'DownloadAlbum', 'ImportDownload')
        AND jq.status IN ('pending', 'processing')
    `).all(artistMbid) as any[];

        const trackDownloadJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
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
        AND jq.type IN ('DownloadTrack', 'ImportDownload')
        AND jq.status IN ('pending', 'processing')
    `).all(artistMbid) as any[];

        const videoDownloadJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
      INNER JOIN Recordings recording
        ON CAST(recording.id AS TEXT) = CAST(jq.ref_id AS TEXT)
        OR CAST(recording.id AS TEXT) = CAST(json_extract(jq.payload, '$.canonicalRecordingId') AS TEXT)
        OR recording.mbid = json_extract(jq.payload, '$.canonicalRecordingMbid')
      WHERE recording.is_video = 1
        AND (
          recording.artist_mbid = ?
          OR CAST(recording.artist_metadata_id AS TEXT) = CAST(? AS TEXT)
        )
        AND jq.type IN ('DownloadVideo', 'ImportDownload')
        AND jq.status IN ('pending', 'processing')
    `).all(artistMbid, artist?.id ? String(artist.id) : artistId) as any[];

        const libraryRescanJob = db.prepare(`
      SELECT id, type, status, ref_id, created_at, started_at
      FROM job_queue
      WHERE type = 'RescanFolders'
        AND json_extract(payload, '$.addNewArtists') = 1
        AND status IN ('pending', 'processing')
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
            scanning: jobs.some((job) => job.type === "RefreshArtist" || job.type === "RefreshAlbum" || job.type === "ScanAlbum"),
            curating: jobs.some((job) => job.type === "CurateArtist"),
            downloading: jobs.some((job) => job.type.startsWith("Download") || job.type === "ImportDownload"),
            libraryScan: jobs.some((job) => job.type === "RescanFolders"),
            totalActive: jobs.length,
            jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status })),
        };
    }

    static async getArtistDetail(id: string): Promise<any | null> {
        let existing = loadArtistWithEffectiveMonitor(id);

        if (!existing) {
            try {
                await RefreshArtistService.scanBasic(id, { includeSimilarArtists: false, seedSimilarArtists: false });
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

    static async getRemoteArtistPage(artistId: string): Promise<any> {
        const page = await this.getArtistPageDb(artistId);
        if (!page) {
            throw new Error(`Artist not found: ${artistId}`);
        }
        return page;
    }

    static async getArtistPageDb(artistId: string): Promise<any | null> {
        let artist = loadArtistWithEffectiveMonitor(artistId);

        // Cold-load: seed basic canonical metadata for not-yet-added artists so
        // search-result navigation works.  Existing artists are returned as-is;
        // staleness refresh is the scheduler's job.
        if (!artist) {
            try {
                await RefreshArtistService.scanBasic(artistId, { includeSimilarArtists: false, seedSimilarArtists: false });
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
        if (artist.mbid) {
            RefreshArtistService.syncProviderSelectionsFromStoredOffers(String(artist.mbid));
        }
        const needsEnrichment = shouldHydrateArtistPage(artist, artistId);

        const videos = db.prepare(`
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
           CAST(COALESCE(recording.artist_metadata_id, artist_metadata.id) AS TEXT) AS artist_id,
           artist_metadata.name AS artist_name,
           COALESCE(recording.monitored, 0) AS monitored,
           COALESCE(recording.monitored_lock, 0) AS monitored_lock,
           recording.updated_at AS last_scanned,
           CASE WHEN EXISTS (
             SELECT 1
             FROM TrackFiles lf
             WHERE lf.file_type = 'video'
               AND (
                 lf.media_id = recording.id
                 OR lf.canonical_recording_mbid = recording.mbid
                 OR CAST(lf.provider_id AS TEXT) = CAST(provider_item.provider_id AS TEXT)
               )
           ) THEN 1 ELSE 0 END AS is_downloaded
         FROM Recordings recording
         LEFT JOIN ArtistMetadata artist_metadata
           ON artist_metadata.id = recording.artist_metadata_id
          OR (recording.artist_mbid IS NOT NULL AND artist_metadata.mbid = recording.artist_mbid)
         LEFT JOIN ProviderItems provider_item
           ON provider_item.rowid = (
             SELECT candidate.rowid
             FROM ProviderItems candidate
             WHERE candidate.entity_type = 'video'
               AND (
                 candidate.recording_id = recording.id
                 OR (recording.mbid IS NOT NULL AND candidate.recording_mbid = recording.mbid)
               )
             ORDER BY COALESCE(candidate.match_confidence, 0) DESC, candidate.updated_at DESC, candidate.provider_id ASC
             LIMIT 1
           )
         WHERE recording.is_video = 1
           AND (
             CAST(recording.artist_metadata_id AS TEXT) = ?
             OR recording.artist_mbid = ?
             OR artist_metadata.mbid = ?
           )
         ORDER BY (COALESCE(recording.release_date, provider_item.release_date) IS NULL) ASC, COALESCE(recording.release_date, provider_item.release_date) DESC, recording.title ASC, recording.id ASC
       `).all(String(artist.id), String(artist.mbid || artistId), String(artist.mbid || artistId)) as any[];
        const musicBrainzReleaseGroups = artist.mbid
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
           stereo.provider_data AS stereo_provider_data,
           stereo.monitored_lock AS stereo_monitor_lock,
           spatial.selected_provider AS spatial_provider,
           spatial.selected_provider_id AS spatial_provider_id,
           spatial.selected_release_mbid AS spatial_release_mbid,
           spatial.quality AS spatial_quality,
           spatial.match_status AS spatial_match_status,
           spatial.match_method AS spatial_match_method,
           spatial.provider_data AS spatial_provider_data,
           spatial.monitored_lock AS spatial_monitor_lock,
           CASE
             WHEN stereo.id IS NULL AND spatial.id IS NULL THEN 0
             WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1
             ELSE 0
           END AS wanted,
           rg.data
         FROM Albums rg
         LEFT JOIN ReleaseGroupSlots stereo
           ON stereo.release_group_mbid = rg.mbid
          AND stereo.slot = 'stereo'
         LEFT JOIN ReleaseGroupSlots spatial
           ON spatial.release_group_mbid = rg.mbid
          AND spatial.slot = 'spatial'
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

        let similarArtists: any[] = [];
        try {
            const similarRows = db.prepare(`
        SELECT
          a.mbid as id,
          a.name,
          a.picture,
          COALESCE(a.popularity, 0) as popularity
        FROM ProviderSimilarArtists sa
        JOIN ArtistMetadata a ON sa.similar_artist_id = a.mbid
        WHERE sa.artist_id = ?
        ORDER BY COALESCE(a.popularity, 0) DESC, sa.created_at ASC, a.mbid ASC
        LIMIT 10
      `).all(artist.mbid || artistId) as any[];

            similarArtists = similarRows.map((row) => ({
                id: row.id,
                name: row.name,
                picture: row.picture,
                popularity: row.popularity || 0,
            }));
        } catch {
            similarArtists = [];
        }

        const topTracks = db.prepare(`
      -- Drive from the artist's release groups (a small, indexed set) instead of
      -- scanning all Tracks: the old "WHERE release_group.artist_mbid = ? OR
      -- EXISTS(...)" forced a full Tracks scan (~750k rows) with per-row
      -- correlated subqueries — ~58s on a large library. Restricting
      -- track.release_mbid to the artist's releases uses the release index.
      WITH artist_rgs(mbid) AS (
        SELECT mbid FROM Albums WHERE artist_mbid = ?
        UNION
        SELECT release_group_mbid FROM ArtistReleaseGroups WHERE artist_mbid = ?
      ),
      artist_releases(mbid) AS (
        SELECT ar.mbid
        FROM AlbumReleases ar
        JOIN artist_rgs ON ar.release_group_mbid = artist_rgs.mbid
      )
      SELECT
        track.mbid AS id,
        release_group.mbid AS album_id,
        track.title,
        NULL AS version,
        COALESCE(
          ROUND(COALESCE(track.length_ms, recording.length_ms, provider_track.duration, 0) / 1000.0),
          0
        ) AS duration,
        track.position AS track_number,
        track.medium_position AS volume_number,
        COALESCE(provider_track.explicit, 0) AS explicit,
        COALESCE(provider_track.quality, selected_slot.quality, primary_file.quality, '') AS quality,
        CASE WHEN EXISTS (
          SELECT 1
          FROM ReleaseGroupSlots monitored_slot
          WHERE monitored_slot.release_group_mbid = release_group.mbid
            AND monitored_slot.monitored = 1
        ) THEN 1 ELSE 0 END AS monitor,
        COALESCE(selected_slot.monitored_lock, 0) AS monitor_lock,
        COALESCE(artist_metadata.popularity, 0) AS popularity,
        release_group.title AS album_title,
        provider_album.asset_id AS album_cover,
        artist_metadata.name AS artist_name,
        artist_metadata.mbid AS artist_id,
        COALESCE(release.date, release_group.first_release_date) AS release_date,
        track.updated_at AS last_scanned,
        track.updated_at AS created_at,
        track.updated_at AS updated_at,
        recording.data AS recording_data,
        provider_track.provider AS preview_provider,
        provider_track.provider_id AS preview_provider_track_id,
        track.mbid AS musicbrainz_track_id,
        track.recording_mbid AS musicbrainz_recording_id,
        track.release_mbid AS musicbrainz_release_id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM TrackFiles downloaded_file
          WHERE downloaded_file.file_type = 'track'
            AND downloaded_file.canonical_track_mbid = track.mbid
        ) THEN 1 ELSE 0 END AS is_downloaded
      FROM Tracks track
      JOIN AlbumReleases release ON release.mbid = track.release_mbid
      JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
      LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.mbid = release_group.artist_mbid
      LEFT JOIN Recordings recording ON recording.mbid = track.recording_mbid
      LEFT JOIN ProviderItems provider_track
        ON provider_track.rowid = (
          SELECT preferred_provider_track.rowid
          FROM ProviderItems preferred_provider_track
          WHERE preferred_provider_track.entity_type = 'track'
            AND (
              preferred_provider_track.track_mbid = track.mbid
              OR preferred_provider_track.recording_mbid = track.recording_mbid
            )
          ORDER BY
            CASE preferred_provider_track.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
            preferred_provider_track.updated_at DESC,
            preferred_provider_track.provider_id ASC
          LIMIT 1
        )
      LEFT JOIN ProviderItems provider_album
        ON provider_album.rowid = (
          SELECT preferred_provider_album.rowid
          FROM ProviderItems preferred_provider_album
          WHERE preferred_provider_album.entity_type = 'album'
            AND preferred_provider_album.release_group_mbid = release_group.mbid
          ORDER BY
            CASE preferred_provider_album.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
            preferred_provider_album.updated_at DESC,
            preferred_provider_album.provider_id ASC
          LIMIT 1
        )
      LEFT JOIN ReleaseGroupSlots selected_slot
        ON selected_slot.release_group_mbid = release_group.mbid
       AND selected_slot.selected_release_mbid = track.release_mbid
       AND selected_slot.id = (
         SELECT preferred_slot.id
         FROM ReleaseGroupSlots preferred_slot
         WHERE preferred_slot.release_group_mbid = release_group.mbid
           AND preferred_slot.selected_release_mbid = track.release_mbid
         ORDER BY CASE preferred_slot.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
         LIMIT 1
       )
      LEFT JOIN TrackFiles primary_file
        ON primary_file.canonical_track_mbid = track.mbid
       AND primary_file.file_type = 'track'
       AND primary_file.id = (
         SELECT preferred_file.id
         FROM TrackFiles preferred_file
         WHERE preferred_file.canonical_track_mbid = track.mbid
           AND preferred_file.file_type = 'track'
         ORDER BY CASE preferred_file.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END, preferred_file.id ASC
         LIMIT 1
       )
      WHERE track.release_mbid IN (SELECT mbid FROM artist_releases)
      GROUP BY track.mbid
      ORDER BY popularity DESC, release_date DESC, track.mbid ASC
      LIMIT 24
    `).all(String(artist.mbid || artistId), String(artist.mbid || artistId)) as any[];

        const releaseGroupDownloadStats = getReleaseGroupDownloadStatsMap(musicBrainzReleaseGroups.map((album) => album.mbid));
        const artistDownloadStats = getArtistDownloadStats(artistId);

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
        const releaseGroupCards = musicBrainzReleaseGroups.map((row) => mapReleaseGroupCard(row, {
            artistId: String(artist.id),
            artistName: String(artist.name || "Unknown Artist"),
            includeSpatial,
            downloadStats: releaseGroupDownloadStats.get(String(row.mbid)),
        }));

        for (const releaseGroup of releaseGroupCards) {
            const bucket = RELEASE_GROUP_BUCKETS[releaseGroup.module as keyof typeof RELEASE_GROUP_BUCKETS] || "ARTIST_ALBUMS";
            modules[bucket].push(releaseGroup);
        }

        const hydratedTopTracks = hydrateTrackRows(topTracks).map((track, index) => {
            const sourceTrack = topTracks[index];

            return {
                ...track,
                album: {
                    id: track.album_id == null ? null : String(track.album_id),
                    title: sourceTrack?.album_title || null,
                    cover_id: sourceTrack?.album_cover || null,
                },
            };
        });

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
                    items: videos.map((video) => ({
                        ...video,
                        cover_id: video.cover || null,
                        quality: video.quality || "MP4_1080P",
                        monitored_lock: Boolean(video.monitored_lock),
                        is_monitored: Boolean(video.monitored),
                        downloaded: video.is_downloaded ? 1 : 0,
                        is_downloaded: Boolean(video.is_downloaded),
                    })),
                }],
            });
        }

        if (similarArtists.length > 0) {
            rows.push({
                modules: [{
                    type: "ARTIST_LIST",
                    title: "Similar Artists",
                    items: similarArtists,
                }],
            });
        }

        const bio = artist.bio_text || null;
        const artistFiles = LibraryFilesService.resolveExistingFiles(db.prepare(`
      SELECT id AS id,
        media_id AS media_id,
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
        AND album_id IS NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'bio')

      UNION ALL

      SELECT id AS id,
        media_id AS media_id,
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
        AND album_id IS NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'bio')
      ORDER BY file_type ASC, id ASC
    `).all(artistId, artistId) as any[]);

        return {
            artist: {
                ...artist,
                picture: proxyArtistArtworkUrl(artist.picture, artist.cover_image_url),
                cover_image_url: proxyArtistArtworkUrl(artist.cover_image_url),
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
