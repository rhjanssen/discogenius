import fs from 'fs';
import path from 'path';
import { db } from '../../database.js';
import { streamingProviderManager } from "../providers/index.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { getLyricsForProviderMedia } from "../extras/lyrics/lyric-service.js";
import {
    albumProviderArtworkCandidatesFromRow,
    normalizeArtworkUrl,
    parseJsonObject,
    resolveAlbumArtwork,
    resolveArtistArtwork,
    resolveMediaCoverProxyUrl,
    type ProviderArtworkCandidate,
} from "../metadata/media-cover-service.js";

type AlbumProviderItemRow = {
    provider: string | null;
    provider_id: string;
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    provider_title: string | null;
    provider_version: string | null;
    provider_quality: string | null;
    provider_explicit: number | null;
    provider_duration: number | null;
    provider_release_date: string | null;
    provider_upc: string | null;
    provider_asset_id: string | null;
    provider_data: string | null;
    release_group_title: string | null;
    primary_type: string | null;
    first_release_date: string | null;
    release_group_cover_image_id: string | null;
    release_group_vibrant_color: string | null;
    release_group_video_cover: string | null;
    release_group_popularity: number | null;
    release_group_review_text: string | null;
    release_group_review_source: string | null;
    release_group_review_last_updated: string | null;
    release_group_data: string | null;
    release_title: string | null;
    release_date: string | null;
    barcode: string | null;
    release_copyright: string | null;
    media_count: number | null;
    track_count: number | null;
    release_data: string | null;
    artist_id: string | null;
    artist_name: string | null;
};

type VideoProviderItemRow = {
    provider: string | null;
    provider_id: string;
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    recording_mbid: string | null;
    album_id: string | null;
    provider_title: string | null;
    provider_quality: string | null;
    provider_explicit: number | null;
    provider_duration: number | null;
    provider_release_date: string | null;
    provider_asset_id: string | null;
    provider_data: string | null;
    recording_title: string | null;
    recording_release_date: string | null;
    recording_cover_image_id: string | null;
    recording_artist_credit: string | null;
    recording_length_ms: number | null;
    recording_data: string | null;
    artist_id: string | null;
    artist_name: string | null;
    album_title: string | null;
    album_mbid: string | null;
};

/**
 * Clean provider text by removing TIDAL-style [wimpLink] tags and normalizing line breaks.
 */
function cleanProviderText(text: string): string {
    const normalized = text
        .replace(/\r\n/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n");

    return normalized
        .replace(/\[wimpLink\b[^\]]*\]([\s\S]*?)\[\/wimpLink\]/gi, '$1')
        .replace(/\[wimpLink\b[^\]]*\]/gi, '')
        .replace(/\[\/wimpLink\]/gi, '')
        .trim();
}

function escapeXml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function xmlElement(name: string, value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text ? `  <${name}>${escapeXml(text)}</${name}>` : null;
}

function xmlUniqueId(type: string, value: unknown, isDefault = false): string | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    return `  <uniqueid type="${escapeXml(type)}" default="${isDefault ? "true" : "false"}">${escapeXml(text)}</uniqueid>`;
}

function writeXmlFile(outputPath: string, xml: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, xml, 'utf-8');
}

function warnNfoFallback(entity: string, id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ [METADATA] Falling back to local ${entity} metadata for ${id}: ${message}`);
}

function textOrNull(...values: unknown[]): string | null {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) return text;
    }
    return null;
}

function splitProviderIds(value: string | null | undefined): string[] {
    return String(value || "")
        .split(";")
        .map((id) => id.trim())
        .filter(Boolean);
}

function loadAlbumProviderItem(albumId: string): AlbumProviderItemRow | null {
    return (db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            pi.artist_mbid,
            pi.release_group_mbid,
            pi.release_mbid,
            pi.title AS provider_title,
            pi.version AS provider_version,
            pi.quality AS provider_quality,
            pi.explicit AS provider_explicit,
            pi.duration AS provider_duration,
            pi.release_date AS provider_release_date,
            pi.upc AS provider_upc,
            pi.asset_id AS provider_asset_id,
            pi.data AS provider_data,
            rg.title AS release_group_title,
            rg.primary_type AS primary_type,
            rg.first_release_date AS first_release_date,
            rg.cover_image_id AS release_group_cover_image_id,
            rg.vibrant_color AS release_group_vibrant_color,
            rg.video_cover AS release_group_video_cover,
            rg.popularity AS release_group_popularity,
            rg.review_text AS release_group_review_text,
            rg.review_source AS release_group_review_source,
            rg.review_last_updated AS release_group_review_last_updated,
            rg.data AS release_group_data,
            release.title AS release_title,
            release.date AS release_date,
            release.barcode AS barcode,
            release.copyright AS release_copyright,
            release.media_count AS media_count,
            release.track_count AS track_count,
            release.data AS release_data,
            artist.id AS artist_id,
            COALESCE(artist.name, artist_metadata.name) AS artist_name
        FROM ProviderItems pi
        LEFT JOIN Albums rg ON rg.mbid = pi.release_group_mbid
        LEFT JOIN AlbumReleases release ON release.mbid = pi.release_mbid
        LEFT JOIN ArtistMetadata artist_metadata
          ON artist_metadata.mbid = COALESCE(pi.artist_mbid, rg.artist_mbid, release.artist_mbid)
        LEFT JOIN Artists artist ON artist.mbid = artist_metadata.mbid
        WHERE pi.entity_type = 'album'
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(albumId) as AlbumProviderItemRow | undefined) ?? null;
}

function loadVideoProviderItem(videoId: string): VideoProviderItemRow | null {
    return (db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            pi.artist_mbid,
            pi.release_group_mbid,
            pi.release_mbid,
            pi.recording_mbid,
            CAST(pi.album_id AS TEXT) AS album_id,
            pi.title AS provider_title,
            pi.quality AS provider_quality,
            pi.explicit AS provider_explicit,
            pi.duration AS provider_duration,
            pi.release_date AS provider_release_date,
            pi.asset_id AS provider_asset_id,
            pi.data AS provider_data,
            recording.title AS recording_title,
            recording.release_date AS recording_release_date,
            recording.cover_image_id AS recording_cover_image_id,
            recording.artist_credit AS recording_artist_credit,
            recording.length_ms AS recording_length_ms,
            recording.data AS recording_data,
            artist.id AS artist_id,
            COALESCE(artist.name, artist_metadata.name) AS artist_name,
            album.title AS album_title,
            release.mbid AS album_mbid
        FROM ProviderItems pi
        LEFT JOIN Recordings recording
          ON recording.id = pi.recording_id
          OR (pi.recording_mbid IS NOT NULL AND recording.mbid = pi.recording_mbid)
        LEFT JOIN ArtistMetadata artist_metadata
          ON artist_metadata.mbid = COALESCE(pi.artist_mbid, recording.artist_mbid)
        LEFT JOIN Artists artist ON artist.mbid = artist_metadata.mbid
        LEFT JOIN Albums album ON album.mbid = pi.release_group_mbid
        LEFT JOIN AlbumReleases release ON release.mbid = pi.release_mbid
        WHERE pi.entity_type = 'video'
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(videoId) as VideoProviderItemRow | undefined) ?? null;
}

async function getArtistForNfo(artistId: string) {
    try {
        return await streamingProviderManager.getDefaultStreamingProvider().getArtist(artistId);
    } catch (error) {
        warnNfoFallback("artist", artistId, error);
        const row = db.prepare(`
            SELECT id, name, picture, popularity
            FROM Artists
            WHERE id = ?
        `).get(artistId) as { id: number | string; name: string; picture?: string | null; popularity?: number | null } | undefined;

        if (!row) throw error;
        return {
            id: String(row.id),
            name: row.name || "Unknown Artist",
            picture: row.picture || null,
            popularity: row.popularity || 0,
            artist_types: ["ARTIST"],
            artist_roles: [],
        };
    }
}

async function getArtistBioTextForNfo(artistId: string): Promise<string> {
    try {
        const bio = await streamingProviderManager.getDefaultStreamingProvider().getArtistBio?.(artistId);
        if (bio) return cleanProviderText(bio);
    } catch (error) {
        warnNfoFallback("artist biography", artistId, error);
    }

    const row = db.prepare("SELECT bio_text FROM Artists WHERE id = ?").get(artistId) as { bio_text?: string | null } | undefined;
    return row?.bio_text ? cleanProviderText(row.bio_text) : "";
}

async function getAlbumForNfo(albumId: string) {
    try {
        return await streamingProviderManager.getDefaultStreamingProvider().getAlbum(albumId);
    } catch (error) {
        warnNfoFallback("album", albumId, error);
        const row = loadAlbumProviderItem(albumId);

        if (!row) throw error;
        const providerData = parseJsonObject(row.provider_data) || {};
        const releaseData = parseJsonObject(row.release_data) || {};
        const artistName = row.artist_name || "Unknown Artist";
        const artistId = row.artist_id || row.artist_mbid || "";
        const title = row.release_group_title || row.release_title || row.provider_title || providerData.title || "Unknown Album";
        const releaseDate = row.release_date || row.first_release_date || row.provider_release_date || providerData.release_date || null;
        return {
            id: String(row.provider_id),
            title,
            url: (() => {
                try {
                    return buildStreamingMediaUrl("album", String(row.provider_id));
                } catch {
                    return null;
                }
            })(),
            cover: row.release_group_cover_image_id || row.provider_asset_id || providerData.cover || providerData.image || null,
            releaseDate,
            release_date: releaseDate,
            type: row.primary_type || providerData.type || "ALBUM",
            quality: row.provider_quality || providerData.quality || "UNKNOWN",
            explicit: Boolean(row.provider_explicit ?? providerData.explicit),
            popularity: row.release_group_popularity || providerData.popularity || 0,
            duration: row.provider_duration || providerData.duration || 0,
            numberOfTracks: row.track_count || providerData.num_tracks || providerData.trackCount || 0,
            numberOfVideos: providerData.num_videos || providerData.videoCount || 0,
            numberOfVolumes: row.media_count || providerData.num_volumes || providerData.volumeCount || 1,
            vibrant_color: row.release_group_vibrant_color || providerData.vibrant_color || null,
            version: row.provider_version || providerData.version || null,
            items: [],
            artist: {
                id: String(artistId),
                name: artistName,
                picture: null,
            },
            artist_id: String(artistId),
            artist_name: artistName,
            upc: row.barcode || row.provider_upc || providerData.upc || null,
            copyright: row.release_copyright || providerData.copyright || releaseData.copyright || null,
            video_cover: row.release_group_video_cover || providerData.video_cover || providerData.videoCover || null,
            num_videos: providerData.num_videos || providerData.videoCount || 0,
            num_volumes: row.media_count || providerData.num_volumes || providerData.volumeCount || 1,
            num_tracks: row.track_count || providerData.num_tracks || providerData.trackCount || 0,
            artists: [{ id: String(artistId), name: artistName, picture: null }],
        };
    }
}

async function getAlbumReviewTextForNfo(albumId: string): Promise<string> {
    try {
        const review = await streamingProviderManager.getDefaultStreamingProvider().getAlbumReview?.(albumId);
        if (review) return cleanProviderText(review);
    } catch (error) {
        warnNfoFallback("album review", albumId, error);
    }

    const row = loadAlbumProviderItem(albumId);
    const providerData = parseJsonObject(row?.provider_data) || {};
    const releaseGroupData = parseJsonObject(row?.release_group_data) || {};
    const review = textOrNull(
        row?.release_group_review_text,
        providerData.review_text,
        providerData.review,
        providerData.description,
        releaseGroupData.review_text,
        releaseGroupData.overview,
    );
    return review ? cleanProviderText(review) : "";
}

async function getVideoForNfo(videoId: string) {
    try {
        const video = await streamingProviderManager.getDefaultStreamingProvider().getVideo?.(videoId);
        if (!video) {
            throw new Error(`provider video ${videoId} not found`);
        }
        return video;
    } catch (error) {
        warnNfoFallback("video", videoId, error);
        const row = loadVideoProviderItem(videoId);

        if (!row) throw error;
        const artistId = row.artist_id ? String(row.artist_id) : null;
        const providerData = parseJsonObject(row.provider_data) || {};
        const recordingData = parseJsonObject(row.recording_data) || {};
        const artistName = row.artist_name || row.recording_artist_credit || null;
        const artists = Array.isArray(providerData.artists)
            ? providerData.artists
            : Array.isArray(providerData.credits)
                ? providerData.credits
                : Array.isArray(recordingData.artists)
                    ? recordingData.artists
                    : [];
        return {
            id: String(row.provider_id),
            title: row.recording_title || row.provider_title || providerData.title || "Unknown Video",
            artist_id: artistId,
            artist_name: artistName,
            artists: artists.length > 0 ? artists : (artistId && artistName ? [{ id: artistId, name: artistName }] : []),
            album_id: row.album_id ? String(row.album_id) : null,
            duration: row.provider_duration || (row.recording_length_ms ? Math.round(row.recording_length_ms / 1000) : 0),
            release_date: row.recording_release_date || row.provider_release_date || providerData.release_date || null,
            image_id: row.recording_cover_image_id || row.provider_asset_id || providerData.cover || null,
            vibrant_color: null,
            quality: row.provider_quality || providerData.quality || "MP4_1080P",
            explicit: Boolean(row.provider_explicit ?? providerData.explicit),
            popularity: providerData.popularity || 0,
            url: (() => {
                try {
                    return buildStreamingMediaUrl("video", String(row.provider_id));
                } catch {
                    return null;
                }
            })(),
            type: "Music Video",
        };
    }
}

type VideoThumbnailResolution =
    | "160x107"
    | "480x320"
    | "750x500"
    | "1080x720"
    | "640x360"
    | "1280x720"
    | "origin";

const normalizeVideoThumbnailResolution = (resolution: VideoThumbnailResolution): "160x107" | "480x320" | "750x500" | "1080x720" => {
    if (resolution === "origin" || resolution === "1280x720") {
        return "1080x720";
    }
    if (resolution === "640x360") {
        return "480x320";
    }
    return resolution;
};

async function downloadProviderArtwork(
    url: string | null | undefined,
    outputPath: string,
    label: string,
): Promise<void> {
    if (!url) {
        console.log(`ℹ️ [METADATA] No ${label} available, skipping.`);
        return;
    }

    const fetchUrl = resolveMediaCoverProxyUrl(url);
    if (!fetchUrl) {
        console.log(`⚠️ [METADATA] Invalid ${label} URL: ${url}`);
        return;
    }

    console.log(`📥 [METADATA] Downloading ${label}: ${fetchUrl}`);

    let response: Response;
    try {
        response = await fetch(fetchUrl);
    } catch (error) {
        console.warn(`⚠️ [METADATA] Failed to download ${label}: ${(error as Error).message}`);
        return;
    }
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download ${label}: ${response.statusText}`);
        return;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] ${label} saved: ${outputPath}`);
}

function loadResolvedArtistArtwork(artistId: string): string | null {
    const row = db.prepare(`
        SELECT cover_image_url, picture
        FROM Artists
        WHERE id = ? OR mbid = ?
        LIMIT 1
    `).get(artistId, artistId) as { cover_image_url?: string | null; picture?: string | null } | undefined;

    const resolved = row?.picture || row?.cover_image_url || null;
    return typeof resolved === "string" && /^https?:\/\//i.test(resolved) ? resolved : null;
}

function loadAlbumArtworkContext(albumId: string): {
    albumMbid: string | null;
    skyHookData: Record<string, any> | null;
    providerCandidates: ProviderArtworkCandidate[];
} | null {
    const row = db.prepare(`
        SELECT
            pi.provider_id AS provider_album_id,
            pi.asset_id AS provider_cover,
            pi.provider AS selected_provider,
            pi.provider_id AS selected_provider_id,
            pi.asset_id AS provider_asset_id,
            pi.data AS provider_data,
            rg.mbid AS album_mbid,
            rg.cover_image_id AS release_group_cover,
            rg.data AS release_group_data,
            stereo.selected_provider AS stereo_provider,
            stereo.selected_provider_id AS stereo_provider_id,
            stereo.provider_data AS stereo_provider_data,
            spatial.selected_provider AS spatial_provider,
            spatial.selected_provider_id AS spatial_provider_id,
            spatial.provider_data AS spatial_provider_data
        FROM ProviderItems pi
        LEFT JOIN Albums rg
          ON rg.mbid = pi.release_group_mbid
        LEFT JOIN ReleaseGroupSlots stereo
          ON stereo.release_group_mbid = rg.mbid
         AND stereo.slot = 'stereo'
        LEFT JOIN ReleaseGroupSlots spatial
          ON spatial.release_group_mbid = rg.mbid
         AND spatial.slot = 'spatial'
        WHERE pi.entity_type = 'album'
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(albumId) as Record<string, any> | undefined;

    if (!row) {
        return null;
    }

    const providerCandidates = [
        ...albumProviderArtworkCandidatesFromRow(row),
        {
            provider: String(row.selected_provider || "tidal"),
            entityId: row.provider_album_id == null ? albumId : String(row.provider_album_id),
            imageId: row.release_group_cover == null ? null : String(row.release_group_cover),
            data: null,
        },
        {
            provider: String(row.selected_provider || "tidal"),
            entityId: row.provider_album_id == null ? albumId : String(row.provider_album_id),
            imageId: row.provider_cover == null ? null : String(row.provider_cover),
            data: row.provider_data,
        },
    ];

    return {
        albumMbid: row.album_mbid ? String(row.album_mbid) : null,
        skyHookData: parseJsonObject(row.release_group_data),
        providerCandidates,
    };
}

function loadArtistArtworkContext(artistId: string): {
    skyHookData: Record<string, any> | null;
    providerCandidates: ProviderArtworkCandidate[];
} | null {
    const row = db.prepare(`
        SELECT
            a.id,
            a.mbid,
            a.picture,
            a.cover_image_url,
            am.data AS artist_metadata_data,
            pi.provider,
            pi.provider_id,
            pi.data AS provider_data
        FROM Artists a
        LEFT JOIN ArtistMetadata am
          ON am.mbid = a.mbid
        LEFT JOIN ProviderItems pi
          ON pi.entity_type = 'artist'
         AND (
            (a.mbid IS NOT NULL AND pi.artist_mbid = a.mbid)
            OR CAST(pi.provider_id AS TEXT) = CAST(a.id AS TEXT)
         )
        WHERE CAST(a.id AS TEXT) = CAST(? AS TEXT)
           OR CAST(a.mbid AS TEXT) = CAST(? AS TEXT)
        ORDER BY CASE WHEN pi.artist_mbid IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
    `).get(artistId, artistId) as Record<string, any> | undefined;

    if (!row) {
        return null;
    }

    return {
        skyHookData: parseJsonObject(row.artist_metadata_data),
        providerCandidates: [
            {
                provider: row.provider ? String(row.provider) : "tidal",
                entityId: row.provider_id == null ? artistId : String(row.provider_id),
                imageId: normalizeArtworkUrl(row.picture) ? String(row.picture) : (row.picture == null ? null : String(row.picture)),
                data: row.provider_data,
            },
            {
                provider: row.provider ? String(row.provider) : "tidal",
                entityId: row.provider_id == null ? artistId : String(row.provider_id),
                imageId: normalizeArtworkUrl(row.cover_image_url) ? String(row.cover_image_url) : null,
                data: row.provider_data,
            },
        ],
    };
}

/**
 * Download album cover at specified resolution
 * @param albumId - Tidal album ID
 * @param resolution - Resolution: 80, 160, 320, 640, 1280, or "origin"
 * @param outputPath - Full path where to save the image
 */
export async function downloadAlbumCover(
    albumId: string,
    resolution: 80 | 160 | 250 | 320 | 500 | 640 | 1200 | 1280 | 'origin',
    outputPath: string
): Promise<void> {
    const context = loadAlbumArtworkContext(albumId);
    let url = context
        ? await resolveAlbumArtwork({
            albumMbid: context.albumMbid,
            skyHookData: context.skyHookData,
            providerCandidates: context.providerCandidates,
            size: resolution,
        })
        : null;

    if (!url) {
        url = await streamingProviderManager.getDefaultStreamingProvider().getArtworkUrl?.({
            entityType: "album",
            providerId: albumId,
            size: resolution,
        }) ?? null;
    }
    await downloadProviderArtwork(url, outputPath, `album cover for ${albumId}`);
}

/**
 * Download album video cover (animated MP4) at specified resolution
 * @param videoCoverId - Album video cover UUID (from album.videoCover)
 * @param resolution - Resolution: 80, 160, 320, 640, 1280, or "origin"
 * @param outputPath - Full path where to save the MP4
 */
export async function downloadAlbumVideoCover(
    videoCoverId: string,
    resolution: number | "origin",
    outputPath: string
): Promise<void> {
    const allowed = [80, 160, 250, 320, 500, 640, 1200, 1280];
    const numericResolution = typeof resolution === "number" ? resolution : Number(resolution);
    const safeResolution = resolution === "origin"
        ? "origin"
        : (Number.isFinite(numericResolution)
            ? (allowed.find((size) => size >= numericResolution) ?? allowed[allowed.length - 1])
            : 320);

    const size = safeResolution === "origin" ? "origin" : `${safeResolution}x${safeResolution}`;
    const url = await streamingProviderManager.getDefaultStreamingProvider().getArtworkUrl?.({
        entityType: "albumVideoCover",
        imageId: videoCoverId,
        size,
    });
    await downloadProviderArtwork(url, outputPath, "album video cover");
}

/**
 * Download artist picture at specified resolution
 * @param artistId - Tidal artist ID
 * @param resolution - Preferred resolution. SkyHook/source images are used as-is; provider fallback may quantize.
 * @param outputPath - Full path where to save the image
 */
export async function downloadArtistPicture(
    artistId: string,
    resolution: number | "origin",
    outputPath: string
): Promise<void> {
    const context = loadArtistArtworkContext(artistId);
    const resolvedArtworkUrl = context
        ? await resolveArtistArtwork({
            skyHookData: context.skyHookData,
            providerCandidates: context.providerCandidates,
            preferredCoverTypes: ["Poster", "Headshot", "Fanart"],
            size: resolution,
        })
        : loadResolvedArtistArtwork(artistId);
    if (resolvedArtworkUrl) {
        await downloadProviderArtwork(resolvedArtworkUrl, outputPath, `artist picture for ${artistId}`);
        return;
    }

    try {
        const url = await streamingProviderManager.getDefaultStreamingProvider().getArtworkUrl?.({
            entityType: "artist",
            providerId: artistId,
            size: resolution,
        });
        await downloadProviderArtwork(url, outputPath, `artist picture for ${artistId}`);
    } catch (error) {
        console.warn(`⚠️ [METADATA] Failed to resolve provider artist picture for ${artistId}: ${(error as Error).message}`);
    }
}

/**
 * Download music video thumbnail at specified resolution
 * NOTE: Video thumbnails are 3:2 aspect ratio (e.g., 1080x720, 750x500)
 * @param imageId - Video image UUID (from video.imageId)
 * @param resolution - Resolution: "160x107", "480x320", "750x500", or "1080x720"
 * @param outputPath - Full path where to save the image
 */
export async function downloadVideoThumbnail(
    imageId: string,
    resolution: VideoThumbnailResolution,
    outputPath: string
): Promise<void> {
    const normalizedResolution = normalizeVideoThumbnailResolution(resolution);
    const url = await streamingProviderManager.getDefaultStreamingProvider().getArtworkUrl?.({
        entityType: "video",
        imageId,
        size: normalizedResolution,
    });
    await downloadProviderArtwork(url, outputPath, "video thumbnail");
}

/**
 * Get track lyrics including synchronized subtitles
 * @param trackId - Tidal track ID
 * @returns Lyrics object with text and subtitles (LRC format)
 */
export async function getTrackLyrics(trackId: string): Promise<{
    text: string;
    subtitles: string;
    provider: string;
    matchType?: string;
} | null> {
    return getLyricsForProviderMedia(trackId);
}

/**
 * Save synchronized lyrics to .lrc file
 * @param trackId - Tidal track ID
 * @param outputPath - Full path where to save the .lrc file
 */
export async function saveLyricsFile(
    trackId: string,
    outputPath: string
): Promise<void> {
    const lyrics = await getTrackLyrics(trackId);

    const content = lyrics?.subtitles || lyrics?.text || "";
    if (!content) {
        throw new Error(`No lyrics available for track ${trackId}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');

    console.log(`✅ [METADATA] Lyrics saved: ${outputPath}`);
}

/**
 * Save artist.nfo in the Jellyfin/Kodi music artist shape.
 */
export async function saveArtistNfoFile(
    artistId: string,
    outputPath: string
): Promise<void> {
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    const artist = await getArtistForNfo(artistId);
    const bioText = await getArtistBioTextForNfo(artistId);
    const localArtist = db.prepare(`
        SELECT mbid
        FROM Artists
        WHERE id = ?
    `).get(artistId) as { mbid?: string | null } | undefined;

    const albums = localArtist?.mbid
        ? db.prepare(`
        SELECT title, release_date
        FROM (
            SELECT title, first_release_date AS release_date
            FROM Albums
            WHERE artist_mbid = ?
        )
        ORDER BY release_date, title
        LIMIT 250
    `).all(localArtist.mbid) as Array<{ title: string; release_date: string | null }>
        : [];

    const elements = [
        xmlElement("title", artist.name),
        xmlElement("name", artist.name),
        xmlElement("sorttitle", artist.name),
        xmlElement("biography", bioText),
        xmlElement("outline", bioText),
        xmlElement("musicbrainzartistid", localArtist?.mbid),
        xmlUniqueId("MusicBrainzArtist", localArtist?.mbid, true),
        xmlUniqueId(`${provider.id}Artist`, artistId),
        ...albums.map((album) => {
            const year = String(album.release_date || "").match(/^\d{4}/)?.[0] || "";
            return `  <album>\n${[
                xmlElement("title", album.title),
                xmlElement("year", year),
            ].filter((element): element is string => Boolean(element)).map((element) => `  ${element}`).join("\n")}\n  </album>`;
        }),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<artist>\n${elements.join("\n")}\n</artist>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Artist NFO saved: ${outputPath}`);
}

/**
 * Save album.nfo in the Jellyfin/Kodi music album shape.
 */
export async function saveAlbumNfoFile(
    albumId: string,
    outputPath: string
): Promise<void> {
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    const album = await getAlbumForNfo(albumId);
    const reviewText = await getAlbumReviewTextForNfo(albumId);
    const localAlbum = loadAlbumProviderItem(albumId);
    const selectedSlot = localAlbum?.release_group_mbid
        ? db.prepare(`
            SELECT selected_release_mbid, selected_provider_id
            FROM ReleaseGroupSlots
            WHERE release_group_mbid = ?
              AND selected_release_mbid IS NOT NULL
              AND (
                selected_provider_id = ?
                OR selected_provider_id LIKE ?
                OR selected_provider_id LIKE ?
                OR selected_provider_id LIKE ?
              )
            ORDER BY CASE WHEN slot = 'stereo' THEN 0 ELSE 1 END
            LIMIT 1
        `).get(
            localAlbum.release_group_mbid,
            albumId,
            `${albumId};%`,
            `%;${albumId};%`,
            `%;${albumId}`,
        ) as { selected_release_mbid?: string | null; selected_provider_id?: string | null } | undefined
        : undefined;
    const canonicalReleaseMbid = selectedSlot?.selected_release_mbid || localAlbum?.release_mbid || null;
    const canonicalRelease = canonicalReleaseMbid
        ? db.prepare(`
            SELECT release.mbid, release_group.title, release.date, release.barcode
            FROM AlbumReleases release
            JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
            WHERE release.mbid = ?
            LIMIT 1
        `).get(canonicalReleaseMbid) as {
            mbid?: string | null;
            title?: string | null;
            date?: string | null;
            barcode?: string | null;
        } | undefined
        : undefined;
    const providerAlbumIds = splitProviderIds(selectedSlot?.selected_provider_id || albumId);
    const tracks = canonicalRelease?.mbid
        ? db.prepare(`
            SELECT
                track.title,
                CASE WHEN track.length_ms IS NULL THEN NULL ELSE ROUND(track.length_ms / 1000.0) END AS duration,
                track.position AS track_number,
                track.medium_position AS volume_number,
                track.recording_mbid,
                track.mbid AS track_mbid
            FROM Tracks track
            WHERE track.release_mbid = ?
            ORDER BY COALESCE(track.medium_position, 1), COALESCE(track.position, 0), track.id
        `).all(canonicalRelease.mbid)
        : db.prepare(`
        SELECT
            pi.title,
            pi.duration,
            NULL AS track_number,
            NULL AS volume_number,
            pi.recording_mbid,
            pi.track_mbid
        FROM ProviderItems pi
        WHERE pi.entity_type = 'track'
          AND CAST(pi.album_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.provider_id
    `).all(albumId);
    const nfoTracks = tracks as Array<{
        title: string;
        duration: number | null;
        track_number: number | null;
        volume_number: number | null;
        recording_mbid: string | null;
        track_mbid: string | null;
    }>;
    const releaseDate = canonicalRelease?.date || album.releaseDate;
    const year = releaseDate ? releaseDate.substring(0, 4) : "";
    const albumRecord = album as any;
    const artists = Array.isArray(albumRecord.artists) && albumRecord.artists.length > 0
        ? albumRecord.artists.map((artist: { name?: unknown }) => artist?.name).filter((name: unknown) => String(name ?? "").trim().length > 0)
        : [albumRecord.artist_name || albumRecord.artist?.name || "Unknown"];

    const elements = [
        xmlElement("title", canonicalRelease?.title || album.title),
        xmlElement("review", reviewText),
        xmlElement("year", year),
        xmlElement("releasedate", releaseDate),
        ...artists.map((artistName: unknown) => xmlElement("artist", artistName)),
        ...artists.map((artistName: unknown) => xmlElement("albumartist", artistName)),
        xmlElement("musicbrainzalbumid", canonicalRelease?.mbid || localAlbum?.release_mbid),
        xmlElement("musicbrainzreleasegroupid", localAlbum?.release_group_mbid),
        xmlElement("musicbrainzalbumartistid", localAlbum?.artist_mbid),
        xmlElement("upc", canonicalRelease?.barcode || album.upc),
        xmlUniqueId("MusicBrainzAlbum", canonicalRelease?.mbid || localAlbum?.release_mbid, true),
        xmlUniqueId("MusicBrainzReleaseGroup", localAlbum?.release_group_mbid),
        xmlUniqueId("MusicBrainzAlbumArtist", localAlbum?.artist_mbid),
        ...providerAlbumIds.map((providerAlbumId) => xmlUniqueId(`${provider.id}Album`, providerAlbumId)),
        ...nfoTracks.map((track) => {
            const trackElements = [
                xmlElement("disc", track.volume_number || 1),
                xmlElement("position", track.track_number),
                xmlElement("title", track.title),
                xmlElement("duration", track.duration),
                xmlUniqueId("MusicBrainzTrack", track.track_mbid),
                xmlUniqueId("MusicBrainzRecording", track.recording_mbid),
            ].filter((element): element is string => Boolean(element));
            return `  <track>\n${trackElements.map((element) => `  ${element}`).join("\n")}\n  </track>`;
        }),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<album>\n${elements.join("\n")}\n</album>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Album NFO saved: ${outputPath}`);
}

/**
 * Save a music-video NFO sidecar. Jellyfin's music-video NFO root is musicvideo.
 */
export async function saveVideoNfoFile(
    videoId: string,
    outputPath: string
): Promise<void> {
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    const video = await getVideoForNfo(videoId);
    const videoRecord = video as any;
    const localVideo = loadVideoProviderItem(videoId);
    const videoArtistId = videoRecord.artist_id || videoRecord.artist?.providerId || localVideo?.artist_id || null;
    const videoArtistName = videoRecord.artist_name || videoRecord.artist?.name || localVideo?.artist_name || null;
    const videoAlbumId = videoRecord.album_id || null;
    const videoReleaseDate = videoRecord.release_date || videoRecord.releaseDate || null;
    const artistRow = videoArtistId
        ? db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(videoArtistId) as { mbid?: string | null } | undefined
        : undefined;
    const albumItem = videoAlbumId ? loadAlbumProviderItem(String(videoAlbumId)) : null;
    const albumRow = albumItem ? {
        title: albumItem.release_group_title || albumItem.release_title || albumItem.provider_title,
        mbid: albumItem.release_mbid,
        mb_release_group_id: albumItem.release_group_mbid,
    } : localVideo ? {
        title: localVideo.album_title,
        mbid: localVideo.album_mbid || localVideo.release_mbid,
        mb_release_group_id: localVideo.release_group_mbid,
    } : undefined;
    const year = String(videoReleaseDate || "").match(/^\d{4}/)?.[0] || "";
    const videoArtists = Array.isArray(videoRecord.artists) && videoRecord.artists.length > 0
        ? videoRecord.artists
        : Array.isArray(videoRecord.raw?.artists) ? videoRecord.raw.artists : [];
    const artistNames = videoArtists.length > 0
        ? videoArtists.map((artist: { name?: unknown }) => artist?.name).filter((name: unknown) => String(name ?? "").trim().length > 0)
        : [videoArtistName || "Unknown Artist"];

    const elements = [
        xmlElement("title", video.title),
        xmlElement("year", year),
        xmlElement("releasedate", videoReleaseDate),
        ...artistNames.map((artistName: unknown) => xmlElement("artist", artistName)),
        xmlElement("album", albumRow?.title),
        xmlElement("musicbrainzartistid", artistRow?.mbid || localVideo?.artist_mbid),
        xmlElement("musicbrainzalbumid", albumRow?.mbid),
        xmlElement("musicbrainzreleasegroupid", albumRow?.mb_release_group_id),
        xmlUniqueId("MusicBrainzArtist", artistRow?.mbid || localVideo?.artist_mbid),
        xmlUniqueId("MusicBrainzAlbum", albumRow?.mbid),
        xmlUniqueId("MusicBrainzReleaseGroup", albumRow?.mb_release_group_id),
        xmlUniqueId(`${provider.id}Video`, videoId, true),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<musicvideo>\n${elements.join("\n")}\n</musicvideo>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Video NFO saved: ${outputPath}`);
}
