/**
 * Standardized TIDAL URL builder.
 * Uses the canonical `tidal.com/browse/` format shared by Discogenius download routing.
 */
export function tidalUrl(type: "artist" | "album" | "track" | "video" | "playlist", id: string | number): string {
    return `https://tidal.com/browse/${type}/${id}`;
}
