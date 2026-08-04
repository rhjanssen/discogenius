export type CanonicalMediumKind = "digital" | "cd" | "vinyl" | "other";

export interface CurationEditionCandidate {
  releaseGroupId: number;
  editionId: number;

  attainableUnitIds: ReadonlySet<number>;
  /** Backward compatibility alias */
  attainableRecordingIds?: ReadonlySet<number>;

  official: boolean;
  medium: CanonicalMediumKind;
  preferredCountry: boolean;
  mediaCount: number;
  releaseDate: string | null;

  /** Album < EP < Single < Other. Lower is better. */
  releaseTypeRank: number;

  /** Existing compilation/remix/live demotion. Lower is better. */
  secondaryTypeRank: number;

  hasUsablePlan: boolean;
  planExplicitPreferenceRank: 0 | 1;
  editionExplicitPreferenceRank: number;

  /** Manual or locked selection. */
  protected: boolean;

  /** This monitored edition is the current representative. */
  existingRepresentative: boolean;

  protectedReason?: "manual_selection" | "locked_selection";
}

/** Backward compatibility alias */
export type CurationReleaseCandidate = CurationEditionCandidate;

export type CurationEditionRole =
  | "representative"
  | "supplemental";

export type CurationSelectionReason =
  | "release_group_primary"
  | "discography_gap_fill"
  | "manual_selection"
  | "locked_selection";

export interface CurationEditionDecision {
  editionId: number;
  releaseGroupId: number;
  role: CurationEditionRole;
  reason: CurationSelectionReason;
  contributedUnitIds: number[];
}

export interface LibraryCurationResult {
  representativeEditionIdByReleaseGroup: ReadonlyMap<number, number>;
  supplementalEditionIds: number[];
  selectedEditionIds: number[];
  selectedReleaseGroupIds: number[];
  attainableUnitIds: Set<number>;
  decisions: CurationEditionDecision[];

  /** Backward compatibility aliases */
  selectedReleaseIds?: number[];
  baselineReleaseIds?: number[];
  attainableRecordingIds?: Set<number>;
}

const mediumRank: Record<CanonicalMediumKind, number> = {
  digital: 0,
  cd: 1,
  vinyl: 2,
  other: 3,
};

function getCandidateUnits(c: CurationEditionCandidate): ReadonlySet<number> {
  return c.attainableUnitIds ?? c.attainableRecordingIds ?? new Set<number>();
}

export function comparePrimaryEditionCandidates(
  left: CurationEditionCandidate,
  right: CurationEditionCandidate,
): number {
  const leftUnits = getCandidateUnits(left);
  const rightUnits = getCandidateUnits(right);
  return (left.secondaryTypeRank ?? 0) - (right.secondaryTypeRank ?? 0)
    || rightUnits.size - leftUnits.size
    || Number(right.official) - Number(left.official)
    || Number(Boolean(right.hasUsablePlan)) - Number(Boolean(left.hasUsablePlan))
    || (right.planExplicitPreferenceRank ?? 0) - (left.planExplicitPreferenceRank ?? 0)
    || (right.editionExplicitPreferenceRank ?? 0) - (left.editionExplicitPreferenceRank ?? 0)
    || mediumRank[left.medium] - mediumRank[right.medium]
    || Number(right.preferredCountry) - Number(left.preferredCountry)
    || left.mediaCount - right.mediaCount
    || String(left.releaseDate || "9999-99-99").localeCompare(String(right.releaseDate || "9999-99-99"))
    || left.editionId - right.editionId;
}

export function selectRepresentativeEdition(
  group: readonly CurationEditionCandidate[],
): CurationEditionCandidate | null {
  if (group.length === 0) return null;

  const protectedExisting = group.find(
    (candidate) => candidate.protected && candidate.existingRepresentative,
  );
  if (protectedExisting) return protectedExisting;

  const protectedEditions = group
    .filter((candidate) => candidate.protected)
    .sort(comparePrimaryEditionCandidates);
  if (protectedEditions.length > 0) {
    return protectedEditions[0];
  }

  const optional = group.filter((c) => !c.protected).sort(comparePrimaryEditionCandidates);
  if (optional.length === 0) return null;

  const unitKey = (candidate: CurationEditionCandidate): string =>
    [...getCandidateUnits(candidate)].sort((a, b) => a - b).join(",");

  const bestByUnits = new Map<string, CurationEditionCandidate>();
  for (const candidate of optional) {
    const key = unitKey(candidate);
    const existing = bestByUnits.get(key);
    if (!existing || comparePrimaryEditionCandidates(candidate, existing) < 0) {
      bestByUnits.set(key, candidate);
    }
  }

  const peers = [...bestByUnits.values()].sort(comparePrimaryEditionCandidates);
  return peers[0] ?? null;
}

function unionUnits(
  candidates: ReadonlyArray<CurationEditionCandidate>,
): Set<number> {
  const result = new Set<number>();
  for (const candidate of candidates) {
    for (const unitId of getCandidateUnits(candidate)) {
      result.add(unitId);
    }
  }
  return result;
}

function difference(
  universe: ReadonlySet<number>,
  subtract: ReadonlySet<number>,
): Set<number> {
  const result = new Set<number>();
  for (const item of universe) {
    if (!subtract.has(item)) {
      result.add(item);
    }
  }
  return result;
}

function compareProductPriority(
  left: CurationEditionCandidate,
  right: CurationEditionCandidate,
): number {
  return (left.releaseTypeRank ?? 0) - (right.releaseTypeRank ?? 0)
    || (left.secondaryTypeRank ?? 0) - (right.secondaryTypeRank ?? 0);
}

function compareSolutionQuality(
  left: CurationEditionCandidate[],
  right: CurationEditionCandidate[],
): number {
  if (left.length !== right.length) return left.length - right.length;

  const leftTypeRank = left.reduce((sum, c) => sum + (c.releaseTypeRank ?? 0), 0);
  const rightTypeRank = right.reduce((sum, c) => sum + (c.releaseTypeRank ?? 0), 0);
  if (leftTypeRank !== rightTypeRank) return leftTypeRank - rightTypeRank;

  const leftSecRank = left.reduce((sum, c) => sum + (c.secondaryTypeRank ?? 0), 0);
  const rightSecRank = right.reduce((sum, c) => sum + (c.secondaryTypeRank ?? 0), 0);
  if (leftSecRank !== rightSecRank) return leftSecRank - rightSecRank;

  const leftPlans = left.filter((c) => c.hasUsablePlan).length;
  const rightPlans = right.filter((c) => c.hasUsablePlan).length;
  if (leftPlans !== rightPlans) return rightPlans - leftPlans;

  const leftSorted = [...left].sort(comparePrimaryEditionCandidates);
  const rightSorted = [...right].sort(comparePrimaryEditionCandidates);
  for (let i = 0; i < leftSorted.length; i += 1) {
    const cmp = comparePrimaryEditionCandidates(leftSorted[i], rightSorted[i]);
    if (cmp !== 0) return cmp;
  }

  const leftIds = [...left].map((c) => c.editionId).sort((a, b) => a - b).join(",");
  const rightIds = [...right].map((c) => c.editionId).sort((a, b) => a - b).join(",");
  return leftIds.localeCompare(rightIds);
}

function exactMinimumCover(
  pool: readonly CurationEditionCandidate[],
  wanted: ReadonlySet<number>,
): CurationEditionCandidate[] | null {
  let best: CurationEditionCandidate[] | null = null;

  const visit = (
    index: number,
    chosen: CurationEditionCandidate[],
    covered: Set<number>,
  ): void => {
    if (best && chosen.length > best.length) return;

    let complete = true;
    for (const unitId of wanted) {
      if (!covered.has(unitId)) {
        complete = false;
        break;
      }
    }

    if (complete) {
      if (!best || compareSolutionQuality(chosen, best) < 0) {
        best = [...chosen];
      }
      return;
    }

    if (index >= pool.length) return;

    const remainingCoverage = new Set(covered);
    for (let i = index; i < pool.length; i += 1) {
      for (const u of getCandidateUnits(pool[i])) {
        remainingCoverage.add(u);
      }
    }
    for (const unitId of wanted) {
      if (!remainingCoverage.has(unitId)) return;
    }

    const candidate = pool[index];
    const withCandidateCoverage = new Set(covered);
    for (const u of getCandidateUnits(candidate)) withCandidateCoverage.add(u);

    visit(index + 1, [...chosen, candidate], withCandidateCoverage);
    visit(index + 1, chosen, covered);
  };

  visit(0, [], new Set());
  return best;
}

function deterministicGreedyCover(
  candidates: ReadonlyArray<CurationEditionCandidate>,
  wanted: ReadonlySet<number>,
): CurationEditionCandidate[] {
  const selected: CurationEditionCandidate[] = [];
  const selectedIds = new Set<number>();
  const covered = new Set<number>();

  while ([...wanted].some((unitId) => !covered.has(unitId))) {
    const next = candidates
      .filter((candidate) => !selectedIds.has(candidate.editionId))
      .map((candidate) => ({
        candidate,
        gain: [...getCandidateUnits(candidate)]
          .filter((unitId) => wanted.has(unitId) && !covered.has(unitId)).length,
      }))
      .filter(({ gain }) => gain > 0)
      .sort((left, right) =>
        right.gain - left.gain
        || (left.candidate.releaseTypeRank ?? 0) - (right.candidate.releaseTypeRank ?? 0)
        || (left.candidate.secondaryTypeRank ?? 0) - (right.candidate.secondaryTypeRank ?? 0)
        || Number(right.candidate.hasUsablePlan) - Number(left.candidate.hasUsablePlan)
        || comparePrimaryEditionCandidates(left.candidate, right.candidate)
        || left.candidate.editionId - right.candidate.editionId)[0];

    if (!next) break;

    selected.push(next.candidate);
    selectedIds.add(next.candidate.editionId);
    for (const unitId of getCandidateUnits(next.candidate)) {
      covered.add(unitId);
    }
  }

  return selected;
}

function selectSupplementalCover(
  pool: readonly CurationEditionCandidate[],
  wanted: ReadonlySet<number>,
): CurationEditionCandidate[] {
  if (pool.length === 0 || wanted.size === 0) return [];
  if (pool.length <= 20) {
    const exact = exactMinimumCover(pool, wanted);
    if (exact) return exact;
  }
  return deterministicGreedyCover(pool, wanted);
}

function pruneRedundantEditions(
  selected: CurationEditionCandidate[],
  initialRepresentatives: Map<number, CurationEditionCandidate>,
): CurationEditionCandidate[] {
  const isRep = (c: CurationEditionCandidate): boolean =>
    initialRepresentatives.get(c.releaseGroupId)?.editionId === c.editionId;

  const current = [...selected];

  while (true) {
    const removableCandidates = current
      .filter((c) => !c.protected)
      .sort((left, right) => {
        const leftTypeRank = left.releaseTypeRank ?? 0;
        const rightTypeRank = right.releaseTypeRank ?? 0;
        if (leftTypeRank !== rightTypeRank) {
          return rightTypeRank - leftTypeRank;
        }
        const leftSecRank = left.secondaryTypeRank ?? 0;
        const rightSecRank = right.secondaryTypeRank ?? 0;
        if (leftSecRank !== rightSecRank) {
          return rightSecRank - leftSecRank;
        }
        const leftRep = isRep(left) ? 1 : 0;
        const rightRep = isRep(right) ? 1 : 0;
        if (leftRep !== rightRep) {
          return leftRep - rightRep;
        }
        const cmp = comparePrimaryEditionCandidates(left, right);
        if (cmp !== 0) {
          return -cmp;
        }
        return right.editionId - left.editionId;
      });

    let prunedAny = false;
    for (const candidate of removableCandidates) {
      const otherSelected = current.filter((c) => c.editionId !== candidate.editionId);
      const coveredByOthers = unionUnits(otherSelected);
      const candUnits = getCandidateUnits(candidate);
      const allUnitsCovered = [...candUnits].every((u) => coveredByOthers.has(u));

      if (!allUnitsCovered) continue;

      const priorityOk = [...candUnits].every((unitId) => {
        const coveringOther = otherSelected.filter((other) => getCandidateUnits(other).has(unitId));
        return coveringOther.some((other) => compareProductPriority(other, candidate) <= 0);
      });

      if (priorityOk) {
        const idx = current.findIndex((c) => c.editionId === candidate.editionId);
        if (idx >= 0) {
          current.splice(idx, 1);
          prunedAny = true;
          break;
        }
      }
    }

    if (!prunedAny) break;
  }

  return current;
}

export function curateLibraryReleases(
  inputCandidates: ReadonlyArray<CurationEditionCandidate>,
  redundancyEnabled: boolean,
): LibraryCurationResult {
  const candidates = inputCandidates
    .filter((candidate) => getCandidateUnits(candidate).size > 0 || candidate.protected)
    .sort((left, right) =>
      left.releaseGroupId - right.releaseGroupId || comparePrimaryEditionCandidates(left, right));

  const groups = new Map<number, CurationEditionCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.releaseGroupId) || [];
    group.push(candidate);
    groups.set(candidate.releaseGroupId, group);
  }

  const representatives = new Map<number, CurationEditionCandidate>();
  for (const [rgId, group] of groups) {
    const rep = selectRepresentativeEdition(group);
    if (rep) {
      representatives.set(rgId, rep);
    }
  }

  const protectedEditions = candidates.filter((c) => c.protected);

  const representativeSet = new Set([...representatives.values()].map((c) => c.editionId));
  const selectedMap = new Map<number, CurationEditionCandidate>();
  for (const rep of representatives.values()) {
    selectedMap.set(rep.editionId, rep);
  }
  for (const p of protectedEditions) {
    selectedMap.set(p.editionId, p);
  }

  const coveredByRepresentativesAndProtected = unionUnits([...selectedMap.values()]);

  const allEligibleUnits = unionUnits(candidates);
  const novelSupplementalUnits = difference(
    allEligibleUnits,
    coveredByRepresentativesAndProtected,
  );

  if (novelSupplementalUnits.size > 0) {
    const eligibleSupplemental = candidates.filter(
      (c) =>
        !representativeSet.has(c.editionId)
        && !c.protected
        && [...getCandidateUnits(c)].some((u) => novelSupplementalUnits.has(u)),
    );

    const supplementalCover = selectSupplementalCover(
      eligibleSupplemental,
      novelSupplementalUnits,
    );
    for (const s of supplementalCover) {
      selectedMap.set(s.editionId, s);
    }
  }

  let selected = [...selectedMap.values()];

  if (redundancyEnabled) {
    selected = pruneRedundantEditions(selected, representatives);
  }

  const survivingByGroup = new Map<number, CurationEditionCandidate[]>();
  for (const candidate of selected) {
    const group = survivingByGroup.get(candidate.releaseGroupId) || [];
    group.push(candidate);
    survivingByGroup.set(candidate.releaseGroupId, group);
  }

  const finalRepresentativeMap = new Map<number, number>();
  for (const [rgId, group] of survivingByGroup) {
    const prevRep = representatives.get(rgId);
    let chosenRep: CurationEditionCandidate;

    if (prevRep && group.some((c) => c.editionId === prevRep.editionId)) {
      chosenRep = prevRep;
    } else {
      const survivingProtectedRep = group.find(
        (c) => c.protected && c.existingRepresentative,
      );
      if (survivingProtectedRep) {
        chosenRep = survivingProtectedRep;
      } else {
        const sorted = [...group].sort(comparePrimaryEditionCandidates);
        chosenRep = sorted[0];
      }
    }
    finalRepresentativeMap.set(rgId, chosenRep.editionId);
  }

  const finalSelectedIds = selected.map((c) => c.editionId).sort((a, b) => a - b);
  const finalSupplementalIds: number[] = [];
  const decisions: CurationEditionDecision[] = [];

  for (const candidate of selected) {
    const isRep = finalRepresentativeMap.get(candidate.releaseGroupId) === candidate.editionId;
    const role: CurationEditionRole = isRep ? "representative" : "supplemental";
    if (!isRep) {
      finalSupplementalIds.push(candidate.editionId);
    }

    let reason: CurationSelectionReason;
    if (candidate.protected) {
      reason = candidate.protectedReason || "manual_selection";
    } else {
      reason = isRep ? "release_group_primary" : "discography_gap_fill";
    }

    const otherSelected = selected.filter((c) => c.editionId !== candidate.editionId);
    const coveredByOthers = unionUnits(otherSelected);
    const contributedUnitIds = [...getCandidateUnits(candidate)]
      .filter((u) => !coveredByOthers.has(u))
      .sort((a, b) => a - b);

    decisions.push({
      editionId: candidate.editionId,
      releaseGroupId: candidate.releaseGroupId,
      role,
      reason,
      contributedUnitIds,
    });
  }

  finalSupplementalIds.sort((a, b) => a - b);
  const selectedReleaseGroupIds = [...finalRepresentativeMap.keys()].sort((a, b) => a - b);
  const attainableUnitIds = unionUnits(selected);

  return {
    representativeEditionIdByReleaseGroup: finalRepresentativeMap,
    supplementalEditionIds: finalSupplementalIds,
    selectedEditionIds: finalSelectedIds,
    selectedReleaseGroupIds,
    attainableUnitIds,
    decisions,
    selectedReleaseIds: finalSelectedIds,
    baselineReleaseIds: finalSelectedIds,
    attainableRecordingIds: attainableUnitIds,
  };
}
