import { Router } from "express";
import { db } from "../database.js";

import {
    albumCoverLocalUrl,
    imageContainerFromImagesColumn,
    mapArtistArtworkToLocalUrl,
    registerMediaCoverProxyUrl,
    resolveMediaCoverProxyUrl,
    videoCoverLocalUrl,
} from "../services/metadata/media-cover-service.js";
import { catalogProviderRegistry } from "../services/catalog/index.js";
import { servarrMetadata } from "../services/metadata/servarr-metadata.js";
import type {
    SearchResponseContract,
    SearchResultContract,
} from "../contracts/catalog.js";

const router = Router();
const SEARCH_TYPES = ["artists", "albums", "tracks", "videos"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

function toFtsPrefixQuery(value: string): string | null {
    const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
    if (tokens.length === 0) return null;
    return tokens
        .slice(0, 8)
        .map((token) => `"${token.replace(/"/g, '""')}"*`)
        .join(" AND ");
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

async function getSupplementalArtistImageUrl(
    artistMbid: string | null | undefined,
    cache: Map<string, string | null>,
): Promise<string | null> {
    const mbid = String(artistMbid || "").trim();
    if (!mbid) {
        return null;
    }
    if (cache.has(mbid)) {
        return cache.get(mbid) ?? null;
    }

    try {
        const supplemental = await servarrMetadata.getArtistInfo(mbid);
        const imageUrl = servarrMetadata.getArtistImageUrl(supplemental);
        const proxied = registerMediaCoverProxyUrl(imageUrl) || imageUrl || null;
        cache.set(mbid, proxied);
        return proxied;
    } catch {
        cache.set(mbid, null);
        return null;
    }
}

router.get("/", async (req, res) => {
    try {
        const query = String(req.query.query ?? "").trim();
        const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
        const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 200);
        const requestedTypes = normalizeSearchTypes(req.query.type);
        const requestedTypeSet = new Set(requestedTypes);
        const remoteRequested = ["1", "true", "yes", "on"]
            .includes(String(req.query.remote || "").trim().toLowerCase());
        const includeLocalLibrary = !["0", "false", "no", "off"]
            .includes(String(req.query.local || "").trim().toLowerCase());
        // Keep established-library search local and indexed, but give a fresh
        // installation the same canonical discovery path as the add-artist flow.
        const libraryIsEmpty = !db.prepare("SELECT 1 FROM Artists LIMIT 1").get();
        // Remote only when explicitly requested, or when a local search on an
        // empty library needs discovery (Lidarr Add New). A remote-only follow-up
        // must not re-run local enrichment.
        const includeRemoteCatalog = remoteRequested || (libraryIsEmpty && includeLocalLibrary);

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
        const supplementalArtistImageCache = new Map<string, string | null>();
        // Start the remote catalog request before synchronous SQLite work. The
        // network round trip then overlaps local matching instead of making
        // global search pay both costs serially.
        const remoteSearchPromise = includeRemoteCatalog
            && query.length >= 2
            && (requestedTypeSet.has("artists") || requestedTypeSet.has("albums"))
            ? catalogProviderRegistry.getActive().search(query, { limit })
            : null;

        // 1. Local library search
        if (includeLocalLibrary) {
            if (requestedTypeSet.has("artists")) {
                const ftsQuery = toFtsPrefixQuery(query);
                const matchedArtistIds = ftsQuery
                    ? (db.prepare(`
                        SELECT entity_id AS id
                        FROM CatalogSearch
                        WHERE CatalogSearch MATCH ? AND entity_type = 'artist'
                        LIMIT ?
                    `).all(ftsQuery, limit * 2) as Array<{ id: string }>).map((row) => row.id)
                    : [];
                const artistMarks = matchedArtistIds.map(() => "?").join(", ");
                // Prefer MB-linked rows over provider-only duplicates with the same
                // name (COLLATE NOCASE uses idx_artists_name; avoid lower() scans).
                const localArtists = matchedArtistIds.length === 0 ? [] : db
                    .prepare(
                        `SELECT current_artist.id, current_artist.mbid, current_artist.name,
                                current_artist.picture, current_artist.cover_image_url,
                                artist_metadata.images AS canonical_images,
                                current_artist.monitored AS monitor
                         FROM Artists current_artist
                         LEFT JOIN ArtistMetadata artist_metadata
                           ON artist_metadata.mbid = current_artist.mbid
                         WHERE current_artist.id IN (${artistMarks})
                           AND NOT EXISTS (
                             SELECT 1
                             FROM Artists canonical_artist
                             WHERE canonical_artist.mbid IS NOT NULL
                               AND canonical_artist.id != current_artist.id
                               AND canonical_artist.name = current_artist.name COLLATE NOCASE
                           )
                         ORDER BY
                           CASE WHEN current_artist.mbid IS NOT NULL THEN 0 ELSE 1 END,
                           current_artist.popularity DESC
                         LIMIT ?`
                    )
                    .all(...matchedArtistIds, limit) as any[];

                for (const row of localArtists) {
                    if (row.mbid) addedArtistMbids.add(row.mbid);
                    addedArtistIds.add(row.id.toString());
                    results.artists.push(formatSearchResult({
                        id: row.id,
                        name: row.name,
                        picture: mapArtistArtworkToLocalUrl({
                            artistMbid: row.mbid,
                            servarrMetadataData: imageContainerFromImagesColumn(row.canonical_images),
                            providerCandidates: [
                                { imageId: row.picture },
                                { imageId: row.cover_image_url },
                            ],
                        }) || row.cover_image_url || row.picture,
                        monitored: !!row.monitor,
                        in_library: true,
                    }, 'artist'));
                }
            }

            if (requestedTypeSet.has("albums")) {
                // Two-phase like the tracks branch: bare title match first,
                // slot/artist enrichment only for the survivors.
                const ftsQuery = toFtsPrefixQuery(query);
                const matchedAlbumMbids = ftsQuery
                    ? (db.prepare(`
                        SELECT entity_id AS mbid
                        FROM CatalogSearch
                        WHERE CatalogSearch MATCH ? AND entity_type = 'album'
                        LIMIT ?
                    `).all(ftsQuery, limit) as Array<{ mbid: string }>).map((row) => row.mbid)
                    : [];
                const albumMarks = matchedAlbumMbids.map(() => "?").join(", ");
                const localReleaseGroups = matchedAlbumMbids.length === 0 ? [] : db
                    .prepare(
                        `SELECT
              rg.mbid AS id,
              rg.title,
              rg.first_release_date AS release_date,
              rg.primary_type,
              a.name AS artist_name,
              rg.images,
              COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
              COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
              stereo.selected_provider AS stereo_provider,
              stereo.selected_provider_id AS stereo_provider_id,
              spatial.selected_provider AS spatial_provider,
              spatial.selected_provider_id AS spatial_provider_id,
              COALESCE(stereo.quality, spatial.quality) AS quality,
              CASE WHEN stereo.monitored = 1 OR spatial.monitored = 1 THEN 1 ELSE 0 END AS monitored
            FROM Albums rg
            LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
            LEFT JOIN ReleaseGroupSlots stereo
              ON stereo.release_group_mbid = rg.mbid
             AND stereo.slot = 'stereo'
            LEFT JOIN ReleaseGroupSlots spatial
              ON spatial.release_group_mbid = rg.mbid
             AND spatial.slot = 'spatial'
            WHERE rg.mbid IN (${albumMarks})
            ORDER BY (rg.first_release_date IS NULL) ASC, rg.first_release_date DESC, rg.title ASC`
                    )
                    .all(...matchedAlbumMbids) as any[];

                for (const row of localReleaseGroups) {
                    addedAlbumMbids.add(row.id);
                    results.albums.push(formatSearchResult({
                        id: row.id,
                        name: row.title,
                        cover_id: albumCoverLocalUrl({
                            albumMbid: row.id,
                            images: imageContainerFromImagesColumn(row.images),
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
                // Two-phase: match + rank + LIMIT on the bare title scan first,
                // then run the (expensive, correlated) enrichment only for the
                // few survivors. Enriching during the scan evaluated five
                // correlated subqueries per candidate row across millions of
                // Tracks — a 30s+ synchronous stall per keystroke. Group by
                // recording so one song doesn't fill the results with a copy
                // per edition.
                const ftsQuery = toFtsPrefixQuery(query);
                const matchedTrackMbids = ftsQuery
                    ? (db.prepare(
                        `SELECT track_mbid AS mbid
                         FROM TrackSearch
                         WHERE TrackSearch MATCH ?
                         GROUP BY COALESCE(recording_mbid, track_mbid)
                         LIMIT ?`
                    ).all(ftsQuery, limit) as Array<{ mbid: string }>).map((row) => row.mbid)
                    : [];
                const trackMarks = matchedTrackMbids.map(() => "?").join(", ");
                // Autocomplete only needs title/artist/duration/quality/monitor +
                // album cover from Albums.images — skip album ProviderItems and
                // unused cover_provider columns that used to inflate each row.
                const localTracks = matchedTrackMbids.length === 0 ? [] : db
                    .prepare(
                        `SELECT
              t.mbid AS id,
              t.title,
              artist.name AS artist_name,
              COALESCE(file_quality.quality, provider_track.quality, selected_slot.quality) AS quality,
              COALESCE(provider_track.explicit, 0) AS explicit,
              COALESCE(ROUND(COALESCE(t.length_ms, recording.length_ms, provider_track.duration, 0) / 1000.0), 0) AS duration,
              COALESCE(release.date, rg.first_release_date) AS release_date,
              rg.mbid AS release_group_mbid,
              rg.images AS rg_images,
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
              -- COALESCE of two single-index lookups: an OR across track_mbid /
              -- recording_mbid defeats both (entity_type, *) indexes and scans
              -- every track offer per result row (~0.5s x row).
              ON provider_track.rowid = COALESCE(
                (
                  SELECT preferred_provider_track.rowid
                  FROM ProviderItems preferred_provider_track
                  WHERE preferred_provider_track.entity_type = 'track'
                    AND preferred_provider_track.track_mbid = t.mbid
                  ORDER BY
                    CASE preferred_provider_track.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
                    preferred_provider_track.updated_at DESC,
                    preferred_provider_track.provider_id ASC
                  LIMIT 1
                ),
                (
                  SELECT preferred_provider_track.rowid
                  FROM ProviderItems preferred_provider_track
                  WHERE preferred_provider_track.entity_type = 'track'
                    AND preferred_provider_track.recording_mbid = t.recording_mbid
                  ORDER BY
                    CASE preferred_provider_track.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
                    preferred_provider_track.updated_at DESC,
                    preferred_provider_track.provider_id ASC
                  LIMIT 1
                )
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
            WHERE t.mbid IN (${trackMarks})
            ORDER BY t.title ASC, t.mbid ASC`
                    )
                    .all(...matchedTrackMbids) as any[];

                results.tracks.push(...localTracks.map((row: any) => formatSearchResult({
                    id: row.id,
                    name: row.title,
                    artist_name: row.artist_name,
                    // A track shows its album's art. Resolve it through the same
                    // canonical→provider path the album results use so the result
                    // carries a usable URL, not a raw provider asset id.
                    cover: albumCoverLocalUrl({
                        albumMbid: row.release_group_mbid,
                        images: imageContainerFromImagesColumn(row.rg_images),
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
                // Two-phase like the tracks branch. Overfetch the bare title
                // matches because the enrichment applies a managed-artist /
                // provider-offer filter that can drop candidates.
                const ftsQuery = toFtsPrefixQuery(query);
                const matchedVideoIds = ftsQuery
                    ? (db.prepare(`
                        SELECT CAST(entity_id AS INTEGER) AS id
                        FROM CatalogSearch
                        WHERE CatalogSearch MATCH ? AND entity_type = 'video'
                        LIMIT ?
                    `).all(ftsQuery, limit * 4) as Array<{ id: number }>).map((row) => row.id)
                    : [];
                const videoMarks = matchedVideoIds.map(() => "?").join(", ");
                const localVideos = matchedVideoIds.length === 0 ? [] : db
                    .prepare(
                        `SELECT
              recording.id AS id,
              recording.title,
              artist.name AS artist_name,
              recording.monitored AS monitored,
              COALESCE(recording.cover_image_id, provider_video.asset_id) AS cover,
              recording.cover_image_url AS cover_url,
              COALESCE(recording.release_date, provider_video.release_date) AS release_date,
              COALESCE((
                SELECT lf.quality
                FROM TrackFiles lf
                WHERE lf.file_type = 'video'
                  AND lf.canonical_recording_mbid = recording.mbid
                ORDER BY lf.verified_at DESC, lf.id DESC
                LIMIT 1
              ), (
                SELECT lf.quality
                FROM TrackFiles lf
                WHERE lf.file_type = 'video'
                  AND lf.recording_id = recording.id
                ORDER BY lf.verified_at DESC, lf.id DESC
                LIMIT 1
              ), provider_video.quality) AS current_quality
            FROM Recordings recording
            LEFT JOIN ArtistMetadata artist ON artist.mbid = recording.artist_mbid
            LEFT JOIN Artists managed_artist ON managed_artist.mbid = artist.mbid
            LEFT JOIN ProviderItems provider_video
              -- Same COALESCE-of-indexed-lookups pattern as tracks: OR across
              -- recording_id / recording_mbid / provider_id defeats indexes.
              ON provider_video.rowid = COALESCE(
                (
                  SELECT preferred_provider_video.rowid
                  FROM ProviderItems preferred_provider_video
                  WHERE preferred_provider_video.entity_type = 'video'
                    AND preferred_provider_video.recording_id = recording.id
                    AND (
                      preferred_provider_video.match_status IS NULL
                      OR LOWER(preferred_provider_video.match_status) <> 'rejected'
                    )
                    AND (
                      preferred_provider_video.availability IS NULL
                      OR LOWER(CAST(preferred_provider_video.availability AS TEXT))
                         NOT IN ('0', 'false', 'unavailable', 'no', '')
                    )
                  ORDER BY
                    preferred_provider_video.updated_at DESC,
                    preferred_provider_video.provider ASC,
                    preferred_provider_video.provider_id ASC
                  LIMIT 1
                ),
                (
                  SELECT preferred_provider_video.rowid
                  FROM ProviderItems preferred_provider_video
                  WHERE preferred_provider_video.entity_type = 'video'
                    AND recording.mbid IS NOT NULL
                    AND preferred_provider_video.recording_mbid = recording.mbid
                    AND (
                      preferred_provider_video.match_status IS NULL
                      OR LOWER(preferred_provider_video.match_status) <> 'rejected'
                    )
                    AND (
                      preferred_provider_video.availability IS NULL
                      OR LOWER(CAST(preferred_provider_video.availability AS TEXT))
                         NOT IN ('0', 'false', 'unavailable', 'no', '')
                    )
                  ORDER BY
                    preferred_provider_video.updated_at DESC,
                    preferred_provider_video.provider ASC,
                    preferred_provider_video.provider_id ASC
                  LIMIT 1
                ),
                (
                  SELECT preferred_provider_video.rowid
                  FROM ProviderItems preferred_provider_video
                  WHERE preferred_provider_video.entity_type = 'video'
                    AND recording.foreign_recording_id IS NOT NULL
                    AND preferred_provider_video.provider_id = recording.foreign_recording_id
                    AND (
                      preferred_provider_video.match_status IS NULL
                      OR LOWER(preferred_provider_video.match_status) <> 'rejected'
                    )
                    AND (
                      preferred_provider_video.availability IS NULL
                      OR LOWER(CAST(preferred_provider_video.availability AS TEXT))
                         NOT IN ('0', 'false', 'unavailable', 'no', '')
                    )
                  ORDER BY
                    preferred_provider_video.updated_at DESC,
                    preferred_provider_video.provider ASC,
                    preferred_provider_video.provider_id ASC
                  LIMIT 1
                )
              )
            WHERE recording.id IN (${videoMarks})
              AND (managed_artist.id IS NOT NULL OR provider_video.provider_id IS NOT NULL)
            ORDER BY (recording.release_date IS NULL) ASC, recording.release_date DESC, recording.title ASC, recording.id ASC
            LIMIT ?`
                    )
                    .all(...matchedVideoIds, limit) as any[];

                for (const row of localVideos) {
                    results.videos.push(formatSearchResult({
                        id: row.id,
                        name: row.title,
                        artist_name: row.artist_name,
                        image_id: videoCoverLocalUrl(row.id, row.cover_url),
                        quality: row.current_quality,
                        release_date: row.release_date,
                        monitored: !!row.monitored,
                        in_library: true,
                    }, 'video'));
                }
            }
        }

        // 2. Remote catalog search (Servarr Metadata Server or local MusicBrainz)
        if (remoteSearchPromise) {
            const remoteItems = await remoteSearchPromise!;
            for (const artist of remoteItems.artists || []) {
                if (requestedTypeSet.has("artists")) {
                    const mbid = artist.id;
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
                                servarrMetadata.getArtistImageUrl(artist),
                            ].map((val) => {
                                const text = val == null ? "" : String(val).trim();
                                if (!text) return null;
                                const resolved = resolveMediaCoverProxyUrl(text);
                                if (resolved) return resolved;
                                return /^\/media-cover-proxy\//i.test(text) ? null : text;
                            }).find(Boolean);

                            const supplementalImage = imageId
                                ? null
                                : await getSupplementalArtistImageUrl(mbid, supplementalArtistImageCache);

                            results.artists.push(formatSearchResult({
                                id: localArtist.id,
                                name: artist.artistname,
                                picture: registerMediaCoverProxyUrl(imageId) || imageId || supplementalImage || null,
                                monitored: !!localArtist.monitor,
                                in_library: true,
                            }, 'artist'));
                            addedArtistIds.add(localArtist.id.toString());
                        } else {
                            const imageId = servarrMetadata.getArtistImageUrl(artist)
                                || await getSupplementalArtistImageUrl(mbid, supplementalArtistImageCache);
                            const releaseGroupCount = Array.isArray(artist.Albums) ? artist.Albums.length : 0;
                            const disambiguation = String(artist.disambiguation || "").trim();
                            const details = [
                                disambiguation || String(artist.type || "").trim(),
                                releaseGroupCount > 0 ? `${releaseGroupCount} release groups` : null,
                            ].filter(Boolean).join(" · ");

                            results.artists.push(formatSearchResult({
                                id: mbid,
                                name: artist.artistname,
                                picture: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                monitored: false,
                                in_library: false,
                                subtitle: details || null,
                            }, 'artist'));
                        }
                        addedArtistMbids.add(mbid);
                    }
                }
            }
            for (const releaseGroup of remoteItems.releaseGroups || []) {
                if (requestedTypeSet.has("albums")) {
                    const mbid = releaseGroup.mbid;
                    if (mbid && !addedAlbumMbids.has(mbid)) {
                        const localAlbum = db.prepare(`
                            SELECT rg.mbid, CASE WHEN stereo.monitored = 1 OR spatial.monitored = 1 THEN 1 ELSE 0 END AS monitored
                            FROM Albums rg
                            LEFT JOIN ReleaseGroupSlots stereo ON stereo.release_group_mbid = rg.mbid AND stereo.slot = 'stereo'
                            LEFT JOIN ReleaseGroupSlots spatial ON spatial.release_group_mbid = rg.mbid AND spatial.slot = 'spatial'
                            WHERE rg.mbid = ?
                            LIMIT 1
                        `).get(mbid) as any;

                        const artistName = releaseGroup.artistName || null;
                        const imageId = servarrMetadata.getAlbumImageUrl({
                            Id: releaseGroup.mbid,
                            Title: releaseGroup.title,
                            ReleaseDate: releaseGroup.releaseDate || undefined,
                            Disambiguation: releaseGroup.disambiguation || undefined,
                            Images: releaseGroup.images || [],
                        });

                        if (localAlbum) {
                            results.albums.push(formatSearchResult({
                                id: mbid,
                                name: releaseGroup.title,
                                cover_id: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                artist_name: artistName,
                                release_date: releaseGroup.releaseDate || null,
                                monitored: !!localAlbum.monitored,
                                in_library: true,
                            }, 'album'));
                        } else {
                            results.albums.push(formatSearchResult({
                                id: mbid,
                                name: releaseGroup.title,
                                cover_id: registerMediaCoverProxyUrl(imageId) || imageId || null,
                                artist_name: artistName,
                                release_date: releaseGroup.releaseDate || null,
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
