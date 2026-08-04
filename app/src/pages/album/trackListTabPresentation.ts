import type { TrackListTabContract } from "@contracts/pages";
import { editionMediaRank, editionTabLabel } from "@/pages/album/editionDisplay";

export interface TrackListTabPresentation {
  editionId: number;
  label: string;
  default: boolean;
}

/**
 * Label and order the track-list tabs the API resolved.
 *
 * Membership and the default tab are backend decisions: `/page` collapses
 * equivalent and nested Editions through canonical acquisition units and marks
 * exactly one tab as the list that opens first. This function may only choose
 * how those tabs read and in which order they sit — Digital before CD before
 * Vinyl, larger tracklist first within a format — so the strip stays stable
 * while the selected list still comes from curation.
 */
export function resolveTrackListTabPresentation(
  tabs: readonly TrackListTabContract[] | undefined,
  albumTitle: string | null | undefined,
): TrackListTabPresentation[] {
  if (!tabs || tabs.length === 0) return [];

  const byEditionId = new Map<number, TrackListTabContract>();
  for (const tab of tabs) {
    if (!byEditionId.has(tab.editionId)) byEditionId.set(tab.editionId, tab);
  }

  return [...byEditionId.values()]
    .sort((left, right) =>
      editionMediaRank(left.mediaFormats) - editionMediaRank(right.mediaFormats)
      || (right.trackCount ?? 0) - (left.trackCount ?? 0)
      || left.editionId - right.editionId)
    .map((tab) => ({
      editionId: tab.editionId,
      label: editionTabLabel(tab, albumTitle),
      default: tab.default,
    }));
}

/**
 * The Edition whose track list opens first.
 *
 * `/page` ships those tracks inline, so this must agree with
 * `initialTrackListEditionId` or the page fetches an Edition it already has.
 */
export function defaultTrackListEditionId(
  tabs: readonly TrackListTabPresentation[],
): number | null {
  return tabs.find((tab) => tab.default)?.editionId ?? null;
}
