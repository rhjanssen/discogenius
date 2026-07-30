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
    libraryReleaseId: number;
    plan: OptimizedAcquisitionPlan;
    plannerVersion: number;
    policyHash: string;
    computedAt?: string;
  }): number {
    if (!input.plan.provider.trim()) throw new Error("Acquisition plan provider is required");
    if (!input.policyHash.trim()) throw new Error("Acquisition plan policy hash is required");
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM AcquisitionPlans WHERE library_release_id = ?")
        .run(input.libraryReleaseId);
      const planRow = this.db.prepare(`
        INSERT INTO AcquisitionPlans (
          library_release_id, provider, composition, download_mode, state,
          planner_version, policy_hash, computed_at, updated_at
        ) VALUES (?, ?, ?, ?, 'current', ?, ?, ?, CURRENT_TIMESTAMP)
        RETURNING id
      `).get(
        input.libraryReleaseId,
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
          track.providerReleaseMatchId,
          (counts.get(track.providerReleaseMatchId) || 0) + 1,
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
      orderedSources.forEach((providerReleaseMatchId, index) => {
        const source = insertSource.get(
          planRow.id,
          providerReleaseMatchId,
          index === 0 ? "primary" : "supplement",
          index,
        ) as { id: number };
        planSourceIdByMatchId.set(providerReleaseMatchId, source.id);
      });

      const insertTrack = this.db.prepare(`
        INSERT INTO AcquisitionPlanTracks (
          plan_id, track_id, source_id, provider_track_match_id,
          provider_audio_variant_id, source_quality_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const track of input.plan.tracks) {
        const sourceId = planSourceIdByMatchId.get(track.providerReleaseMatchId);
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

  markStale(libraryReleaseId: number): number {
    return this.db.prepare(`
      UPDATE AcquisitionPlans
      SET state = 'stale', updated_at = CURRENT_TIMESTAMP
      WHERE library_release_id = ? AND state != 'stale'
    `).run(libraryReleaseId).changes;
  }

  clear(libraryReleaseId: number): number {
    return this.db.prepare("DELETE FROM AcquisitionPlans WHERE library_release_id = ?")
      .run(libraryReleaseId).changes;
  }

  getCompletion(libraryReleaseId: number): LibraryReleaseCompletion {
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT track.id) AS track_count,
        COUNT(DISTINCT plan_track.track_id) AS assigned_count,
        COUNT(DISTINCT file.track_id) AS complete_count
      FROM LibraryReleases library_release
      JOIN AlbumReleases release ON release.id = library_release.release_id
      JOIN Tracks track ON track.album_release_id = release.id
      LEFT JOIN AcquisitionPlans plan
        ON plan.library_release_id = library_release.id
       AND plan.state = 'current'
      LEFT JOIN AcquisitionPlanTracks plan_track
        ON plan_track.plan_id = plan.id
       AND plan_track.track_id = track.id
      LEFT JOIN TrackFiles file
        ON file.library_id = library_release.library_id
       AND file.album_release_id = library_release.release_id
       AND file.track_id = track.id
       AND file.recording_id = track.recording_id
       AND file.file_class = 'audio'
      WHERE library_release.id = ?
    `).get(libraryReleaseId) as {
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
