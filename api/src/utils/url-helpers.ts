/**
 * URL reconstruction helpers
 * Since we're removing URL columns from the database,
 * use these to generate URLs dynamically from tidal_id
 */

// Valid Tidal image sizes per content type (from tidalapi library)
// Invalid sizes return HTTP 403 Forbidden
const VALID_ARTIST_SIZES = [160, 320, 480, 750]; // max 750x750
const VALID_ALBUM_SIZES = [80, 160, 320, 640, 1280, 3000]; // 3000 = "origin" resolution
const VALID_VIDEO_WIDTHS = [160, 480, 750, 1080]; // 3:2 ratio

/**
 * Snap a requested size to the nearest valid Tidal image size
 */
function snapToValidSize(requestedSize: number, validSizes: number[]): number {
    const larger = validSizes.find(s => s >= requestedSize);
    return larger ?? validSizes[validSizes.length - 1];
}

export function getTidalAlbumUrl(tidalId: string): string {
    return `https://listen.tidal.com/album/${tidalId}`;
}

export function getTidalTrackUrl(tidalId: string): string {
    return `https://listen.tidal.com/track/${tidalId}`;
}

export function getTidalVideoUrl(tidalId: string): string {
    return `https://listen.tidal.com/video/${tidalId}`;
}

export function getTidalArtistUrl(tidalId: string): string {
    return `https://listen.tidal.com/artist/${tidalId}`;
}

/**
 * Get album cover URL with validated size
 * @param coverId - Album cover UUID (e.g., "1234-5678-9abc-def0")
 * @param size - Requested size, will snap to valid: 80, 160, 320, 640, 1280, 3000
 */
export function getAlbumCover(coverId: string | null, size: number = 640): string {
    if (!coverId) return '';
    const validSize = snapToValidSize(size, VALID_ALBUM_SIZES);
    const pictureId = coverId.replace(/-/g, '/');
    return `https://resources.tidal.com/images/${pictureId}/${validSize}x${validSize}.jpg`;
}

/**
 * Get artist picture URL with validated size
 * @param pictureId - Artist picture UUID (e.g., "1234-5678-9abc-def0")
 * @param size - Requested size, will snap to valid: 160, 320, 480, 750
 */
export function getArtistPicture(pictureId: string | null, size: number = 320): string {
    if (!pictureId) return '';
    const validSize = snapToValidSize(size, VALID_ARTIST_SIZES);
    const formattedId = pictureId.replace(/-/g, '/');
    return `https://resources.tidal.com/images/${formattedId}/${validSize}x${validSize}.jpg`;
}

/**
 * Get video thumbnail URL with validated size (3:2 aspect ratio)
 * @param coverId - Video image UUID
 * @param width - Requested width, will snap to valid: 160x107, 480x320, 750x500, 1080x720
 */
export function getVideoThumbnail(coverId: string | null, width: number = 750): string {
    if (!coverId) return '';
    // Snap to valid video widths and calculate corresponding height
    let w: number, h: number;
    if (width <= 160) { w = 160; h = 107; }
    else if (width <= 480) { w = 480; h = 320; }
    else if (width <= 750) { w = 750; h = 500; }
    else { w = 1080; h = 720; }

    const formattedId = coverId.replace(/-/g, '/');
    return `https://resources.tidal.com/images/${formattedId}/${w}x${h}.jpg`;
}

