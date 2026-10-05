import type Database from "better-sqlite3";
import type { LidarrTrack } from "../metadata/servarr-metadata.js";

/** A catalog position is a mutable fact, never a track identity. */
export function normalizeEditionTracks(releaseMbid: string, tracks: readonly LidarrTrack[]): LidarrTrack[] {
  if (typeof releaseMbid !== "string" || !releaseMbid.trim() || !Array.isArray(tracks)) {
    throw new Error("A complete catalog edition identity and track list are required");
  }
  const byId = new Map<string, LidarrTrack>();
  const byPosition = new Map<string, string>();
  for (const track of tracks) {
    if (!track || typeof track.Id !== "string" || !track.Id.trim()
      || typeof track.RecordingId !== "string" || !track.RecordingId.trim()
      || !Number.isSafeInteger(track.MediumNumber) || track.MediumNumber < 1
      || !Number.isSafeInteger(track.TrackPosition) || track.TrackPosition < 0) {
      throw new Error(`Invalid catalog track identity or position in edition ${releaseMbid}`);
    }
    const previous = byId.get(track.Id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(track)) {
        throw new Error(`Conflicting catalog occurrences of track ${track.Id} in edition ${releaseMbid}`);
      }
      continue;
    }
    const slot = `${track.MediumNumber}:${track.TrackPosition}`;
    const occupant = byPosition.get(slot);
    if (occupant) throw new Error(`Conflicting catalog tracks ${occupant} and ${track.Id} at ${releaseMbid} ${slot}`);
    byPosition.set(slot, track.Id);
    byId.set(track.Id, track);
  }
  return [...byId.values()];
}

/** Free changed positions only within the transaction that writes this edition.
 * Stable MBIDs retain their integer IDs, including moves between editions.
 * Obsolete, unreferenced catalog rows may be replaced; owned identities fail closed.
 * Temporary positions must never be committed or exposed between write chunks. */
export function prepareEditionTrackPositions(db: Database.Database, releaseMbid: string, tracks: readonly LidarrTrack[], retainedTrackIds: ReadonlySet<string> = new Set(tracks.map(track => track.Id))): void {
  if (!db.inTransaction) throw new Error("Edition track reconciliation requires an active transaction");
  const byId = db.prepare("SELECT id, release_mbid, medium_position, position FROM Tracks WHERE mbid=?");
  const bySlot = db.prepare("SELECT id, mbid FROM Tracks WHERE release_mbid=? AND medium_position=? AND position=?");
  const movingIds = new Set<number>();
  const obsolete = new Map<number, string>();
  for (const row of db.prepare("SELECT id, mbid FROM Tracks WHERE release_mbid=?").all(releaseMbid) as Array<{ id: number; mbid: string }>) {
    if (!retainedTrackIds.has(row.mbid)) obsolete.set(row.id, row.mbid);
  }
  for (const track of tracks) {
    const existing = byId.get(track.Id) as { id: number; release_mbid: string; medium_position: number; position: number } | undefined;
    if (existing && (existing.release_mbid !== releaseMbid || existing.medium_position !== track.MediumNumber || existing.position !== track.TrackPosition)) movingIds.add(existing.id);
    const occupant = bySlot.get(releaseMbid, track.MediumNumber, track.TrackPosition) as { id: number; mbid: string } | undefined;
    if (occupant && occupant.mbid !== track.Id && !retainedTrackIds.has(occupant.mbid)) obsolete.set(occupant.id, occupant.mbid);
  }
  const protectedReference = db.prepare(`
    SELECT 'TrackFiles' AS source FROM TrackFiles WHERE track_id=@id
    UNION ALL SELECT 'TrackFiles' FROM TrackFiles WHERE canonical_track_mbid=@mbid
    UNION ALL SELECT 'ProviderTrackMatches' FROM ProviderTrackMatches WHERE track_id=@id
    UNION ALL SELECT 'AcquisitionPlanTracks' FROM AcquisitionPlanTracks WHERE track_id=@id
    UNION ALL SELECT 'LibraryVideos' FROM LibraryVideos WHERE inline_track_id=@id
    UNION ALL SELECT 'ArtistTopTracks' FROM ArtistTopTracks WHERE track_id=@id
    UNION ALL SELECT 'MetadataFiles' FROM MetadataFiles WHERE canonical_track_mbid=@mbid
    UNION ALL SELECT 'LyricFiles' FROM LyricFiles WHERE canonical_track_mbid=@mbid
    UNION ALL SELECT 'ExtraFiles' FROM ExtraFiles WHERE canonical_track_mbid=@mbid
    LIMIT 1
  `);
  // Check every conflict before making any changes. Credits and the download
  // projection are derived catalog rows and can cascade with an obsolete track.
  for (const [id, mbid] of obsolete) {
    const reference = protectedReference.get({ id, mbid }) as { source: string } | undefined;
    if (reference) throw new Error(`Catalog track conflict in edition ${releaseMbid}: obsolete track ${mbid} is still referenced by ${reference.source}`);
  }
  const remove = db.prepare("DELETE FROM Tracks WHERE id=?");
  for (const id of obsolete.keys()) remove.run(id);
  const stage = db.prepare("UPDATE Tracks SET medium_position=-1, position=-id WHERE id=?");
  for (const id of movingIds) stage.run(id);
}

/** Editions exchanging stable track identities must commit together. Unrelated
 * editions remain separate admission units, even in a large release group. */
export function groupConnectedEditions<T extends { Id: string; Tracks: readonly LidarrTrack[] }>(db: Database.Database, editions: readonly T[]): T[][] {
  const parents = new Map(editions.map(edition => [edition.Id, edition.Id]));
  const root = (id: string): string => {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const existingEdition = db.prepare("SELECT release_mbid FROM Tracks WHERE mbid=?");
  for (const edition of editions) for (const track of edition.Tracks) {
    const existing = existingEdition.get(track.Id) as { release_mbid: string } | undefined;
    if (existing && parents.has(existing.release_mbid)) parents.set(root(existing.release_mbid), root(edition.Id));
  }
  const groups = new Map<string, T[]>();
  for (const edition of editions) {
    const key = root(edition.Id);
    const group = groups.get(key) ?? [];
    group.push(edition);
    groups.set(key, group);
  }
  return [...groups.values()];
}
