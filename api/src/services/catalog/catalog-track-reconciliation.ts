import type Database from "better-sqlite3";
import type { LidarrTrack } from "../metadata/servarr-metadata.js";
import { AcquisitionPlanRepository } from "../music/acquisition-plan-repository.js";
import { prepareAcquisitionPlanMutation } from "../music/acquisition-plan-ownership.js";

/** Redirects are catalogue identity evidence, never inferred from slots or titles.
 * Validate the full incoming graph before any admitted catalogue write. */
export function collectCatalogRedirects(tracks: readonly LidarrTrack[]): { tracks: Map<string, string>; recordings: Map<string, string> } {
  const result = { tracks: new Map<string, string>(), recordings: new Map<string, string>() };
  const currentTracks = new Set(tracks.map(track => track.Id));
  const currentRecordings = new Set(tracks.map(track => track.RecordingId));
  for (const track of tracks) {
    for (const [field, target, redirects, current] of [
      ['OldIds', track.Id, result.tracks, currentTracks],
      ['OldRecordingIds', track.RecordingId, result.recordings, currentRecordings],
    ] as const) {
      const aliases = track[field];
      if (aliases == null) continue;
      if (!Array.isArray(aliases)) throw new Error(`Invalid catalogue ${field} for ${target}`);
      for (const alias of aliases) {
        if (typeof alias !== 'string' || !alias.trim() || alias !== alias.trim() || current.has(alias))
          throw new Error(`Invalid catalogue ${field} redirect for ${target}`);
        const existing = redirects.get(alias);
        if (existing && existing !== target) throw new Error(`Conflicting catalogue ${field} redirect ${alias}`);
        redirects.set(alias, target);
      }
    }
  }
  return result;
}

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
  const normalized = [...byId.values()];
  collectCatalogRedirects(normalized);
  return normalized;
}

/** A changed occurrence MBID may retain its local row only with authoritative
 * aliases, or one unique occurrence of the same canonical recording in the SAME
 * edition before and after. Titles, positions and durations are not identity.
 * Existing target rows/ambiguous occurrences need separate owner consolidation. */
export function reconcileEditionTrackIdentities(db: Database.Database, releaseMbid: string, tracks: readonly LidarrTrack[], retainedTrackIds: ReadonlySet<string>): number {
  if (!db.inTransaction) throw new Error('Track identity reconciliation requires an active transaction');
  return db.transaction(() => {
    const existing = db.prepare(`SELECT track.id,track.mbid,track.recording_mbid,recording.id AS recording_id,
      track.recording_id AS original_recording_id,track.album_edition_id FROM Tracks track
      JOIN Recordings recording ON recording.mbid=track.recording_mbid WHERE track.release_mbid=?`).all(releaseMbid) as Array<{id:number;mbid:string;recording_mbid:string;recording_id:number;original_recording_id:number|null;album_edition_id:number}>;
    const aliases = collectCatalogRedirects(tracks).tracks;
    let changed = 0;
    for (const old of existing) {
      if (retainedTrackIds.has(old.mbid)) continue;
      const explicit = aliases.get(old.mbid);
      const sameRecording = tracks.filter(track => track.RecordingId === old.recording_mbid);
      const target = explicit ? tracks.find(track => track.Id === explicit)
        : sameRecording.length === 1 && existing.filter(track => track.recording_mbid === old.recording_mbid).length === 1 ? sameRecording[0] : undefined;
      if (!target || db.prepare('SELECT id FROM Tracks WHERE mbid=?').get(target.Id)) continue;
      if (target.RecordingId !== old.recording_mbid) throw new Error(`Track redirect ${old.mbid} has a different recording identity`);
      if (old.original_recording_id != null && old.original_recording_id !== old.recording_id) throw new Error(`Track ${old.mbid} has conflicting canonical recording identity`);
      const plans = (db.prepare(`SELECT DISTINCT plan_id AS id FROM AcquisitionPlanTracks WHERE track_id=?
        OR provider_track_match_id IN (SELECT id FROM ProviderTrackMatches WHERE track_id=?)`).all(old.id,old.id) as {id:number}[]).map(row=>row.id);
      prepareAcquisitionPlanMutation(db,plans);
      const active = db.prepare(`SELECT id FROM commands WHERE status IN ('queued','started')
        AND name IN ('DownloadAlbum','DownloadTrack','DownloadVideo','ImportDownload')
        AND (json_extract(payload,'$.releaseMbid')=? OR ? IN (SELECT value FROM json_tree(commands.payload) WHERE type='text')
          OR CAST(json_extract(payload,'$.canonicalTrackId') AS TEXT)=?
          OR CAST(json_extract(payload,'$.resolved.canonicalTrackId') AS TEXT)=?) LIMIT 1`)
        .get(releaseMbid,old.mbid,String(old.id),String(old.id));
      if (active) throw new Error(`Track ${old.mbid} has an executing media snapshot`);
      const waiting = db.prepare(`SELECT id FROM DownloadQueue WHERE plan_id IS NULL
        AND (json_extract(payload,'$.canonicalTrackMbid')=? OR CAST(json_extract(payload,'$.canonicalTrackId') AS TEXT)=?) LIMIT 1`)
        .get(old.mbid,String(old.id));
      const legacyWaiting = db.prepare(`SELECT id FROM DownloadQueue WHERE plan_id IS NULL
        AND ? IN (SELECT value FROM json_tree(DownloadQueue.payload) WHERE type='text') LIMIT 1`).get(old.mbid);
      if (waiting || legacyWaiting) throw new Error(`Track ${old.mbid} has a standalone waiting request`);
      const conflict = db.prepare(`SELECT id FROM TrackFiles WHERE
        (track_id=? AND canonical_track_mbid IS NOT NULL AND canonical_track_mbid NOT IN (?,?))
        OR (canonical_track_mbid=? AND track_id IS NOT NULL AND track_id!=?) LIMIT 1`)
        .get(old.id,old.mbid,target.Id,old.mbid,old.id);
      if (conflict) throw new Error(`Track ${old.mbid} has conflicting file identity`);
      const wrongScope = db.prepare(`SELECT id FROM TrackFiles WHERE (track_id=? OR canonical_track_mbid=?) AND (
        (recording_id IS NOT NULL AND recording_id!=?) OR (canonical_recording_mbid IS NOT NULL AND canonical_recording_mbid!=?)
        OR (album_edition_id IS NOT NULL AND album_edition_id!=?)) LIMIT 1`)
        .get(old.id,old.mbid,old.recording_id,old.recording_mbid,old.album_edition_id);
      if (wrongScope) throw new Error(`Track ${old.mbid} has conflicting recording or edition file scope`);
      for (const table of ['MetadataFiles','LyricFiles','ExtraFiles']) {
        if (db.prepare(`SELECT id FROM "${table}" WHERE canonical_track_mbid=?
          AND canonical_recording_mbid IS NOT NULL AND canonical_recording_mbid!=? LIMIT 1`).get(old.mbid,old.recording_mbid)) {
          throw new Error(`Track ${old.mbid} has conflicting sidecar recording scope`);
        }
      }
      db.prepare(`UPDATE Tracks SET mbid=?,recording_id=?,foreign_track_id=CASE WHEN foreign_track_id=? THEN ? ELSE foreign_track_id END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(target.Id,old.recording_id,old.mbid,target.Id,old.id);
      db.prepare('UPDATE TrackFiles SET canonical_track_mbid=?,needs_rename=1 WHERE track_id=?').run(target.Id,old.id);
      db.prepare('UPDATE TrackFiles SET track_id=?,canonical_track_mbid=?,needs_rename=1 WHERE canonical_track_mbid=?').run(old.id,target.Id,old.mbid);
      for (const table of ['MetadataFiles','LyricFiles','ExtraFiles']) {
        db.prepare(`UPDATE "${table}" SET canonical_track_mbid=?,needs_rename=1 WHERE canonical_track_mbid=?`).run(target.Id,old.mbid);
      }
      prepareAcquisitionPlanMutation(db,plans);
      for (const id of plans) db.prepare("UPDATE AcquisitionPlans SET state='stale',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      changed++;
    }
    return changed;
  })();
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
    UNION ALL SELECT 'TrackFiles' FROM TrackFiles
      WHERE track_id IS NULL AND album_edition_id=(SELECT album_edition_id FROM Tracks WHERE id=@id)
        AND recording_id=(SELECT recording_id FROM Tracks WHERE id=@id)
    UNION ALL SELECT 'LibraryVideos' FROM LibraryVideos WHERE inline_track_id=@id
    UNION ALL SELECT 'ArtistTopTracks' FROM ArtistTopTracks WHERE track_id=@id
    UNION ALL SELECT 'MetadataFiles' FROM MetadataFiles WHERE canonical_track_mbid=@mbid
    UNION ALL SELECT 'LyricFiles' FROM LyricFiles WHERE canonical_track_mbid=@mbid
    UNION ALL SELECT 'ExtraFiles' FROM ExtraFiles WHERE canonical_track_mbid=@mbid
    LIMIT 1
  `);
  // Validate file ownership before expiring any derived coverage. All changes
  // participate in the same rollback as the edition reconciliation.
  // Credits and the download projection may cascade with an obsolete track.
  for (const [id, mbid] of obsolete) {
    const reference = protectedReference.get({ id, mbid }) as { source: string } | undefined;
    if (reference) throw new Error(`Catalog track conflict in edition ${releaseMbid}: obsolete track ${mbid} is still referenced by ${reference.source}`);
    const activeSnapshot = db.prepare(`SELECT id FROM commands
      WHERE status IN ('queued','started')
        AND name IN ('DownloadAlbum','DownloadTrack','DownloadVideo','ImportDownload')
        AND (json_extract(payload,'$.releaseMbid')=? OR ? IN (
          SELECT entry.value FROM json_tree(commands.payload) entry WHERE entry.type='text'
        )) LIMIT 1`).get(releaseMbid, mbid);
    if (activeSnapshot) throw new Error(`Catalog track ${mbid} has an executing media snapshot`);
    const standaloneIntent = db.prepare(`SELECT id FROM DownloadQueue
      WHERE plan_id IS NULL AND command_id IS NULL AND ? IN (
        SELECT entry.value FROM json_tree(DownloadQueue.payload) entry WHERE entry.type='text'
      ) LIMIT 1`).get(mbid);
    if (standaloneIntent) throw new Error(`Catalog track ${mbid} has a waiting standalone media request`);
  }
  for (const id of obsolete.keys()) {
    const contradictory = db.prepare(`SELECT match.id FROM ProviderTrackMatches match
      JOIN Tracks track ON track.id=match.track_id
      WHERE track.id=? AND match.recording_id!=track.recording_id LIMIT 1`).get(id);
    if (contradictory) throw new Error(`Catalog track ${id} has conflicting provider recording identity`);
    new AcquisitionPlanRepository(db).expireRemovedTrackAssignments(id);
    // Edition occurrence context expires; the provider resource's recording
    // decision and exact source membership remain intact for future matching.
    db.prepare("UPDATE ProviderTrackMatches SET track_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE track_id=?").run(id);
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
