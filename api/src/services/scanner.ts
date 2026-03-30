/**
 * Modular Scanner Service
 * 
 * Implements tiered scanning levels (BASIC → SHALLOW → DEEP).
 * Each level builds on the previous, making incremental API calls.
 * 
 * ARTIST SCAN LEVELS:
 * - BASIC:   /artists/{id} (name, picture, types, roles, popularity) + similar
 * - SHALLOW: + /artists/{id}/bio
 * - DEEP:    + /artists/{id}/albums (×3 filters) + /artists/{id}/videos + /pages/artist
 * 
 * ALBUM SCAN LEVELS:
 * - BASIC:   /albums/{id} (metadata) + similar
 * - SHALLOW: + /albums/{id}/tracks + /albums/{id}/review
 * - DEEP:    + /albums/{id}/credits
 */

import { db } from "../database.js";
import {
    getArtist, getArtistBio, getArtistAlbums, getArtistVideos, getArtistPage, getArtistSimilar,
    getAlbum, getAlbumTracks, getAlbumReview, getAlbumCredits, getAlbumItemsCredits, getAlbumSimilar,
    getTrack, getVideo, getPlaylist, getPlaylistTracks
} from "./tidal.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { ModuleFixer } from "./module-fixer.js";
import { VersionGrouper } from "./version-grouper.js";
import { getConfigSection } from "./config.js";
import { shouldHydrateArtistAlbumTracks, shouldHydrateArtistCatalog } from "./scan-policy.js";
import { createCooperativeBatcher } from "../utils/concurrent.js";
import pLimit from "p-limit";
import { readIntEnv } from "../utils/env.js";
import { resolveArtistFolder } from "./naming.js";

export enum ScanLevel {
    NONE = 0,
    BASIC = 1,
    SHALLOW = 2,
    DEEP = 3,
}

export enum ScanTargetType {
    ARTIST = 'ARTIST',
    ALBUM = 'ALBUM',
}

interface ScanOptions {
    monitorArtist?: boolean;
    monitorAlbums?: boolean;
    hydrateCatalog?: boolean;
    hydrateAlbumTracks?: boolean;
    forceUpdate?: boolean;
    forceAlbumUpdate?: boolean;
    includeSimilarArtists?: boolean;
    seedSimilarArtists?: boolean;
    includeSimilarAlbums?: boolean;
    seedSimilarAlbums?: boolean;
    progress?: (event: ArtistScanProgressEvent) => void;
}

export type ArtistScanProgressEvent =
    | { kind: 'status'; message: string }
    | { kind: 'albums_total'; total: number }
    | { kind: 'album'; index: number; total: number; albumId: string; title: string; created: boolean }
    | { kind: 'album_tracks'; index: number; total: number; albumId: string; title: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY = readIntEnv(
    "DISCOGENIUS_ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY",
    1,
    1,
);

function isRefreshDue(lastScanned: string | null | undefined, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    if (!lastScanned) return true;
    const last = new Date(lastScanned).getTime();
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= refreshDays * DAY_MS;
}

function shouldRefreshTracks(albumId: string, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    const row = db.prepare(`
        SELECT
            COUNT(*) as total_tracks,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE album_id = ? AND type != 'Music Video'
    `).get(albumId) as any;

    const totalTracks = Number(row?.total_tracks || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;

    if (totalTracks === 0 || missingScans > 0 || !oldestScan) return true;
    return isRefreshDue(oldestScan, refreshDays);
}

function shouldRefreshVideos(artistId: string, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    const row = db.prepare(`
        SELECT
            COUNT(*) as total_videos,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE artist_id = ? AND type = 'Music Video'
    `).get(artistId) as any;

    const totalVideos = Number(row?.total_videos || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    if (totalVideos === 0 || missingScans > 0 || !oldestScan) return true;
    return isRefreshDue(oldestScan, refreshDays);
}

function getTrackRefreshState(albumId: string, refreshDays: number | undefined): {
    shouldRefresh: boolean;
    missingTracks: boolean;
    oldestScanTime: number;
} {
    if (!refreshDays || refreshDays <= 0) {
        return {
            shouldRefresh: true,
            missingTracks: false,
            oldestScanTime: Number.NEGATIVE_INFINITY,
        };
    }

    const row = db.prepare(`
        SELECT
            COUNT(*) as total_tracks,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE album_id = ? AND type != 'Music Video'
    `).get(albumId) as any;

    const totalTracks = Number(row?.total_tracks || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    const missingTracks = totalTracks === 0 || missingScans > 0 || !oldestScan;
    const oldestScanTime = oldestScan ? new Date(oldestScan).getTime() : Number.NEGATIVE_INFINITY;

    return {
        shouldRefresh: missingTracks || isRefreshDue(oldestScan, refreshDays),
        missingTracks,
        oldestScanTime: Number.isFinite(oldestScanTime) ? oldestScanTime : Number.NEGATIVE_INFINITY,
    };
}

async function storeSimilarArtists(artistId: string, forceUpdate: boolean = false): Promise<string[]> {
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

        const deleteRelations = db.prepare(`DELETE FROM similar_artists WHERE artist_id = ?`);
        const insertRelation = db.prepare(`
            INSERT OR IGNORE INTO similar_artists (artist_id, similar_artist_id)
            VALUES (?, ?)
        `);

        const tx = db.transaction((items: any[]) => {
            deleteRelations.run(artistId);
            for (const s of items) {
                const similarArtistId = s?.tidal_id?.toString?.() ?? String(s?.tidal_id ?? '');
                if (!similarArtistId) continue;
                if (similarArtistId === String(artistId)) continue;
                ids.add(similarArtistId);
                upsertArtist.run(
                    similarArtistId,
                    s?.name || 'Unknown Artist',
                    s?.picture || null,
                    s?.popularity ?? null,
                    resolveArtistFolder(s?.name || 'Unknown Artist')
                );
                insertRelation.run(artistId, similarArtistId);
            }
        });

        tx(similarArtists || []);
        return Array.from(ids);
    } catch (e) {
        console.warn(`[Scanner] Failed to fetch/store similar artists for ${artistId}:`, e);
    }
    return [];
}

async function storeSimilarAlbums(
    albumId: string,
    forceUpdate: boolean = false
): Promise<Array<{ albumId: string; artistId: string }>> {
    try {
        const similarAlbums = await getAlbumSimilar(albumId);
        const ids = new Set<string>();
        const pairs: Array<{ albumId: string; artistId: string }> = [];

        const upsertArtist = db.prepare(`
            INSERT INTO artists (id, name, monitor, path)
            VALUES (?, ?, 0, ?)
            ON CONFLICT(id) DO UPDATE SET
                ${forceUpdate
                ? `
                name = excluded.name,
                path = COALESCE(artists.path, excluded.path)
                `
                : `
                name = COALESCE(excluded.name, name),
                path = COALESCE(artists.path, excluded.path)
                `}
        `);

        const upsertAlbum = db.prepare(`
            INSERT INTO albums (
                id, artist_id, title, version, release_date, type, explicit, quality,
                cover, vibrant_color, video_cover,
                num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                mb_primary, mb_secondary, monitor
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, 0, 0, ?, NULL, NULL, NULL, NULL, 0)
            ON CONFLICT(id) DO UPDATE SET
                ${forceUpdate
                ? `
                artist_id = excluded.artist_id,
                title = excluded.title,
                release_date = excluded.release_date,
                cover = excluded.cover,
                type = excluded.type,
                explicit = excluded.explicit,
                quality = excluded.quality,
                popularity = excluded.popularity
                `
                : `
                artist_id = COALESCE(excluded.artist_id, artist_id),
                title = COALESCE(excluded.title, title),
                release_date = COALESCE(excluded.release_date, release_date),
                cover = COALESCE(excluded.cover, cover),
                type = COALESCE(excluded.type, type),
                explicit = COALESCE(excluded.explicit, explicit),
                quality = COALESCE(excluded.quality, quality),
                popularity = COALESCE(excluded.popularity, popularity)
                `}
        `);

        const deleteRelations = db.prepare(`DELETE FROM similar_albums WHERE album_id = ?`);
        const insertRelation = db.prepare(`
            INSERT OR IGNORE INTO similar_albums (album_id, similar_album_id)
            VALUES (?, ?)
        `);

        const tx = db.transaction((items: any[]) => {
            deleteRelations.run(albumId);
            for (const s of items) {
                const similarAlbumId = s?.tidal_id?.toString?.() ?? String(s?.tidal_id ?? '');
                if (!similarAlbumId) continue;
                if (similarAlbumId === String(albumId)) continue;

                const similarArtistId = s?.artist_id?.toString?.() ?? String(s?.artist_id ?? '');
                if (!similarArtistId) continue;
                if (!ids.has(similarAlbumId)) {
                    ids.add(similarAlbumId);
                    pairs.push({ albumId: similarAlbumId, artistId: similarArtistId });
                }

                upsertArtist.run(
                    similarArtistId,
                    s?.artist_name || 'Unknown Artist',
                    resolveArtistFolder(s?.artist_name || 'Unknown Artist')
                );
                upsertAlbum.run(
                    similarAlbumId,
                    similarArtistId,
                    s?.title || 'Unknown Album',
                    s?.release_date || null,
                    s?.type || 'ALBUM',
                    s?.explicit ? 1 : 0,
                    s?.quality || 'LOSSLESS',
                    s?.cover || null,
                    s?.popularity ?? 0
                );
                insertRelation.run(albumId, similarAlbumId);
            }
        });

        tx(similarAlbums || []);
        return pairs;
    } catch (e) {
        console.warn(`[Scanner] Failed to fetch/store similar albums for ${albumId}:`, e);
    }
    return [];
}

// ============================================================================
// SCAN LEVEL DETECTION
// ============================================================================

/**
 * Determine the current scan level of an artist based on what data exists
 */
export function getArtistScanLevel(artistId: string): ScanLevel {
    const artist = db.prepare(`
        SELECT id, name, picture, bio_text, last_scanned,
               (SELECT COUNT(*) FROM album_artists WHERE artist_id = ?) as album_count,
               (SELECT COUNT(*) FROM media WHERE artist_id = ? AND type = 'Music Video') as video_count
        FROM artists WHERE id = ?
    `).get(artistId, artistId, artistId) as any;

    if (!artist) return ScanLevel.NONE;

    // Has albums/videos = DEEP scan done
    if (artist.album_count > 0 || artist.video_count > 0) {
        return ScanLevel.DEEP;
    }

    // Has bio = SHALLOW scan done
    if (artist.bio_text !== null && artist.bio_text !== undefined) {
        return ScanLevel.SHALLOW;
    }

    // Has name/picture = BASIC scan done
    if (artist.name) {
        return ScanLevel.BASIC;
    }

    return ScanLevel.NONE;
}

/**
 * Determine the current scan level of an album based on what data exists
 */
export function getAlbumScanLevel(albumId: string): ScanLevel {
    const album = db.prepare(`
        SELECT id, title, cover, review_text, credits,
               (SELECT COUNT(*) FROM media WHERE album_id = ?) as track_count
        FROM albums WHERE id = ?
    `).get(albumId, albumId) as any;

    if (!album) return ScanLevel.NONE;

    // Has credits = DEEP scan done
    if (album.credits) {
        return ScanLevel.DEEP;
    }

    // Has tracks and review = SHALLOW scan done
    if (album.track_count > 0 && album.review_text !== null) {
        return ScanLevel.SHALLOW;
    }

    // Has basic metadata = BASIC scan done
    if (album.title) {
        return ScanLevel.BASIC;
    }

    return ScanLevel.NONE;
}

// ============================================================================
// ARTIST SCANNING - MODULAR FUNCTIONS
// ============================================================================

/**
 * BASIC Artist Scan - Single API call
 * Fetches: name, picture, artistTypes, artistRoles, popularity
 */
export async function scanArtistBasic(artistId: string, options: ScanOptions = {}): Promise<void> {
    console.log(`[Scanner] scanArtistBasic for ${artistId}`);

    const existing = db.prepare("SELECT id, monitor, name, last_scanned FROM artists WHERE id = ?").get(artistId) as any;
    const refreshDays = getConfigSection("monitoring").artist_refresh_days;
    const shouldRefresh = !existing || options.forceUpdate === true || isRefreshDue(existing?.last_scanned, refreshDays);

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
                "SELECT 1 FROM similar_artists WHERE artist_id = ? LIMIT 1"
            ).get(artistId) as any;
            const shouldFetchSimilar = options.seedSimilarArtists === true || !hasSimilar;

            if (shouldFetchSimilar) {
                const similarArtistIds = await storeSimilarArtists(artistId, options.forceUpdate === true);
                if (options.seedSimilarArtists) {
                    for (const similarId of similarArtistIds) {
                        try {
                            await scanArtistShallow(similarId, {
                                monitorArtist: false,
                                includeSimilarArtists: false,
                                seedSimilarArtists: false,
                            });
                        } catch (e) {
                            console.warn(`[Scanner] Failed to seed similar artist ${similarId}:`, e);
                        }
                    }
                }
            }
        }
        console.log(`[Scanner] scanArtistBasic skipped for ${artistId} (fresh)`);
        return;
    }

    const artistData = await getArtist(artistId);
    const resolvedArtistFolder = resolveArtistFolder(artistData.name, (artistData as any)?.mbid ?? null);

    // BLOCK: Various Artists - prevent monitoring to avoid library flooding
    if (artistData.name === 'Various Artists' || artistId === '0') {
        console.warn(`[Scanner] Cannot monitor 'Various Artists' (ID: ${artistId}). Skipping.`);
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
            JSON.stringify(artistData.artist_types || ['ARTIST']),
            JSON.stringify(artistData.artist_roles || []),
            shouldMonitorInt,
            shouldMonitorInt,
            null,
            resolvedArtistFolder
        );
    } else {
        const monitorValue = options.monitorArtist === true ? shouldMonitorInt : existing.monitor;
        db.prepare(`
            UPDATE artists SET 
                name = ?, picture = ?, popularity = ?, artist_types = ?, artist_roles = ?,
                monitor = ?,
                monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END,
                last_scanned = CURRENT_TIMESTAMP,
                path = COALESCE(path, ?)
            WHERE id = ?
        `).run(
            artistData.name,
            artistData.picture,
            artistData.popularity,
            JSON.stringify(artistData.artist_types || ['ARTIST']),
            JSON.stringify(artistData.artist_roles || []),
            monitorValue,
            monitorValue,
            resolvedArtistFolder,
            artistId
        );
    }

    const includeSimilar = options.includeSimilarArtists !== false || options.seedSimilarArtists === true;
    const similarArtistIds = includeSimilar
        ? await storeSimilarArtists(artistId, options.forceUpdate === true)
        : [];

    if (options.seedSimilarArtists) {
        for (const similarId of similarArtistIds) {
            try {
                await scanArtistShallow(similarId, {
                    monitorArtist: false,
                    includeSimilarArtists: false,
                    seedSimilarArtists: false,
                });
            } catch (e) {
                console.warn(`[Scanner] Failed to seed similar artist ${similarId}:`, e);
            }
        }
    }

    console.log(`[Scanner] scanArtistBasic complete for ${artistId}`);
}

/**
 * SHALLOW Artist Scan - Adds biography
 * Requires: BASIC scan completed
 * Fetches: bio
 */
export async function scanArtistShallow(artistId: string, options: ScanOptions = {}): Promise<void> {
    console.log(`[Scanner] scanArtistShallow for ${artistId}`);

    const refreshDays = getConfigSection("monitoring").artist_refresh_days;
    const existing = db.prepare(`SELECT bio_text, last_scanned FROM artists WHERE id = ?`).get(artistId) as any;
    const shouldRefreshBio =
        options.forceUpdate === true ||
        existing?.bio_text == null ||
        isRefreshDue(existing?.last_scanned, refreshDays);

    // Always run BASIC scan first so we consistently refresh core metadata and similar artists.
    await scanArtistBasic(artistId, options);

    if (!shouldRefreshBio) {
        console.log(`[Scanner] Skipping bio refresh for ${artistId} (fresh)`);
        return;
    }

    // Fetch biography
    try {
        const bio = await getArtistBio(artistId);
        const bioText = bio?.text ?? null;
        const bioSource = bio?.source ?? null;
        const bioUpdated = bio?.lastUpdated ?? null;

        if (bio !== null && bio !== undefined) {
            db.prepare(`
                UPDATE artists SET 
                    bio_text = ?, bio_source = ?, bio_last_updated = ?
                WHERE id = ?
            `).run(bioText ?? '', bioSource, bioUpdated, artistId);
        } else if (options.forceUpdate === true || existing?.bio_text == null) {
            // Mark that we tried (prevents repeated 404 calls on every page load)
            db.prepare(`
                UPDATE artists SET
                    bio_text = ?, bio_source = ?, bio_last_updated = ?
                WHERE id = ?
            `).run('', bioSource, bioUpdated, artistId);
        }
    } catch (e) {
        console.warn(`[Scanner] Failed to fetch bio for ${artistId}:`, e);
    }

    console.log(`[Scanner] scanArtistShallow complete for ${artistId}`);
}

/**
 * DEEP Artist Scan - Full discography and relationships
 * Requires: SHALLOW scan completed
 * Fetches: albums (×3 filters), videos, page layout
 */
export async function scanArtistDeep(artistId: string, options: ScanOptions = {}): Promise<void> {
    console.log(`[Scanner] scanArtistDeep for ${artistId}`);
    options.progress?.({ kind: 'status', message: `Scanning artist ${artistId}...` });

    const monitoringConfig = getConfigSection("monitoring");
    const artistRow = db.prepare("SELECT last_scanned FROM artists WHERE id = ?").get(artistId) as any;
    const currentLevel = getArtistScanLevel(artistId);
    const shouldScanArtist =
        options.forceUpdate === true ||
        currentLevel < ScanLevel.DEEP ||
        !artistRow ||
        isRefreshDue(artistRow?.last_scanned, monitoringConfig.artist_refresh_days);

    if (!shouldScanArtist) {
        console.log(`[Scanner] Skipping artist ${artistId} scan (fresh)`);
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
        console.log(`[Scanner] Artist ${artistId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
        await scanArtistShallow(artistId, {
            ...options,
            includeSimilarArtists,
            seedSimilarArtists,
        });
    }

    let albums: any[] = [];
    if (shouldHydrateCatalog) {
        // 1. Fetch artist page layout for module assignments
        let albumModuleMap: Map<string, string> = new Map();
        let pageData: any = null;
        try {
            pageData = await getArtistPage(artistId);
            if (pageData?.rows) {
                albumModuleMap = parseArtistPageModules(pageData, artistId);
            }
            console.log(`[Scanner] Mapped ${albumModuleMap.size} albums to modules from page API`);
        } catch (e) {
            console.warn(`[Scanner] Failed to fetch page layout for ${artistId}:`, e);
        }

        // 2. Fetch videos
        const shouldRefreshArtistVideos =
            options.forceUpdate === true ||
            shouldRefreshVideos(artistId, monitoringConfig.video_refresh_days);
        if (shouldRefreshArtistVideos) {
            try {
                const videos = await getArtistVideos(artistId);
                console.log(`[Scanner] Found ${videos.length} videos for artist ${artistId}`);
                await storeVideos(artistId, videos, options);
            } catch (e) {
                console.warn(`[Scanner] Failed to fetch videos for ${artistId}:`, e);
            }
        } else {
            console.log(`[Scanner] Skipping video refresh for ${artistId} (fresh)`);
        }

        // 3. Fetch all albums (the getArtistAlbums function fetches all three endpoints)
        albums = await getArtistAlbums(artistId);
        console.log(`[Scanner] Found ${albums.length} albums for artist ${artistId}`);
        options.progress?.({ kind: 'albums_total', total: albums.length });

        // Store album metadata (sequential — DB writes + per-album module mapping)
        const cooperateAlbumStore = createCooperativeBatcher(20);
        for (let i = 0; i < albums.length; i++) {
            const album = albums[i];
            const created = await storeAlbum(album, artistId, albumModuleMap, options);
            await cooperateAlbumStore();
            options.progress?.({
                kind: 'album',
                index: i + 1,
                total: albums.length,
                albumId: album.tidal_id,
                title: album.title,
                created,
            });
        }

        // Inline album track scanning (tracks are fetched as part of
        // artist refresh, not queued as separate jobs). Uses bounded parallelism
        // since each album scan is an independent API call.
        if (shouldHydrateArtistAlbumTracks(options)) {
            // Keep nested album-track scans narrower than the scheduler thread pool so
            // the API stays responsive while artists are refreshing.
            const limit = pLimit(ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY);
            const albumsNeedingTrackScan = albums
                .map((album) => {
                    const expectedTracks = album.num_tracks || 0;
                    const existingCount = db.prepare("SELECT COUNT(*) as count FROM media WHERE album_id = ? AND type != 'Music Video'").get(album.tidal_id) as any;
                    const hasMissingTracks = expectedTracks > 0
                        ? existingCount.count < expectedTracks
                        : existingCount.count === 0;
                    const refreshState = getTrackRefreshState(album.tidal_id, monitoringConfig.track_refresh_days);

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
                console.log(`[Scanner] Scanning tracks for ${albumsNeedingTrackScan.length}/${albums.length} albums inline`);
                const trackScanTotal = albumsNeedingTrackScan.length;
                await Promise.all(albumsNeedingTrackScan.map((album, idx) => limit(async () => {
                    options.progress?.({
                        kind: 'album_tracks',
                        index: idx + 1,
                        total: trackScanTotal,
                        albumId: album.tidal_id,
                        title: album.title,
                    });
                    await scanAlbumTracks(album.tidal_id);
                })));
            }
        } else {
            console.log(`[Scanner] Skipping inline track hydration for artist ${artistId} (monitorAlbums=false)`);
        }

        // 4. Build version groups (2-level Other Versions traversal)
        console.log(`[Scanner] Building version groups for artist ${artistId}...`);
        await VersionGrouper.applyVersionGroups(artistId);

        // 5. Fix module tags — pass cached page data to avoid redundant API call
        console.log(`[Scanner] Fixing module tags for artist ${artistId}...`);
        await ModuleFixer.fixModuleTagsForArtist(artistId);
    } else {
        console.log(`[Scanner] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);
    }

    // Update last_scanned
    db.prepare(`UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?`).run(artistId);

    console.log(`[Scanner] scanArtistDeep complete for ${artistId}`);
}

// ============================================================================
// ALBUM SCANNING - MODULAR FUNCTIONS
// ============================================================================

/**
 * BASIC Album Scan - Single API call
 * Fetches: album metadata (title, cover, release_date, type, quality, etc.)
 */
export async function scanAlbumBasic(
    albumId: string,
    artistId?: string,
    moduleOverride?: string | null,
    options: ScanOptions = {}
): Promise<void> {
    console.log(`[Scanner] scanAlbumBasic for ${albumId}`);

    const monitoringConfig = getConfigSection("monitoring");
    const existingRow = db.prepare("SELECT id, last_scanned FROM albums WHERE id = ?").get(albumId) as any;
    const shouldRefreshAlbum =
        !existingRow ||
        options.forceUpdate === true ||
        isRefreshDue(existingRow?.last_scanned, monitoringConfig.album_refresh_days);

    if (existingRow && !shouldRefreshAlbum) {
        console.log(`[Scanner] scanAlbumBasic skipped for ${albumId} (fresh)`);
        return;
    }

    const albumData = await getAlbum(albumId);
    const forceUpdate = options.forceUpdate === true;

    // Ensure primary artist exists
    const primaryArtistId = albumData.artist_id || artistId;
    if (primaryArtistId) {
        const artistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(primaryArtistId);
        if (!artistExists) {
            const primaryArtistName = albumData.artist_name || 'Unknown Artist';
            db.prepare(`INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)`)
                .run(primaryArtistId, primaryArtistName, resolveArtistFolder(primaryArtistName));
        }
    }

    const existing = db.prepare("SELECT id, monitor, monitor_lock FROM albums WHERE id = ?").get(albumId) as any;
    const existingModuleRow = artistId
        ? (db.prepare("SELECT module FROM album_artists WHERE album_id = ? AND artist_id = ?").get(albumId, artistId) as any)
        : null;
    const module = moduleOverride ?? existingModuleRow?.module ?? null;

    if (!existing) {
        db.prepare(`
            INSERT INTO albums (
                id, artist_id, title, version, release_date, type, explicit, quality,
                cover, vibrant_color, video_cover,
                num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                mb_primary, mb_secondary, monitor, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            albumId,
            primaryArtistId,
            albumData.title,
            albumData.version || null,
            albumData.release_date,
            albumData.type || 'ALBUM',
            albumData.explicit ? 1 : 0,
            albumData.quality,
            albumData.cover,
            albumData.vibrant_color || null,
            albumData.video_cover || null,
            albumData.num_tracks || 0,
            albumData.num_volumes || 1,
            albumData.num_videos || 0,
            albumData.duration || 0,
            albumData.popularity || null,
            albumData.copyright || null,
            albumData.upc || null,
            getMusicBrainzPrimary(albumData.type, module, albumData.title),
            getMusicBrainzSecondary(albumData.type, module, albumData.title),
            0 // monitor defaults to false
        );
    } else {
        const updateSql = forceUpdate
            ? `
            UPDATE albums SET
                artist_id=?,
                title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                cover=?, vibrant_color=?, video_cover=?,
                num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=?
        `
            : `
            UPDATE albums SET
                artist_id=COALESCE(?, artist_id),
                title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=?
        `;

        db.prepare(updateSql).run(
            primaryArtistId ?? null,
            albumData.title,
            albumData.version || null,
            albumData.release_date,
            albumData.type || 'ALBUM',
            albumData.explicit ? 1 : 0,
            albumData.quality,
            albumData.cover,
            albumData.vibrant_color || null,
            albumData.video_cover || null,
            albumData.num_tracks || 0,
            albumData.num_volumes || 1,
            albumData.num_videos || 0,
            albumData.duration || 0,
            albumData.popularity || null,
            albumData.copyright || null,
            albumData.upc || null,
            getMusicBrainzPrimary(albumData.type, module, albumData.title),
            getMusicBrainzSecondary(albumData.type, module, albumData.title),
            albumId
        );
    }

    const includeSimilar = options.includeSimilarAlbums !== false || options.seedSimilarAlbums === true;
    const similarAlbums = includeSimilar
        ? await storeSimilarAlbums(albumId, forceUpdate)
        : [];

    if (options.seedSimilarAlbums !== false) {
        for (const similar of similarAlbums) {
            try {
                await scanArtistShallow(similar.artistId, {
                    monitorArtist: false,
                    includeSimilarArtists: false,
                    seedSimilarArtists: false,
                });
                await scanAlbumShallow(similar.albumId, {
                    includeSimilarAlbums: false,
                    seedSimilarAlbums: false,
                });
            } catch (e) {
                console.warn(`[Scanner] Failed to seed similar album ${similar.albumId}:`, e);
            }
        }
    }

    console.log(`[Scanner] scanAlbumBasic complete for ${albumId}`);
}

/**
 * SHALLOW Album Scan - Tracks and review
 * Requires: BASIC scan completed
 * Fetches: tracks, review
 */
export async function scanAlbumShallow(albumId: string, options: ScanOptions = {}): Promise<void> {
    console.log(`[Scanner] scanAlbumShallow for ${albumId}`);

    const monitoringConfig = getConfigSection("monitoring");
    const existing = db.prepare(`SELECT review_text, last_scanned FROM albums WHERE id = ?`).get(albumId) as any;
    const shouldRefreshAlbumMeta =
        options.forceUpdate === true ||
        !existing ||
        isRefreshDue(existing?.last_scanned, monitoringConfig.album_refresh_days);

    if (shouldRefreshAlbumMeta) {
        await scanAlbumBasic(albumId, undefined, undefined, options);
    } else {
        console.log(`[Scanner] Skipping album metadata refresh for ${albumId} (fresh)`);
    }

    const shouldRefreshTrackList =
        options.forceUpdate === true ||
        shouldRefreshTracks(albumId, monitoringConfig.track_refresh_days);
    if (shouldRefreshTrackList) {
        await scanAlbumTracks(albumId);
    } else {
        console.log(`[Scanner] Skipping track refresh for album ${albumId} (fresh)`);
    }

    const shouldRefreshReview =
        options.forceUpdate === true ||
        existing?.review_text == null ||
        shouldRefreshAlbumMeta;

    if (shouldRefreshReview) {
        try {
            const review = await getAlbumReview(albumId);
            const reviewText = review?.text ?? null;
            const reviewSource = review?.source ?? null;
            const reviewUpdated = review?.lastUpdated ?? null;

            if (review !== null && review !== undefined) {
                db.prepare(`
                    UPDATE albums
                    SET review_text = ?, review_source = ?, review_last_updated = ?
                    WHERE id = ?
                `).run(reviewText ?? '', reviewSource, reviewUpdated, albumId);
            } else if (options.forceUpdate === true || existing?.review_text == null) {
                // Mark that we tried (prevents repeated 404 calls on every page load)
                db.prepare(`
                    UPDATE albums
                    SET review_text = ?, review_source = ?, review_last_updated = ?
                    WHERE id = ?
                `).run('', reviewSource, reviewUpdated, albumId);
            }
        } catch (e) {
            console.warn(`[Scanner] Failed to fetch review for album ${albumId}:`, e);
        }
    } else {
        console.log(`[Scanner] Skipping review refresh for album ${albumId} (fresh)`);
    }

    console.log(`[Scanner] scanAlbumShallow complete for ${albumId}`);
}

/**
 * DEEP Album Scan - Credits
 * Requires: SHALLOW scan completed
 * Fetches: credits
 */
export async function scanAlbumDeep(albumId: string, options: ScanOptions = {}): Promise<void> {
    console.log(`[Scanner] scanAlbumDeep for ${albumId}`);

    // Ensure SHALLOW exists
    const currentLevel = getAlbumScanLevel(albumId);
    if (options.forceUpdate || currentLevel < ScanLevel.SHALLOW) {
        console.log(`[Scanner] Album ${albumId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
        await scanAlbumShallow(albumId, options);
    }

    // Fetch album-level credits
    try {
        const credits = await getAlbumCredits(albumId);
        if (credits && credits.length > 0) {
            db.prepare('UPDATE albums SET credits = ? WHERE id = ?')
                .run(JSON.stringify(credits), albumId);
        }
    } catch (e) {
        console.warn(`[Scanner] Failed to fetch credits for album ${albumId}:`, e);
    }

    // Fetch and store per-track credits in media.credits
    try {
        const trackCreditsMap = await getAlbumItemsCredits(albumId);
        if (trackCreditsMap.size > 0) {
            const updateTrackCredits = db.prepare('UPDATE media SET credits = ? WHERE id = ? AND album_id = ?');
            db.transaction(() => {
                for (const [trackId, credits] of trackCreditsMap) {
                    updateTrackCredits.run(JSON.stringify(credits), trackId, albumId);
                }
            })();
        }
    } catch (e) {
        console.warn(`[Scanner] Failed to fetch per-track credits for album ${albumId}:`, e);
    }

    db.prepare(`UPDATE albums SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?`).run(albumId);

    console.log(`[Scanner] scanAlbumDeep complete for ${albumId}`);
}

/**
 * SHALLOW Playlist Scan - playlist metadata and track membership.
 *
 * Fetches TIDAL playlist metadata, updates/creates local playlist row,
 * refreshes referenced album/media rows, and rewrites playlist_tracks.
 */
type PlaylistTrackValidationState = 'valid' | 'empty' | 'partial' | 'malformed';

interface PlaylistTrackValidationEntry {
    trackId: number;
    position: number;
    albumId: string | null;
}

interface PlaylistTrackValidationResult {
    state: PlaylistTrackValidationState;
    expectedTrackCount: number;
    remoteItemCount: number;
    tracks: PlaylistTrackValidationEntry[];
    reason?: string;
}

function parsePlaylistTrackId(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function resolvePlaylistAlbumId(track: Record<string, unknown>): string | null {
    if (track.album_id !== null && track.album_id !== undefined) {
        return String(track.album_id);
    }
    if (track.albumId !== null && track.albumId !== undefined) {
        return String(track.albumId);
    }

    const albumObj = track.album;
    if (albumObj && typeof albumObj === 'object') {
        const albumId = (albumObj as { id?: unknown }).id;
        if (albumId !== null && albumId !== undefined) {
            return String(albumId);
        }
    }

    return null;
}

export function validatePlaylistTrackPayload(expectedTrackCountRaw: unknown, payload: unknown): PlaylistTrackValidationResult {
    const expectedTrackCount = Number.parseInt(String(expectedTrackCountRaw ?? 0), 10);
    if (!Number.isFinite(expectedTrackCount) || expectedTrackCount < 0) {
        return {
            state: 'malformed',
            expectedTrackCount: 0,
            remoteItemCount: 0,
            tracks: [],
            reason: `invalid metadata track count (${String(expectedTrackCountRaw ?? '')})`,
        };
    }

    const itemsRaw: unknown = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && 'items' in payload)
            ? (payload as { items?: unknown }).items
            : null;

    if (!Array.isArray(itemsRaw)) {
        return {
            state: 'malformed',
            expectedTrackCount,
            remoteItemCount: 0,
            tracks: [],
            reason: 'playlist track payload was not an array',
        };
    }

    const remoteItemCount = itemsRaw.length;
    const tracks: PlaylistTrackValidationEntry[] = [];
    let parseFailures = 0;

    for (let index = 0; index < itemsRaw.length; index += 1) {
        const source = itemsRaw[index];
        const candidate = source && typeof source === 'object' && 'item' in source
            ? (source as { item?: unknown }).item
            : source;

        if (!candidate || typeof candidate !== 'object') {
            parseFailures += 1;
            continue;
        }

        const track = candidate as Record<string, unknown>;
        const trackId = parsePlaylistTrackId(track.id);
        if (trackId === null) {
            parseFailures += 1;
            continue;
        }

        tracks.push({
            trackId,
            position: index,
            albumId: resolvePlaylistAlbumId(track),
        });
    }

    if (expectedTrackCount === 0 && remoteItemCount === 0) {
        return {
            state: 'empty',
            expectedTrackCount,
            remoteItemCount,
            tracks,
        };
    }

    if (expectedTrackCount === 0 && remoteItemCount > 0) {
        return {
            state: 'malformed',
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `metadata reports zero tracks but payload contained ${remoteItemCount} item(s)`,
        };
    }

    if (expectedTrackCount > 0 && remoteItemCount === 0) {
        return {
            state: 'malformed',
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `metadata reports ${expectedTrackCount} track(s) but payload was empty`,
        };
    }

    if (tracks.length === 0) {
        return {
            state: 'malformed',
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `no parseable track ids in ${remoteItemCount} payload item(s)`,
        };
    }

    if (parseFailures > 0) {
        return {
            state: 'partial',
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `${parseFailures} payload item(s) missing a parseable track id`,
        };
    }

    if (remoteItemCount !== expectedTrackCount) {
        return {
            state: 'partial',
            expectedTrackCount,
            remoteItemCount,
            tracks,
            reason: `metadata expected ${expectedTrackCount} track(s) but payload returned ${remoteItemCount}`,
        };
    }

    return {
        state: 'valid',
        expectedTrackCount,
        remoteItemCount,
        tracks,
    };
}

export async function scanPlaylist(playlistId: string, options?: { forceUpdate?: boolean }): Promise<void> {
    console.log(`[Scanner] scanPlaylist for ${playlistId}`);

    const forceUpdate = options?.forceUpdate === true;
    const tidalPlaylist = await getPlaylist(playlistId);
    if (!tidalPlaylist) {
        console.warn(`[Scanner] Playlist ${playlistId} not found on TIDAL`);
        return;
    }

    const resolvedPlaylistUuid = String(tidalPlaylist.uuid || playlistId);

    const playlistTrackResponse = await getPlaylistTracks(playlistId);
    const validation = validatePlaylistTrackPayload(tidalPlaylist.numberOfTracks, playlistTrackResponse);

    if (validation.state === 'malformed') {
        const reason = validation.reason || 'invalid payload';
        console.warn(`[Scanner] Playlist ${playlistId}: malformed track payload (${reason})`);
        throw new Error(`[Scanner] Playlist ${playlistId} failed fail-closed validation: ${reason}`);
    }

    if (validation.state === 'partial') {
        const reason = validation.reason || 'partial payload coverage';
        console.warn(`[Scanner] Playlist ${playlistId}: partial track payload (${reason})`);
        throw new Error(`[Scanner] Playlist ${playlistId} fail-closed: ${reason}`);
    }

    const upsertPlaylistMetadata = db.prepare(`
        INSERT INTO playlists (
            uuid, tidal_id, title, description, creator_name, creator_id,
            cover_id, square_cover_id, num_tracks, num_videos, duration,
            created, last_updated, type, public_playlist, monitored, downloaded,
            user_date_added, last_scanned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(uuid) DO UPDATE SET
            tidal_id = excluded.tidal_id,
            title = excluded.title,
            description = excluded.description,
            creator_name = excluded.creator_name,
            creator_id = excluded.creator_id,
            cover_id = excluded.cover_id,
            square_cover_id = excluded.square_cover_id,
            num_tracks = excluded.num_tracks,
            num_videos = excluded.num_videos,
            duration = excluded.duration,
            created = excluded.created,
            last_updated = excluded.last_updated,
            type = excluded.type,
            public_playlist = excluded.public_playlist,
            last_scanned = CURRENT_TIMESTAMP
    `);

    const playlistMetadataValues = [
        resolvedPlaylistUuid,
        String(tidalPlaylist.uuid || playlistId),
        tidalPlaylist.title || 'Unknown Playlist',
        tidalPlaylist.description || null,
        tidalPlaylist.creator?.name || null,
        tidalPlaylist.creator?.id != null ? String(tidalPlaylist.creator.id) : null,
        tidalPlaylist.image || null,
        tidalPlaylist.squareImage || null,
        Number(tidalPlaylist.numberOfTracks || 0),
        Number(tidalPlaylist.numberOfVideos || 0),
        Number(tidalPlaylist.duration || 0),
        tidalPlaylist.created || null,
        tidalPlaylist.lastUpdated || null,
        tidalPlaylist.type || 'PLAYLIST',
        tidalPlaylist.publicPlaylist ? 1 : 0,
    ];

    const deletePlaylistTracks = db.prepare('DELETE FROM playlist_tracks WHERE playlist_uuid = ?');

    const writeEmptyPlaylist = db.transaction(() => {
        upsertPlaylistMetadata.run(...playlistMetadataValues);
        deletePlaylistTracks.run(resolvedPlaylistUuid);
    });

    if (validation.state === 'empty') {
        writeEmptyPlaylist();
        console.log(`[Scanner] Playlist ${playlistId}: remote playlist is empty; metadata refreshed and local playlist tracks cleared`);
        return;
    }

    const tracks = validation.tracks;
    console.log(`[Scanner] Fetched ${tracks.length} tracks for playlist ${playlistId}`);

    const albumIds = new Set<string>();
    for (const track of tracks) {
        if (track.albumId) {
            albumIds.add(track.albumId);
        }
    }

    for (const albumId of albumIds) {
        try {
            await scanAlbumShallow(albumId, {
                forceUpdate,
                includeSimilarAlbums: false,
                seedSimilarAlbums: false,
            });
        } catch (error) {
            console.warn(`[Scanner] Failed to scan album ${albumId} for playlist ${playlistId}:`, error);
        }
    }

    const mediaExists = db.prepare('SELECT 1 FROM media WHERE id = ? LIMIT 1');
    const missingLocalTrackIds = new Set<number>();

    for (const track of tracks) {
        const exists = mediaExists.get(track.trackId);
        if (!exists) {
            missingLocalTrackIds.add(track.trackId);
        }
    }

    if (missingLocalTrackIds.size > 0) {
        console.warn(
            `[Scanner] Playlist ${playlistId}: fail-closed partial local coverage (${missingLocalTrackIds.size} missing local media row(s))`,
        );
        throw new Error(
            `[Scanner] Playlist ${playlistId} fail-closed: missing ${missingLocalTrackIds.size} local media row(s) for remote track ids`,
        );
    }

    const insertPlaylistTrack = db.prepare(
        'INSERT INTO playlist_tracks (playlist_uuid, track_id, position) VALUES (?, ?, ?)'
    );

    const writePlaylistMembership = db.transaction((entries: PlaylistTrackValidationEntry[]) => {
        upsertPlaylistMetadata.run(...playlistMetadataValues);
        deletePlaylistTracks.run(resolvedPlaylistUuid);
        for (const entry of entries) {
            insertPlaylistTrack.run(resolvedPlaylistUuid, entry.trackId, entry.position);
        }
    });

    writePlaylistMembership(tracks);
    console.log(`[Scanner] Playlist ${playlistId}: full replace path (${tracks.length} tracks)`);

    console.log(`[Scanner] scanPlaylist complete for ${playlistId}`);
}

/**
 * Seed a single track into the local database without triggering a deep artist crawl.
 * This is used by add-track flows that need album metadata and track rows promptly.
 */
export async function seedTrack(trackId: string, options: ScanOptions = {}) {
    const trackData = await getTrack(trackId);
    const artistId = trackData.artist_id?.toString?.() ?? String(trackData.artist_id ?? '');
    const albumId = trackData.album_id?.toString?.() ?? String(trackData.album_id ?? '');

    if (!artistId || !albumId) {
        throw new Error("Track missing artist or album info");
    }

    await scanArtistBasic(artistId, {
        ...options,
        includeSimilarArtists: false,
        seedSimilarArtists: false,
    });

    await scanAlbumShallow(albumId, {
        ...options,
        includeSimilarAlbums: false,
        seedSimilarAlbums: false,
    });

    return trackData;
}

/**
 * Seed a single music video without forcing a full artist scan.
 * Only the required artist/album rows are fetched so the UI can return quickly.
 */
export async function seedVideo(videoId: string, options: ScanOptions = {}) {
    const videoData = await getVideo(videoId);
    const artistId = videoData.artist_id?.toString?.() ?? String(videoData.artist_id ?? '');
    const albumId = videoData.album_id?.toString?.() ?? String(videoData.album_id ?? '');

    if (!artistId) {
        throw new Error("Video missing artist info");
    }

    await scanArtistBasic(artistId, {
        ...options,
        includeSimilarArtists: false,
        seedSimilarArtists: false,
    });

    if (albumId) {
        await scanAlbumBasic(albumId, artistId, undefined, {
            ...options,
            includeSimilarAlbums: false,
            seedSimilarAlbums: false,
        });
    }

    await storeVideos(artistId, [{ ...videoData, album_id: albumId || null }], options);
    return videoData;
}

/**
 * Scan album tracks - used by SHALLOW scan
 */
async function scanAlbumTracks(albumId: string): Promise<void> {
    const tracks = await getAlbumTracks(albumId);
    console.log(`[Scanner] Fetched ${tracks.length} tracks for album ${albumId}`);

    const album = db.prepare("SELECT id, artist_id, type, monitor FROM albums WHERE id = ?").get(albumId) as any;
    if (!album) {
        console.warn(`[Scanner] Album ${albumId} not found, skipping tracks`);
        return;
    }

    const trackInsert = db.prepare(`
        INSERT INTO media (
            id, artist_id, album_id, title, version, release_date, type, explicit, quality,
            track_number, volume_number, duration, popularity,
            bpm, key, key_scale, peak, replay_gain,
            credits, copyright, isrc, monitor, last_scanned, downloaded
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
    `);

    const trackUpdate = db.prepare(`
        UPDATE media SET
            artist_id=?,
            title=?, version=?, release_date=?, explicit=?, quality=?,
            track_number=?, volume_number=?, duration=?, popularity=?,
            bpm=?, key=?, key_scale=?, peak=?, replay_gain=?,
            credits=?, copyright=?, last_scanned=CURRENT_TIMESTAMP
        WHERE id=? AND album_id=?
    `);

    const selectArtist = db.prepare("SELECT id FROM artists WHERE id = ?");
    const insertArtist = db.prepare(`INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)`);
    const selectMedia = db.prepare("SELECT id, monitor, monitor_lock FROM media WHERE id = ? AND album_id = ?");

    const cooperateTrackStore = createCooperativeBatcher(25);
    const trackBatch: any[] = [];
    for (const track of tracks) {
        const trackArtistId = track.artist_id || album.artist_id;
        track.artist_id = trackArtistId;
        trackBatch.push(track);

        // Flush batch every 25 tracks or at the end
        if (trackBatch.length >= 25 || track === tracks[tracks.length - 1]) {
            db.transaction(() => {
                for (const t of trackBatch) {
                    const tArtistId = t.artist_id;

                    // Ensure track artist exists
                    if (tArtistId && tArtistId !== album.artist_id) {
                        const artistExists = selectArtist.get(tArtistId);
                        if (!artistExists) {
                            let artistName = 'Unknown Artist';
                            if (t.artists && Array.isArray(t.artists)) {
                                const found = t.artists.find((a: any) => String(a.id) === String(tArtistId));
                                if (found) artistName = found.name;
                            }
                            insertArtist.run(tArtistId, artistName, resolveArtistFolder(artistName));
                        }
                    }

                    const exists = selectMedia.get(t.tidal_id, albumId) as any;

                    let shouldMonitor = exists?.monitor || (album?.monitor ? 1 : 0);
                    if (exists?.monitor_lock) {
                        shouldMonitor = exists.monitor;
                    }

                    if (!exists) {
                        trackInsert.run(
                            t.tidal_id,
                            tArtistId,
                            albumId,
                            t.title,
                            t.version || null,
                            t.release_date || null,
                            album.type,
                            t.explicit ? 1 : 0,
                            t.quality,
                            t.track_number || 0,
                            t.volume_number || 1,
                            t.duration,
                            t.popularity || 0,
                            t.bpm || null,
                            t.key || null,
                            t.key_scale || null,
                            t.peak || null,
                            t.replay_gain || null,
                            null,
                            t.copyright || null,
                            t.isrc || null,
                            shouldMonitor
                        );
                    } else {
                        trackUpdate.run(
                            tArtistId,
                            t.title,
                            t.version || null,
                            t.release_date || null,
                            t.explicit ? 1 : 0,
                            t.quality,
                            t.track_number || 0,
                            t.volume_number || 1,
                            t.duration,
                            t.popularity || 0,
                            t.bpm || null,
                            t.key || null,
                            t.key_scale || null,
                            t.peak || null,
                            t.replay_gain || null,
                            null,
                            t.copyright || null,
                            t.tidal_id,
                            albumId
                        );
                    }

                    storeTrackArtists(t);
                }
            })();
            trackBatch.length = 0;
            await cooperateTrackStore();
        }
    }
}

// ============================================================================
// UNIFIED SCAN ENTRY POINT
// ============================================================================

/**
 * Unified scan function that dispatches to appropriate level functions
 */
export async function scan(
    targetType: ScanTargetType,
    targetId: string,
    level: ScanLevel,
    options: ScanOptions = {}
): Promise<void> {
    if (targetType === ScanTargetType.ARTIST) {
        switch (level) {
            case ScanLevel.BASIC:
                await scanArtistBasic(targetId, options);
                break;
            case ScanLevel.SHALLOW:
                await scanArtistShallow(targetId, options);
                break;
            case ScanLevel.DEEP:
                await scanArtistDeep(targetId, options);
                break;
        }
    } else if (targetType === ScanTargetType.ALBUM) {
        switch (level) {
            case ScanLevel.BASIC:
                await scanAlbumBasic(targetId, undefined, undefined, options);
                break;
            case ScanLevel.SHALLOW:
                await scanAlbumShallow(targetId, options);
                break;
            case ScanLevel.DEEP:
                await scanAlbumDeep(targetId, options);
                break;
        }
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse artist page modules to build album-to-module map
 */
function parseArtistPageModules(pageData: any, artistId: string): Map<string, string> {
    const albumModuleMap = new Map<string, string>();

    for (const row of pageData.rows || []) {
        for (const module of row.modules || []) {
            const items = module.pagedList?.items || module.items || [];
            const moduleType = module.type;
            const moduleTitle = (module.title || '').toLowerCase();

            if (items.length > 0) {
                // Only override categories that cannot be derived reliably from album.type alone
                // (e.g., LIVE vs regular ALBUM, artist COMPILATION albums, DJ mixes).
                let normalizedModule: string | null = null;

                if (moduleTitle.includes('live')) {
                    normalizedModule = 'LIVE';
                } else if (moduleTitle.includes('compilation')) {
                    normalizedModule = 'COMPILATION';
                } else if (moduleTitle.includes('appears')) {
                    normalizedModule = 'APPEARS_ON';
                } else if (moduleTitle.includes('mix') || moduleTitle.includes('dj')) {
                    normalizedModule = 'DJ_MIXES';
                } else if (moduleTitle.includes('remix')) {
                    normalizedModule = 'REMIX';
                }

                if (normalizedModule) {
                    for (const item of items) {
                        if (item.id) {
                            albumModuleMap.set(item.id.toString(), normalizedModule);
                        }
                    }
                }
            }

        }
    }

    return albumModuleMap;
}

/**
 * Store videos for an artist
 */
async function storeVideos(artistId: string, videos: any[], options: ScanOptions): Promise<void> {
    const forceUpdate = options.forceUpdate === true;
    const videoInsert = db.prepare(`
        INSERT INTO media (
            id, artist_id, album_id, title, duration, release_date, version,
            explicit, type, quality, popularity, cover, monitor, last_scanned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const videoUpdate = db.prepare(`
        UPDATE media SET
            title=?, duration=?, release_date=?, version=?,
            explicit=?, quality=?, popularity=?,
            ${forceUpdate ? "cover=?" : "cover=COALESCE(?, cover)"},
            last_scanned=CURRENT_TIMESTAMP
        WHERE id=? AND type='Music Video'
    `);

    const selectVideo = db.prepare("SELECT id, monitor, monitor_lock FROM media WHERE id = ? AND type='Music Video'");

    db.transaction(() => {
        for (const video of videos) {
            const exists = selectVideo.get(video.tidal_id) as any;

            let shouldMonitor = exists?.monitor || 0;
            if (exists?.monitor_lock) {
                shouldMonitor = exists.monitor;
            }

            const quality = video.quality || 'MP4_1080P';
            const cover = video.image_id || null;

            if (!exists) {
                videoInsert.run(
                    video.tidal_id,
                    artistId,
                    video.album_id || null,
                    video.title,
                    video.duration,
                    video.release_date,
                    video.version || null,
                    video.explicit ? 1 : 0,
                    quality,
                    video.popularity || 0,
                    cover,
                    shouldMonitor
                );
            } else {
                videoUpdate.run(
                    video.title,
                    video.duration,
                    video.release_date,
                    video.version || null,
                    video.explicit ? 1 : 0,
                    quality,
                    video.popularity || 0,
                    cover,
                    video.tidal_id
                );
            }
        }
    })();
}

/**
 * Store an album (used during DEEP artist scan)
 */
async function storeAlbum(
    album: any,
    scanningArtistId: string,
    albumModuleMap: Map<string, string>,
    options: ScanOptions
): Promise<boolean> {
    const forceUpdate = options.forceUpdate === true;
    const primaryArtistId = album.artist_id;

    // Ensure primary artist exists
    const artistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(primaryArtistId);
    if (!artistExists && primaryArtistId !== scanningArtistId) {
        const primaryArtistName = album.artist_name || 'Unknown Artist';
        db.prepare(`INSERT INTO artists (id, name, monitor, path) VALUES (?, ?, 0, ?)`)
            .run(primaryArtistId, primaryArtistName, resolveArtistFolder(primaryArtistName));
    }

    const exists = db.prepare("SELECT id, monitor, monitor_lock FROM albums WHERE id = ?").get(album.tidal_id) as any;

    const shouldMonitor = exists?.monitor || 0;

    const moduleFromPage = albumModuleMap.get(album.tidal_id) || album._module || null;

    if (!exists) {
        db.prepare(`
            INSERT INTO albums (
                id, artist_id, title, version, release_date, type, explicit, quality,
                cover, vibrant_color, video_cover,
                num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                mb_primary, mb_secondary, monitor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            album.tidal_id,
            primaryArtistId,
            album.title,
            album.version || null,
            album.release_date,
            album.type || 'ALBUM',
            album.explicit ? 1 : 0,
            album.quality,
            album.cover,
            album.vibrant_color || null,
            album.video_cover || null,
            album.num_tracks || 0,
            album.num_volumes || 1,
            album.num_videos || 0,
            album.duration || 0,
            album.popularity || null,
            album.copyright || null,
            album.upc || null,
            getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
            getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
            shouldMonitor
        );
    } else {
        const updateSql = forceUpdate
            ? `
            UPDATE albums SET
                artist_id=?,
                title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                cover=?, vibrant_color=?, video_cover=?,
                num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=?
        `
            : `
            UPDATE albums SET
                artist_id=COALESCE(?, artist_id),
                title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=?
        `;

        db.prepare(updateSql).run(
            primaryArtistId ?? null,
            album.title,
            album.version || null,
            album.release_date,
            album.type || 'ALBUM',
            album.explicit ? 1 : 0,
            album.quality,
            album.cover,
            album.vibrant_color || null,
            album.video_cover || null,
            album.num_tracks || 0,
            album.num_volumes || 1,
            album.num_videos || 0,
            album.duration || 0,
            album.popularity || null,
            album.copyright || null,
            album.upc || null,
            getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
            getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
            album.tidal_id
        );
    }

    // Handle album_artists relationship.
    // group_type/module are artist-page classifications, so only the scanning artist's row
    // should be rewritten from this scan context. Other related artists keep their own
    // classification until they are scanned directly.
    const albumGroup = album._group_type || album._group || 'ALBUMS';

    const upsertScannedRelation = db.prepare(`
        INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist_id, album_id) DO UPDATE SET
            artist_name = COALESCE(excluded.artist_name, album_artists.artist_name),
            ord = COALESCE(excluded.ord, album_artists.ord),
            type = excluded.type,
            group_type = excluded.group_type,
            module = excluded.module
    `);

    const upsertRelatedRelation = db.prepare(`
        INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist_id, album_id) DO UPDATE SET
            artist_name = COALESCE(excluded.artist_name, album_artists.artist_name),
            ord = COALESCE(excluded.ord, album_artists.ord),
            type = excluded.type,
            group_type = COALESCE(album_artists.group_type, excluded.group_type),
            module = COALESCE(album_artists.module, excluded.module)
    `);

    const participants = new Map<string, { name: string | null; ord: number | null }>();
    const setParticipant = (artistId: string, name: string | null, ord: number | null) => {
        if (!artistId) return;
        const key = String(artistId);
        if (!participants.has(key)) {
            participants.set(key, { name, ord });
            return;
        }

        const current = participants.get(key)!;
        participants.set(key, {
            name: current.name || name,
            ord: current.ord ?? ord,
        });
    };

    setParticipant(scanningArtistId, scanningArtistId === primaryArtistId ? album.artist_name || null : null, 0);
    setParticipant(primaryArtistId, album.artist_name || null, 0);

    if (album.artists && Array.isArray(album.artists)) {
        for (let index = 0; index < album.artists.length; index += 1) {
            const artist = album.artists[index];
            const otherArtistId = artist?.id?.toString?.() ?? String(artist?.id ?? '');
            if (!otherArtistId || otherArtistId === 'undefined' || otherArtistId === 'null') continue;
            setParticipant(otherArtistId, artist?.name || null, index);
        }
    }

    // Always link the scanning artist to every album returned by the artist endpoints.
    // This is required for page-db queries (`WHERE aa.artist_id = ?`) to work for "Appears On" albums.
    const scanningType = primaryArtistId === scanningArtistId ? 'MAIN' : 'APPEARS_ON';
    const scanningParticipant = participants.get(String(scanningArtistId));
    upsertScannedRelation.run(
        album.tidal_id,
        scanningArtistId,
        scanningParticipant?.name || null,
        scanningParticipant?.ord ?? null,
        scanningType,
        albumGroup,
        moduleFromPage,
    );

    // Link the album's primary artist as well.
    if (primaryArtistId && primaryArtistId !== scanningArtistId) {
        const primaryParticipant = participants.get(String(primaryArtistId));
        upsertRelatedRelation.run(
            album.tidal_id,
            primaryArtistId,
            primaryParticipant?.name || album.artist_name || null,
            primaryParticipant?.ord ?? 0,
            'MAIN',
            null,
            null,
        );
    }

    // Add other artists (best-effort)
    if (album.artists && Array.isArray(album.artists)) {
        for (const artist of album.artists) {
            const otherArtistId = artist?.id?.toString?.() ?? String(artist?.id ?? '');
            if (!otherArtistId || otherArtistId === 'undefined' || otherArtistId === 'null') continue;
            if (otherArtistId !== scanningArtistId && otherArtistId !== primaryArtistId) {
                const otherArtistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(otherArtistId);
                if (!otherArtistExists) {
                    const otherArtistName = artist.name || 'Unknown Artist';
                    db.prepare(`INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)`)
                        .run(otherArtistId, otherArtistName, resolveArtistFolder(otherArtistName));
                }
                const participant = participants.get(otherArtistId);
                upsertRelatedRelation.run(
                    album.tidal_id,
                    otherArtistId,
                    participant?.name || artist.name || null,
                    participant?.ord ?? null,
                    'MAIN',
                    null,
                    null,
                );
            }
        }
    }

    return !exists;
}

/**
 * Store track artists in media_artists table
 */
function storeTrackArtists(track: any): void {
    const mediaId = track?.tidal_id?.toString?.() ?? String(track?.tidal_id ?? '');
    if (!mediaId) return;

    db.prepare(`DELETE FROM media_artists WHERE media_id = ?`).run(mediaId);

    let trackArtists = [];
    try {
        trackArtists = typeof track.artists === 'string'
            ? JSON.parse(track.artists)
            : (track.artists || []);
    } catch (e) {
        trackArtists = [];
    }

    if (!Array.isArray(trackArtists)) trackArtists = [];

    const primaryArtistId = track?.artist_id?.toString?.() ?? String(track?.artist_id ?? '');
    const primaryArtistName = track?.artist_name || null;

    const upsertArtist = db.prepare(`
        INSERT INTO artists (id, name, picture, popularity, monitor, path)
        VALUES (?, ?, ?, 0, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = CASE
                WHEN artists.name = 'Unknown Artist' AND excluded.name <> 'Unknown Artist' THEN excluded.name
                ELSE artists.name
            END,
            picture = COALESCE(artists.picture, excluded.picture),
            path = COALESCE(artists.path, excluded.path)
    `);

    const insertMediaArtist = db.prepare(`
        INSERT INTO media_artists (media_id, artist_id, type) VALUES (?, ?, ?)
    `);

    const normalizeRole = (value: unknown): 'MAIN' | 'FEATURED' | null => {
        if (value === null || value === undefined) return null;
        const normalized = String(value).trim().toUpperCase();
        if (!normalized) return null;
        if (normalized === 'MAIN' || normalized === 'PRIMARY') return 'MAIN';
        if (normalized === 'FEATURED' || normalized === 'FEATURE') return 'FEATURED';
        return null;
    };

    const byArtistId = new Map<string, { name: string; picture: string | null; type: 'MAIN' | 'FEATURED' }>();

    for (const artist of trackArtists) {
        const artistId = artist?.id?.toString?.() ?? String(artist?.id ?? '');
        if (!artistId || artistId === 'undefined' || artistId === 'null') continue;

        const roleFromApi = normalizeRole(artist?.type);
        const inferredRole: 'MAIN' | 'FEATURED' =
            roleFromApi ?? (primaryArtistId && artistId === primaryArtistId ? 'MAIN' : 'FEATURED');

        const name = artist?.name || (artistId === primaryArtistId ? (primaryArtistName || 'Unknown Artist') : 'Unknown Artist');
        const picture = artist?.picture || null;

        const existing = byArtistId.get(artistId);
        if (!existing) {
            byArtistId.set(artistId, { name, picture, type: inferredRole });
            continue;
        }

        // Prefer keeping MAIN if we see it anywhere.
        const mergedType: 'MAIN' | 'FEATURED' = (existing.type === 'MAIN' || inferredRole === 'MAIN') ? 'MAIN' : 'FEATURED';
        byArtistId.set(artistId, {
            name: existing.name !== 'Unknown Artist' ? existing.name : name,
            picture: existing.picture ?? picture,
            type: mergedType,
        });
    }

    // Ensure primary artist is always present as MAIN.
    if (primaryArtistId && !byArtistId.has(primaryArtistId)) {
        byArtistId.set(primaryArtistId, {
            name: primaryArtistName || 'Unknown Artist',
            picture: null,
            type: 'MAIN',
        });
    }

    const tx = db.transaction(() => {
        for (const [artistId, info] of byArtistId) {
            const artistName = info.name || 'Unknown Artist';
            upsertArtist.run(artistId, artistName, info.picture, resolveArtistFolder(artistName));
            insertMediaArtist.run(mediaId, artistId, info.type);
        }
    });

    tx();
}

// ============================================================================
// MUSICBRAINZ TYPE FUNCTIONS
// ============================================================================

function getMusicBrainzPrimary(tidalType: string | undefined, module: string | undefined, title: string = ''): string {
    if (getMusicBrainzSecondary(tidalType, module, title) !== null) {
        return 'album';
    }
    const type = (tidalType || 'ALBUM').toUpperCase();
    switch (type) {
        case 'SINGLE': return 'single';
        case 'EP': return 'ep';
        case 'ALBUM':
        default: return 'album';
    }
}

function getMusicBrainzSecondary(tidalType: string | undefined, module: string | undefined, title: string = ''): string | null {
    const normalizedModule = (module || '').toUpperCase();
    const lowerTitle = (title || '').toLowerCase();

    // Module-based detection (from artist page) - LIVE and COMPILATION only via module
    if (normalizedModule === 'LIVE' || normalizedModule === 'ARTIST_LIVE_ALBUMS') return 'live';
    if (normalizedModule === 'COMPILATION' || normalizedModule === 'ARTIST_COMPILATIONS') return 'compilation';
    if (normalizedModule === 'DJ_MIXES') return 'dj-mix';
    // APPEARS_ON is NOT a MusicBrainz secondary type - it's a separate classification
    // (albums where artist is featured on someone else's release, not the artist's own compilation albums)
    if (normalizedModule === 'APPEARS_ON') return null;

    // Title-based detection - REMIX and SOUNDTRACK only via title
    if (lowerTitle.includes('soundtrack') || lowerTitle.includes('o.s.t.') || lowerTitle.includes('original score') || lowerTitle.includes('motion picture')) {
        return 'soundtrack';
    }
    if (lowerTitle.includes('remix') || lowerTitle.includes('remixed') || lowerTitle.includes('remixes')) {
        return 'remix';
    }

    return null;
}

