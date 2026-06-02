import fs from 'fs';
import path from 'path';
import { db } from '../database.js';
import { streamingProviderManager } from "./providers/index.js";
import { getLyricsForProviderMedia } from "./extras/lyrics/lyric-service.js";
import {
    albumProviderArtworkCandidatesFromRow,
    normalizeArtworkUrl,
    parseJsonObject,
    resolveAlbumArtwork,
    resolveArtistArtwork,
    resolveMediaCoverProxyUrl,
    type ProviderArtworkCandidate,
} from "./metadata/media-cover-service.js";

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
        const row = db.prepare(`
            SELECT a.*, ar.name AS artist_name
            FROM ProviderAlbums a
            LEFT JOIN Artists ar ON ar.id = a.artist_id
            WHERE a.id = ?
        `).get(albumId) as {
            id: number | string;
            artist_id: number | string;
            artist_name?: string | null;
            title: string;
            release_date?: string | null;
            type?: string | null;
            quality?: string | null;
            explicit?: number | boolean | null;
            duration?: number | null;
            num_tracks?: number | null;
            num_videos?: number | null;
            num_volumes?: number | null;
            cover?: string | null;
            vibrant_color?: string | null;
            video_cover?: string | null;
            version?: string | null;
            upc?: string | null;
            copyright?: string | null;
        } | undefined;

        if (!row) throw error;
        const artistName = row.artist_name || "Unknown Artist";
        return {
            id: String(row.id),
            title: row.title || "Unknown Album",
            url: `https://tidal.com/album/${row.id}`,
            cover: row.cover || null,
            releaseDate: row.release_date || null,
            release_date: row.release_date || null,
            type: row.type || "ALBUM",
            quality: row.quality || "UNKNOWN",
            explicit: Boolean(row.explicit),
            popularity: 0,
            duration: row.duration || 0,
            numberOfTracks: row.num_tracks || 0,
            numberOfVideos: row.num_videos || 0,
            numberOfVolumes: row.num_volumes || 1,
            vibrant_color: row.vibrant_color || null,
            version: row.version || null,
            items: [],
            artist: {
                id: String(row.artist_id),
                name: artistName,
                picture: null,
            },
            artist_id: String(row.artist_id),
            artist_name: artistName,
            upc: row.upc || null,
            copyright: row.copyright || null,
            video_cover: row.video_cover || null,
            num_videos: row.num_videos || 0,
            num_volumes: row.num_volumes || 1,
            num_tracks: row.num_tracks || 0,
            artists: [{ id: String(row.artist_id), name: artistName, picture: null }],
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

    const row = db.prepare("SELECT review_text FROM ProviderAlbums WHERE id = ?").get(albumId) as { review_text?: string | null } | undefined;
    return row?.review_text ? cleanProviderText(row.review_text) : "";
}

async function getVideoForNfo(videoId: string) {
    try {
        const video = await streamingProviderManager.getDefaultStreamingProvider().getVideo?.(videoId);
        if (!video) {
            throw new Error(`Provider video ${videoId} not found`);
        }
        return video;
    } catch (error) {
        warnNfoFallback("video", videoId, error);
        const row = db.prepare(`
            SELECT m.id, m.title, m.artist_id, ar.name AS artist_name, m.album_id,
                   m.duration, m.release_date, m.cover, m.quality, m.explicit, m.popularity,
                   m.credits
            FROM ProviderMedia m
            LEFT JOIN Artists ar ON ar.id = m.artist_id
            WHERE m.id = ?
        `).get(videoId) as {
            id: number | string;
            title: string;
            artist_id?: number | string | null;
            artist_name?: string | null;
            album_id?: number | string | null;
            duration?: number | null;
            release_date?: string | null;
            cover?: string | null;
            quality?: string | null;
            explicit?: number | boolean | null;
            popularity?: number | null;
            credits?: string | null;
        } | undefined;

        if (!row) throw error;
        const artistId = row.artist_id ? String(row.artist_id) : null;
        const artistName = row.artist_name || null;
        return {
            id: String(row.id),
            title: row.title || "Unknown Video",
            artist_id: artistId,
            artist_name: artistName,
            artists: (() => {
                try {
                    const credits = JSON.parse(row.credits || "[]");
                    if (Array.isArray(credits) && credits.length > 0) return credits;
                } catch {
                    // Ignore JSON parsing errors and fall back to single artist
                }
                return artistId && artistName ? [{ id: artistId, name: artistName }] : [];
            })(),
            album_id: row.album_id ? String(row.album_id) : null,
            duration: row.duration || 0,
            release_date: row.release_date || null,
            image_id: row.cover || null,
            vibrant_color: null,
            quality: row.quality || "MP4_1080P",
            explicit: Boolean(row.explicit),
            popularity: row.popularity || 0,
            url: `https://listen.tidal.com/video/${row.id}`,
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
    skyHookData: Record<string, any> | null;
    providerCandidates: ProviderArtworkCandidate[];
} | null {
    const row = db.prepare(`
        SELECT
            pa.id AS provider_album_id,
            pa.cover AS provider_cover,
            pi.provider AS selected_provider,
            pi.provider_id AS selected_provider_id,
            pi.data AS provider_data,
            rg.data AS release_group_data,
            stereo.selected_provider AS stereo_provider,
            stereo.selected_provider_id AS stereo_provider_id,
            stereo.provider_data AS stereo_provider_data,
            spatial.selected_provider AS spatial_provider,
            spatial.selected_provider_id AS spatial_provider_id,
            spatial.provider_data AS spatial_provider_data
        FROM ProviderAlbums pa
        LEFT JOIN ProviderItems pi
          ON pi.entity_type = 'album'
         AND CAST(pi.provider_id AS TEXT) = CAST(pa.id AS TEXT)
        LEFT JOIN Albums rg
          ON rg.mbid = COALESCE(pi.release_group_mbid, pa.mb_release_group_id)
        LEFT JOIN ReleaseGroupSlots stereo
          ON stereo.release_group_mbid = rg.mbid
         AND stereo.slot = 'stereo'
        LEFT JOIN ReleaseGroupSlots spatial
          ON spatial.release_group_mbid = rg.mbid
         AND spatial.slot = 'spatial'
        WHERE CAST(pa.id AS TEXT) = CAST(? AS TEXT)
        ORDER BY CASE WHEN pi.release_group_mbid IS NOT NULL THEN 0 ELSE 1 END
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
            imageId: row.provider_cover == null ? null : String(row.provider_cover),
            data: row.provider_data,
        },
    ];

    return {
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

    const albums = db.prepare(`
        SELECT title, release_date
        FROM ProviderAlbums
        WHERE artist_id = ?
        ORDER BY release_date, title
        LIMIT 250
    `).all(artistId) as Array<{ title: string; release_date: string | null }>;

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
    const localAlbum = db.prepare(`
        SELECT a.mbid, a.mb_release_group_id, ar.mbid AS artist_mbid
        FROM ProviderAlbums a
        LEFT JOIN Artists ar ON ar.id = a.artist_id
        WHERE a.id = ?
    `).get(albumId) as { mbid?: string | null; mb_release_group_id?: string | null; artist_mbid?: string | null } | undefined;
    const selectedSlot = localAlbum?.mb_release_group_id
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
            localAlbum.mb_release_group_id,
            albumId,
            `${albumId};%`,
            `%;${albumId};%`,
            `%;${albumId}`,
        ) as { selected_release_mbid?: string | null; selected_provider_id?: string | null } | undefined
        : undefined;
    const canonicalRelease = selectedSlot?.selected_release_mbid
        ? db.prepare(`
            SELECT release.mbid, release_group.title, release.date, release.barcode
            FROM AlbumReleases release
            JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
            WHERE release.mbid = ?
            LIMIT 1
        `).get(selectedSlot.selected_release_mbid) as {
            mbid?: string | null;
            title?: string | null;
            date?: string | null;
            barcode?: string | null;
        } | undefined
        : undefined;
    const providerAlbumIds = String(selectedSlot?.selected_provider_id || albumId)
        .split(";")
        .map((id) => id.trim())
        .filter(Boolean);
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
            ORDER BY COALESCE(track.medium_position, 1), COALESCE(track.position, 0), track.Id
        `).all(canonicalRelease.mbid)
        : db.prepare(`
        SELECT
            media.title,
            media.duration,
            media.track_number,
            media.volume_number,
            media.mbid AS recording_mbid,
            (
                SELECT track.mbid
                FROM Tracks track
                WHERE track.release_mbid = album.mbid
                  AND track.recording_mbid = media.mbid
                  AND track.medium_position = COALESCE(media.volume_number, 1)
                  AND track.position = COALESCE(media.track_number, 1)
                LIMIT 1
            ) AS track_mbid
        FROM ProviderMedia media
        JOIN ProviderAlbums album ON album.id = media.album_id
        WHERE media.album_id = ? AND media.type != 'Music Video'
        ORDER BY COALESCE(media.volume_number, 1), COALESCE(media.track_number, 0), media.id
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
        xmlElement("musicbrainzalbumid", canonicalRelease?.mbid || localAlbum?.mbid),
        xmlElement("musicbrainzreleasegroupid", localAlbum?.mb_release_group_id),
        xmlElement("musicbrainzalbumartistid", localAlbum?.artist_mbid),
        xmlElement("upc", canonicalRelease?.barcode || album.upc),
        xmlUniqueId("MusicBrainzAlbum", canonicalRelease?.mbid || localAlbum?.mbid, true),
        xmlUniqueId("MusicBrainzReleaseGroup", localAlbum?.mb_release_group_id),
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
    const videoArtistId = videoRecord.artist_id || videoRecord.artist?.providerId || null;
    const videoArtistName = videoRecord.artist_name || videoRecord.artist?.name || null;
    const videoAlbumId = videoRecord.album_id || null;
    const videoReleaseDate = videoRecord.release_date || videoRecord.releaseDate || null;
    const artistRow = videoArtistId
        ? db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(videoArtistId) as { mbid?: string | null } | undefined
        : undefined;
    const albumRow = videoAlbumId
        ? db.prepare("SELECT title, mbid, mb_release_group_id FROM ProviderAlbums WHERE id = ?").get(videoAlbumId) as {
            title?: string | null;
            mbid?: string | null;
            mb_release_group_id?: string | null;
        } | undefined
        : undefined;
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
        xmlElement("musicbrainzartistid", artistRow?.mbid),
        xmlElement("musicbrainzalbumid", albumRow?.mbid),
        xmlElement("musicbrainzreleasegroupid", albumRow?.mb_release_group_id),
        xmlUniqueId("MusicBrainzArtist", artistRow?.mbid),
        xmlUniqueId("MusicBrainzAlbum", albumRow?.mbid),
        xmlUniqueId("MusicBrainzReleaseGroup", albumRow?.mb_release_group_id),
        xmlUniqueId(`${provider.id}Video`, videoId, true),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<musicvideo>\n${elements.join("\n")}\n</musicvideo>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Video NFO saved: ${outputPath}`);
}
