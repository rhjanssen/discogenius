import { Router } from "express";
import { db } from "../database.js";

import {
    albumProviderArtworkCandidatesFromRow,
    chooseCachedAlbumArtwork,
    chooseCachedProviderArtwork,
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
        // Videos use the stored canonical/provider thumbnail id when present.
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
                        `SELECT id, mbid, name, COALESCE(picture, cover_image_url) AS picture, monitored AS monitor
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
              CASE WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1 ELSE 0 END AS monitored
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
                        `SELECT
              t.mbid AS id,
              t.title,
              artist.name AS artist_name,
              COALESCE(file_quality.quality, provider_track.quality, selected_slot.quality) AS quality,
              COALESCE(provider_track.explicit, 0) AS explicit,
              COALESCE(ROUND(COALESCE(t.length_ms, recording.length_ms, provider_track.duration, 0) / 1000.0), 0) AS duration,
              COALESCE(release.date, rg.first_release_date) AS release_date,
              COALESCE(
                json_extract(selected_slot.provider_data, '$.cover'),
                provider_album.asset_id,
                provider_track.asset_id,
                json_extract(provider_track.data, '$.cover')
              ) AS album_cover,
              rg.mbid AS release_group_mbid,
              rg.data AS rg_data,
              COALESCE(selected_slot.selected_provider, provider_album.provider, provider_track.provider) AS cover_provider,
              COALESCE(selected_slot.provider_data, provider_album.data, provider_track.data) AS cover_provider_data,
              CASE WHEN EXISTS (
                SELECT 1
                FROM ReleaseGroupSlots monitored_slot
                WHERE monitored_slot.release_group_mbid = rg.mbid
                  AND monitored_slot.monitored = 1
              ) THEN 1 ELSE 0 END AS monitored
            FROM Tracks t
            JOIN AlbumReleases release ON release.mbid = t.release_mbid
            JOIN Albums rg ON rg.mbid = release.release_group_mbid
            JOIN ArtistMetadata artist ON artist.mbid = rg.artist_mbid
            JOIN Artists managed_artist ON managed_artist.mbid = artist.mbid
            LEFT JOIN Recordings recording ON recording.mbid = t.recording_mbid
            LEFT JOIN ProviderItems provider_track
              ON provider_track.rowid = (
                SELECT preferred_provider_track.rowid
                FROM ProviderItems preferred_provider_track
                WHERE preferred_provider_track.entity_type = 'track'
                  AND (
                    preferred_provider_track.track_mbid = t.mbid
                    OR preferred_provider_track.recording_mbid = t.recording_mbid
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
                  AND preferred_provider_album.release_group_mbid = rg.mbid
                ORDER BY
                  CASE preferred_provider_album.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
                  preferred_provider_album.updated_at DESC,
                  preferred_provider_album.provider_id ASC
                LIMIT 1
              )
            LEFT JOIN ReleaseGroupSlots selected_slot
              ON selected_slot.release_group_mbid = rg.mbid
             AND selected_slot.selected_release_mbid = t.release_mbid
             AND selected_slot.id = (
               SELECT preferred_slot.id
               FROM ReleaseGroupSlots preferred_slot
               WHERE preferred_slot.release_group_mbid = rg.mbid
                 AND preferred_slot.selected_release_mbid = t.release_mbid
               ORDER BY CASE preferred_slot.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
               LIMIT 1
             )
            LEFT JOIN TrackFiles file_quality
              ON file_quality.canonical_track_mbid = t.mbid
             AND file_quality.file_type = 'track'
             AND file_quality.id = (
               SELECT preferred_file.id
               FROM TrackFiles preferred_file
               WHERE preferred_file.canonical_track_mbid = t.mbid
                 AND preferred_file.file_type = 'track'
               ORDER BY CASE preferred_file.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END, preferred_file.id ASC
               LIMIT 1
             )
            WHERE t.title LIKE ? ESCAPE '\\'
            ORDER BY t.title ASC, t.mbid ASC
            LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.tracks.push(...localTracks.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    artist_name: row.artist_name,
                    // A track shows its album's art. Resolve it through the same
                    // canonical→provider path the album results use so the result
                    // carries a usable URL, not a raw provider asset id.
                    cover: chooseCachedAlbumArtwork({
                        albumMbid: row.release_group_mbid,
                        skyHookData: parseJsonObject(row.rg_data),
                        providerCandidates: row.album_cover
                            ? [{ provider: row.cover_provider, imageId: row.album_cover, data: row.cover_provider_data }]
                            : albumProviderArtworkCandidatesFromRow(row),
                    }),
                    quality: row.quality,
                    explicit: !!row.explicit,
                    duration: row.duration,
                    release_date: row.release_date,
                    monitored: !!row.monitored,
                    in_library: true,
                }, 'track')));
            }

            if (requestedTypeSet.has("videos")) {
                const localVideos = db
                    .prepare(
                        `SELECT
              recording.id AS id,
              recording.title,
              artist.name AS artist_name,
              COALESCE(recording.monitored, 0) AS monitored,
              COALESCE(recording.cover_image_id, provider_video.asset_id) AS cover,
              recording.cover_image_url AS cover_url,
              provider_video.provider AS cover_provider,
              provider_video.data AS cover_provider_data,
              COALESCE(recording.release_date, provider_video.release_date) AS release_date,
              COALESCE((
                SELECT lf.quality
                FROM TrackFiles lf
                WHERE lf.file_type = 'video'
                  AND (
                    CAST(lf.media_id AS TEXT) = CAST(provider_video.provider_id AS TEXT)
                    OR CAST(lf.provider_id AS TEXT) = CAST(provider_video.provider_id AS TEXT)
                    OR (
                      recording.mbid IS NOT NULL
                      AND lf.canonical_recording_mbid = recording.mbid
                    )
                    OR (
                      recording.foreign_recording_id IS NOT NULL
                      AND lf.canonical_recording_mbid = recording.foreign_recording_id
                    )
                  )
                ORDER BY lf.verified_at DESC, lf.id DESC
                LIMIT 1
              ), (
                SELECT lf.quality
                FROM TrackFiles lf
                WHERE lf.file_type = 'video'
                  AND CAST(lf.media_id AS TEXT) = CAST(recording.id AS TEXT)
                ORDER BY lf.verified_at DESC, lf.id DESC
                LIMIT 1
              ), provider_video.quality) AS current_quality
            FROM Recordings recording
            LEFT JOIN ArtistMetadata artist ON artist.mbid = recording.artist_mbid
            LEFT JOIN Artists managed_artist ON managed_artist.mbid = artist.mbid
            LEFT JOIN ProviderItems provider_video
              ON provider_video.rowid = (
                SELECT preferred_provider_video.rowid
                FROM ProviderItems preferred_provider_video
                WHERE preferred_provider_video.entity_type = 'video'
                  AND (
                    preferred_provider_video.recording_id = recording.id
                    OR (
                      recording.mbid IS NOT NULL
                      AND preferred_provider_video.recording_mbid = recording.mbid
                    )
                    OR (
                      recording.foreign_recording_id IS NOT NULL
                      AND preferred_provider_video.provider_id = recording.foreign_recording_id
                    )
                  )
                ORDER BY
                  preferred_provider_video.updated_at DESC,
                  preferred_provider_video.provider ASC,
                  preferred_provider_video.provider_id ASC
                LIMIT 1
              )
            WHERE COALESCE(recording.is_video, 0) = 1
              AND recording.title LIKE ? ESCAPE '\\'
              AND (managed_artist.id IS NOT NULL OR provider_video.provider_id IS NOT NULL)
            ORDER BY (recording.release_date IS NULL) ASC, recording.release_date DESC, recording.title ASC, recording.id ASC
            LIMIT ?`
                    )
                    .all(like, limit) as any[];

                results.videos.push(...localVideos.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    artist_name: row.artist_name,
                    // Resolve the video thumbnail to a usable URL: a stored canonical
                    // URL goes through the proxy; a raw provider asset id is turned
                    // into a provider thumbnail URL — never pass the bare id through.
                    image_id: registerMediaCoverProxyUrl(row.cover_url)
                        || chooseCachedProviderArtwork(
                            [{ provider: row.cover_provider, imageId: row.cover, data: row.cover_provider_data }],
                            "video",
                        ),
                    quality: row.current_quality,
                    release_date: row.release_date,
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
                        const localArtist = db.prepare("SELECT id, monitored AS monitor, picture, cover_image_url FROM Artists WHERE mbid = ? LIMIT 1").get(mbid) as any;
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
                            SELECT rg.mbid, CASE WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1 ELSE 0 END AS monitored
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
