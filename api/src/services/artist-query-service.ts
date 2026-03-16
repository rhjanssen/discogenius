import { db } from "../database.js";
import { loadToken, getArtist, getArtistBio, getArtistPage } from "./tidal.js";
import {
    getAlbumDownloadStats,
    getAlbumDownloadStatsMap,
    getArtistDownloadStats,
    getArtistDownloadStatsMap,
    getMediaDownloadStateMap,
} from "./download-state.js";
import { buildManagedArtistPredicate } from "./managed-artists.js";
import { loadArtistWithEffectiveMonitor } from "./artist-monitoring.js";
import { LibraryFilesService } from "./library-files.js";

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

function hasUsableTidalSession(): boolean {
    const token = loadToken();
    if (!token?.access_token) return false;
    if (!token.expires_at) return true;
    return token.expires_at > Math.floor(Date.now() / 1000);
}

export class ArtistQueryService {
    static listArtists(input: ArtistListQuery) {
        const limit = input.limit;
        const offset = input.offset;
        const search = input.search;
        const sortParam = input.sort || "name";
        const sortDir = (input.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
        const monitoredFilter = input.monitored;
        const includeDownloadStats = input.includeDownloadStats !== false;

        let query = `
      SELECT a.*, 
        CASE WHEN ${managedArtistPredicate} THEN 1 ELSE 0 END as effective_monitor,
        COALESCE(ac.cnt, 0) as album_count,
        COALESCE(ac.monitored_cnt, 0) as monitored_album_count,
        COALESCE(tc.cnt, 0) as track_count,
        COALESCE(tc.monitored_cnt, 0) as monitored_track_count
      FROM artists a
      LEFT JOIN (
        SELECT artist_id, 
          COUNT(*) as cnt,
          SUM(CASE WHEN monitor = 1 THEN 1 ELSE 0 END) as monitored_cnt
        FROM albums GROUP BY artist_id
      ) ac ON ac.artist_id = a.id
      LEFT JOIN (
        SELECT artist_id,
          COUNT(*) as cnt,
          SUM(CASE WHEN monitor = 1 THEN 1 ELSE 0 END) as monitored_cnt
        FROM media WHERE type != 'Music Video' GROUP BY artist_id
      ) tc ON tc.artist_id = a.id
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
        const artistDownloadStats = includeDownloadStats
            ? getArtistDownloadStatsMap(artists.map((artist) => artist.id))
            : null;

        return {
            items: artists.map((artist) => ({
                ...artist,
                downloaded: includeDownloadStats
                    ? artistDownloadStats?.get(String(artist.id))?.downloadedPercent ?? 0
                    : Number(artist.downloaded ?? 0),
                is_monitored: Boolean(artist.effective_monitor),
                is_downloaded: includeDownloadStats
                    ? artistDownloadStats?.get(String(artist.id))?.isDownloaded ?? false
                    : false,
            })),
            total: totalResult.total,
            limit,
            offset,
            hasMore: offset + artists.length < totalResult.total,
        };
    }

    static async getArtistById(artistId: string): Promise<any | null> {
        const artist = loadArtistWithEffectiveMonitor(artistId);

        if (!artist) {
            try {
                const tidalArtist = await getArtist(artistId);
                return {
                    id: tidalArtist.tidal_id,
                    name: tidalArtist.name,
                    picture: tidalArtist.picture,
                    is_monitored: false,
                    is_downloaded: false,
                    album_count: 0,
                };
            } catch {
                return null;
            }
        }

        const artistDownloadStats = getArtistDownloadStats(artistId);
        return {
            ...artist,
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
      WHERE a.artist_id = ? AND jq.type = 'ScanAlbum' AND jq.status IN ('pending', 'processing')
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
            scanning: jobs.some((job) => job.type === "RefreshArtist" || job.type === "ScanAlbum"),
            curating: jobs.some((job) => job.type === "CurateArtist"),
            downloading: jobs.some((job) => job.type.startsWith("Download") || job.type === "ImportDownload"),
            libraryScan: jobs.some((job) => job.type === "RescanFolders"),
            totalActive: jobs.length,
            jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status })),
        };
    }

    static async getArtistDetail(id: string): Promise<any | null> {
        let artist = db.prepare(`
      SELECT * FROM artists WHERE id = ?
    `).get(id) as any;

        if (!artist) {
            try {
                const tidalArtist = await getArtist(id);
                const bio = await getArtistBio(id).catch(() => null);
                const bioText = bio?.text ?? null;
                const bioSource = bio?.source ?? null;
                const bioUpdated = bio?.lastUpdated ?? null;

                db.prepare(`
          INSERT OR IGNORE INTO artists (
            id, name, picture, popularity, bio_text, bio_source, bio_last_updated, monitor
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
                    tidalArtist.tidal_id,
                    tidalArtist.name,
                    tidalArtist.picture,
                    tidalArtist.popularity,
                    bioText,
                    bioSource,
                    bioUpdated,
                );

                artist = db.prepare(`SELECT * FROM artists WHERE id = ?`).get(id) as any;
            } catch {
                return null;
            }
        }

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
        const canUseTidal = hasUsableTidalSession();
        let artist = loadArtistWithEffectiveMonitor(artistId);

        if (!artist) {
            if (!canUseTidal) {
                return null;
            }

            try {
                const artistData = await getArtist(artistId);
                const existing = db.prepare(`
          SELECT id, monitor, monitored_at
          FROM artists
          WHERE id = ?
        `).get(artistId) as any;

                const artistTypes = JSON.stringify(artistData.artist_types || ["ARTIST"]);
                const artistRoles = JSON.stringify(artistData.artist_roles || []);

                if (existing) {
                    db.prepare(`
            UPDATE artists
            SET name = ?,
                picture = ?,
                popularity = ?,
                artist_types = ?,
                artist_roles = ?
            WHERE id = ?
          `).run(
                        artistData.name,
                        artistData.picture,
                        artistData.popularity,
                        artistTypes,
                        artistRoles,
                        artistId,
                    );
                } else {
                    db.prepare(`
            INSERT INTO artists (
              id,
              name,
              picture,
              popularity,
              artist_types,
              artist_roles,
              monitor,
              monitored_at,
              user_date_added,
              last_scanned
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)
          `).run(
                        artistId,
                        artistData.name,
                        artistData.picture,
                        artistData.popularity,
                        artistTypes,
                        artistRoles,
                    );
                }

                artist = loadArtistWithEffectiveMonitor(artistId);
            } catch {
                return null;
            }
        }

        if (!artist) {
            return null;
        }

        const needsEnrichment = !artist.name || artist.name === "Unknown Artist" || artist.artist_types == null;
        if (needsEnrichment && canUseTidal) {
            try {
                const artistData = await getArtist(artistId);
                db.prepare(`
          UPDATE artists
          SET name = ?,
              picture = ?,
              popularity = ?,
              artist_types = ?,
              artist_roles = ?
          WHERE id = ?
        `).run(
                    artistData.name,
                    artistData.picture,
                    artistData.popularity,
                    JSON.stringify(artistData.artist_types || ["ARTIST"]),
                    JSON.stringify(artistData.artist_roles || []),
                    artistId,
                );
                artist = loadArtistWithEffectiveMonitor(artistId) || artist;
            } catch {
                // Keep rendering from local DB state.
            }
        }

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
      SELECT DISTINCT
        t.*, 
        a.title as album_title,
        a.cover as album_cover,
        a.id as album_id
      FROM media t
      JOIN albums a ON t.album_id = a.id
      JOIN media_artists ma ON t.id = ma.media_id
      WHERE t.album_id IS NOT NULL
        AND t.type <> 'Music Video'
        AND ma.artist_id = ?
        AND UPPER(ma.type) = 'MAIN'
      ORDER BY COALESCE(t.popularity, 0) DESC, t.id ASC
      LIMIT 50
    `).all(artistId) as any[];

        const albumDownloadStats = getAlbumDownloadStatsMap(albums.map((album) => album.id));
        const topTrackDownloadStates = getMediaDownloadStateMap(topTracks.map((track) => track.id), "track");
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
        };

        const moduleToBucket: Record<string, string> = {
            ALBUM: "ARTIST_ALBUMS",
            EP: "ARTIST_EPS",
            SINGLE: "ARTIST_SINGLES",
            APPEARS_ON: "ARTIST_APPEARS_ON",
            COMPILATION: "ARTIST_COMPILATIONS",
            LIVE: "ARTIST_LIVE_ALBUMS",
            REMIX: "ARTIST_REMIXES",
        };

        transformedAlbums.forEach((album) => {
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

        const topTrackIds = topTracks.map((track) => String(track.id));
        const filesByTrack = new Map<string, any[]>();
        if (topTrackIds.length > 0) {
            const placeholders = topTrackIds.map(() => "?").join(",");
            const trackFiles = db.prepare(`
        SELECT id, media_id, file_type, file_path, relative_path, filename, extension,
               quality, library_root, file_size, bitrate, sample_rate, bit_depth, codec, duration
        FROM library_files
        WHERE media_id IN (${placeholders})
          AND file_type IN ('track', 'lyrics')
        ORDER BY file_type ASC, id ASC
      `).all(...topTrackIds) as any[];

            for (const file of trackFiles) {
                const key = String(file.media_id);
                const list = filesByTrack.get(key) ?? [];
                list.push(file);
                filesByTrack.set(key, list);
            }
        }

        const rows: any[] = [];

        if (topTracks.length > 0) {
            rows.push({
                modules: [{
                    type: "TRACK_LIST",
                    title: "Top Tracks",
                    items: topTracks.map((track) => {
                        const trackId = String(track.id);
                        return {
                            id: trackId,
                            title: track.title,
                            version: track.version || null,
                            duration: track.duration || 0,
                            track_number: track.track_number || 0,
                            volume_number: track.volume_number || 1,
                            quality: track.quality,
                            is_monitored: Boolean(track.monitor),
                            monitor_locked: Boolean(track.monitor_lock),
                            downloaded: topTrackDownloadStates.get(trackId) ? 1 : 0,
                            is_downloaded: topTrackDownloadStates.get(trackId) ?? false,
                            files: filesByTrack.get(trackId) ?? [],
                            album: {
                                id: String(track.album_id),
                                title: track.album_title,
                                cover_id: track.album_cover || null,
                            },
                        };
                    }),
                }],
            });
        }

        const pushAlbumModule = (title: string, items: any[], type = "ALBUM_LIST") => {
            if (items.length === 0) return;
            rows.push({ modules: [{ type, title, items }] });
        };

        pushAlbumModule("Albums", modules.ARTIST_ALBUMS);
        pushAlbumModule("Live Albums", modules.ARTIST_LIVE_ALBUMS);
        pushAlbumModule("EPs", modules.ARTIST_EPS.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")));
        pushAlbumModule("Singles", modules.ARTIST_SINGLES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")));
        pushAlbumModule("Compilations", modules.ARTIST_COMPILATIONS, "COMPILATIONS");
        pushAlbumModule("Remixes", modules.ARTIST_REMIXES.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || "")));
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
            needs_scan: !artist.last_scanned,
            album_count: transformedAlbums.length,
            monitored_album_count: transformedAlbums.filter((album) => album.is_monitored).length,
        };
    }
}
