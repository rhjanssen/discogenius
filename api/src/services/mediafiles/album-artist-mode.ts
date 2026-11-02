/** How ALBUMARTIST is chosen. Every other tag is the same in both modes. */
export type AlbumArtistMode = "plex_jellyfin" | "picard";

/**
 * Identity of this tag writer. Stored inside the `retag:v1:` fingerprint so a
 * library stamped before Picard parity is opened once and rewritten. The
 * prefix itself stays `retag:v1:` so a running retag command is not reset.
 */
export const TAG_STANDARD_ID = "picard-v1";

/**
 * Explicit `picard` wins. The legacy boolean `full_album_artist_credit: true`
 * migrates to `picard`, including when it sits next to the factory default
 * `plex_jellyfin` that config fills in before normalize. A saved mode without
 * that boolean is kept. Anything else is the Plex/Jellyfin default.
 */
export function resolveAlbumArtistMode(raw?: {
  album_artist_mode?: string | null;
  full_album_artist_credit?: boolean | null;
} | null): AlbumArtistMode {
  if (raw?.album_artist_mode === "picard") return "picard";
  if (raw?.full_album_artist_credit === true) return "picard";
  if (raw?.album_artist_mode === "plex_jellyfin") return "plex_jellyfin";
  return "plex_jellyfin";
}
