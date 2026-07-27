import { db } from "../../database.js";

export interface RelationalOrphanSummary {
  providerItemMatchesRemoved: number;
  releaseGroupSlotTargetsRemoved: number;
  releaseGroupSlotSourcesRemoved: number;
  releaseGroupSlotTrackAssignmentsRemoved: number;
}

/**
 * Prune rows whose ownership relationship is unambiguous but is not expressed
 * as a database foreign key, or whose foreign key targets have vanished.
 *
 * ProviderItemMatches direct edges are owned by the matching ProviderItems
 * offer. Composite album edges deliberately encode several offer ids in one
 * semicolon-delimited value (legacy readers also accept '+'), so they cannot be
 * validated by an exact source-key lookup and are preserved for their normal
 * release-group rebuild.
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

  const providerItemMatches = db.prepare(`
    DELETE FROM ProviderItemMatches AS match
    WHERE instr(match.provider_item_id, ';') = 0
      AND instr(match.provider_item_id, '+') = 0
      AND NOT EXISTS (
        SELECT 1
        FROM ProviderItems AS item
        WHERE item.provider = match.provider
          AND item.entity_type = match.provider_item_type
          AND item.provider_id = match.provider_item_id
      )
  `).run();

  return {
    providerItemMatchesRemoved: providerItemMatches.changes,
    releaseGroupSlotTargetsRemoved: targetsRemoved,
    releaseGroupSlotSourcesRemoved: sourcesRemoved,
    releaseGroupSlotTrackAssignmentsRemoved: assignmentsRemoved,
  };
}

