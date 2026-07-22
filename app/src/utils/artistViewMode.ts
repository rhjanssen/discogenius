/** Shared artist/album card layout preference (carousel | grid | list). */
export const ARTIST_VIEW_MODE_STORAGE_KEY = "discogenius_artist_view_mode";

export type ArtistViewMode = "carousel" | "grid" | "list";

export function readArtistViewMode(): ArtistViewMode {
  try {
    const saved = localStorage.getItem(ARTIST_VIEW_MODE_STORAGE_KEY);
    if (saved === "grid" || saved === "carousel" || saved === "list") {
      return saved;
    }
  } catch {
    // Storage may be unavailable; fall through to default.
  }
  return "carousel";
}

export function writeArtistViewMode(mode: ArtistViewMode): void {
  try {
    localStorage.setItem(ARTIST_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference persistence is best-effort.
  }
}
