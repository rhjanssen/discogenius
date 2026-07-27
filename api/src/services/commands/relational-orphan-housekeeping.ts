import { db } from "../../database.js";

export interface RelationalOrphanSummary {
  providerItemMatchesRemoved: number;
}

/**
 * Prune rows whose ownership relationship is unambiguous but is not expressed
 * as a database foreign key.
 *
 * ProviderItemMatches direct edges are owned by the matching ProviderItems
 * offer. Composite album edges deliberately encode several offer ids in one
 * semicolon-delimited value (legacy readers also accept '+'), so they cannot be
 * validated by an exact source-key lookup and are preserved for their normal
 * release-group rebuild.
 */
export function pruneRelationalOrphans(): RelationalOrphanSummary {
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
  };
}
