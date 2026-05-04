import { db } from "../database.js";
import {
    getArtistBio,
    getArtistSimilar,
} from "./providers/tidal/tidal.js";
import { ModuleFixer } from "./module-fixer.js";
import { VersionGrouper } from "./version-grouper.js";
import { getConfigSection } from "./config.js";
import { shouldHydrateArtistAlbumTracks, shouldHydrateArtistCatalog } from "./scan-policy.js";
import { createCooperativeBatcher } from "../utils/concurrent.js";
import pLimit from "p-limit";
import { readIntEnv } from "../utils/env.js";
import {
    resolveArtistFolderForPersistence,
    resolveArtistFolderFromTemplate,
    shouldReapplyArtistPathTemplate,
} from "./artist-paths.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { ScanLevel, type ScanOptions } from "./scan-types.js";
import { getTrackRefreshState, isRefreshDue, shouldRefreshVideos } from "./scan-refresh-state.js";
import { MetadataIdentityService } from "./metadata-identity-service.js";
import { lidarrMetadataService } from "./metadata/lidarr-metadata-service.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type ProviderReleaseGroupMatch,
} from "./metadata/provider-release-group-matcher.js";
import { providerManager } from "./providers/index.js";
import type { IProvider, ProviderAlbum, ProviderArtist, ProviderVideo } from "./providers/provider-interface.js";
import { ReleaseGroupSlotService } from "./release-group-slot-service.js";

const ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY = readIntEnv(
    "DISCOGENIUS_ARTIST_ALBUM_TRACK_SCAN_CONCURRENCY",
    1,
    1,
);

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMusicBrainzMbid(value: string | number | null | undefined): boolean {
    return MUSICBRAINZ_MBID_RE.test(String(value || "").trim());
}

function providerAlbumToLegacyAlbumRow(providerAlbum: ProviderAlbum, fallbackArtistId: string): any {
    const raw = providerAlbum.raw;
    if (raw && typeof raw === "object" && "tidal_id" in raw) {
        return raw;
    }

    return {
        tidal_id: providerAlbum.providerId,
        artist_id: providerAlbum.artist?.providerId || fallbackArtistId,
        artist_name: providerAlbum.artist?.name || "Unknown Artist",
        artists: providerAlbum.artist ? [{ id: providerAlbum.artist.providerId, name: providerAlbum.artist.name }] : [],
        title: providerAlbum.title || "Unknown Album",
        release_date: providerAlbum.releaseDate || null,
        cover: providerAlbum.cover || null,
        vibrant_color: null,
        video_cover: null,
        num_tracks: providerAlbum.trackCount || 0,
        num_videos: 0,
        num_volumes: providerAlbum.volumeCount || 1,
        duration: providerAlbum.duration || 0,
        type: providerAlbum.type || "ALBUM",
        version: providerAlbum.version || null,
        explicit: providerAlbum.explicit || false,
        quality: providerAlbum.quality || "LOSSLESS",
        url: providerAlbum.url || null,
        popularity: 0,
        copyright: null,
        upc: providerAlbum.upc || null,
        _group_type: "ALBUMS",
        _module: providerAlbum.type === "EP" ? "EP" : providerAlbum.type === "SINGLE" ? "SINGLE" : "ALBUM",
    };
}

function providerVideoToLegacyVideoRow(providerVideo: ProviderVideo, fallbackArtistId: string): any {
    const raw = providerVideo.raw;
    if (raw && typeof raw === "object" && "tidal_id" in raw) {
        return raw;
    }

    return {
        tidal_id: providerVideo.providerId,
        title: providerVideo.title,
        duration: providerVideo.duration || 0,
        release_date: providerVideo.releaseDate || null,
        explicit: providerVideo.explicit || false,
        quality: providerVideo.quality || "MP4_1080P",
        image_id: providerVideo.cover || null,
        artist_id: providerVideo.artist?.providerId || fallbackArtistId,
        artist_name: providerVideo.artist?.name || "Unknown Artist",
        url: providerVideo.url,
        type: "Music Video",
    };
}

export class RefreshArtistService {
    private static getArtistMusicBrainzId(artistId: string): string | null {
        const row = db.prepare("SELECT mbid FROM artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
        return row?.mbid ? String(row.mbid) : null;
    }

    private static async syncArtistMusicBrainzCatalog(artistId: string, force = false): Promise<string | null> {
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        if (!artistMbid) {
            return null;
        }

        const cachedCount = db.prepare("SELECT COUNT(*) AS count FROM mb_release_groups WHERE artist_mbid = ?")
            .get(artistMbid) as { count: number };
        if (!force && Number(cachedCount?.count || 0) > 0) {
            return artistMbid;
        }

        try {
            await lidarrMetadataService.syncArtist(artistMbid);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to sync Lidarr metadata for artist ${artistId} (${artistMbid}):`, error);
        }

        return artistMbid;
    }

    static async upsertMusicBrainzArtist(artistMbid: string, options: ScanOptions = {}): Promise<string> {
        if (!isMusicBrainzMbid(artistMbid)) {
            throw new Error(`Invalid MusicBrainz artist id: ${artistMbid}`);
        }

        const existing = db.prepare(
            "SELECT id, monitor, path FROM artists WHERE id = ? OR mbid = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1",
        ).get(artistMbid, artistMbid, artistMbid) as { id: string | number; monitor?: number | null; path?: string | null } | undefined;
        const localArtistId = existing?.id != null ? String(existing.id) : artistMbid;
        const shouldMonitor = options.monitorArtist === true ? true : Boolean(existing?.monitor);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
        const artistData = await lidarrMetadataService.syncArtist(artistMbid);
        const artistName = artistData.artistname || "Unknown Artist";
        const posterUrl = lidarrMetadataService.getArtistImageUrl(artistData, "Poster");
        const fanartUrl = lidarrMetadataService.getArtistImageUrl(artistData, "Fanart") || posterUrl;
        const resolvedArtistFolder = resolveArtistFolderForPersistence({
            artistId: localArtistId,
            artistName,
            artistMbId: artistMbid,
            existingPath: existing?.path ?? null,
        });

        if (artistName === "Various Artists" || localArtistId === "0") {
            console.warn(`[RefreshArtistService] Cannot monitor 'Various Artists' (MBID: ${artistMbid}). Skipping.`);
            throw new Error("Cannot monitor 'Various Artists'. Please monitor specific compilations instead.");
        }

        if (!existing) {
            db.prepare(`
                INSERT INTO artists (
                    id, name, picture, cover_image_url, popularity, artist_types, artist_roles,
                    mbid, musicbrainz_status, musicbrainz_last_checked, musicbrainz_match_method,
                    bio_text, bio_source,
                    monitor, monitored_at, user_date_added, last_scanned, path
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP, 'lidarr-metadata',
                    ?, 'lidarr', ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?, CURRENT_TIMESTAMP, ?)
            `).run(
                localArtistId,
                artistName,
                posterUrl,
                fanartUrl,
                0,
                JSON.stringify([artistData.type || "Artist"]),
                JSON.stringify([]),
                artistMbid,
                artistData.overview || null,
                shouldMonitorInt,
                shouldMonitorInt,
                null,
                resolvedArtistFolder,
            );
        } else {
            db.prepare(`
                UPDATE artists SET
                    name = ?,
                    picture = COALESCE(?, picture),
                    cover_image_url = COALESCE(?, cover_image_url),
                    popularity = COALESCE(popularity, 0),
                    artist_types = ?,
                    artist_roles = COALESCE(artist_roles, ?),
                    mbid = ?,
                    musicbrainz_status = 'verified',
                    musicbrainz_last_checked = CURRENT_TIMESTAMP,
                    musicbrainz_match_method = 'lidarr-metadata',
                    bio_text = COALESCE(?, bio_text),
                    bio_source = CASE WHEN ? IS NOT NULL THEN 'lidarr' ELSE bio_source END,
                    monitor = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END,
                    last_scanned = CURRENT_TIMESTAMP,
                    path = COALESCE(path, ?)
                WHERE id = ?
            `).run(
                artistName,
                posterUrl,
                fanartUrl,
                JSON.stringify([artistData.type || "Artist"]),
                JSON.stringify([]),
                artistMbid,
                artistData.overview || null,
                artistData.overview || null,
                shouldMonitorInt,
                shouldMonitorInt,
                resolvedArtistFolder,
                localArtistId,
            );
        }

        return localArtistId;
    }

    private static buildProviderReleaseGroupMatches(
        artistMbid: string | null,
        albums: any[],
    ): Map<string, ProviderReleaseGroupMatch> {
        if (!artistMbid || albums.length === 0) {
            return new Map();
        }

        const releaseGroups = lidarrMetadataService.getCachedReleaseGroupsForArtist(artistMbid);
        if (releaseGroups.length === 0) {
            return new Map();
        }

        return matchProviderAlbumsToReleaseGroups(
            albums.map((album) => ({
                providerId: String(album.tidal_id),
                title: String(album.title || ""),
                version: album.version ?? null,
                releaseDate: album.release_date ?? null,
                type: album.type ?? null,
            })),
            releaseGroups,
        );
    }

    private static normalizeProviderMatchText(value: unknown): string {
        return String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
    }

    private static storeProviderArtistMatch(provider: IProvider, artistMbid: string, artist: ProviderArtist, status: "verified" | "probable"): void {
        db.prepare(`
            INSERT INTO provider_items (
                provider, entity_type, provider_id, artist_mbid,
                title, match_status, match_confidence, match_method, data, updated_at
            )
            VALUES (?, 'artist', ?, ?, ?, ?, ?, 'artist-name-search', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                artist_mbid = COALESCE(excluded.artist_mbid, provider_items.artist_mbid),
                title = excluded.title,
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `).run(
            provider.id,
            artist.providerId,
            artistMbid,
            artist.name || null,
            status,
            status === "verified" ? 1 : 0.75,
            JSON.stringify(artist.raw ?? artist),
        );
    }

    private static async resolveProviderArtistId(provider: IProvider, artistId: string, artistMbid: string | null): Promise<string | null> {
        if (!artistMbid || !isMusicBrainzMbid(artistId)) {
            return artistId;
        }

        const cached = db.prepare(`
            SELECT provider_id
            FROM provider_items
            WHERE provider = ?
              AND entity_type = 'artist'
              AND artist_mbid = ?
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(provider.id, artistMbid) as { provider_id?: string | number | null } | undefined;
        if (cached?.provider_id != null) {
            return String(cached.provider_id);
        }

        const localArtist = db.prepare("SELECT name FROM artists WHERE id = ? OR mbid = ? LIMIT 1")
            .get(artistId, artistMbid) as { name?: string | null } | undefined;
        const artistName = String(localArtist?.name || "").trim();
        if (!artistName) {
            return null;
        }

        try {
            const results = await provider.search(artistName, { types: ["artists"], limit: 8 });
            const artists = Array.isArray(results.artists) ? results.artists : [];
            const normalizedName = this.normalizeProviderMatchText(artistName);
            const exact = artists.find((artist) => this.normalizeProviderMatchText(artist.name) === normalizedName);
            const selected = exact || artists[0] || null;
            if (!selected?.providerId) {
                return null;
            }

            this.storeProviderArtistMatch(provider, artistMbid, selected, exact ? "verified" : "probable");
            return selected.providerId;
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to resolve ${provider.name} artist for ${artistName} (${artistMbid}):`, error);
            return null;
        }
    }

    private static reapplyArtistPathAfterIdentity(artistId: string): void {
        const artist = db.prepare("SELECT id, name, mbid, path FROM artists WHERE id = ?").get(artistId) as {
            id: number | string;
            name: string | null;
            mbid: string | null;
            path: string | null;
        } | undefined;

        if (!artist?.name || !artist.mbid) {
            return;
        }

        const existingPath = String(artist.path || "").trim();
        if (existingPath && !shouldReapplyArtistPathTemplate({
            artistId,
            artistName: artist.name,
            artistMbId: artist.mbid,
            existingPath,
        })) {
            return;
        }

        const nextPath = resolveArtistFolderFromTemplate({
            artistId,
            artistName: artist.name,
            artistMbId: artist.mbid,
        });
        db.prepare("UPDATE artists SET path = ? WHERE id = ?").run(nextPath, artistId);
    }

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
            "SELECT id, monitor, name, mbid, last_scanned, path FROM artists WHERE id = ?",
        ).get(artistId) as any;
        const refreshDays = getConfigSection("monitoring").artist_refresh_days;
        const shouldRefresh =
            !existing ||
            options.forceUpdate === true ||
            isRefreshDue(existing?.last_scanned, refreshDays);

        const shouldMonitor = options.monitorArtist === true ? true : (existing?.monitor || false);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
        const provider = providerManager.getDefaultProvider();
        const providerAuthenticated = provider.isAuthenticated ? provider.isAuthenticated() : true;

        if (isMusicBrainzMbid(artistId) && (!existing || existing.mbid === artistId || String(existing.id) === artistId)) {
            await this.upsertMusicBrainzArtist(artistId, options);
            console.log(`[RefreshArtistService] scanBasic complete for MusicBrainz artist ${artistId}`);
            return;
        }

        if (existing?.mbid && !providerAuthenticated) {
            await this.upsertMusicBrainzArtist(String(existing.mbid), {
                ...options,
                monitorArtist: options.monitorArtist === true ? true : Boolean(existing.monitor),
            });
            console.log(`[RefreshArtistService] scanBasic skipped provider lookup for ${artistId} (provider not connected)`);
            return;
        }

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

            if (!existing.mbid || options.forceUpdate === true) {
                await MetadataIdentityService.resolveArtist(artistId, { force: options.forceUpdate === true });
                this.reapplyArtistPathAfterIdentity(artistId);
                await this.syncArtistMusicBrainzCatalog(artistId, options.forceUpdate === true);
            }

            console.log(`[RefreshArtistService] scanBasic skipped for ${artistId} (fresh)`);
            return;
        }

        const artistData = await provider.getArtist(artistId);
        const resolvedArtistFolder = resolveArtistFolderForPersistence({
            artistId,
            artistName: artistData.name,
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
                artistData.popularity ?? null,
                JSON.stringify(artistData.types || ["ARTIST"]),
                JSON.stringify(artistData.roles || []),
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
                artistData.popularity ?? null,
                JSON.stringify(artistData.types || ["ARTIST"]),
                JSON.stringify(artistData.roles || []),
                monitorValue,
                monitorValue,
                resolvedArtistFolder,
                artistId,
            );
        }

        await MetadataIdentityService.resolveArtist(artistId, { force: options.forceUpdate === true });
        this.reapplyArtistPathAfterIdentity(artistId);
        await this.syncArtistMusicBrainzCatalog(artistId, options.forceUpdate === true);

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

        const refreshed = db.prepare("SELECT mbid FROM artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
        if (isMusicBrainzMbid(artistId) && refreshed?.mbid === artistId) {
            console.log(`[RefreshArtistService] Skipping provider biography lookup for MusicBrainz artist ${artistId}`);
            return;
        }

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
            const artistMbid = await this.syncArtistMusicBrainzCatalog(artistId, options.forceUpdate === true);
            const provider = providerManager.getDefaultProvider();
            const providerAuthenticated = provider.isAuthenticated ? provider.isAuthenticated() : true;
            if (!providerAuthenticated) {
                console.log(
                    `[RefreshArtistService] Skipping provider catalog hydration for ${artistId} ` +
                    `(provider not connected)`,
                );
                db.prepare("UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(artistId);
                return;
            }

            const providerArtistId = await this.resolveProviderArtistId(provider, artistId, artistMbid);
            if (!providerArtistId) {
                console.log(`[RefreshArtistService] Skipping provider catalog hydration for ${artistId} (no provider artist match)`);
                db.prepare("UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(artistId);
                return;
            }

            const albumModuleMap = new Map<string, string>();

            const shouldRefreshArtistVideos =
                options.forceUpdate === true ||
                shouldRefreshVideos(artistId, monitoringConfig.video_refresh_days);
            if (shouldRefreshArtistVideos) {
                try {
                    const videos = (await provider.getArtistVideos?.(providerArtistId) || [])
                        .map((video) => providerVideoToLegacyVideoRow(video, artistId));
                    console.log(`[RefreshArtistService] Found ${videos.length} videos for artist ${artistId}`);
                    RefreshVideoService.upsertArtistVideos(artistId, videos, options);
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to fetch videos for ${artistId}:`, error);
                }
            } else {
                console.log(`[RefreshArtistService] Skipping video refresh for ${artistId} (fresh)`);
            }

            const filteringConfig = getConfigSection("filtering");
            const providerAlbums = provider.listArtistReleaseOffers
                ? await provider.listArtistReleaseOffers(providerArtistId, {
                    includeAppearsOn: filteringConfig.include_appears_on === true,
                })
                : await provider.getArtistAlbums(providerArtistId);
            const albums = providerAlbums.map((album) => providerAlbumToLegacyAlbumRow(album, artistId));
            const providerReleaseGroupMatches = this.buildProviderReleaseGroupMatches(artistMbid, albums);
            console.log(`[RefreshArtistService] Found ${albums.length} albums for artist ${artistId}`);
            options.progress?.({ kind: "albums_total", total: albums.length });

            const cooperateAlbumStore = createCooperativeBatcher(20);
            for (let index = 0; index < albums.length; index += 1) {
                const album = albums[index];
                const releaseGroupMatch = providerReleaseGroupMatches.get(String(album.tidal_id));
                if (releaseGroupMatch && releaseGroupMatch.status !== "unmatched") {
                    album._mb_release_group_match = releaseGroupMatch;
                    album._mb_artist_mbid = artistMbid;
                }
                const created = await RefreshAlbumService.upsertArtistAlbum(album, artistId, albumModuleMap, {
                    ...options,
                    resolveMusicBrainz: options.resolveMusicBrainz ?? false,
                });
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

            const slotCounts = ReleaseGroupSlotService.syncProviderAlbumSelections({
                provider: provider.id,
                artistMbid,
                albums: albums.map((album) => ({
                    providerId: String(album.tidal_id),
                    title: String(album.title || ""),
                    version: album.version ?? null,
                    releaseDate: album.release_date ?? null,
                    quality: album.quality ?? null,
                    explicit: album.explicit ?? null,
                    trackCount: album.num_tracks ?? null,
                    volumeCount: album.num_volumes ?? null,
                    raw: album,
                })),
                matches: providerReleaseGroupMatches,
            });
            if (slotCounts.stereo > 0 || slotCounts.spatial > 0) {
                console.log(`[RefreshArtistService] Selected provider offers for ${slotCounts.stereo} stereo and ${slotCounts.spatial} spatial release-group slots`);
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
                        await RefreshAlbumService.scanTracks(String(album.tidal_id), { resolveMusicBrainz: false });
                    })));
                }
            } else {
                console.log(`[RefreshArtistService] Skipping inline track hydration for artist ${artistId} (hydrateAlbumTracks=false)`);
            }

            console.log(`[RefreshArtistService] Building version groups for artist ${artistId}...`);
            await VersionGrouper.applyVersionGroups(artistId);

            console.log(`[RefreshArtistService] Fixing module tags for artist ${artistId}...`);
            await ModuleFixer.fixModuleTagsForArtist(artistId, undefined, providerArtistId);
        } else {
            console.log(`[RefreshArtistService] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);
        }

        db.prepare("UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(artistId);
        console.log(`[RefreshArtistService] scanDeep complete for ${artistId}`);
    }
}
