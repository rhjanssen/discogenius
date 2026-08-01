/**
 * When an Album needs more than one track list.
 *
 * Several monitored Editions usually tell the same story twice — a standard and
 * a deluxe, a reissue with the same recordings. Showing tabs for those is noise:
 * the deluxe list already contains the standard one, so one list loses nothing.
 *
 * Tabs earn their place only when two monitored Editions carry canonical
 * Recordings the other does not, because then no single list can show
 * everything the Library actually monitors.
 *
 * Unmonitored Editions never contribute. They are alternatives on offer, not
 * things the Library holds.
 */
export interface TrackListEditionInput {
  editionId: number;
  /** Canonical Recording ids of the Edition — not provider coverage. */
  recordingIds: ReadonlySet<number>;
  representative: boolean;
}

export interface TrackListTab {
  editionId: number;
  /** The tab shown first: the Album's representative Edition. */
  default: boolean;
}

function nested(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const recordingId of smaller) {
    if (!larger.has(recordingId)) return false;
  }
  return true;
}

/**
 * The track-list tabs for one Album in one Library.
 *
 * Returns an empty array when a single list suffices — the caller then renders
 * the representative Edition's tracks with no tab strip at all.
 */
export function resolveTrackListTabs(
  editions: readonly TrackListEditionInput[],
): TrackListTab[] {
  const monitored = [...editions].sort((left, right) => left.editionId - right.editionId);
  if (monitored.length < 2) return [];

  // Equivalent and strictly nested sets are both "nested" — one list covers them.
  let needsTabs = false;
  for (let i = 0; i < monitored.length && !needsTabs; i += 1) {
    for (let j = i + 1; j < monitored.length; j += 1) {
      if (!nested(monitored[i].recordingIds, monitored[j].recordingIds)) {
        needsTabs = true;
        break;
      }
    }
  }
  if (!needsTabs) return [];

  const representative = monitored.find((edition) => edition.representative)
    ?? monitored[0];
  return monitored.map((edition) => ({
    editionId: edition.editionId,
    default: edition.editionId === representative.editionId,
  }));
}
