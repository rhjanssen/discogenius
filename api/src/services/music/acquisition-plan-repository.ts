import type Database from "better-sqlite3";
import type { OptimizedAcquisitionPlan } from "./acquisition-plan-optimizer.js";

export interface LibraryReleaseCompletion {
  trackCount: number;
  assignedCount: number;
  completeCount: number;
}

export interface PlanSelectionOutcome {
  /** The plan the monitored edition now executes, or null when nothing is monitored. */
  selectedPlanId: number | null;
  selectedPlanKey: string | null;
  /** The user's standing choice survived this replan. */
  preferenceHonored: boolean;
  /** The preferred plan still exists but no longer covers what the best one does. */
  preferenceLostCoverage: boolean;
  /**
   * A locked preference the provider can no longer deliver. It stays selected,
   * marked `unavailable`, rather than being swapped for a different offer.
   */
  preferenceUnavailable: boolean;
}

/**
 * Candidate acquisition plans for a Library and a canonical Edition.
 *
 * Plans are deliberately NOT owned by a `LibraryEditions` row. Curation has to
 * be able to read the plans for an Edition it has not monitored — that is how it
 * judges provider availability — and the Album page has to be able to show the
 * offers under an Edition the user has not chosen yet, which is the entire point
 * of offering a choice. Monitoring is a later, separate decision.
 */
export class AcquisitionPlanRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Replace every candidate plan for one (Library, canonical Edition) and
   * reconcile the monitored edition's selection with the new plan set.
   *
   * Both halves run in one transaction because `LibraryEditions.preferred_plan_key`
   * is a deferred foreign key into the very rows this deletes and rebuilds.
   *
   * `preferredPlanKey` is the user's standing choice. It is honoured whenever
   * that plan still exists among the freshly computed alternatives AND still
   * covers every canonical track the best alternative would; when it does not,
   * the best-ranked plan is selected instead and `preferenceHonored` is false so
   * the caller can say so rather than silently substituting.
   */
  replacePlans(input: {
    libraryId: number;
    editionId: number;
    plans: readonly OptimizedAcquisitionPlan[];
    /** Canonical track count of the target Edition — the denominator of coverage. */
    targetTrackCount: number;
    preferredPlanKey?: string | null;
    /**
     * The album is user-locked. A lock protects the plan choice outright: the
     * preference is honoured even when a better-covering plan exists, because
     * the user asked for exactly this one.
     */
    lockPreference?: boolean;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): PlanSelectionOutcome | null {
    if (!input.policyHash.trim()) throw new Error("Acquisition plan policy hash is required");
    if (input.plans.length === 0) return null;
    for (const plan of input.plans) {
      if (!plan.provider.trim()) throw new Error("Acquisition plan provider is required");
    }

    const preferredPlanKey = input.preferredPlanKey?.trim() || null;
    const candidateIndex = preferredPlanKey
      ? input.plans.findIndex((plan) => plan.planKey === preferredPlanKey)
      : -1;
    // A manual choice survives replanning only while it still covers every
    // canonical track the best alternative would. Comparing counts is not
    // enough: two 15-track plans covering different tracks are not equivalent,
    // and a plan that swapped five tracks for five others would have passed a
    // numeric test while quietly changing what the user gets.
    const bestPlan = input.plans.reduce((best, plan) =>
      plan.coverage > best.coverage ? plan : best);
    const bestTrackIds = new Set(bestPlan.tracks.map((track) => track.trackId));
    const preferredCovers = (index: number): boolean => {
      const covered = new Set(input.plans[index].tracks.map((track) => track.trackId));
      for (const trackId of bestTrackIds) {
        if (!covered.has(trackId)) return false;
      }
      return true;
    };
    const preferenceHonored = candidateIndex >= 0
      && (input.lockPreference === true || preferredCovers(candidateIndex));
    const resolvedIndex = preferenceHonored ? candidateIndex : 0;
    const preferenceLostCoverage = candidateIndex >= 0 && !preferenceHonored;
    // A locked plan that vanishes from the freshly computed set is not a reason
    // to run a different one. The user locked this offer; the honest outcome is
    // that it stays selected and says it is unavailable, so the Album page shows
    // a stale selection to act on rather than quietly downloading something else.
    // The row survives the rebuild intact — sources, per-track assignment and
    // exact provider variants included — so re-selecting it means the same files.
    const retainedPlanKey = input.lockPreference === true
      && preferredPlanKey != null
      && candidateIndex < 0
      ? preferredPlanKey
      : null;

    return this.db.transaction(() => {
      // Release the deferred reference before deleting the rows it points at.
      this.db.prepare(`
        UPDATE LibraryEditions
        SET preferred_plan_key = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ?
      `).run(input.libraryId, input.editionId);
      this.db.prepare(`
        DELETE FROM AcquisitionPlans
        WHERE library_id = ? AND edition_id = ?
          AND (? IS NULL OR plan_key != ?)
      `).run(input.libraryId, input.editionId, retainedPlanKey, retainedPlanKey);

      let selectedPlanId = 0;
      input.plans.forEach((plan, index) => {
        const id = this.insertPlan({
          libraryId: input.libraryId,
          editionId: input.editionId,
          plan,
          targetTrackCount: input.targetTrackCount,
          rank: index,
          plannerVersion: input.plannerVersion,
          policyHash: input.policyHash,
          computedAt: input.computedAt,
        });
        if (index === resolvedIndex) selectedPlanId = id;
      });

      let selectedPlanKey = input.plans[resolvedIndex].planKey;
      const retained = retainedPlanKey == null ? undefined : this.db.prepare(`
        UPDATE AcquisitionPlans
        SET state = 'unavailable', rank = ?, updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ? AND plan_key = ?
        RETURNING id
      `).get(
        input.plans.length,
        input.libraryId,
        input.editionId,
        retainedPlanKey,
      ) as { id: number } | undefined;
      if (retained) {
        selectedPlanId = retained.id;
        selectedPlanKey = retainedPlanKey!;
      }

      // Only a monitored edition carries a selection; an evaluated-but-unmonitored
      // one simply has candidates and no row to record a choice on.
      const applied = this.db.prepare(`
        UPDATE LibraryEditions
        SET preferred_plan_key = ?,
            plan_selection_mode = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ?
      `).run(
        selectedPlanKey,
        preferenceHonored || retained ? "manual" : "auto",
        input.libraryId,
        input.editionId,
      ).changes;

      return {
        selectedPlanId: applied > 0 ? selectedPlanId : null,
        selectedPlanKey: applied > 0 ? selectedPlanKey : null,
        preferenceHonored: preferenceHonored || Boolean(retained),
        preferenceLostCoverage,
        preferenceUnavailable: Boolean(retained),
      };
    })();
  }

  /**
   * Record which persisted plan a monitored Edition executes.
   *
   * Returns false when no such plan exists for exactly this Library and Edition —
   * a plan key alone is not authority to select it.
   */
  /**
   * The plans on record for this Edition, when they were built from exactly
   * these inputs by exactly this planner.
   *
   * `policy_hash` covers the policy *and* a digest of the provider evidence the
   * planner reasons over (see AcquisitionPlanningService), so an unchanged hash
   * means a rebuild would reproduce what is already stored. Returns null when
   * anything differs, when no plans exist, or when they are not all current —
   * a partially-stale set has to be rebuilt rather than trusted.
   */
  plansMatchFingerprint(input: {
    libraryId: number;
    editionId: number;
    plannerVersion: number;
    policyHash: string;
  }): { selectedPlanId: number | null } | null {
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN planner_version = ? AND policy_hash = ? AND state = 'current' THEN 1 ELSE 0 END) AS matching
      FROM AcquisitionPlans
      WHERE library_id = ? AND edition_id = ?
    `).get(
      input.plannerVersion,
      input.policyHash,
      input.libraryId,
      input.editionId,
    ) as { total: number; matching: number | null };
    if (!summary || summary.total === 0 || Number(summary.matching ?? 0) !== summary.total) {
      return null;
    }

    const selected = this.db.prepare(`
      SELECT plan.id
      FROM LibraryEditions monitored_edition
      JOIN AcquisitionPlans plan
        ON plan.library_id = monitored_edition.library_id
       AND plan.edition_id = monitored_edition.edition_id
       AND plan.plan_key = monitored_edition.preferred_plan_key
      WHERE monitored_edition.library_id = ? AND monitored_edition.edition_id = ?
    `).get(input.libraryId, input.editionId) as { id: number } | undefined;
    return { selectedPlanId: selected?.id ?? null };
  }

  selectPlan(input: { libraryId: number; editionId: number; planKey: string }): boolean {
    return this.db.transaction(() => {
      const exists = this.db.prepare(`
        SELECT 1 FROM AcquisitionPlans
        WHERE library_id = ? AND edition_id = ? AND plan_key = ?
      `).get(input.libraryId, input.editionId, input.planKey);
      if (!exists) return false;
      return this.db.prepare(`
        UPDATE LibraryEditions
        SET preferred_plan_key = ?, plan_selection_mode = 'manual',
            updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ?
      `).run(input.planKey, input.libraryId, input.editionId).changes > 0;
    })();
  }

  listPlans(libraryId: number, editionId: number): Array<{
    id: number;
    planKey: string;
    provider: string;
    composition: "single_source" | "composite";
    downloadMode: "album" | "tracks";
    state: string;
    rank: number;
    coverage: number;
    targetTrackCount: number;
    sourceProviderEditionMatchIds: number[];
  }> {
    const rows = this.db.prepare(`
      SELECT id, plan_key, provider, composition, download_mode, state,
             rank, coverage, target_track_count, quality_tier, explicit_content
      FROM AcquisitionPlans
      WHERE library_id = ? AND edition_id = ?
      ORDER BY rank, id
    `).all(libraryId, editionId) as Array<{
      id: number;
      plan_key: string;
      provider: string;
      composition: "single_source" | "composite";
      download_mode: "album" | "tracks";
      state: string;
      rank: number;
      coverage: number;
      target_track_count: number;
    }>;
    const sourceStmt = this.db.prepare(`
      SELECT provider_edition_match_id
      FROM AcquisitionPlanSources
      WHERE plan_id = ?
      ORDER BY sort_order
    `);
    return rows.map((row) => ({
      id: row.id,
      planKey: row.plan_key,
      provider: row.provider,
      composition: row.composition,
      downloadMode: row.download_mode,
      state: row.state,
      rank: row.rank,
      coverage: row.coverage,
      targetTrackCount: row.target_track_count,
      sourceProviderEditionMatchIds: (sourceStmt.all(row.id) as Array<{
        provider_edition_match_id: number;
      }>).map((source) => source.provider_edition_match_id),
    }));
  }

  /**
   * Canonical tracks of `editionId` that the plan does not cover.
   *
   * The canonical track list is authoritative: a provider offering 11 of 12
   * tracks produces a plan with one missing track, never an 11-track Edition.
   */
  missingTrackIds(planId: number): number[] {
    return (this.db.prepare(`
      SELECT track.id
      FROM AcquisitionPlans plan
      JOIN Tracks track ON track.album_edition_id = plan.edition_id
      WHERE plan.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM AcquisitionPlanTracks assignment
          WHERE assignment.plan_id = plan.id AND assignment.track_id = track.id
        )
      ORDER BY track.medium_position, track.position, track.id
    `).all(planId) as Array<{ id: number }>).map(({ id }) => id);
  }

  private insertPlan(input: {
    libraryId: number;
    editionId: number;
    plan: OptimizedAcquisitionPlan;
    targetTrackCount: number;
    rank: number;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): number {
    const planRow = this.db.prepare(`
      INSERT INTO AcquisitionPlans (
        library_id, edition_id, provider, composition, download_mode, state,
        plan_key, rank, coverage, target_track_count,
        quality_tier, explicit_content,
        explicit_track_count, clean_track_count, unknown_explicitness_count,
        planner_version, policy_hash, computed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      RETURNING id
    `).get(
      input.libraryId,
      input.editionId,
      input.plan.provider,
      input.plan.composition,
      input.plan.downloadMode,
      input.plan.planKey,
      input.rank,
      input.plan.coverage,
      input.targetTrackCount,
      input.plan.qualityTier,
      input.plan.explicitContent,
      input.plan.explicitnessCounts.explicitTrackCount,
      input.plan.explicitnessCounts.cleanTrackCount,
      input.plan.explicitnessCounts.unknownExplicitnessCount,
      input.plannerVersion,
      input.policyHash,
      input.computedAt || new Date().toISOString(),
    ) as { id: number };

    const counts = new Map<number, number>();
    for (const track of input.plan.tracks) {
      counts.set(
        track.providerEditionMatchId,
        (counts.get(track.providerEditionMatchId) || 0) + 1,
      );
    }
    // The user's preferred Provider Edition stays `primary` even when a
    // secondary source contributes more tracks, so the next replan can still
    // recover the preference from the plan.
    const preferredSourceId = input.plan.preferredSourceId;
    const preferredRank = (sourceId: number): number =>
      preferredSourceId != null && sourceId === preferredSourceId ? 0 : 1;
    const orderedSources = [...input.plan.sourceIds].sort((left, right) =>
      preferredRank(left) - preferredRank(right)
      || (counts.get(right) || 0) - (counts.get(left) || 0)
      || left - right);
    const insertSource = this.db.prepare(`
      INSERT INTO AcquisitionPlanSources (
        plan_id, provider_edition_match_id, role, sort_order
      ) VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const planSourceIdByMatchId = new Map<number, number>();
    orderedSources.forEach((providerEditionMatchId, index) => {
      const source = insertSource.get(
        planRow.id,
        providerEditionMatchId,
        index === 0 ? "primary" : "supplement",
        index,
      ) as { id: number };
      planSourceIdByMatchId.set(providerEditionMatchId, source.id);
    });

    const insertTrack = this.db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id,
        provider_audio_variant_id, source_quality_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const track of input.plan.tracks) {
      const sourceId = planSourceIdByMatchId.get(track.providerEditionMatchId);
      if (sourceId == null) {
        throw new Error(`Track ${track.trackId} references an unselected acquisition source`);
      }
      insertTrack.run(
        planRow.id,
        track.trackId,
        sourceId,
        track.providerTrackMatchId,
        track.providerAudioVariantId,
        JSON.stringify({ quality: track.sourceQuality }),
      );
    }
    return planRow.id;
  }

  markStale(libraryId: number, editionId: number): number {
    return this.db.prepare(`
      UPDATE AcquisitionPlans
      SET state = 'stale', updated_at = CURRENT_TIMESTAMP
      WHERE library_id = ? AND edition_id = ? AND state != 'stale'
    `).run(libraryId, editionId).changes;
  }

  clear(libraryId: number, editionId: number): number {
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE LibraryEditions
        SET preferred_plan_key = NULL, plan_selection_mode = 'auto',
            updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ?
      `).run(libraryId, editionId);
      return this.db.prepare(`
        DELETE FROM AcquisitionPlans WHERE library_id = ? AND edition_id = ?
      `).run(libraryId, editionId).changes;
    })();
  }

  getCompletion(libraryId: number, editionId: number): LibraryReleaseCompletion {
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT track.id) AS track_count,
        COUNT(DISTINCT plan_track.track_id) AS assigned_count,
        COUNT(DISTINCT file.track_id) AS complete_count
      FROM LibraryEditions monitored_edition
      JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
      JOIN Tracks track ON track.album_edition_id = edition.id
      LEFT JOIN SelectedAcquisitionPlans plan
        ON plan.library_edition_id = monitored_edition.id
       AND plan.state = 'current'
      LEFT JOIN AcquisitionPlanTracks plan_track
        ON plan_track.plan_id = plan.id
       AND plan_track.track_id = track.id
      LEFT JOIN TrackFiles file
        ON file.library_id = monitored_edition.library_id
       AND file.album_edition_id = monitored_edition.edition_id
       AND file.track_id = track.id
       AND file.recording_id = track.recording_id
       AND file.file_class = 'audio'
      WHERE monitored_edition.library_id = ? AND monitored_edition.edition_id = ?
    `).get(libraryId, editionId) as {
      track_count: number;
      assigned_count: number;
      complete_count: number;
    };
    return {
      trackCount: Number(row?.track_count || 0),
      assignedCount: Number(row?.assigned_count || 0),
      completeCount: Number(row?.complete_count || 0),
    };
  }
}
