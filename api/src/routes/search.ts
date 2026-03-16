import { Router } from "express";
import { loadToken, searchTidal } from "../services/tidal.js";
import { db } from "../database.js";

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
function formatSearchResult(item: any, type: 'artist' | 'album' | 'track' | 'video'): any {
    const result: any = {
        id: item.id?.toString(),
        name: item.name || item.title,
        type,
        monitored: item.monitored || false,
        in_library: item.in_library || false,
        quality: item.quality,
        explicit: item.explicit,
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

        const hasRemoteAuth = Boolean(loadToken()?.access_token);
        if (!hasRemoteAuth) {
            return res.status(401).json({ detail: "TIDAL authentication required" });
        }

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
                        "SELECT id, name, picture, monitor FROM artists WHERE name LIKE ? ESCAPE '\\' ORDER BY popularity DESC LIMIT ?"
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
                const localAlbums = db
                    .prepare(
                        `SELECT a.id, a.title, a.cover, a.monitor, ar.name as artist_name 
           FROM albums a 
           LEFT JOIN artists ar ON ar.id = a.artist_id 
               WHERE a.title LIKE ? ESCAPE '\\' 
           ORDER BY a.release_date DESC LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.albums.push(...localAlbums.map((row: any) => formatSearchResult({
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

        // REMOTE SEARCH
        if (hasRemoteAuth) {
            try {
                // Keep the UI responsive: remote search can be slow; cap it with a short timeout.
                const timeoutMs = Math.max(250, Math.min(Number(process.env.DISCOGENIUS_SEARCH_REMOTE_TIMEOUT_MS || 2500), 15000));
                const remoteResults = await Promise.race([
                    searchTidal(query, requestedTypes, limit),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Remote search timeout after ${timeoutMs}ms`)), timeoutMs)),
                ]) as any;


                if (remoteResults && Array.isArray(remoteResults)) {
                    // Normalize all seen IDs to strings for proper comparison
                    const seen = new Set(
                        [...results.artists, ...results.albums, ...results.tracks, ...results.videos]
                            .map((r) => `${String(r.type)}:${String(r.id)}`)
                    );

                    for (const item of remoteResults) {
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

        res.json({ success: true, results });
    } catch (error: any) {
        console.error('[search] Error:', error);
        res.status(500).json({ detail: "Search request failed" });
    }
});

export default router;
