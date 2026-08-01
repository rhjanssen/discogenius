/**
 * Artist-wide fewest-releases coverage: pick a minimal set of release groups
 * whose preferred recordings cover the filtered discography, with least
 * redundant overlap. Used by curation redundancy instead of pure largest-first
 * containment (MATCHING_SET_COVER_DESIGN / TASKS).
 *
 * `recordingIds` are coverage identity keys from curation: `isrc:…` when
 * MusicBrainz has ISRCs (so retitled masters of the same recording collapse),
 * otherwise `mbid:…` / bare recording MBIDs.
 */

export type CoverageReleaseGroupCandidate = {
  mbid: string;
  /** Coverage identity keys (ISRC-preferred, else recording MBID). */
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
 *
 * A manual edition choice is a preference, not a lock. The user picks the
 * standard over the deluxe, and that should stand — the deluxe-only recordings
 * are usually obtainable anyway, as singles, on another edition, from another
 * provider, and curation should go and monitor those instead of overruling a
 * deliberate choice.
 *
 * It should not stand when those recordings exist *only* on the edition the user
 * declined, because then honouring the preference silently loses canonical
 * recordings from the library. That is the one case automation may overrule, and
 * only for an unlocked album: a lock says "do not reconsider this", full stop,
 * and an album that keeps its gap is showing the user exactly what their choice
 * costs.
 *
 * The comparison is canonical **Recording identity across the whole
 * discography**, never track counts. Two 12-track editions carrying different
 * recordings are not interchangeable, and a numeric test would call them equal.
 */
export type ManualEditionChoiceAlbum = {
  releaseGroupId: number;
  /** Canonical recordings the user's chosen editions of this album supply. */
  chosenRecordingIds: ReadonlySet<number>;
  /**
   * Canonical recordings the editions of this album that curation would have
   * chosen supply. Only editions curation considers eligible belong here — an
   * edition no provider can deliver is not an alternative that was passed over.
   */
  alternativeRecordingIds: ReadonlySet<number>;
};

export type ManualEditionChoiceOverrule = {
  releaseGroupId: number;
  /**
   * Recordings reachable only through the declined edition, ascending. These
   * are what the override costs, and what makes the reason arguable rather than
   * merely announced.
   */
  unreachableRecordingIds: number[];
};

export function findUnreachableManualEditionChoices(input: {
  albums: readonly ManualEditionChoiceAlbum[];
  /**
   * Canonical recordings reachable from everything else the library monitors
   * across this artist's discography — other albums, singles, other editions.
   * The album under test contributes only its chosen editions.
   */
  reachableRecordingIds: ReadonlySet<number>;
}): ManualEditionChoiceOverrule[] {
  const overrules: ManualEditionChoiceOverrule[] = [];
  for (const album of input.albums) {
    const unreachable: number[] = [];
    for (const recordingId of album.alternativeRecordingIds) {
      if (album.chosenRecordingIds.has(recordingId)) continue;
      if (input.reachableRecordingIds.has(recordingId)) continue;
      unreachable.push(recordingId);
    }
    if (unreachable.length === 0) continue;
    overrules.push({
      releaseGroupId: album.releaseGroupId,
      unreachableRecordingIds: unreachable.sort((left, right) => left - right),
    });
  }
  return overrules.sort((left, right) => left.releaseGroupId - right.releaseGroupId);
}
