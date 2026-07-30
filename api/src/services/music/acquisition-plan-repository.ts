import type Database from "better-sqlite3";
import type { OptimizedAcquisitionPlan } from "./acquisition-plan-optimizer.js";

export interface LibraryReleaseCompletion {
  trackCount: number;
  assignedCount: number;
  completeCount: number;
}

export class AcquisitionPlanRepository {
  constructor(private readonly db: Database.Database) {}

  replaceCurrentPlan(input: {
    libraryEditionId: number;
    plan: OptimizedAcquisitionPlan;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): number {
    if (!input.plan.provider.trim()) throw new Error("Acquisition plan provider is required");
    if (!input.policyHash.trim()) throw new Error("Acquisition plan policy hash is required");
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM AcquisitionPlans WHERE library_edition_id = ?")
        .run(input.libraryEditionId);
      const planRow = this.db.prepare(`
        INSERT INTO AcquisitionPlans (
          library_edition_id, provider, composition, download_mode, state,
          planner_version, policy_hash, computed_at, updated_at
        ) VALUES (?, ?, ?, ?, 'current', ?, ?, ?, CURRENT_TIMESTAMP)
        RETURNING id
      `).get(
        input.libraryEditionId,
        input.plan.provider,
        input.plan.composition,
        input.plan.downloadMode,
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
      const orderedSources = [...input.plan.sourceIds].sort((left, right) =>
        (counts.get(right) || 0) - (counts.get(left) || 0) || left - right);
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
    })();
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
