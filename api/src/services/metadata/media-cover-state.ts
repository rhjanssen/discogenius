import fs from "node:fs";
import path from "node:path";
import { db } from "../../database.js";

export type ArtworkIdentity = {
  coverEntity: "Artist" | "Album" | "Edition" | "Video";
  entityId: string | number;
  coverType: string;
};
export type ArtworkSource = {
  url: string;
  preference: "canonical" | "provider" | null;
  fulfilledBy: "canonical" | "provider" | "manual" | null;
  contentHash: string | null;
};

export function artworkKey(identity: ArtworkIdentity): [string, string, string] {
  return [identity.coverEntity, String(identity.entityId), identity.coverType];
}

/** Bounded recovery reader for pre-redesign markers. Never writes the cache.
 * Keep old markers until their complete migration has been validated. */
export function readArtworkSource(identity: ArtworkIdentity, legacyFolder: string): ArtworkSource | null {
  const stored = db.prepare(`SELECT source_url AS url, preference,
    fulfilled_by AS fulfilledBy, content_hash AS contentHash FROM ArtworkSources
    WHERE cover_entity = ? AND entity_id = ? AND cover_type = ?`).get(...artworkKey(identity)) as ArtworkSource | undefined;
  if (stored) return stored;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(legacyFolder, `.${identity.coverType}.source.json`), "utf8"));
    const fulfilledBy = marker.fulfilledBy ?? marker.sourceKind ?? null;
    const preference = marker.preference ?? null;
    if (typeof marker.url !== "string" || (preference !== null && !["canonical", "provider"].includes(preference))
      || (fulfilledBy !== null && !["canonical", "provider", "manual"].includes(fulfilledBy))) return null;
    return { url: marker.url, preference, fulfilledBy,
      contentHash: typeof marker.contentHash === "string" ? marker.contentHash : null };
  } catch { return null; }
}

/** Caller owns writer admission. No filesystem or network work in this write. */
export function storeArtworkSource(identity: ArtworkIdentity, source: ArtworkSource): void {
  db.prepare(`INSERT INTO ArtworkSources
    (cover_entity, entity_id, cover_type, source_url, preference, fulfilled_by, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cover_entity, entity_id, cover_type)
    DO UPDATE SET source_url = excluded.source_url, preference = excluded.preference,
      fulfilled_by = excluded.fulfilled_by, content_hash = excluded.content_hash`)
    .run(...artworkKey(identity), source.url, source.preference, source.fulfilledBy, source.contentHash);
}
