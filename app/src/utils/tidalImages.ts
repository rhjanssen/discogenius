export type TidalImageType = 'artist' | 'album' | 'video' | 'square';

export type TidalImageSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | number;

// Valid Tidal image sizes per content type (from tidalapi library)
// Invalid sizes return HTTP 403 Forbidden
const VALID_ARTIST_SIZES = [160, 320, 480, 750]; // max 750x750
const VALID_ALBUM_SIZES = [80, 160, 320, 640, 1280, 3000]; // 3000 = "origin" resolution
const VALID_SQUARE_SIZES = [80, 160, 320, 480, 640, 750, 1080, 1280]; // union for backwards compat

// Valid video aspect ratio sizes (3:2 ratio) for music video thumbnails/images
const VALID_VIDEO_SIZES: [number, number][] = [[160, 107], [480, 320], [750, 500], [1080, 720]];

// Valid video cover sizes (square, MP4 format) - for animated album covers
// These are looping MP4 videos used as album art on some releases
const VALID_VIDEO_COVER_SIZES = [80, 160, 320, 640, 1280]; // 'origin' also available

/**
 * Snap a requested size to the nearest valid Tidal image size
 */
function snapToValidSize(requestedSize: number, validSizes: number[]): number {
  // Find the smallest valid size >= requested, or the largest if none found
  const larger = validSizes.find(s => s >= requestedSize);
  return larger ?? validSizes[validSizes.length - 1];
}

/**
 * Generate a Tidal image URL with explicit dimensions
 * @param uuid - The image UUID from Tidal
 * @param type - Content type: 'artist', 'album' (both square), 'video' (3:2), or 'square' (explicit)
 * @param size - Image size/width. Can be a number or preset name:
 *   - tiny: 160px (Video: 160x107)
 *   - small: 320px (Video: 480x320)
 *   - medium: 480px (Video: 750x500) - Note: 640 is invalid
 *   - large: 750px/1280px (Video: 1080x720)
 * @returns Tidal CDN image URL or null if no UUID provided
 */
export function getTidalImage(
  uuid: string | null | undefined,
  type: TidalImageType,
  size: TidalImageSize
): string | null {
  if (!uuid) return null;

  let width: number;
  let height: number;

  // Resolve named sizes to numbers based on type
  if (typeof size === 'string') {
    switch (size) {
      case 'tiny':
        width = 160;
        break;
      case 'small':
        width = type === 'video' ? 480 : 320;
        break;
      case 'medium':
        // Artists: 480, Albums: 640, Videos: 750
        width = type === 'video' ? 750 : (type === 'artist' ? 480 : 640);
        break;
      case 'large':
        width = type === 'video' ? 1080 : (type === 'artist' ? 750 : 1280);
        break;
      case 'huge':
        // For albums, use origin (3000x3000), artists max at 750
        width = type === 'video' ? 1080 : (type === 'artist' ? 750 : 3000);
        break;
      default:
        width = 320;
    }
  } else {
    width = size;
  }

  // Determine height and strictly enforce valid resolutions per content type
  if (type === 'video') {
    // Snap to valid video resolutions (3:2 aspect ratio)
    if (width <= 160) { width = 160; height = 107; }
    else if (width <= 480) { width = 480; height = 320; }
    else if (width <= 750) { width = 750; height = 500; }
    else { width = 1080; height = 720; }
  } else if (type === 'artist') {
    // Artist images: valid sizes are 160, 320, 480, 750
    width = snapToValidSize(width, VALID_ARTIST_SIZES);
    height = width;
  } else if (type === 'album') {
    // Album images: valid sizes are 80, 160, 320, 640, 1280
    width = snapToValidSize(width, VALID_ALBUM_SIZES);
    height = width;
  } else {
    // Generic square - try to use a size that works for both
    // Prefer album sizes since they're more commonly used
    width = snapToValidSize(width, VALID_ALBUM_SIZES);
    height = width;
  }

  return `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${width}x${height}.jpg`;
}

/**
 * Get album cover image URL
 * @param coverId - The album cover UUID from Tidal (stored in `albums.cover`)
 * @param size - Image size (default: 'medium' = 640px)
 */
export function getAlbumCover(
  coverId: string | null | undefined,
  size: TidalImageSize = 'medium'
): string | null {
  return getTidalImage(coverId, 'album', size);
}

/**
 * Get artist picture URL
 * @param pictureId - The artist picture UUID from Tidal (stored in artists.picture)
 * @param size - Image size (default: 'medium' = 480px)
 */
export function getArtistPicture(
  pictureId: string | null | undefined,
  size: TidalImageSize = 'medium'
): string | null {
  return getTidalImage(pictureId, 'artist', size);
}

/**
 * Get music video thumbnail URL (JPG)
 * @param coverId - The video image UUID from Tidal (stored in `media.cover`)
 * @param size - Image size (default: 'medium' = 750x500)
 */
export function getVideoThumbnail(
  coverId: string | null | undefined,
  size: TidalImageSize = 'medium'
): string | null {
  return getTidalImage(coverId, 'video', size);
}

export type AlbumVideoCoverSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'origin' | number;

/**
 * Get album video cover URL (animated MP4 cover)
 * Some albums have animated video covers that loop as album art.
 * These are square MP4 videos, publicly accessible without authentication.
 * 
 * @param videoCoverId - The video cover UUID from Tidal (from album.videoCover field)
 * @param size - Video size:
 *   - tiny: 80x80 (~67KB)
 *   - small: 160x160 (~132KB)
 *   - medium: 320x320 (~262KB)
 *   - large: 640x640 (~349KB)
 *   - huge: 1280x1280 (~3.5MB)
 *   - origin: Original resolution (~12MB)
 *   - number: Custom size (will snap to nearest valid)
 * @returns Tidal CDN MP4 video URL or null if no UUID provided
 * 
 * Valid sizes: 80, 160, 320, 640, 1280, origin
 * Format: video/mp4
 * No authentication required.
 */
export function getAlbumVideoCover(
  videoCoverId: string | null | undefined,
  size: AlbumVideoCoverSize = 'medium'
): string | null {
  if (!videoCoverId) return null;

  let dimension: number | 'origin';

  if (typeof size === 'string') {
    switch (size) {
      case 'tiny':
        dimension = 80;
        break;
      case 'small':
        dimension = 160;
        break;
      case 'medium':
        dimension = 320;
        break;
      case 'large':
        dimension = 640;
        break;
      case 'huge':
        dimension = 1280;
        break;
      case 'origin':
        dimension = 'origin';
        break;
      default:
        dimension = 320;
    }
  } else {
    // Snap to nearest valid size
    dimension = snapToValidSize(size, VALID_VIDEO_COVER_SIZES);
  }

  const sizeStr = dimension === 'origin' ? 'origin' : `${dimension}x${dimension}`;
  return `https://resources.tidal.com/videos/${videoCoverId.replace(/-/g, '/')}/${sizeStr}.mp4`;
}
