import fs from 'fs';
import path from 'path';
import { db } from '../database.js';
import { tidalApiRequest, getCountryCode, getAlbumReview, getArtistBio, getArtist, getAlbum, getVideo } from "./providers/tidal/tidal.js";

/**
 * Clean Tidal text by removing [wimpLink] tags and normalizing line breaks.
 */
function cleanTidalText(text: string): string {
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
        return await getArtist(artistId);
    } catch (error) {
        warnNfoFallback("artist", artistId, error);
        const row = db.prepare(`
            SELECT id, name, picture, popularity
            FROM artists
            WHERE id = ?
        `).get(artistId) as { id: number | string; name: string; picture?: string | null; popularity?: number | null } | undefined;

        if (!row) throw error;
        return {
            id: String(row.id),
            tidal_id: String(row.id),
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
        const bio = await getArtistBio(artistId);
        if (bio?.text) return cleanTidalText(bio.text);
    } catch (error) {
        warnNfoFallback("artist biography", artistId, error);
    }

    const row = db.prepare("SELECT bio_text FROM artists WHERE id = ?").get(artistId) as { bio_text?: string | null } | undefined;
    return row?.bio_text ? cleanTidalText(row.bio_text) : "";
}

async function getAlbumForNfo(albumId: string) {
    try {
        return await getAlbum(albumId);
    } catch (error) {
        warnNfoFallback("album", albumId, error);
        const row = db.prepare(`
            SELECT a.*, ar.name AS artist_name
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
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
            tidal_id: String(row.id),
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
        const review = await getAlbumReview(albumId);
        if (review?.text) return cleanTidalText(review.text);
    } catch (error) {
        warnNfoFallback("album review", albumId, error);
    }

    const row = db.prepare("SELECT review_text FROM albums WHERE id = ?").get(albumId) as { review_text?: string | null } | undefined;
    return row?.review_text ? cleanTidalText(row.review_text) : "";
}

async function getVideoForNfo(videoId: string) {
    try {
        return await getVideo(videoId);
    } catch (error) {
        warnNfoFallback("video", videoId, error);
        const row = db.prepare(`
            SELECT m.id, m.title, m.artist_id, ar.name AS artist_name, m.album_id,
                   m.duration, m.release_date, m.cover, m.quality, m.explicit, m.popularity
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
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
        } | undefined;

        if (!row) throw error;
        const artistId = row.artist_id ? String(row.artist_id) : null;
        const artistName = row.artist_name || null;
        return {
            id: String(row.id),
            tidal_id: String(row.id),
            title: row.title || "Unknown Video",
            artist_id: artistId,
            artist_name: artistName,
            artists: artistId && artistName ? [{ id: artistId, name: artistName }] : [],
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

/**
 * Convert UUID to path format (abc-def-ghi -> abc/def/ghi)
 */
function uuidToPath(uuid: string): string {
    return uuid.replace(/-/g, '/');
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

/**
 * Download album cover at specified resolution
 * @param albumId - Tidal album ID
 * @param resolution - Resolution: 80, 160, 320, 640, 1280, or "origin"
 * @param outputPath - Full path where to save the image
 */
export async function downloadAlbumCover(
    albumId: string,
    resolution: 80 | 160 | 320 | 640 | 1280 | 'origin',
    outputPath: string
): Promise<void> {
    const cc = await getCountryCode();
    const album = await tidalApiRequest(`/albums/${albumId}?countryCode=${cc}`) as any;
    const coverUuid = album.cover;

    if (!coverUuid) {
        console.log(`ℹ️ [METADATA] No album cover available for album ${albumId}, skipping.`);
        return;
    }

    const coverPath = uuidToPath(coverUuid);
    let url: string;

    if (resolution === 'origin') {
        url = `https://resources.tidal.com/images/${coverPath}/origin.jpg`;
    } else {
        url = `https://resources.tidal.com/images/${coverPath}/${resolution}x${resolution}.jpg`;
    }

    console.log(`📥 [METADATA] Downloading album cover: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download album cover for ${albumId}: ${response.statusText}`);
        return;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] Album cover saved: ${outputPath}`);
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
    if (!videoCoverId) {
        console.log(`ℹ️ [METADATA] No album video cover available, skipping.`);
        return;
    }

    const allowed = [80, 160, 320, 640, 1280];
    const numericResolution = typeof resolution === "number" ? resolution : Number(resolution);
    const safeResolution = resolution === "origin"
        ? "origin"
        : (Number.isFinite(numericResolution)
            ? (allowed.find((size) => size >= numericResolution) ?? allowed[allowed.length - 1])
            : 320);

    const coverPath = uuidToPath(videoCoverId);
    const sizeStr = safeResolution === "origin" ? "origin" : `${safeResolution}x${safeResolution}`;
    const url = `https://resources.tidal.com/videos/${coverPath}/${sizeStr}.mp4`;

    console.log(`📥 [METADATA] Downloading album video cover: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download album video cover: ${response.statusText}`);
        return;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] Album video cover saved: ${outputPath}`);
}

/**
 * Download artist picture at specified resolution
 * NOTE: Artist pictures DO NOT have "origin" resolution! Max is 750x750
 * @param artistId - Tidal artist ID
 * @param resolution - Resolution: 160, 320, 480, or 750 (NO origin!)
 * @param outputPath - Full path where to save the image
 */
export async function downloadArtistPicture(
    artistId: string,
    resolution: 160 | 320 | 480 | 750,
    outputPath: string
): Promise<void> {
    const cc = await getCountryCode();
    const artist = await tidalApiRequest(`/artists/${artistId}?countryCode=${cc}`) as any;
    const pictureUuid = artist.picture;

    if (!pictureUuid) {
        console.log(`ℹ️ [METADATA] No artist picture available for artist ${artistId}, skipping.`);
        return;
    }

    const picturePath = uuidToPath(pictureUuid);
    const url = `https://resources.tidal.com/images/${picturePath}/${resolution}x${resolution}.jpg`;

    console.log(`📥 [METADATA] Downloading artist picture: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download artist picture for ${artistId}: ${response.statusText}`);
        return;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] Artist picture saved: ${outputPath}`);
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
    if (!imageId) {
        console.log(`ℹ️ [METADATA] No video thumbnail available, skipping.`);
        return;
    }

    const imagePath = uuidToPath(imageId);
    const normalizedResolution = normalizeVideoThumbnailResolution(resolution);
    const [width, height] = normalizedResolution.split('x');
    const url = `https://resources.tidal.com/images/${imagePath}/${width}x${height}.jpg`;

    console.log(`📥 [METADATA] Downloading video thumbnail: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download video thumbnail: ${response.statusText}`);
        return;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] Video thumbnail saved: ${outputPath}`);
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
} | null> {
    try {
        const cc = await getCountryCode();
        const data = await tidalApiRequest(`/tracks/${trackId}/lyrics?countryCode=${cc}`) as any;

        return {
            text: data?.lyrics || '',
            subtitles: data?.subtitles || '', // Synchronized lyrics (LRC format)
            provider: data?.lyricsProvider || ''
        };
    } catch (error: any) {
        console.error(`❌ [METADATA] Failed to fetch lyrics for track ${trackId}:`, error.message);
        return null;
    }
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

    if (!lyrics?.subtitles) {
        throw new Error(`No synchronized lyrics available for track ${trackId}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lyrics.subtitles, 'utf-8');

    console.log(`✅ [METADATA] Lyrics saved: ${outputPath}`);
}

/**
 * Save artist.nfo in the Jellyfin/Kodi music artist shape.
 */
export async function saveArtistNfoFile(
    artistId: string,
    outputPath: string
): Promise<void> {
    const artist = await getArtistForNfo(artistId);
    const bioText = await getArtistBioTextForNfo(artistId);
    const localArtist = db.prepare(`
        SELECT mbid
        FROM artists
        WHERE id = ?
    `).get(artistId) as { mbid?: string | null } | undefined;

    const albums = db.prepare(`
        SELECT title, release_date
        FROM albums
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
        xmlUniqueId("TidalArtist", artistId),
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
    const album = await getAlbumForNfo(albumId);
    const reviewText = await getAlbumReviewTextForNfo(albumId);
    const localAlbum = db.prepare(`
        SELECT a.mbid, a.mb_release_group_id, ar.mbid AS artist_mbid
        FROM albums a
        LEFT JOIN artists ar ON ar.id = a.artist_id
        WHERE a.id = ?
    `).get(albumId) as { mbid?: string | null; mb_release_group_id?: string | null; artist_mbid?: string | null } | undefined;
    const tracks = db.prepare(`
        SELECT title, duration, track_number, volume_number, mbid
        FROM media
        WHERE album_id = ? AND type != 'Music Video'
        ORDER BY COALESCE(volume_number, 1), COALESCE(track_number, 0), id
    `).all(albumId) as Array<{
        title: string;
        duration: number | null;
        track_number: number | null;
        volume_number: number | null;
        mbid: string | null;
    }>;
    const year = album.releaseDate ? album.releaseDate.substring(0, 4) : "";
    const artists = Array.isArray(album.artists) && album.artists.length > 0
        ? album.artists.map((artist: { name?: unknown }) => artist?.name).filter((name: unknown) => String(name ?? "").trim().length > 0)
        : [album.artist_name || album.artist?.name || "Unknown"];

    const elements = [
        xmlElement("title", album.title),
        xmlElement("review", reviewText),
        xmlElement("outline", reviewText),
        xmlElement("year", year),
        xmlElement("releasedate", album.releaseDate),
        ...artists.map((artistName: unknown) => xmlElement("artist", artistName)),
        ...artists.map((artistName: unknown) => xmlElement("albumartist", artistName)),
        xmlElement("musicbrainzalbumid", localAlbum?.mbid),
        xmlElement("musicbrainzreleasegroupid", localAlbum?.mb_release_group_id),
        xmlElement("musicbrainzalbumartistid", localAlbum?.artist_mbid),
        xmlElement("upc", album.upc),
        xmlUniqueId("MusicBrainzAlbum", localAlbum?.mbid, true),
        xmlUniqueId("MusicBrainzReleaseGroup", localAlbum?.mb_release_group_id),
        xmlUniqueId("MusicBrainzAlbumArtist", localAlbum?.artist_mbid),
        xmlUniqueId("TidalAlbum", albumId),
        ...tracks.map((track) => {
            const trackElements = [
                xmlElement("disc", track.volume_number || 1),
                xmlElement("position", track.track_number),
                xmlElement("title", track.title),
                xmlElement("duration", track.duration),
                xmlUniqueId("MusicBrainzTrack", track.mbid),
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
    const video = await getVideoForNfo(videoId);
    const artistRow = video.artist_id
        ? db.prepare("SELECT mbid FROM artists WHERE id = ?").get(video.artist_id) as { mbid?: string | null } | undefined
        : undefined;
    const albumRow = video.album_id
        ? db.prepare("SELECT title, mbid, mb_release_group_id FROM albums WHERE id = ?").get(video.album_id) as {
            title?: string | null;
            mbid?: string | null;
            mb_release_group_id?: string | null;
        } | undefined
        : undefined;
    const year = String(video.release_date || "").match(/^\d{4}/)?.[0] || "";
    const artistNames = Array.isArray(video.artists) && video.artists.length > 0
        ? video.artists.map((artist: { name?: unknown }) => artist?.name).filter((name: unknown) => String(name ?? "").trim().length > 0)
        : [video.artist_name || "Unknown Artist"];

    const elements = [
        xmlElement("title", video.title),
        xmlElement("year", year),
        xmlElement("releasedate", video.release_date),
        ...artistNames.map((artistName: unknown) => xmlElement("artist", artistName)),
        xmlElement("album", albumRow?.title),
        xmlElement("musicbrainzartistid", artistRow?.mbid),
        xmlElement("musicbrainzalbumid", albumRow?.mbid),
        xmlElement("musicbrainzreleasegroupid", albumRow?.mb_release_group_id),
        xmlUniqueId("MusicBrainzArtist", artistRow?.mbid),
        xmlUniqueId("MusicBrainzAlbum", albumRow?.mbid),
        xmlUniqueId("MusicBrainzReleaseGroup", albumRow?.mb_release_group_id),
        xmlUniqueId("TidalVideo", videoId, true),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<musicvideo>\n${elements.join("\n")}\n</musicvideo>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Video NFO saved: ${outputPath}`);
}
