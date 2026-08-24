import type { ArtistLibraryScope, ArtistPolicy } from "@/services/api";

export type ArtistLibraryAction = "monitor" | "policy" | "unmonitor";

/**
 * Product-default artist scope. The API resolves this against current Settings:
 * Stereo, plus Spatial and Video when their features are enabled.
 */
export const AUTOMATIC_ARTIST_LIBRARY_SCOPE: Readonly<{ allLibraries: true }> = Object.freeze({
  allLibraries: true,
});

export function buildArtistLibraryUpdate(
  action: ArtistLibraryAction,
  policy: ArtistPolicy,
): ({ monitored?: boolean; policy?: ArtistPolicy } & ArtistLibraryScope) {
  if (action === "monitor") {
    return { monitored: true, policy, ...AUTOMATIC_ARTIST_LIBRARY_SCOPE };
  }
  if (action === "policy") {
    return { policy, ...AUTOMATIC_ARTIST_LIBRARY_SCOPE };
  }
  return { monitored: false, ...AUTOMATIC_ARTIST_LIBRARY_SCOPE };
}
