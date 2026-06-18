/**
 * Quality system aligned with tidal-dl-ng downloader options and TIDAL metadata.
 * 
 * IMPORTANT: TIDAL's metadata API primarily advertises these source-quality tags:
 *   - LOSSLESS (16-bit 44.1kHz)
 *   - HIRES_LOSSLESS (up to 24-bit 192kHz)
 *   - DOLBY_ATMOS (spatial audio - separate media type)
 *
 * Discogenius stores the actual library-file quality in `track_files.quality`.
 * That means AAC downloads converted by tidal-dl-ng can show up as `LOW` or `HIGH`
 * in the local library even if the TIDAL source metadata only reports lossless tiers.
 * 
 * tidal-dl-ng quality_audio options (from tidalapi.Quality):
 *   LOW            -> 96 kbps AAC
 *   HIGH           -> 320 kbps AAC
 *   LOSSLESS       -> 16-bit 44.1kHz FLAC
 *   HIRES_LOSSLESS -> up to 24-bit 192kHz FLAC
 * 
 * Spatial audio is treated as a separate media slot (like music videos), not a quality tier.
 * Albums can have both stereo and spatial versions downloaded separately.
 * tidal-dl-ng's download_dolby_atmos is hardcoded to true; curation (include_spatial) controls
 * whether spatial items are monitored and kept in the library.
 */

/**
 * Maps tidal-dl-ng quality settings to what should be monitored in the database.
 * Since TIDAL only stores LOSSLESS and HIRES_LOSSLESS, LOW/HIGH all monitor LOSSLESS.
 */
export const TIDAL_DL_NG_QUALITY_TO_MONITOR: Record<string, string> = {
    "LOW": "LOSSLESS",            // Monitor LOSSLESS, tidal-dl-ng downloads as 96 kbps AAC
    "HIGH": "LOSSLESS",           // Monitor LOSSLESS, tidal-dl-ng downloads as 320 kbps AAC
    "LOSSLESS": "LOSSLESS",       // Monitor LOSSLESS, tidal-dl-ng downloads as 16-bit FLAC
    "HIRES_LOSSLESS": "HIRES_LOSSLESS", // Monitor HIRES_LOSSLESS, downloads as 24-bit FLAC
};

/**
 * Human-readable quality descriptions for display
 */
export const QUALITY_DESCRIPTIONS: Record<string, string> = {
    "LOW": "Low (96 kbps AAC)",
    "HIGH": "High (320 kbps AAC)",
    "LOSSLESS": "Lossless (16-bit 44.1kHz FLAC)",
    "HIRES_LOSSLESS": "Hi-Res (up to 24-bit 192kHz FLAC)",
    "DOLBY_ATMOS": "Dolby Atmos (spatial audio)",
};

export function normalizeAudioQualityTag(quality: string | null | undefined): string {
    return (quality || "").trim().toUpperCase();
}
