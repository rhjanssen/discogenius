/**
 * Seed the acquisition plan a monitored Edition executes.
 *
 * Plans are scoped to (library_id, edition_id), and "the plan that runs" is the
 * one the monitored `LibraryEditions` row names in `preferred_plan_key`. Both
 * halves are needed for a fixture plan to be visible through
 * `SelectedAcquisitionPlans`, so they live here rather than being spelled out —
 * and half-spelled — in every suite.
 */
export interface SeedSelectedPlanInput {
  /** The monitored LibraryEditions row this plan belongs to. */
  libraryEditionId: number;
  provider: string;
  composition?: "single_source" | "composite";
  downloadMode?: "album" | "tracks";
  state?: "current" | "stale" | "unavailable" | "failed";
  planKey?: string;
  qualityTier?: string;
  explicitContent?: "explicit" | "clean" | "unknown";
  coverage?: number;
  targetTrackCount?: number;
}

interface MinimalDatabase {
  prepare: (sql: string) => {
    get: (...args: any[]) => any;
    run: (...args: any[]) => any;
  };
}

export function seedSelectedAcquisitionPlan(
  db: MinimalDatabase,
  input: SeedSelectedPlanInput,
): { id: number } {
  const planKey = input.planKey ?? "fixture";
  const row = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, quality_tier,
      explicit_content, planner_version, policy_hash, computed_at
    )
    SELECT
      monitored_edition.library_id, monitored_edition.edition_id,
      @provider, @composition, @downloadMode, @state,
      @planKey, 0, @coverage, @targetTrackCount, @qualityTier,
      @explicitContent, 1, 'test', CURRENT_TIMESTAMP
    FROM LibraryEditions monitored_edition
    WHERE monitored_edition.id = @libraryEditionId
    RETURNING id
  `).get({
    libraryEditionId: input.libraryEditionId,
    provider: input.provider,
    composition: input.composition ?? "single_source",
    downloadMode: input.downloadMode ?? "album",
    state: input.state ?? "current",
    planKey,
    coverage: input.coverage ?? 0,
    targetTrackCount: input.targetTrackCount ?? 0,
    qualityTier: input.qualityTier ?? "lossless",
    explicitContent: input.explicitContent ?? "unknown",
  }) as { id: number } | undefined;
  if (!row) {
    throw new Error(
      `seedSelectedAcquisitionPlan: no LibraryEditions row ${input.libraryEditionId}`,
    );
  }
  db.prepare(`
    UPDATE LibraryEditions
    SET preferred_plan_key = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(planKey, input.libraryEditionId);
  return row;
}
