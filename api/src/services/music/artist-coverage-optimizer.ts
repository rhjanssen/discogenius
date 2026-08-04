/**
 * Artist-wide fewest-releases coverage: pick a minimal set of release groups
 * whose preferred acquisition units cover the filtered discography, with least
 * redundant overlap. Used by curation redundancy instead of pure largest-first
 * containment (MATCHING_SET_COVER_DESIGN / TASKS).
 *
 * `recordingIds` are coverage identity keys from curation.
 */

export type CoverageReleaseGroupCandidate = {
  mbid: string;
  /** Coverage identity keys. */
  recordingIds: ReadonlySet<string>;
  /** Provider albums needed to acquire the selected edition (`;`-split count). */
  providerAlbumCount: number;
  /** Higher is better (Album > EP > Single; compilations already penalized). */
  typePriority: number;
};

function compareCoverageCandidates(
  left: CoverageReleaseGroupCandidate,
  right: CoverageReleaseGroupCandidate,
  remaining: ReadonlySet<string>,
): number {
  const leftCover = countOverlap(left.recordingIds, remaining);
  const rightCover = countOverlap(right.recordingIds, remaining);
  return rightCover - leftCover
    || left.providerAlbumCount - right.providerAlbumCount
    || right.typePriority - left.typePriority
    || right.recordingIds.size - left.recordingIds.size
    || left.mbid.localeCompare(right.mbid);
}

function countOverlap(recordingIds: ReadonlySet<string>, remaining: ReadonlySet<string>): number {
  let overlap = 0;
  for (const recordingId of recordingIds) {
    if (remaining.has(recordingId)) overlap += 1;
  }
  return overlap;
}

/**
 * Greedy set-cover over MusicBrainz recording MBIDs.
 * Returns the release-group MBIDs to retain; callers mark the rest redundant.
 */
export function selectFewestReleaseGroupsForCoverage(
  candidates: readonly CoverageReleaseGroupCandidate[],
): Set<string> {
  const retained = new Set<string>();
  if (candidates.length === 0) {
    return retained;
  }

  const remaining = new Set<string>();
  for (const candidate of candidates) {
    for (const recordingId of candidate.recordingIds) {
      remaining.add(recordingId);
    }
  }
  if (remaining.size === 0) {
    return retained;
  }

  const unused = [...candidates];
  while (remaining.size > 0 && unused.length > 0) {
    unused.sort((left, right) => compareCoverageCandidates(left, right, remaining));
    const best = unused[0];
    const covered = countOverlap(best.recordingIds, remaining);
    if (covered <= 0) {
      break;
    }
    retained.add(best.mbid);
    unused.shift();
    for (const recordingId of best.recordingIds) {
      remaining.delete(recordingId);
    }
  }

  return retained;
}

/**
 * When a manual edition choice costs the discography coverage nothing else
 * supplies.
 */
export type ManualEditionChoiceAlbum = {
  releaseGroupId: number;
  /** Acquisition units the user's chosen editions of this album supply. */
  chosenUnitIds?: ReadonlySet<number>;
  /** Acquisition units the alternative editions supply. */
  alternativeUnitIds?: ReadonlySet<number>;

  /** Canonical recordings alias for backward-compatibility. */
  chosenRecordingIds?: ReadonlySet<number>;
  /** Canonical recordings alias for backward-compatibility. */
  alternativeRecordingIds?: ReadonlySet<number>;
};

export type ManualEditionChoiceOverrule = {
  releaseGroupId: number;
  unreachableUnitIds: number[];
  unreachableRecordingIds: number[];
};

export function findUnreachableManualEditionChoices(input: {
  albums: readonly ManualEditionChoiceAlbum[];
  reachableUnitIds?: ReadonlySet<number>;
  reachableRecordingIds?: ReadonlySet<number>;
}): ManualEditionChoiceOverrule[] {
  const reachable = input.reachableUnitIds ?? input.reachableRecordingIds ?? new Set<number>();
  const overrules: ManualEditionChoiceOverrule[] = [];

  for (const album of input.albums) {
    const chosen = album.chosenUnitIds ?? album.chosenRecordingIds ?? new Set<number>();
    const alternative = album.alternativeUnitIds ?? album.alternativeRecordingIds ?? new Set<number>();
    const unreachable: number[] = [];

    for (const unitId of alternative) {
      if (chosen.has(unitId)) continue;
      if (reachable.has(unitId)) continue;
      unreachable.push(unitId);
    }
    if (unreachable.length === 0) continue;
    const sorted = unreachable.sort((left, right) => left - right);
    overrules.push({
      releaseGroupId: album.releaseGroupId,
      unreachableUnitIds: sorted,
      unreachableRecordingIds: sorted,
    });
  }
  return overrules.sort((left, right) => left.releaseGroupId - right.releaseGroupId);
}
