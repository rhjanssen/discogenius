/**
 * When an Album needs more than one track list.
 *
 * Several monitored Editions usually tell the same story twice — a standard and
 * a deluxe, a reissue with the same recordings, or the Stereo library's Dreams
 * edition and the Spatial library's Dreams edition (identical tracklists, two
 * MB releases for different slots). Showing tabs for those is noise.
 *
 * Tabs earn their place only when two *distinct* recording sets are monitored
 * and neither nests the other (true overlap with unique tracks on each side),
 * because then no single list can show everything.
 *
 * Collapse order:
 *   1. Same edition id (multi-library) → one entry
 *   2. Equivalent recording sets → one entry (prefer representative / larger)
 *   3. Strict subsets → drop; keep the superset only
 *   4. Remaining maximals that only partially overlap → one tab each
 *
 * Callers should pass every monitored Edition of the album (all libraries),
 * ideally with recording ids already mapped through coverage units so
 * clean/explicit twins count as the same set.
 *
 * Unmonitored Editions never contribute. They are alternatives on offer, not
 * things the Library holds.
 */
export interface TrackListEditionInput {
  editionId: number;
  /** Canonical Recording ids (or coverage units) of the Edition. */
  recordingIds: ReadonlySet<number>;
  representative: boolean;
}

export interface TrackListTab {
  editionId: number;
  /** The tab shown first: the Album's representative Edition when present. */
  default: boolean;
}

function nested(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const recordingId of smaller) {
    if (!larger.has(recordingId)) return false;
  }
  return true;
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false;
  for (const recordingId of left) {
    if (!right.has(recordingId)) return false;
  }
  return true;
}

function isStrictSubset(
  smaller: ReadonlySet<number>,
  larger: ReadonlySet<number>,
): boolean {
  if (smaller.size >= larger.size) return false;
  for (const recordingId of smaller) {
    if (!larger.has(recordingId)) return false;
  }
  return true;
}

/**
 * One entry per distinct recording set. Stereo + Spatial twins of the same
 * tracklist (same recordings, different edition ids) collapse to a single tab
 * so the page shows both slot badges on one list instead of two identical tabs.
 */
export function collapseEquivalentEditions(
  editions: readonly TrackListEditionInput[],
): TrackListEditionInput[] {
  const groups: TrackListEditionInput[][] = [];
  for (const edition of editions) {
    const group = groups.find((candidate) =>
      setsEqual(candidate[0].recordingIds, edition.recordingIds));
    if (group) group.push(edition);
    else groups.push([edition]);
  }
  return groups.map((group) =>
    [...group].sort((left, right) =>
      Number(right.representative) - Number(left.representative)
      || right.recordingIds.size - left.recordingIds.size
      || left.editionId - right.editionId)[0]);
}

/**
 * Drop editions whose track set is a strict subset of another monitored
 * edition. The superset tab already shows every track the subset has.
 */
export function collapseNestedEditions(
  editions: readonly TrackListEditionInput[],
): TrackListEditionInput[] {
  return editions.filter((edition) =>
    !editions.some((other) =>
      other.editionId !== edition.editionId
      && isStrictSubset(edition.recordingIds, other.recordingIds)));
}

/**
 * The track-list tabs for one Album (typically across all libraries).
 *
 * - Zero tabs: nothing monitored.
 * - One tab: single musical product after collapse (equal sets / nested
 *   subsets). The page should load that edition's tracks and hide the tab strip.
 * - Two+ tabs: true partial-overlap products that each carry unique tracks.
 *
 * Track-level stereo/spatial acquisition badges still come from planned offers
 * matched by recording identity, so collapsing twins does not hide either slot.
 */
export function resolveTrackListTabs(
  editions: readonly TrackListEditionInput[],
): TrackListTab[] {
  // Dedupe the same edition id if multiple libraries contribute it.
  const byEditionId = new Map<number, TrackListEditionInput>();
  for (const edition of editions) {
    const existing = byEditionId.get(edition.editionId);
    if (!existing) {
      byEditionId.set(edition.editionId, edition);
      continue;
    }
    byEditionId.set(edition.editionId, {
      ...existing,
      representative: existing.representative || edition.representative,
    });
  }

  const equivalent = collapseEquivalentEditions([...byEditionId.values()]
    .sort((left, right) => left.editionId - right.editionId));
  // Standard inside deluxe, clean twin inside the same unit-mapped set after
  // equivalence: only maximals remain. Partial overlap (unique tracks on each
  // side) keeps multiple maximals → tabs.
  const monitored = collapseNestedEditions(equivalent);
  if (monitored.length === 0) return [];

  // Prefer a representative edition that is still among the maximals; otherwise
  // the largest set (then lowest id) is the default tab.
  const representative = monitored.find((edition) => edition.representative)
    ?? [...monitored].sort((left, right) =>
      right.recordingIds.size - left.recordingIds.size
      || left.editionId - right.editionId)[0];
  return monitored.map((edition) => ({
    editionId: edition.editionId,
    default: edition.editionId === representative.editionId,
  }));
}
