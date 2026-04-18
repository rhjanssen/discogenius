import { db } from "../database.js";
import { getArtist, getArtistPage } from "./tidal.js";
import {
    getAlbumDownloadStats,
    getAlbumDownloadStatsMap,
    getArtistDownloadStats,
    getArtistDownloadStatsMap,
    getMediaDownloadStateMap,
} from "./download-state.js";
import { hydrateTrackRows } from "./track-query-service.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { loadArtistWithEffectiveMonitor, type ArtistMonitorRow } from "./artist-monitoring.js";
import { LibraryFilesService } from "./library-files.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { ScanLevel } from "./scan-types.js";
import { shouldRefreshArtist } from "./refresh-policy.js";
import type { ArtistContract, ArtistsListResponseContract } from "../contracts/catalog.js";

const managedArtistPredicate = buildManagedArtistPredicate("a");

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

function buildArtistCountMap(
    table: "albums" | "media",
    artistIds: string[],
    options: { excludeMusicVideos?: boolean } = {},
): Map<string, ArtistCountRow> {
    if (artistIds.length === 0) {
        return new Map();
    }

    const placeholders = artistIds.map(() => "?").join(",");
    const whereClauses = [`artist_id IN (${placeholders})`];

    if (table === "media" && options.excludeMusicVideos) {
        whereClauses.push(`type != 'Music Video'`);
    }

    const rows = db.prepare(`
        SELECT
            CAST(artist_id AS TEXT) AS artist_id,
            COUNT(*) as cnt,
            SUM(CASE WHEN monitor = 1 THEN 1 ELSE 0 END) as monitored_cnt
        FROM ${table}
        WHERE ${whereClauses.join(" AND ")}
        GROUP BY artist_id
    `).all(...artistIds) as ArtistCountRow[];

    return new Map(rows.map((row) => [String(row.artist_id), row]));
}

function hasArtistIdentityGap(artist: ArtistMonitorRow): boolean {
    const artistName = String(artist.name ?? "").trim();
    return !artistName || artistName === "Unknown Artist" || artist.artist_types == null;
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
      FROM artists a
    `;
        let countQuery = "SELECT COUNT(*) as total FROM artists a";
        const params: Array<string | number> = [];
        const countParams: Array<string | number> = [];
        const where: string[] = [];

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
        const albumCountsByArtistId = buildArtistCountMap("albums", artistIds);
        const trackCountsByArtistId = buildArtistCountMap("media", artistIds, { excludeMusicVideos: true });
        const artistDownloadStats = includeDownloadStats
            ? getArtistDownloadStatsMap(artistIds)
            : null;

        return {
            items: artists.map((artist) => {
                const artistId = String(artist.id);
                const albumCounts = albumCountsByArtistId.get(artistId);
                const trackCounts = trackCountsByArtistId.get(artistId);

                return {
                    ...artist,
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

        // Cold-load: seed basic metadata from TIDAL for artists not yet in the DB
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

        const artistDownloadStats = getArtistDownloadStats(artistId);
        const biography = artist.bio_text == null
            ? (artist.biography == null ? null : String(artist.biography))
            : String(artist.bio_text);

        return {
            id: String(artist.id),
            name: artist.name ?? "Unknown Artist",
            picture: artist.picture == null ? null : String(artist.picture),
            cover_image_url: artist.cover_image_url == null ? null : String(artist.cover_image_url),
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
        const albums = db.prepare(`
      SELECT a.*, aa.type as relationship_type, aa.group_type as group_type
      FROM albums a
      JOIN album_artists aa ON a.id = aa.album_id
      WHERE aa.artist_id = ?
      ORDER BY a.release_date DESC
    `).all(artistId) as any[];
        const albumDownloadStats = getAlbumDownloadStatsMap(albums.map((album) => album.id));

        return albums.map((album) => ({
            ...album,
            type: album.group_type === "COMPILATIONS" ? "APPEARS_ON" : album.type,
            group_type: album.group_type || "ALBUMS",
            downloaded: albumDownloadStats.get(String(album.id))?.downloadedPercent ?? 0,
            is_monitored: Boolean(album.monitor),
            is_downloaded: albumDownloadStats.get(String(album.id))?.isDownloaded ?? false,
        }));
    }

    static getArtistActivity(artistId: string): ArtistActivitySnapshot {
        const directJobs = db.prepare(`
      SELECT id, type, status, ref_id, created_at, started_at
      FROM job_queue
      WHERE ref_id = ? AND status IN ('pending', 'processing')
    `).all(artistId) as any[];

        const albumJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
      INNER JOIN albums a ON a.id = jq.ref_id
      WHERE a.artist_id = ? AND jq.type IN ('RefreshAlbum', 'ScanAlbum') AND jq.status IN ('pending', 'processing')
    `).all(artistId) as any[];

        const albumDownloadJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
      INNER JOIN albums a ON a.id = jq.ref_id
      WHERE a.artist_id = ?
        AND jq.type IN ('DownloadAlbum', 'ImportDownload')
        AND jq.status IN ('pending', 'processing')
    `).all(artistId) as any[];

        const mediaDownloadJobs = db.prepare(`
      SELECT jq.id, jq.type, jq.status, jq.ref_id, jq.created_at, jq.started_at
      FROM job_queue jq
      INNER JOIN media m ON m.id = jq.ref_id
      WHERE m.artist_id = ?
        AND jq.type IN ('DownloadTrack', 'DownloadVideo', 'ImportDownload')
        AND jq.status IN ('pending', 'processing')
    `).all(artistId) as any[];

        const libraryRescanJob = db.prepare(`
      SELECT id, type, status, ref_id, created_at, started_at
      FROM job_queue
      WHERE type = 'RescanFolders'
        AND json_extract(payload, '$.addNewArtists') = 1
        AND status IN ('pending', 'processing')
      LIMIT 1
    `).get() as any | undefined;

        const allJobs = new Map<number, any>();
        for (const job of [...directJobs, ...albumJobs, ...albumDownloadJobs, ...mediaDownloadJobs]) {
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
      SELECT * FROM artists WHERE id = ?
    `).get(id) as any;

        if (!artist) {
            return null;
        }

        const albums = db.prepare(`
      SELECT * FROM albums
      WHERE artist_id = ?
      ORDER BY release_date DESC
    `).all(id) as any[];

        const grouped: Record<string, any[]> = {
            ARTIST_ALBUMS: [],
            ARTIST_EP: [],
            ARTIST_SINGLE: [],
            ARTIST_COMPILATIONS: [],
            ARTIST_LIVE_ALBUMS: [],
            ARTIST_APPEARS_ON: [],
        };

        for (const album of albums) {
            const derivedQuality = album.quality || "LOSSLESS";
            album.derived_quality = derivedQuality;

            let moduleName = album.module;
            if (!moduleName) {
                if (album.type === "SINGLE") moduleName = "ARTIST_SINGLE";
                else if (album.type === "EP") moduleName = "ARTIST_EP";
                else moduleName = "ARTIST_ALBUMS";
            }

            if (!grouped[moduleName]) {
                grouped[moduleName] = [];
            }
            grouped[moduleName].push(album);
        }

        return { artist, albums: grouped };
    }

    static async getRemoteArtistPage(artistId: string): Promise<any> {
        const [pageData, artistData] = await Promise.all([
            getArtistPage(artistId),
            getArtist(artistId),
        ]);

        return {
            ...pageData,
            artistInfo: {
                name: artistData.name,
                picture: artistData.picture,
                popularity: artistData.popularity,
                url: artistData.url,
            },
        };
    }

    static async getArtistPageDb(artistId: string): Promise<any | null> {
        let artist = loadArtistWithEffectiveMonitor(artistId);

        // Cold-load: seed basic TIDAL metadata for not-yet-added artists so
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
        const needsEnrichment = shouldHydrateArtistPage(artist, artistId);

        const albums = db.prepare(`
      SELECT 
        a.*,
        pa.name as artist_name,
        aa.type as relationship_type,
        aa.group_type as group_type,
        aa.module as aa_module
      FROM albums a
      LEFT JOIN artists pa ON pa.id = a.artist_id
      JOIN album_artists aa ON a.id = aa.album_id
      WHERE aa.artist_id = ?
      GROUP BY a.id
      ORDER BY a.release_date DESC
    `).all(artistId) as any[];

        const videos = db.prepare("SELECT * FROM media WHERE type = 'Music Video' AND artist_id = ? ORDER BY release_date DESC").all(artistId) as any[];

        let similarArtists: any[] = [];
        try {
            const similarRows = db.prepare(`
        SELECT
          a.id,
          a.name,
          a.picture,
          COALESCE(a.popularity, 0) as popularity
        FROM similar_artists sa
        JOIN artists a ON sa.similar_artist_id = a.id
        WHERE sa.artist_id = ?
        ORDER BY COALESCE(a.popularity, 0) DESC, sa.created_at ASC, a.id ASC
        LIMIT 10
      `).all(artistId) as any[];

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
      SELECT
        t.id,
        t.artist_id,
        t.title,
        t.version,
        t.duration,
        t.track_number,
        t.volume_number,
        t.explicit,
        t.quality,
        t.monitor,
        t.monitor_lock,
        t.popularity,
        a.title as album_title,
        a.cover as album_cover,
        a.id as album_id,
        ta.name as artist_name
      FROM media t
      JOIN albums a ON t.album_id = a.id
      JOIN media_artists ma ON t.id = ma.media_id
      LEFT JOIN artists ta ON ta.id = t.artist_id
      WHERE t.album_id IS NOT NULL
        AND t.type <> 'Music Video'
        AND ma.artist_id = ?
        AND ma.type = 'MAIN'
      ORDER BY COALESCE(t.popularity, 0) DESC, t.id ASC
    `).all(artistId) as any[];

        const albumDownloadStats = getAlbumDownloadStatsMap(albums.map((album) => album.id));
        const videoDownloadStates = getMediaDownloadStateMap(videos.map((video) => video.id), "video");
        const artistDownloadStats = getArtistDownloadStats(artistId);

        const transformedAlbums = albums.map((album) => {
            const derivedQuality = album.quality || "LOSSLESS";
            const downloadStats = albumDownloadStats.get(String(album.id)) ?? getAlbumDownloadStats(album.id);

            return {
                ...album,
                cover_id: album.cover || null,
                monitor_locked: Boolean(album.monitor_lock),
                redundant_of: album.redundant || null,
                type: album.relationship_type === "APPEARS_ON" ? "APPEARS_ON" : album.type,
                is_monitored: Boolean(album.monitor),
                downloaded: downloadStats.downloadedPercent,
                is_downloaded: downloadStats.isDownloaded,
                quality: derivedQuality,
                derived_quality: derivedQuality,
            };
        });

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
        };

        const moduleToBucket: Record<string, string> = {
            ALBUM: "ARTIST_ALBUMS",
            EP: "ARTIST_EPS",
            SINGLE: "ARTIST_SINGLES",
            APPEARS_ON: "ARTIST_APPEARS_ON",
            COMPILATION: "ARTIST_COMPILATIONS",
            LIVE: "ARTIST_LIVE_ALBUMS",
            REMIX: "ARTIST_REMIXES",
            SOUNDTRACK: "ARTIST_SOUNDTRACKS",
            DEMO: "ARTIST_DEMOS",
        };

        transformedAlbums.filter(a => !a.redundant_of).forEach((album) => {
            const moduleValue = album.aa_module?.toUpperCase();
            if (moduleValue && moduleToBucket[moduleValue]) {
                modules[moduleToBucket[moduleValue]].push(album);
                return;
            }

            const groupType = album.group_type?.toUpperCase();
            const albumType = (album.type || "ALBUM").toUpperCase();

            if (groupType === "COMPILATIONS") {
                modules.ARTIST_APPEARS_ON.push(album);
                return;
            }

            if (groupType === "EPSANDSINGLES") {
                if (albumType === "EP") {
                    modules.ARTIST_EPS.push(album);
                } else {
                    modules.ARTIST_SINGLES.push(album);
                }
                return;
            }

            if (albumType === "EP") {
                modules.ARTIST_EPS.push(album);
            } else if (albumType === "SINGLE") {
                modules.ARTIST_SINGLES.push(album);
            } else {
                modules.ARTIST_ALBUMS.push(album);
            }
        });

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
        pushAlbumModule("Demos", modules.ARTIST_DEMOS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "DEMO");
        pushAlbumModule("Remixes", modules.ARTIST_REMIXES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")), "REMIX");
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
                        monitor_locked: Boolean(video.monitor_lock),
                        is_monitored: Boolean(video.monitor),
                        downloaded: videoDownloadStates.get(String(video.id)) ? 1 : 0,
                        is_downloaded: videoDownloadStates.get(String(video.id)) ?? false,
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
      SELECT id, media_id, file_type, file_path, relative_path, filename, extension,
             quality, library_root, file_size, bitrate, sample_rate, bit_depth, codec, duration
      FROM library_files
      WHERE artist_id = ?
        AND album_id IS NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'bio')
      ORDER BY file_type ASC, id ASC
    `).all(artistId) as any[]);

        return {
            artist: {
                ...artist,
                bio,
                files: artistFiles,
                downloaded: artistDownloadStats.downloadedPercent,
                is_monitored: Boolean(artist.effective_monitor),
                is_downloaded: artistDownloadStats.isDownloaded,
            },
            rows,
            needs_scan: !artist.last_scanned || needsEnrichment,
            album_count: transformedAlbums.length,
            monitored_album_count: transformedAlbums.filter((album) => album.is_monitored).length,
        };
    }
}
