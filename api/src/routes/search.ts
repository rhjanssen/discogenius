import { Router } from "express";
import { db } from "../database.js";
import { getProviderAuthMode } from "../services/provider-auth-mode.js";
import { lidarrMetadataService, type LidarrArtist } from "../services/metadata/lidarr-metadata-service.js";
import { providerManager } from "../services/providers/index.js";
import type {
    SearchResponseContract,
    SearchResultContract,
} from "../contracts/catalog.js";

const router = Router();
const SEARCH_TYPES = ["artists", "albums", "tracks", "videos"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

function escapeSqlLike(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
}

// Helper to check monitored status
const ALLOWED_TABLES: Record<string, string> = {
    tracks: 'media',
    videos: 'media',
    artists: 'artists',
    albums: 'albums',
};

const getMonitoredStatus = (tidalId: string, table: string): boolean => {
    const actualTable = ALLOWED_TABLES[table];
    if (!actualTable) return false;

    try {
        const row = db.prepare(`SELECT monitor FROM ${actualTable} WHERE id = ?`).get(tidalId) as any;
        return row ? Boolean(row.monitor) : false;
    } catch {
        return false;
    }
};

const inDb = (tidalId: string, table: string): boolean => {
    const actualTable = ALLOWED_TABLES[table];
    if (!actualTable) return false;
    return !!db.prepare(`SELECT 1 FROM ${actualTable} WHERE id = ?`).get(tidalId);
};

function loadArtistByMusicBrainzId(mbid: string): { id: string | number; monitor: number | null } | undefined {
    return db.prepare("SELECT id, monitor FROM artists WHERE mbid = ? LIMIT 1").get(mbid) as
        { id: string | number; monitor: number | null } | undefined;
}

function coverArtArchiveReleaseGroupUrl(mbid: string | null | undefined): string | null {
    const trimmed = String(mbid || "").trim();
    return trimmed ? `https://coverartarchive.org/release-group/${trimmed}/front-500` : null;
}

function formatLidarrArtistSearchResult(artist: LidarrArtist): SearchResultContract {
    const localArtist = loadArtistByMusicBrainzId(artist.id);
    const releaseGroupCount = Array.isArray(artist.Albums) ? artist.Albums.length : 0;
    const disambiguation = String(artist.disambiguation || "").trim();
    const details = [
        disambiguation || String(artist.type || "").trim(),
        releaseGroupCount > 0 ? `${releaseGroupCount} release groups` : null,
    ].filter(Boolean).join(" · ");

    return {
        id: localArtist?.id != null ? String(localArtist.id) : artist.id,
        name: artist.artistname,
        type: "artist",
        subtitle: details || null,
        imageId: lidarrMetadataService.getArtistImageUrl(artist),
        monitored: Boolean(localArtist?.monitor),
        in_library: Boolean(localArtist),
        quality: null,
        explicit: undefined,
    };
}

function normalizeSearchTypes(input: unknown): SearchType[] {
    const allSearchTypes: SearchType[] = [...SEARCH_TYPES];
    const requestedTypes: SearchType[] = String(input || "all")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .flatMap<SearchType>((value) => {
            if (!value || value === "all") return allSearchTypes;
            if (value === "artist") return ["artists"];
            if (value === "album") return ["albums"];
            if (value === "track") return ["tracks"];
            if (value === "video") return ["videos"];
            return SEARCH_TYPES.includes(value as SearchType) ? [value as SearchType] : [];
        });

    return requestedTypes.length > 0 ? [...new Set(requestedTypes)] : allSearchTypes;
}

// Format a result item with all required frontend fields
function formatSearchResult(item: any, type: 'artist' | 'album' | 'track' | 'video'): SearchResultContract {
    const result: SearchResultContract = {
        id: item.id?.toString(),
        name: item.name || item.title,
        type,
        monitored: item.monitored || false,
        in_library: item.in_library || false,
        quality: item.quality,
        explicit: item.explicit,
        duration: item.duration,
        release_date: item.release_date || item.releaseDate || null,
    };

    // Add subtitle (artist name) for non-artist items
    if (type !== 'artist') {
        result.subtitle = item.subtitle || item.artist_name || item.artist?.name || null;
    }

    // Add image ID based on type
    if (type === 'artist') {
        result.imageId = item.picture || null;
    } else if (type === 'video') {
        // Videos use image_id (snake_case) from Tidal API
        result.imageId = item.image_id || item.imageId || item.image || null;
    } else {
        result.imageId = item.cover_id || item.cover || item.image || item.imageId || null;
    }

    return result;
}

router.get("/", async (req, res) => {
    try {
        const query = String(req.query.query ?? "").trim();
        const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
        const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 200);
        const requestedTypes = normalizeSearchTypes(req.query.type);
        const requestedTypeSet = new Set(requestedTypes);

        if (!query || query.length < 2) {
            return res.status(400).json({ detail: "Query must be at least 2 characters" });
        }

        const providerAuthMode = getProviderAuthMode();
        const provider = providerManager.getDefaultProvider();
        const hasRemoteAuth = providerAuthMode === "live" && Boolean(provider.isAuthenticated?.());
        const includeProviderCatalog =
            req.query.provider === "true" ||
            req.query.provider === "1" ||
            String(req.query.scope || "").toLowerCase() === "provider";

        const results: any = {
            artists: [],
            albums: [],
            tracks: [],
            videos: []
        };

        // LOCAL SEARCH (always included in connected-mode catalog search)
        {
            const escapedQuery = escapeSqlLike(query);
            const like = `%${escapedQuery}%`;

            if (requestedTypeSet.has("artists")) {
                const localArtists = db
                    .prepare(
                        `SELECT id, name, COALESCE(picture, cover_image_url) AS picture, monitor
                         FROM artists current_artist
                         WHERE name LIKE ? ESCAPE '\\'
                           AND NOT EXISTS (
                             SELECT 1
                             FROM artists canonical_artist
                             WHERE canonical_artist.mbid IS NOT NULL
                               AND canonical_artist.id != current_artist.id
                               AND lower(canonical_artist.name) = lower(current_artist.name)
                           )
                         ORDER BY
                           CASE WHEN mbid IS NOT NULL THEN 0 ELSE 1 END,
                           popularity DESC
                         LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.artists.push(...localArtists.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.name,
                    picture: row.picture,
                    monitored: !!row.monitor,
                    in_library: true,
                }, 'artist')));
            }

            if (requestedTypeSet.has("albums")) {
                const localReleaseGroups = db
                    .prepare(
                        `SELECT
             rg.mbid AS id,
             rg.title,
             rg.first_release_date AS release_date,
             rg.primary_type,
             a.name AS artist_name,
	             selected_album.cover AS cover,
	             selected_album.quality AS quality,
	             COALESCE(slot.wanted, a.monitor, 0) AS monitored
	           FROM mb_release_groups rg
	           LEFT JOIN artists a ON a.mbid = rg.artist_mbid
	           LEFT JOIN release_group_slots slot
             ON slot.release_group_mbid = rg.mbid
            AND slot.slot = 'stereo'
           LEFT JOIN albums selected_album
             ON selected_album.id = slot.selected_provider_id
	           WHERE rg.title LIKE ? ESCAPE '\\'
	           ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date DESC, rg.title ASC
	           LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.albums.push(...localReleaseGroups.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    cover_id: row.cover || coverArtArchiveReleaseGroupUrl(row.id),
                    artist_name: row.artist_name,
                    release_date: row.release_date,
                    quality: row.quality,
                    monitored: !!row.monitored,
                    in_library: true,
                }, 'album')));

                const seenReleaseGroupMbids = new Set(localReleaseGroups.map((row: any) => String(row.id)));
                const localAlbums = db
                    .prepare(
                        `SELECT a.id, a.title, a.cover, a.monitor, a.mb_release_group_id, ar.name as artist_name
           FROM albums a
           LEFT JOIN artists ar ON ar.id = a.artist_id
               WHERE a.title LIKE ? ESCAPE '\\'
                 AND (
                   a.mb_release_group_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM mb_release_groups rg
                     WHERE rg.mbid = a.mb_release_group_id
                   )
                 )
           ORDER BY a.release_date DESC LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.albums.push(...localAlbums
                    .filter((row: any) => !row.mb_release_group_id || !seenReleaseGroupMbids.has(String(row.mb_release_group_id)))
                    .map((row: any) => formatSearchResult({
                        id: row.id,
                        name: row.title,
                        cover_id: row.cover,
                        artist_name: row.artist_name,
                        monitored: !!row.monitor,
                        in_library: true,
                    }, 'album')));
            }

            if (requestedTypeSet.has("tracks")) {
                const localTracks = db
                    .prepare(
                        `SELECT m.id, m.title, ar.name as artist_name, m.monitor as monitored, a.cover as album_cover
           FROM media m
           LEFT JOIN artists ar ON ar.id = m.artist_id
           LEFT JOIN albums a ON a.id = m.album_id
           WHERE m.album_id IS NOT NULL AND m.title LIKE ? ESCAPE '\\'
           ORDER BY m.title LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.tracks.push(...localTracks.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    artist_name: row.artist_name,
                    cover: row.album_cover,
                    monitored: !!row.monitored,
                    in_library: true,
                }, 'track')));
            }

            if (requestedTypeSet.has("videos")) {
                const localVideos = db
                    .prepare(
                        `SELECT
             m.id,
             m.title,
             ar.name as artist_name,
             m.monitor as monitored,
             m.cover,
             COALESCE((
               SELECT lf.quality
               FROM library_files lf
               WHERE lf.media_id = m.id
                 AND lf.file_type = 'video'
               ORDER BY lf.verified_at DESC, lf.id DESC
               LIMIT 1
             ), m.quality) as current_quality
           FROM media m
           LEFT JOIN artists ar ON ar.id = m.artist_id
           WHERE m.type = 'Music Video' AND m.title LIKE ? ESCAPE '\\'
           ORDER BY m.release_date DESC LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.videos.push(...localVideos.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    artist_name: row.artist_name,
                    image_id: row.cover,
                    quality: row.current_quality,
                    monitored: !!row.monitored,
                    in_library: true,
                }, 'video')));
            }
        }

        // MUSICBRAINZ / LIDARR ARTIST SEARCH
        // This is available without a connected provider, mirroring Lidarr's
        // ability to add monitored artists before indexers/download clients exist.
        if (requestedTypeSet.has("artists")) {
            try {
                const lidarrArtists = await lidarrMetadataService.searchArtists(query, limit);
                const seenArtists = new Set(results.artists.map((artist: SearchResultContract) => String(artist.id)));
                const seenMbids = new Set(
                    db.prepare("SELECT mbid FROM artists WHERE mbid IS NOT NULL").all()
                        .map((row: any) => String(row.mbid))
                );

                for (const artist of lidarrArtists) {
                    const formatted = formatLidarrArtistSearchResult(artist);
                    if (seenArtists.has(String(formatted.id))) {
                        continue;
                    }
                    if (seenMbids.has(artist.id) && !formatted.in_library) {
                        continue;
                    }
                    results.artists.push(formatted);
                    seenArtists.add(String(formatted.id));
                }
            } catch (error: any) {
                console.warn("[search] Lidarr artist search failed:", error.message);
            }
        }

        // Provider catalog search is intentionally opt-in. Global Discogenius
        // search mirrors Lidarr: search the local library plus MusicBrainz add
        // results, and use providers later for availability/download searches.
        if (hasRemoteAuth && includeProviderCatalog) {
            try {
                // Keep the UI responsive: remote search can be slow; cap it with a short timeout.
                const timeoutMs = Math.max(250, Math.min(Number(process.env.DISCOGENIUS_SEARCH_REMOTE_TIMEOUT_MS || 2500), 15000));
                const remoteResults = await Promise.race([
                    provider.search(query, { types: requestedTypes, limit }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Remote search timeout after ${timeoutMs}ms`)), timeoutMs)),
                ]) as any;


                const remoteItems = Array.isArray(remoteResults)
                    ? remoteResults
                    : [
                        ...(remoteResults?.artists || []).map((item: any) => ({
                            id: item.providerId,
                            type: "artist",
                            name: item.name,
                            picture: item.picture,
                        })),
                        ...(remoteResults?.albums || []).map((item: any) => ({
                            id: item.providerId,
                            type: "album",
                            name: item.title,
                            subtitle: item.artist?.name,
                            cover: item.cover,
                            release_date: item.releaseDate,
                            quality: item.quality,
                            explicit: item.explicit,
                        })),
                        ...(remoteResults?.tracks || []).map((item: any) => ({
                            id: item.providerId,
                            type: "track",
                            name: item.title,
                            subtitle: item.artist?.name,
                            cover: item.album?.cover,
                            duration: item.duration,
                            quality: item.quality,
                        })),
                        ...(remoteResults?.videos || []).map((item: any) => ({
                            id: item.providerId,
                            type: "video",
                            name: item.title,
                            subtitle: item.artist?.name,
                            imageId: item.cover,
                            duration: item.duration,
                            quality: item.quality,
                            explicit: item.explicit,
                        })),
                    ];

                if (remoteItems && Array.isArray(remoteItems)) {
                    // Normalize all seen IDs to strings for proper comparison
                    const seen = new Set(
                        [...results.artists, ...results.albums, ...results.tracks, ...results.videos]
                            .map((r) => `${String(r.type)}:${String(r.id)}`)
                    );

                    for (const item of remoteItems) {
                        if (item.id === null || item.id === undefined) {
                            continue;
                        }

                        const normalizedId = String(item.id);
                        const dedupeKey = `${String(item.type)}:${normalizedId}`;
                        if (seen.has(dedupeKey)) continue;

                        const table = item.type === 'artist' ? 'artists' :
                            item.type === 'album' ? 'albums' :
                                item.type === 'track' ? 'tracks' : 'videos';

                        // Preserve all fields from searchTidal (especially subtitle), then add monitored/in_library
                        const formatted = formatSearchResult({
                            ...item, // This includes subtitle, name, artist_name, etc from searchTidal
                            monitored: getMonitoredStatus(normalizedId, table),
                            in_library: inDb(normalizedId, table),
                        }, item.type);

                        if (item.type === 'artist') results.artists.push(formatted);
                        else if (item.type === 'album') results.albums.push(formatted);
                        else if (item.type === 'track') results.tracks.push(formatted);
                        else if (item.type === 'video') results.videos.push(formatted);

                        seen.add(dedupeKey);
                    }
                }
            } catch (error: any) {
                console.error('[search] Remote search failed:', error.message);
                // Continue with local results
            }
        }

        // Limit each category
        results.artists = results.artists.slice(0, limit);
        results.albums = results.albums.slice(0, limit);
        results.tracks = results.tracks.slice(0, limit);
        results.videos = results.videos.slice(0, limit);

        const payload: SearchResponseContract = {
            success: true,
            results,
            mode: providerAuthMode,
            remoteCatalogAvailable: hasRemoteAuth,
        };
        res.json(payload);
    } catch (error: any) {
        console.error('[search] Error:', error);
        res.status(500).json({ detail: "Search request failed" });
    }
});

export default router;
