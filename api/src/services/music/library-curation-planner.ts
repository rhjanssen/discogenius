export type CanonicalMediumKind = "digital" | "cd" | "vinyl" | "other";

export interface CurationReleaseCandidate {
  releaseGroupId: number;
  releaseId: number;
  attainableRecordingIds: ReadonlySet<number>;
  official: boolean;
  medium: CanonicalMediumKind;
  preferredCountry: boolean;
  mediaCount: number;
  releaseDate: string | null;
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
  return right.attainableRecordingIds.size - left.attainableRecordingIds.size
    || Number(right.official) - Number(left.official)
    || mediumRank[left.medium] - mediumRank[right.medium]
    || Number(right.preferredCountry) - Number(left.preferredCountry)
    || left.mediaCount - right.mediaCount
    || String(left.releaseDate || "9999-99-99").localeCompare(String(right.releaseDate || "9999-99-99"))
    || left.releaseId - right.releaseId;
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
): CurationReleaseCandidate[] {
  const result = [...selected].sort((left, right) => left.releaseId - right.releaseId);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index].protected) continue;
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
  const protectedIds = new Set(protectedCandidates.map((candidate) => candidate.releaseId));
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
          array.findIndex((entry) => entry.releaseId === candidate.releaseId) === candidateIndex)
        .sort((left, right) => left.releaseId - right.releaseId);
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
    if (!protectedIds.has(candidate.releaseId)) {
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
  const selectedIds = new Set(selected.map((candidate) => candidate.releaseId));
  const covered = unionRecordings(selected);

  while ([...wanted].some((recordingId) => !covered.has(recordingId))) {
    const next = candidates
      .filter((candidate) => !selectedIds.has(candidate.releaseId))
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
    selectedIds.add(next.candidate.releaseId);
    for (const recordingId of next.candidate.attainableRecordingIds) covered.add(recordingId);
  }

  return selected;
}

/**
 * Build the Lidarr-like per-release-group baseline, then optionally apply the
 * global recording-coverage redundancy transformation.
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

  const anchors = [...groups.values()]
    .map((group) => [...group].sort(compareAnchorCandidates)[0])
    .filter(Boolean);
  const baseline = [...anchors];
  const baselineIds = new Set(baseline.map((candidate) => candidate.releaseId));
  const covered = unionRecordings(baseline);

  for (const group of [...groups.values()]) {
    for (const candidate of [...group].sort(compareAnchorCandidates)) {
      if (baselineIds.has(candidate.releaseId)) continue;
      if (!contributesMissing(candidate, covered)) continue;
      baseline.push(candidate);
      baselineIds.add(candidate.releaseId);
      for (const recordingId of candidate.attainableRecordingIds) covered.add(recordingId);
    }
  }

  // Extras may become unnecessary after a later group/release fills the same
  // gap. Anchors remain when redundancy is disabled.
  const anchorIds = new Set(anchors.map((candidate) => candidate.releaseId));
  for (let index = baseline.length - 1; index >= 0; index -= 1) {
    if (anchorIds.has(baseline[index].releaseId)) continue;
    const without = baseline.filter((_, candidateIndex) => candidateIndex !== index);
    if (coversAll(without, covered)) baseline.splice(index, 1);
  }

  const wanted = unionRecordings(baseline);
  let selected = baseline;
  if (redundancyEnabled) {
    const exactLimit = 20;
    selected = candidates.length <= exactLimit
      ? exactMinimumCover(candidates, wanted) || deterministicGreedyCover(candidates, wanted)
      : deterministicGreedyCover(candidates, wanted);
    selected = finalIrredundancyPass(selected, wanted);
  }

  return {
    baselineReleaseIds: baseline.map((candidate) => candidate.releaseId).sort((a, b) => a - b),
    selectedReleaseIds: selected.map((candidate) => candidate.releaseId).sort((a, b) => a - b),
    attainableRecordingIds: wanted,
  };
}
