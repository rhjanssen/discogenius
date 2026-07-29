import { db } from "../../database.js";

export interface RelationalOrphanSummary {
  releaseGroupSlotTargetsRemoved: number;
  releaseGroupSlotSourcesRemoved: number;
  releaseGroupSlotTrackAssignmentsRemoved: number;
}

/**
 * Prune rows whose ownership relationship is unambiguous but is not expressed
 * as a database foreign key, or whose foreign key targets have vanished.
 *
 */
export function pruneRelationalOrphans(): RelationalOrphanSummary {
  const assignmentsRemoved = db.prepare(`
    DELETE FROM ReleaseGroupSlotTrackAssignments AS assignment
    WHERE NOT EXISTS (
      SELECT 1 FROM ReleaseGroupSlots AS slot WHERE slot.id = assignment.slot_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM ReleaseGroupSlotTargets AS target WHERE target.id = assignment.target_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM ReleaseGroupSlotSources AS source WHERE source.id = assignment.slot_source_id
    )
  `).run().changes;

  const targetsRemoved = db.prepare(`
    DELETE FROM ReleaseGroupSlotTargets AS target
    WHERE NOT EXISTS (
      SELECT 1 FROM ReleaseGroupSlots AS slot WHERE slot.id = target.slot_id
    )
  `).run().changes;

  const sourcesRemoved = db.prepare(`
    DELETE FROM ReleaseGroupSlotSources AS source
    WHERE NOT EXISTS (
      SELECT 1 FROM ReleaseGroupSlots AS slot WHERE slot.id = source.slot_id
    )
  `).run().changes;

  return {
    releaseGroupSlotTargetsRemoved: targetsRemoved,
    releaseGroupSlotSourcesRemoved: sourcesRemoved,
    releaseGroupSlotTrackAssignmentsRemoved: assignmentsRemoved,
  };
}
