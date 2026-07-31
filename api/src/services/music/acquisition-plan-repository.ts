import type Database from "better-sqlite3";
import type { OptimizedAcquisitionPlan } from "./acquisition-plan-optimizer.js";

export interface LibraryReleaseCompletion {
  trackCount: number;
  assignedCount: number;
  completeCount: number;
}

export class AcquisitionPlanRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist every viable plan for a selected edition and mark exactly one as
   * chosen.
   *
   * `preferredPlanKey` is the user's standing choice. It is honoured whenever
   * that plan still exists among the freshly computed alternatives; when it does
   * not, the best-ranked plan is chosen instead and `preferenceHonored` is false
   * so the caller can say so rather than silently substituting.
   */
  replacePlans(input: {
    libraryEditionId: number;
    plans: readonly OptimizedAcquisitionPlan[];
    preferredPlanKey?: string | null;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): { chosenPlanId: number; chosenPlanKey: string; preferenceHonored: boolean } | null {
    if (!input.policyHash.trim()) throw new Error("Acquisition plan policy hash is required");
    if (input.plans.length === 0) return null;
    for (const plan of input.plans) {
      if (!plan.provider.trim()) throw new Error("Acquisition plan provider is required");
    }

    const preferredPlanKey = input.preferredPlanKey?.trim() || null;
    const chosenIndex = preferredPlanKey
      ? input.plans.findIndex((plan) => plan.planKey === preferredPlanKey)
      : -1;
    const preferenceHonored = chosenIndex >= 0;
    const resolvedChosenIndex = preferenceHonored ? chosenIndex : 0;

    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM AcquisitionPlans WHERE library_edition_id = ?")
        .run(input.libraryEditionId);
      let chosenPlanId = 0;
      input.plans.forEach((plan, index) => {
        const id = this.insertPlan({
          libraryEditionId: input.libraryEditionId,
          plan,
          chosen: index === resolvedChosenIndex,
          selectionMode: index === resolvedChosenIndex && preferenceHonored ? "manual" : "auto",
          rank: index,
          plannerVersion: input.plannerVersion,
          policyHash: input.policyHash,
          computedAt: input.computedAt,
        });
        if (index === resolvedChosenIndex) chosenPlanId = id;
      });
      return {
        chosenPlanId,
        chosenPlanKey: input.plans[resolvedChosenIndex].planKey,
        preferenceHonored,
      };
    })();
  }

  /** Switch the chosen plan for an edition to an already-persisted alternative. */
  choosePlan(libraryEditionId: number, planKey: string): number | null {
    return this.db.transaction(() => {
      const target = this.db.prepare(`
        SELECT id FROM AcquisitionPlans
        WHERE library_edition_id = ? AND plan_key = ?
      `).get(libraryEditionId, planKey) as { id?: number } | undefined;
      if (!target?.id) return null;
      // Clear first: the partial unique index allows only one chosen row.
      this.db.prepare(`
        UPDATE AcquisitionPlans
        SET chosen = 0, selection_mode = 'auto', updated_at = CURRENT_TIMESTAMP
        WHERE library_edition_id = ?
      `).run(libraryEditionId);
      this.db.prepare(`
        UPDATE AcquisitionPlans
        SET chosen = 1, selection_mode = 'manual', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(target.id);
      return target.id;
    })();
  }

  listPlans(libraryEditionId: number): Array<{
    id: number;
    planKey: string;
    provider: string;
    composition: "single_source" | "composite";
    downloadMode: "album" | "tracks";
    state: string;
    chosen: boolean;
    selectionMode: "auto" | "manual";
    rank: number;
    coverage: number;
    sourceProviderEditionMatchIds: number[];
  }> {
    const rows = this.db.prepare(`
      SELECT id, plan_key, provider, composition, download_mode, state,
             chosen, selection_mode, rank, coverage
      FROM AcquisitionPlans
      WHERE library_edition_id = ?
      ORDER BY rank, id
    `).all(libraryEditionId) as Array<{
      id: number;
      plan_key: string;
      provider: string;
      composition: "single_source" | "composite";
      download_mode: "album" | "tracks";
      state: string;
      chosen: number;
      selection_mode: "auto" | "manual";
      rank: number;
      coverage: number;
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
      chosen: Boolean(row.chosen),
      selectionMode: row.selection_mode,
      rank: row.rank,
      coverage: row.coverage,
      sourceProviderEditionMatchIds: (sourceStmt.all(row.id) as Array<{
        provider_edition_match_id: number;
      }>).map((source) => source.provider_edition_match_id),
    }));
  }

  private insertPlan(input: {
    libraryEditionId: number;
    plan: OptimizedAcquisitionPlan;
    chosen: boolean;
    selectionMode: "auto" | "manual";
    rank: number;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): number {
    {
      const planRow = this.db.prepare(`
        INSERT INTO AcquisitionPlans (
          library_edition_id, provider, composition, download_mode, state,
          chosen, selection_mode, plan_key, rank, coverage,
          planner_version, policy_hash, computed_at, updated_at
        ) VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        RETURNING id
      `).get(
        input.libraryEditionId,
        input.plan.provider,
        input.plan.composition,
        input.plan.downloadMode,
        input.chosen ? 1 : 0,
        input.selectionMode,
        input.plan.planKey,
        input.rank,
        input.plan.coverage,
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
  }

  markStale(libraryEditionId: number): number {
    return this.db.prepare(`
      UPDATE AcquisitionPlans
      SET state = 'stale', updated_at = CURRENT_TIMESTAMP
      WHERE library_edition_id = ? AND state != 'stale'
    `).run(libraryEditionId).changes;
  }

  clear(libraryEditionId: number): number {
    return this.db.prepare("DELETE FROM AcquisitionPlans WHERE library_edition_id = ?")
      .run(libraryEditionId).changes;
  }

  getCompletion(libraryEditionId: number): LibraryReleaseCompletion {
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT track.id) AS track_count,
        COUNT(DISTINCT plan_track.track_id) AS assigned_count,
        COUNT(DISTINCT file.track_id) AS complete_count
      FROM LibraryEditions library_release
      JOIN AlbumEditions release ON release.id = library_release.edition_id
      JOIN Tracks track ON track.album_edition_id = release.id
      LEFT JOIN AcquisitionPlans plan
        ON plan.library_edition_id = library_release.id
       AND plan.state = 'current'
       AND plan.chosen = 1
      LEFT JOIN AcquisitionPlanTracks plan_track
        ON plan_track.plan_id = plan.id
       AND plan_track.track_id = track.id
      LEFT JOIN TrackFiles file
        ON file.library_id = library_release.library_id
       AND file.album_edition_id = library_release.edition_id
       AND file.track_id = track.id
       AND file.recording_id = track.recording_id
       AND file.file_class = 'audio'
      WHERE library_release.id = ?
    `).get(libraryEditionId) as {
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
