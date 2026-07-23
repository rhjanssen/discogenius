/**
 * Shared ranking for music-video ↔ album associations.
 *
 * Preferred order (Appears On, preferred placement, album associated-videos):
 *  1. Studio Album/EP/Single (no Live / Compilation secondary)
 *  2. Other non-live, non-compilation release groups
 *  3. Compilations (allowed, but never beat a real album on size alone)
 *  4. Live release groups
 * Then monitored/wanted, then largest track count, then title.
 */

export type VideoAlbumAssociationKind =
  | "studio"
  | "other"
  | "compilation"
  | "live";

/** Lower sorts first. */
export function videoAlbumAssociationKindRank(
  primaryType: string | null | undefined,
  secondaryTypes: string | null | undefined,
): number {
  const secondary = String(secondaryTypes || "").toLowerCase();
  if (secondary.includes('"live"')) return 3;
  if (secondary.includes('"compilation"')) return 2;
  const primary = String(primaryType || "").trim().toLowerCase();
  if (primary === "album" || primary === "ep" || primary === "single") return 0;
  return 1;
}

export function videoAlbumAssociationKind(
  primaryType: string | null | undefined,
  secondaryTypes: string | null | undefined,
): VideoAlbumAssociationKind {
  switch (videoAlbumAssociationKindRank(primaryType, secondaryTypes)) {
    case 0: return "studio";
    case 2: return "compilation";
    case 3: return "live";
    default: return "other";
  }
}

/**
 * SQL expression over Albums alias `a` → 0 studio … 3 live.
 * Keep in sync with {@link videoAlbumAssociationKindRank}.
 */
export const VIDEO_ALBUM_ASSOCIATION_KIND_SQL = `
  CASE
    WHEN LOWER(COALESCE(a.secondary_types, '')) LIKE '%"live"%' THEN 3
    WHEN LOWER(COALESCE(a.secondary_types, '')) LIKE '%"compilation"%' THEN 2
    WHEN LOWER(COALESCE(a.primary_type, '')) IN ('album', 'ep', 'single') THEN 0
    ELSE 1
  END
`.trim();

/**
 * Compare two album association candidates for preferred ranking.
 * Returns negative when `left` should sort before `right`.
 */
export function compareVideoAlbumAssociations(
  left: {
    kindRank: number;
    wanted: boolean | number | null | undefined;
    trackCount: number | null | undefined;
    title?: string | null;
  },
  right: {
    kindRank: number;
    wanted: boolean | number | null | undefined;
    trackCount: number | null | undefined;
    title?: string | null;
  },
): number {
  if (left.kindRank !== right.kindRank) return left.kindRank - right.kindRank;
  const leftWanted = left.wanted ? 1 : 0;
  const rightWanted = right.wanted ? 1 : 0;
  if (leftWanted !== rightWanted) return rightWanted - leftWanted;
  const leftTracks = Number(left.trackCount || 0);
  const rightTracks = Number(right.trackCount || 0);
  if (leftTracks !== rightTracks) return rightTracks - leftTracks;
  return String(left.title || "").localeCompare(String(right.title || ""), undefined, {
    sensitivity: "base",
  });
}
