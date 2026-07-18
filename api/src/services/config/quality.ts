/**
 * Provider-neutral quality-tag helpers.
 *
 * Discogenius stores the actual library-file quality in `TrackFiles.quality`
 * using the neutral tag vocabulary (LOW/HIGH/LOSSLESS/HIRES_LOSSLESS and the
 * spatial tags). Provider-specific quality vocabularies and their mappings
 * live inside each provider plugin (`services/providers/<id>/`), never here.
 */

export function normalizeAudioQualityTag(quality: string | null | undefined): string {
    return (quality || "").trim().toUpperCase();
}
