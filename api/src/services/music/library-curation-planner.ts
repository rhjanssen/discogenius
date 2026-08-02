export type CanonicalMediumKind = "digital" | "cd" | "vinyl" | "other";

export interface CurationReleaseCandidate {
  releaseGroupId: number;
  editionId: number;
  /**
   * Coverage units this edition contributes. Callers may pass raw MusicBrainz
   * recording ids, or ids remapped so clean/explicit counterparts share one
   * unit (see recording-coverage-units.ts).
   */
  attainableRecordingIds: ReadonlySet<number>;
  official: boolean;
  medium: CanonicalMediumKind;
  preferredCountry: boolean;
  mediaCount: number;
  releaseDate: string | null;
  /**
   * Higher is better under the library's prefer_explicit setting
   * (see editionExplicitPreferenceRank). Defaults to neutral.
   * Combines edition label (clean/explicit in disambiguation) with the best
   * acquisition plan's explicitContent when plans have already been computed.
   */
  explicitPreferenceRank?: number;
  /**
   * Lower is better. Compilations / remix dumps are last-resort coverage only —
   * they must not outrank the studio albums that already carry the same songs.
   * 0 = normal album/EP/single; higher = more supplemental.
   */
  secondaryTypeRank?: number;
  /** Manual/locked selections survive the redundancy optimizer. */
  protected?: boolean;
}

export interface LibraryCurationResult {
  baselineReleaseIds: number[];
  selectedReleaseIds: number[];
  attainableRecordingIds: Set<number>;
}

const mediumRank: Record<CanonicalMediumKind, number> = {
  digital: 0,
  cd: 1,
  vinyl: 2,
  other: 3,
};

function compareAnchorCandidates(
  left: CurationReleaseCandidate,
  right: CurationReleaseCandidate,
): number {
  return (left.secondaryTypeRank ?? 0) - (right.secondaryTypeRank ?? 0)
    || right.attainableRecordingIds.size - left.attainableRecordingIds.size
    || Number(right.official) - Number(left.official)
    // Prefer the user's clean/explicit setting when coverage ties (clean twin
    // must not beat the explicit twin solely by lower edition id).
    || (right.explicitPreferenceRank ?? 1) - (left.explicitPreferenceRank ?? 1)
    || mediumRank[left.medium] - mediumRank[right.medium]
    || Number(right.preferredCountry) - Number(left.preferredCountry)
    || left.mediaCount - right.mediaCount
    || String(left.releaseDate || "9999-99-99").localeCompare(String(right.releaseDate || "9999-99-99"))
    || left.editionId - right.editionId;
}

/**
 * Within one release group: collapse coverage-unit-equal peers (clean/explicit
 * twins after pairing) to the single best edition, then keep any edition that
 * still contributes unique units (true deluxe exclusives, region bonuses).
 *
 * Multi-edition is only sound when clean/explicit recordings share coverage
 * units — otherwise two "explicit" MB releases with distinct recording ids look
 * like unique material and both stay. Pairing lives in recording-coverage-units.
 */
export function selectEditionsWithinReleaseGroup(
  group: readonly CurationReleaseCandidate[],
): CurationReleaseCandidate[] {
  if (group.length === 0) return [];
  const protectedChosen = group.filter((candidate) => candidate.protected);
  const optional = group
    .filter((candidate) => !candidate.protected)
    .sort(compareAnchorCandidates);
  if (optional.length === 0) return [...protectedChosen];

  // Collapse unit-equal peers first (prefer_explicit / label / quality rank).
  const unitKey = (candidate: CurationReleaseCandidate): string =>
    [...candidate.attainableRecordingIds].sort((a, b) => a - b).join(",");
  const bestByUnits = new Map<string, CurationReleaseCandidate>();
  for (const candidate of optional) {
    const key = unitKey(candidate);
    const existing = bestByUnits.get(key);
    if (!existing || compareAnchorCandidates(candidate, existing) < 0) {
      bestByUnits.set(key, candidate);
    }
  }
  const peers = [...bestByUnits.values()].sort(compareAnchorCandidates);

  // Anchor + any remaining peer that still adds unique units (not a subset).
  const selected: CurationReleaseCandidate[] = [];
  const covered = new Set<number>();
  for (const candidate of peers) {
    if (selected.length === 0 || contributesMissing(candidate, covered)) {
      selected.push(candidate);
      for (const unit of candidate.attainableRecordingIds) covered.add(unit);
    }
  }
  for (const protectedCandidate of protectedChosen) {
    if (!selected.some((entry) => entry.editionId === protectedCandidate.editionId)) {
      selected.push(protectedCandidate);
    }
  }
  return selected;
}

function unionRecordings(
  candidates: ReadonlyArray<CurationReleaseCandidate>,
): Set<number> {
  const result = new Set<number>();
  for (const candidate of candidates) {
    for (const recordingId of candidate.attainableRecordingIds) {
      result.add(recordingId);
    }
  }
  return result;
}

function contributesMissing(
  candidate: CurationReleaseCandidate,
  covered: ReadonlySet<number>,
): boolean {
  for (const recordingId of candidate.attainableRecordingIds) {
    if (!covered.has(recordingId)) return true;
  }
  return false;
}

function coversAll(
  candidates: ReadonlyArray<CurationReleaseCandidate>,
  wanted: ReadonlySet<number>,
): boolean {
  const covered = unionRecordings(candidates);
  for (const recordingId of wanted) {
    if (!covered.has(recordingId)) return false;
  }
  return true;
}

function finalIrredundancyPass(
  selected: CurationReleaseCandidate[],
  wanted: ReadonlySet<number>,
  /** Primary studio products may not be dropped in favour of a compilation. */
  retainEditionIds: ReadonlySet<number> = new Set(),
): CurationReleaseCandidate[] {
  const result = [...selected].sort((left, right) => left.editionId - right.editionId);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index].protected || retainEditionIds.has(result[index].editionId)) continue;
    const without = result.filter((_, candidateIndex) => candidateIndex !== index);
    if (coversAll(without, wanted)) result.splice(index, 1);
  }
  return result;
}

function exactMinimumCover(
  candidates: ReadonlyArray<CurationReleaseCandidate>,
  wanted: ReadonlySet<number>,
): CurationReleaseCandidate[] | null {
  const protectedCandidates = candidates.filter((candidate) => candidate.protected);
  const optional = candidates.filter((candidate) => !candidate.protected)
    .sort(compareAnchorCandidates);
  const protectedIds = new Set(protectedCandidates.map((candidate) => candidate.editionId));
  let best: CurationReleaseCandidate[] | null = null;

  const visit = (
    index: number,
    chosen: CurationReleaseCandidate[],
    covered: Set<number>,
  ): void => {
    if (best && protectedCandidates.length + chosen.length >= best.length) return;
    let complete = true;
    for (const recordingId of wanted) {
      if (!covered.has(recordingId)) {
        complete = false;
        break;
      }
    }
    if (complete) {
      best = [...protectedCandidates, ...chosen]
        .filter((candidate, candidateIndex, array) =>
          array.findIndex((entry) => entry.editionId === candidate.editionId) === candidateIndex)
        .sort((left, right) => left.editionId - right.editionId);
      return;
    }
    if (index >= optional.length) return;

    const remainingCoverage = new Set(covered);
    for (let candidateIndex = index; candidateIndex < optional.length; candidateIndex += 1) {
      for (const recordingId of optional[candidateIndex].attainableRecordingIds) {
        remainingCoverage.add(recordingId);
      }
    }
    for (const recordingId of wanted) {
      if (!remainingCoverage.has(recordingId)) return;
    }

    const candidate = optional[index];
    if (!protectedIds.has(candidate.editionId)) {
      const withCoverage = new Set(covered);
      for (const recordingId of candidate.attainableRecordingIds) withCoverage.add(recordingId);
      visit(index + 1, [...chosen, candidate], withCoverage);
    }
    visit(index + 1, chosen, covered);
  };

  visit(0, [], unionRecordings(protectedCandidates));
  return best;
}

function deterministicGreedyCover(
  candidates: ReadonlyArray<CurationReleaseCandidate>,
  wanted: ReadonlySet<number>,
): CurationReleaseCandidate[] {
  const selected = candidates.filter((candidate) => candidate.protected);
  const selectedIds = new Set(selected.map((candidate) => candidate.editionId));
  const covered = unionRecordings(selected);

  while ([...wanted].some((recordingId) => !covered.has(recordingId))) {
    const next = candidates
      .filter((candidate) => !selectedIds.has(candidate.editionId))
      .map((candidate) => ({
        candidate,
        gain: [...candidate.attainableRecordingIds]
          .filter((recordingId) => wanted.has(recordingId) && !covered.has(recordingId)).length,
      }))
      .filter(({ gain }) => gain > 0)
      .sort((left, right) =>
        right.gain - left.gain || compareAnchorCandidates(left.candidate, right.candidate))[0];
    if (!next) break;
    selected.push(next.candidate);
    selectedIds.add(next.candidate.editionId);
    for (const recordingId of next.candidate.attainableRecordingIds) covered.add(recordingId);
  }

  return selected;
}

/**
 * Build the Lidarr-like per-release-group baseline, then optionally apply the
 * global recording-coverage redundancy transformation.
 *
 * Per album, clean/explicit twins that share coverage units collapse to one
 * edition; true unique material (deluxe exclusives, region bonuses) may keep a
 * second. Cross-album redundancy then drops singles/EPs/compilations whose
 * units are already covered. One unique track is enough to keep an edition —
 * provided pairing actually made clean/explicit the same unit.
 */
export function curateLibraryReleases(
  inputCandidates: ReadonlyArray<CurationReleaseCandidate>,
  redundancyEnabled: boolean,
): LibraryCurationResult {
  const candidates = inputCandidates
    .filter((candidate) => candidate.attainableRecordingIds.size > 0)
    .sort((left, right) =>
      left.releaseGroupId - right.releaseGroupId || compareAnchorCandidates(left, right));
  const groups = new Map<number, CurationReleaseCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.releaseGroupId) || [];
    group.push(candidate);
    groups.set(candidate.releaseGroupId, group);
  }

  const baseline: CurationReleaseCandidate[] = [];
  for (const group of groups.values()) {
    baseline.push(...selectEditionsWithinReleaseGroup(group));
  }
  baseline.sort((left, right) =>
    left.releaseGroupId - right.releaseGroupId || compareAnchorCandidates(left, right));

  const wanted = unionRecordings(baseline);
  let selected = [...baseline];

  if (redundancyEnabled) {
    // Cover studio/primary products first so a compilation that re-packages two
    // albums cannot replace them under minimum-cardinality set cover. Then fill
    // any remaining unique units (one exclusive demo is enough) from everything.
    const isPrimary = (candidate: CurationReleaseCandidate): boolean =>
      candidate.protected || (candidate.secondaryTypeRank ?? 0) === 0;
    const primaryCandidates = candidates.filter(isPrimary);
    const wantedPrimary = unionRecordings(baseline.filter(isPrimary));
    const exactLimit = 20;
    const cover = (
      pool: readonly CurationReleaseCandidate[],
      target: ReadonlySet<number>,
    ): CurationReleaseCandidate[] => {
      if (target.size === 0 || pool.length === 0) return [];
      if (pool.length <= exactLimit) {
        return exactMinimumCover(pool, target) || deterministicGreedyCover(pool, target);
      }
      return deterministicGreedyCover(pool, target);
    };

    selected = wantedPrimary.size > 0
      ? cover(primaryCandidates, wantedPrimary)
      : cover(candidates, wanted);

    const retainedPrimaryIds = new Set(selected.map((candidate) => candidate.editionId));
    const covered = unionRecordings(selected);
    const remaining = new Set<number>();
    for (const unit of wanted) {
      if (!covered.has(unit)) remaining.add(unit);
    }
    if (remaining.size > 0) {
      const already = new Set(selected.map((candidate) => candidate.editionId));
      const fillers = cover(
        candidates.filter((candidate) => !already.has(candidate.editionId)),
        remaining,
      );
      selected = [...selected, ...fillers];
    }
    // Drop redundant fillers (e.g. a pure re-pack that snuck in) but never
    // drop the primary studio albums in favour of a compilation superset.
    selected = finalIrredundancyPass(selected, wanted, retainedPrimaryIds);
  }

  return {
    baselineReleaseIds: baseline.map((candidate) => candidate.editionId).sort((a, b) => a - b),
    selectedReleaseIds: selected.map((candidate) => candidate.editionId).sort((a, b) => a - b),
    attainableRecordingIds: wanted,
  };
}
