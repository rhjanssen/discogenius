import fs from 'fs';
import path from 'path';
import { tidalApiRequest, getCountryCode, getAlbumReview, getArtistBio } from './tidal.js';

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
 * Save album review to review.txt file
 * @param albumId - Tidal album ID
 * @param outputPath - Full path where to save the review.txt file
 */
export async function saveReviewFile(
    albumId: string,
    outputPath: string
): Promise<void> {
    const review = await getAlbumReview(albumId);
    const reviewText = review?.text ?? null;

    if (!reviewText) {
        throw new Error(`No review available for album ${albumId}`);
    }

    const cleanedReview = cleanTidalText(reviewText);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, cleanedReview, 'utf-8');

    console.log(`✅ [METADATA] Review saved: ${outputPath}`);
}

/**
 * Save artist bio to bio.txt file
 * @param artistId - Tidal artist ID
 * @param outputPath - Full path where to save the bio.txt file
 */
export async function saveBioFile(
    artistId: string,
    outputPath: string
): Promise<void> {
    const bio = await getArtistBio(artistId);
    const bioText = bio?.text ?? null;

    if (!bioText) {
        throw new Error(`No bio available for artist ${artistId}`);
    }

    const cleanedBio = cleanTidalText(bioText);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, cleanedBio, 'utf-8');

    console.log(`✅ [METADATA] Bio saved: ${outputPath}`);
}
