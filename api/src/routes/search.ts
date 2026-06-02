import { Router } from "express";
import { db } from "../database.js";

import {
    albumProviderArtworkCandidatesFromRow,
    chooseCachedAlbumArtwork,
    parseJsonObject,
    registerMediaCoverProxyUrl,
    resolveMediaCoverProxyUrl,
} from "../services/metadata/media-cover-service.js";
import { skyHookProxy } from "../services/metadata/skyhook-proxy.js";
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

    result.subtitle = item.subtitle || (type !== 'artist' ? item.artist_name || item.artist?.name : null) || null;

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

        const results: any = {
            artists: [],
            albums: [],
            tracks: [],
            videos: []
        };

        const addedArtistMbids = new Set<string>();
        const addedArtistIds = new Set<string>();
        const addedAlbumMbids = new Set<string>();

        // 1. Local library search
        {
            const escapedQuery = escapeSqlLike(query);
            const like = `%${escapedQuery}%`;

            if (requestedTypeSet.has("artists")) {
                const localArtists = db
                    .prepare(
                        `SELECT id, mbid, name, COALESCE(picture, cover_image_url) AS picture, monitor
                         FROM Artists current_artist
                         WHERE name LIKE ? ESCAPE '\\'
                           AND NOT EXISTS (
                             SELECT 1
                             FROM Artists canonical_artist
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

                for (const row of localArtists) {
                    if (row.mbid) addedArtistMbids.add(row.mbid);
                    addedArtistIds.add(row.id.toString());
                    results.artists.push(formatSearchResult({
                        id: row.id,
                        name: row.name,
                        picture: row.picture,
                        monitored: !!row.monitor,
                        in_library: true,
                    }, 'artist'));
                }
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
              rg.data,
              COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
              COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
              stereo.selected_provider AS stereo_provider,
              stereo.selected_provider_id AS stereo_provider_id,
              stereo.provider_data AS stereo_provider_data,
              spatial.selected_provider AS spatial_provider,
              spatial.selected_provider_id AS spatial_provider_id,
              spatial.provider_data AS spatial_provider_data,
              COALESCE(stereo.quality, spatial.quality) AS quality,
              CASE WHEN COALESCE(stereo.wanted, 0) = 1 OR COALESCE(spatial.wanted, 0) = 1 THEN 1 ELSE 0 END AS monitored
            FROM Albums rg
            LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
            LEFT JOIN ReleaseGroupSlots stereo
              ON stereo.release_group_mbid = rg.mbid
             AND stereo.slot = 'stereo'
            LEFT JOIN ReleaseGroupSlots spatial
              ON spatial.release_group_mbid = rg.mbid
             AND spatial.slot = 'spatial'
            WHERE rg.title LIKE ? ESCAPE '\\'
            ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date DESC, rg.title ASC
            LIMIT ?`
                    )
                    .all(like, limit) as any[];

                for (const row of localReleaseGroups) {
                    addedAlbumMbids.add(row.id);
                    results.albums.push(formatSearchResult({
                        id: row.id,
                        name: row.title,
                        cover_id: chooseCachedAlbumArtwork({
                            skyHookData: parseJsonObject(row.data),
                            providerCandidates: albumProviderArtworkCandidatesFromRow(row),
                        }),
                        artist_name: row.artist_name,
                        release_date: row.release_date,
                        quality: row.quality,
                        monitored: !!row.monitored,
                        in_library: true,
                    }, 'album'));
                }
            }

            if (requestedTypeSet.has("tracks")) {
                const localTracks = db
                    .prepare(
                        `SELECT m.id, m.title, ar.name as artist_name, m.monitor as monitored, a.cover as album_cover
           FROM ProviderMedia m
           LEFT JOIN Artists ar ON ar.id = m.artist_id
           LEFT JOIN ProviderAlbums a ON a.id = m.album_id
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
                FROM TrackFiles lf
                WHERE lf.media_id = m.id
                  AND lf.file_type = 'video'
                ORDER BY lf.verified_at DESC, lf.id DESC
                LIMIT 1
              ), m.quality) as current_quality
            FROM ProviderMedia m
            LEFT JOIN Artists ar ON ar.id = m.artist_id
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

        // 2. Remote MusicBrainz (Skyhook) search
        if (query.length >= 2 && (requestedTypeSet.has("artists") || requestedTypeSet.has("albums"))) {
            const remoteItems = await skyHookProxy.searchAll(query, limit);
            for (const item of remoteItems) {
                if (item.artist && requestedTypeSet.has("artists")) {
                    const mbid = item.artist.id;
                    if (mbid && !addedArtistMbids.has(mbid)) {
                        // Check if exists in local library
                        const localArtist = db.prepare("SELECT id, monitor, picture, cover_image_url FROM Artists WHERE mbid = ? LIMIT 1").get(mbid) as any;
                        if (localArtist) {
                            if (addedArtistIds.has(localArtist.id.toString())) {
                                continue;
                            }
                            const imageId = [
                                localArtist.picture,
                                localArtist.cover_image_url,
                                skyHookProxy.getArtistImageUrl(item.artist),
                            ].map((val) => {
                                const text = val == null ? "" : String(val).trim();
                                if (!text) return null;
                                const resolved = resolveMediaCoverProxyUrl(text);
                                if (resolved) return resolved;
                                return /^\/MediaCoverProxy\//i.test(text) ? null : text;
                            }).find(Boolean);

                            results.artists.push(formatSearchResult({
                                id: localArtist.id,
                                name: item.artist.artistname,
                                picture: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                monitored: !!localArtist.monitor,
                                in_library: true,
                            }, 'artist'));
                            addedArtistIds.add(localArtist.id.toString());
                        } else {
                            const imageId = skyHookProxy.getArtistImageUrl(item.artist);
                            const releaseGroupCount = Array.isArray(item.artist.Albums) ? item.artist.Albums.length : 0;
                            const disambiguation = String(item.artist.disambiguation || "").trim();
                            const details = [
                                disambiguation || String(item.artist.type || "").trim(),
                                releaseGroupCount > 0 ? `${releaseGroupCount} release groups` : null,
                            ].filter(Boolean).join(" · ");

                            results.artists.push(formatSearchResult({
                                id: mbid,
                                name: item.artist.artistname,
                                picture: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                monitored: false,
                                in_library: false,
                                subtitle: details || null,
                            }, 'artist'));
                        }
                        addedArtistMbids.add(mbid);
                    }
                } else if (item.album && requestedTypeSet.has("albums")) {
                    const mbid = item.album.id;
                    if (mbid && !addedAlbumMbids.has(mbid)) {
                        const localAlbum = db.prepare(`
                            SELECT rg.mbid, CASE WHEN COALESCE(stereo.wanted, 0) = 1 OR COALESCE(spatial.wanted, 0) = 1 THEN 1 ELSE 0 END AS monitored
                            FROM Albums rg
                            LEFT JOIN ReleaseGroupSlots stereo ON stereo.release_group_mbid = rg.mbid AND stereo.slot = 'stereo'
                            LEFT JOIN ReleaseGroupSlots spatial ON spatial.release_group_mbid = rg.mbid AND spatial.slot = 'spatial'
                            WHERE rg.mbid = ?
                            LIMIT 1
                        `).get(mbid) as any;

                        const artistName = item.album.artistname || item.album.artistName || item.album.ArtistName || item.album.artist?.artistname || null;
                        const imageId = skyHookProxy.getAlbumImageUrl(item.album);

                        if (localAlbum) {
                            results.albums.push(formatSearchResult({
                                id: mbid,
                                name: item.album.title,
                                cover_id: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                artist_name: artistName,
                                release_date: item.album.releasedate || item.album.releaseDate || null,
                                monitored: !!localAlbum.monitored,
                                in_library: true,
                            }, 'album'));
                        } else {
                            results.albums.push(formatSearchResult({
                                id: mbid,
                                name: item.album.title,
                                cover_id: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                artist_name: artistName,
                                release_date: item.album.releasedate || item.album.releaseDate || null,
                                monitored: false,
                                in_library: false,
                            }, 'album'));
                        }
                        addedAlbumMbids.add(mbid);
                    }
                }
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
            remoteCatalogAvailable: true,
        };
        res.json(payload);
    } catch (error: any) {
        console.error('[search] Error:', error);
        res.status(500).json({ detail: "Search request failed" });
    }
});

export default router;
