export type ProviderReleaseRelation =
  | "exact"
  | "source_superset"
  | "source_subset"
  | "overlap";

export interface ProviderReleaseRelationInput {
  /** Canonical audio track IDs in the target release. */
  targetTrackIds: ReadonlySet<number>;
  /** Provider release-member IDs in the source release (audio only). */
  sourceMemberIds: ReadonlySet<number>;
  /** Accepted one-to-one member-to-track assignments. */
  acceptedAssignments: ReadonlyArray<{
    sourceMemberId: number;
    targetTrackId: number;
  }>;
}

export interface ProviderReleaseRelationResult {
  relation: ProviderReleaseRelation | null;
  matchedTrackCount: number;
  sourceTrackCount: number;
  targetTrackCount: number;
  sourceCoverage: number;
  targetCoverage: number;
}

/**
 * Calculate the directional provider-release relation from accepted matched
 * sets. Counts describe the sets after validation; counts alone never infer
 * identity or create assignments.
 */
export function determineProviderReleaseRelation(
  input: ProviderReleaseRelationInput,
): ProviderReleaseRelationResult {
  const matchedSources = new Set<number>();
  const matchedTargets = new Set<number>();

  for (const assignment of input.acceptedAssignments) {
    if (!input.sourceMemberIds.has(assignment.sourceMemberId)) continue;
    if (!input.targetTrackIds.has(assignment.targetTrackId)) continue;
    if (matchedSources.has(assignment.sourceMemberId)) continue;
    if (matchedTargets.has(assignment.targetTrackId)) continue;
    matchedSources.add(assignment.sourceMemberId);
    matchedTargets.add(assignment.targetTrackId);
  }

  const sourceTrackCount = input.sourceMemberIds.size;
  const targetTrackCount = input.targetTrackIds.size;
  const matchedTrackCount = matchedTargets.size;
  const sourceCoverage = sourceTrackCount > 0 ? matchedSources.size / sourceTrackCount : 0;
  const targetCoverage = targetTrackCount > 0 ? matchedTargets.size / targetTrackCount : 0;

  let relation: ProviderReleaseRelation | null = null;
  if (matchedTrackCount > 0) {
    const sourceComplete = matchedSources.size === sourceTrackCount;
    const targetComplete = matchedTargets.size === targetTrackCount;
    if (sourceComplete && targetComplete) {
      relation = "exact";
    } else if (targetComplete) {
      relation = "source_superset";
    } else if (sourceComplete) {
      relation = "source_subset";
    } else {
      relation = "overlap";
    }
  }

  return {
    relation,
    matchedTrackCount,
    sourceTrackCount,
    targetTrackCount,
    sourceCoverage,
    targetCoverage,
  };
}
