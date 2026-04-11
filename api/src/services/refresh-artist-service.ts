import { db } from "../database.js";
import {
    getArtist,
    getArtistAlbums,
    getArtistBio,
    getArtistPage,
    getArtistSimilar,
    getArtistVideos,
} from "./tidal.js";
import { ModuleFixer } from "./module-fixer.js";
import { VersionGrouper } from "./version-grouper.js";
import { getConfigSection } from "./config.js";
import { shouldHydrateArtistAlbumTracks, shouldHydrateArtistCatalog } from "./scan-policy.js";
import { createCooperativeBatcher } from "../utils/concurrent.js";
import pLimit from "p-limit";
import { readIntEnv } from "../utils/env.js";
import { resolveArtistFolderForPersistence } from "./artist-paths.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { ScanLevel, type ScanOptions } from "./scan-types.js";
import { getTrackRefreshState, isRefreshDue, shouldRefreshVideos } from "./scan-refresh-state.js";

const ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY = readIntEnv(
    "DISCOGENIUS_ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY",
    1,
    1,
);

function parseArtistPageModules(pageData: any): Map<string, string> {
    const albumModuleMap = new Map<string, string>();

    for (const row of pageData.rows || []) {
        for (const module of row.modules || []) {
            const items = module.pagedList?.items || module.items || [];
            const moduleTitle = String(module.title || "").toLowerCase();

            if (items.length === 0) {
                continue;
            }

            let normalizedModule: string | null = null;

            if (moduleTitle.includes("live")) {
                normalizedModule = "LIVE";
            } else if (moduleTitle.includes("compilation")) {
                normalizedModule = "COMPILATION";
            } else if (moduleTitle.includes("appears")) {
                normalizedModule = "APPEARS_ON";
            } else if (moduleTitle.includes("mix") || moduleTitle.includes("dj")) {
                normalizedModule = "DJ_MIXES";
            } else if (moduleTitle.includes("remix")) {
                normalizedModule = "REMIX";
            }

            if (!normalizedModule) {
                continue;
            }

            for (const item of items) {
                if (item.id) {
                    albumModuleMap.set(String(item.id), normalizedModule);
                }
            }
        }
    }

    return albumModuleMap;
}

export class RefreshArtistService {
    private static async storeSimilarArtists(artistId: string, forceUpdate = false): Promise<string[]> {
        try {
            const similarArtists = await getArtistSimilar(artistId);
            const ids = new Set<string>();

            const upsertArtist = db.prepare(`
                INSERT INTO artists (id, name, picture, popularity, monitor, path)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    ${forceUpdate
                        ? `
                    name = excluded.name,
                    picture = excluded.picture,
                    popularity = excluded.popularity,
                    path = COALESCE(artists.path, excluded.path)
                    `
                        : `
                    name = COALESCE(excluded.name, name),
                    picture = COALESCE(excluded.picture, picture),
                    popularity = COALESCE(excluded.popularity, popularity),
                    path = COALESCE(artists.path, excluded.path)
                    `}
            `);

            const deleteRelations = db.prepare("DELETE FROM similar_artists WHERE artist_id = ?");
            const insertRelation = db.prepare(`
                INSERT OR IGNORE INTO similar_artists (artist_id, similar_artist_id)
                VALUES (?, ?)
            `);

            const tx = db.transaction((items: any[]) => {
                deleteRelations.run(artistId);
                for (const similarArtist of items) {
                    const similarArtistId = similarArtist?.tidal_id?.toString?.()
                        ?? String(similarArtist?.tidal_id ?? "");

                    if (!similarArtistId || similarArtistId === String(artistId)) {
                        continue;
                    }

                    ids.add(similarArtistId);
                    upsertArtist.run(
                        similarArtistId,
                        similarArtist?.name || "Unknown Artist",
                        similarArtist?.picture || null,
                        similarArtist?.popularity ?? null,
                        resolveArtistFolderForPersistence({
                            artistId: similarArtistId,
                            artistName: similarArtist?.name || "Unknown Artist",
                        }),
                    );
                    insertRelation.run(artistId, similarArtistId);
                }
            });

            tx(similarArtists || []);
            return Array.from(ids);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch/store similar artists for ${artistId}:`, error);
            return [];
        }
    }

    static getScanLevel(artistId: string): ScanLevel {
        const artist = db.prepare(`
            SELECT
                id,
                name,
                picture,
                bio_text,
                last_scanned,
                (SELECT COUNT(*) FROM album_artists WHERE artist_id = ?) AS album_count,
                (SELECT COUNT(*) FROM media WHERE artist_id = ? AND type = 'Music Video') AS video_count
            FROM artists
            WHERE id = ?
        `).get(artistId, artistId, artistId) as {
            id?: string;
            name?: string | null;
            bio_text?: string | null;
            album_count?: number;
            video_count?: number;
        } | undefined;

        if (!artist) {
            return ScanLevel.NONE;
        }

        if (Number(artist.album_count || 0) > 0 || Number(artist.video_count || 0) > 0) {
            return ScanLevel.DEEP;
        }

        if (artist.bio_text !== null && artist.bio_text !== undefined) {
            return ScanLevel.SHALLOW;
        }

        if (artist.name) {
            return ScanLevel.BASIC;
        }

        return ScanLevel.NONE;
    }

    static async scanBasic(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanBasic for ${artistId}`);

        const existing = db.prepare(
            "SELECT id, monitor, name, last_scanned, path FROM artists WHERE id = ?",
        ).get(artistId) as any;
        const refreshDays = getConfigSection("monitoring").artist_refresh_days;
        const shouldRefresh =
            !existing ||
            options.forceUpdate === true ||
            isRefreshDue(existing?.last_scanned, refreshDays);

        const shouldMonitor = options.monitorArtist === true ? true : (existing?.monitor || false);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;

        if (existing && !shouldRefresh) {
            if (options.monitorArtist === true && existing.monitor !== shouldMonitorInt) {
                db.prepare(`
                    UPDATE artists SET
                        monitor = ?,
                        monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                    WHERE id = ?
                `).run(shouldMonitorInt, shouldMonitorInt, artistId);
            }

            const includeSimilar = options.includeSimilarArtists !== false || options.seedSimilarArtists === true;
            if (includeSimilar) {
                const hasSimilar = db.prepare(
                    "SELECT 1 FROM similar_artists WHERE artist_id = ? LIMIT 1",
                ).get(artistId) as any;
                const shouldFetchSimilar = options.seedSimilarArtists === true || !hasSimilar;

                if (shouldFetchSimilar) {
                    const similarArtistIds = await this.storeSimilarArtists(artistId, options.forceUpdate === true);
                    if (options.seedSimilarArtists) {
                        for (const similarArtistId of similarArtistIds) {
                            try {
                                await this.scanShallow(similarArtistId, {
                                    monitorArtist: false,
                                    includeSimilarArtists: false,
                                    seedSimilarArtists: false,
                                });
                            } catch (error) {
                                console.warn(`[RefreshArtistService] Failed to seed similar artist ${similarArtistId}:`, error);
                            }
                        }
                    }
                }
            }

            console.log(`[RefreshArtistService] scanBasic skipped for ${artistId} (fresh)`);
            return;
        }

        const artistData = await getArtist(artistId);
        const resolvedArtistFolder = resolveArtistFolderForPersistence({
            artistId,
            artistName: artistData.name,
            artistMbId: (artistData as any)?.mbid ?? null,
            existingPath: existing?.path ?? null,
        });

        if (artistData.name === "Various Artists" || artistId === "0") {
            console.warn(`[RefreshArtistService] Cannot monitor 'Various Artists' (ID: ${artistId}). Skipping.`);
            throw new Error("Cannot monitor 'Various Artists'. Please monitor specific compilations instead.");
        }

        if (!existing) {
            db.prepare(`
                INSERT INTO artists (
                    id, name, picture, popularity, artist_types, artist_roles,
                    monitor, monitored_at, user_date_added, last_scanned, path
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?, CURRENT_TIMESTAMP, ?)
            `).run(
                artistId,
                artistData.name,
                artistData.picture,
                artistData.popularity,
                JSON.stringify(artistData.artist_types || ["ARTIST"]),
                JSON.stringify(artistData.artist_roles || []),
                shouldMonitorInt,
                shouldMonitorInt,
                null,
                resolvedArtistFolder,
            );
        } else {
            const monitorValue = options.monitorArtist === true ? shouldMonitorInt : existing.monitor;
            db.prepare(`
                UPDATE artists SET
                    name = ?,
                    picture = ?,
                    popularity = ?,
                    artist_types = ?,
                    artist_roles = ?,
                    monitor = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END,
                    last_scanned = CURRENT_TIMESTAMP,
                    path = COALESCE(path, ?)
                WHERE id = ?
            `).run(
                artistData.name,
                artistData.picture,
                artistData.popularity,
                JSON.stringify(artistData.artist_types || ["ARTIST"]),
                JSON.stringify(artistData.artist_roles || []),
                monitorValue,
                monitorValue,
                resolvedArtistFolder,
                artistId,
            );
        }

        const includeSimilar = options.includeSimilarArtists !== false || options.seedSimilarArtists === true;
        const similarArtistIds = includeSimilar
            ? await this.storeSimilarArtists(artistId, options.forceUpdate === true)
            : [];

        if (options.seedSimilarArtists) {
            for (const similarArtistId of similarArtistIds) {
                try {
                    await this.scanShallow(similarArtistId, {
                        monitorArtist: false,
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                    });
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to seed similar artist ${similarArtistId}:`, error);
                }
            }
        }

        console.log(`[RefreshArtistService] scanBasic complete for ${artistId}`);
    }

    static async scanShallow(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanShallow for ${artistId}`);

        const refreshDays = getConfigSection("monitoring").artist_refresh_days;
        const existing = db.prepare("SELECT bio_text, last_scanned FROM artists WHERE id = ?").get(artistId) as any;
        const shouldRefreshBio =
            options.forceUpdate === true ||
            existing?.bio_text == null ||
            isRefreshDue(existing?.last_scanned, refreshDays);

        await this.scanBasic(artistId, options);

        if (!shouldRefreshBio) {
            console.log(`[RefreshArtistService] Skipping bio refresh for ${artistId} (fresh)`);
            return;
        }

        try {
            const bio = await getArtistBio(artistId);
            const bioText = bio?.text ?? null;
            const bioSource = bio?.source ?? null;
            const bioUpdated = bio?.lastUpdated ?? null;

            if (bio !== null && bio !== undefined) {
                db.prepare(`
                    UPDATE artists SET
                        bio_text = ?,
                        bio_source = ?,
                        bio_last_updated = ?
                    WHERE id = ?
                `).run(bioText ?? "", bioSource, bioUpdated, artistId);
            } else if (options.forceUpdate === true || existing?.bio_text == null) {
                db.prepare(`
                    UPDATE artists SET
                        bio_text = ?,
                        bio_source = ?,
                        bio_last_updated = ?
                    WHERE id = ?
                `).run("", bioSource, bioUpdated, artistId);
            }
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch bio for ${artistId}:`, error);
        }

        console.log(`[RefreshArtistService] scanShallow complete for ${artistId}`);
    }

    static async scanDeep(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanDeep for ${artistId}`);
        options.progress?.({ kind: "status", message: `Scanning artist ${artistId}...` });

        const monitoringConfig = getConfigSection("monitoring");
        const artistRow = db.prepare("SELECT last_scanned FROM artists WHERE id = ?").get(artistId) as any;
        const currentLevel = this.getScanLevel(artistId);
        const shouldScanArtist =
            options.forceUpdate === true ||
            currentLevel < ScanLevel.DEEP ||
            !artistRow ||
            isRefreshDue(artistRow?.last_scanned, monitoringConfig.artist_refresh_days);

        if (!shouldScanArtist) {
            console.log(`[RefreshArtistService] Skipping artist ${artistId} scan (fresh)`);
            return;
        }

        const includeSimilarArtists = options.includeSimilarArtists !== false;
        const seedSimilarArtists = options.seedSimilarArtists !== false;
        const hasManagedMetadata = currentLevel >= ScanLevel.DEEP;
        const shouldHydrateCatalog = options.forceUpdate === true || shouldHydrateArtistCatalog(options, {
            hasManagedMetadata,
        });
        const shouldRunShallow =
            options.forceUpdate === true ||
            currentLevel < ScanLevel.SHALLOW ||
            includeSimilarArtists ||
            seedSimilarArtists;

        if (shouldRunShallow) {
            console.log(`[RefreshArtistService] Artist ${artistId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
            await this.scanShallow(artistId, {
                ...options,
                includeSimilarArtists,
                seedSimilarArtists,
            });
        }

        if (shouldHydrateCatalog) {
            let albumModuleMap = new Map<string, string>();
            try {
                const pageData = await getArtistPage(artistId);
                if (pageData?.rows) {
                    albumModuleMap = parseArtistPageModules(pageData);
                }
                console.log(`[RefreshArtistService] Mapped ${albumModuleMap.size} albums to modules from page API`);
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to fetch page layout for ${artistId}:`, error);
            }

            const shouldRefreshArtistVideos =
                options.forceUpdate === true ||
                shouldRefreshVideos(artistId, monitoringConfig.video_refresh_days);
            if (shouldRefreshArtistVideos) {
                try {
                    const videos = await getArtistVideos(artistId);
                    console.log(`[RefreshArtistService] Found ${videos.length} videos for artist ${artistId}`);
                    RefreshVideoService.upsertArtistVideos(artistId, videos, options);
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to fetch videos for ${artistId}:`, error);
                }
            } else {
                console.log(`[RefreshArtistService] Skipping video refresh for ${artistId} (fresh)`);
            }

            const albums = await getArtistAlbums(artistId);
            console.log(`[RefreshArtistService] Found ${albums.length} albums for artist ${artistId}`);
            options.progress?.({ kind: "albums_total", total: albums.length });

            const cooperateAlbumStore = createCooperativeBatcher(20);
            for (let index = 0; index < albums.length; index += 1) {
                const album = albums[index];
                const created = await RefreshAlbumService.upsertArtistAlbum(album, artistId, albumModuleMap, options);
                await cooperateAlbumStore();
                options.progress?.({
                    kind: "album",
                    index: index + 1,
                    total: albums.length,
                    albumId: String(album.tidal_id),
                    title: String(album.title),
                    created,
                });
            }

            if (shouldHydrateArtistAlbumTracks(options)) {
                const limit = pLimit(ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY);
                const albumsNeedingTrackScan = albums
                    .map((album) => {
                        const expectedTracks = album.num_tracks || 0;
                        const existingCount = db.prepare(
                            "SELECT COUNT(*) AS count FROM media WHERE album_id = ? AND type != 'Music Video'",
                        ).get(album.tidal_id) as any;
                        const hasMissingTracks = expectedTracks > 0
                            ? existingCount.count < expectedTracks
                            : existingCount.count === 0;
                        const refreshState = getTrackRefreshState(String(album.tidal_id), monitoringConfig.track_refresh_days);

                        return {
                            album,
                            shouldRefresh: options.forceAlbumUpdate === true || hasMissingTracks || refreshState.shouldRefresh,
                            missingTracks: hasMissingTracks || refreshState.missingTracks,
                            oldestScanTime: refreshState.oldestScanTime,
                        };
                    })
                    .filter((entry) => entry.shouldRefresh)
                    .sort((left, right) => {
                        if (left.missingTracks !== right.missingTracks) {
                            return Number(right.missingTracks) - Number(left.missingTracks);
                        }

                        if (left.oldestScanTime !== right.oldestScanTime) {
                            return left.oldestScanTime - right.oldestScanTime;
                        }

                        return String(left.album.tidal_id).localeCompare(String(right.album.tidal_id));
                    })
                    .map((entry) => entry.album);

                if (albumsNeedingTrackScan.length > 0) {
                    console.log(`[RefreshArtistService] Scanning tracks for ${albumsNeedingTrackScan.length}/${albums.length} albums inline`);
                    const trackScanTotal = albumsNeedingTrackScan.length;
                    await Promise.all(albumsNeedingTrackScan.map((album, index) => limit(async () => {
                        options.progress?.({
                            kind: "album_tracks",
                            index: index + 1,
                            total: trackScanTotal,
                            albumId: String(album.tidal_id),
                            title: String(album.title),
                        });
                        await RefreshAlbumService.scanTracks(String(album.tidal_id));
                    })));
                }
            } else {
                console.log(`[RefreshArtistService] Skipping inline track hydration for artist ${artistId} (monitorAlbums=false)`);
            }

            console.log(`[RefreshArtistService] Building version groups for artist ${artistId}...`);
            await VersionGrouper.applyVersionGroups(artistId);

            console.log(`[RefreshArtistService] Fixing module tags for artist ${artistId}...`);
            await ModuleFixer.fixModuleTagsForArtist(artistId);
        } else {
            console.log(`[RefreshArtistService] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);
        }

        db.prepare("UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(artistId);
        console.log(`[RefreshArtistService] scanDeep complete for ${artistId}`);
    }
}
