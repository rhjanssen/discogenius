import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { artworkKey, type ArtworkIdentity } from "./media-cover-state.js";
import { artworkLinkOwnsTrackedPath } from "./media-cover-library-storage.js";

type Intent = {
  id: string; cover_entity: ArtworkIdentity["coverEntity"]; entity_id: string; cover_type: string;
  destination_path: string; staged_path: string; backup_path: string;
  original_identity: string | null; replacement_identity: string;
  database_snapshot: string; phase: "prepared" | "committed";
};

/** Include the inode and bytes: another file with identical image content is
 * still an external replacement, not ours to remove during rollback. */
export function artworkFileIdentity(file: string): string | null {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artwork mutation requires a regular file: ${file}`);
    if (stat.size > 32n * 1024n * 1024n) throw new Error("Artwork mutation exceeds the 32 MiB limit");
    const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const after = fs.lstatSync(file, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) {
      throw new Error("Artwork changed while recording its identity");
    }
    return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), hash });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function identity(intent: Intent): ArtworkIdentity {
  return { coverEntity: intent.cover_entity, entityId: intent.entity_id, coverType: intent.cover_type };
}

function databaseSnapshot(scope: ArtworkIdentity, destination: string): string {
  return JSON.stringify({
    source: db.prepare("SELECT * FROM ArtworkSources WHERE cover_entity=? AND entity_id=? AND cover_type=?").get(...artworkKey(scope)) ?? null,
    links: db.prepare("SELECT * FROM ArtworkLibraryLinks WHERE file_path=? ORDER BY cover_entity,entity_id,cover_type").all(destination),
    file: db.prepare(`SELECT id,artist_id,track_file_id,file_path,relative_path,library_root,library_slot,extension,type,file_type,
      canonical_artist_mbid,canonical_release_group_mbid,canonical_release_mbid,canonical_track_mbid,canonical_recording_mbid,
      provider,provider_entity_type,provider_id,consumer FROM MetadataFiles WHERE file_path=?`).get(destination) ?? null,
  });
}

function hasCommittedLibraryLink(intent: Intent): boolean {
  const link = db.prepare(`SELECT link.metadata_file_id FROM ArtworkLibraryLinks link
    WHERE link.cover_entity=? AND link.entity_id=? AND link.cover_type=?
    AND link.file_path=? AND link.content_hash=?`)
    .get(...artworkKey(identity(intent)),intent.destination_path,JSON.parse(intent.replacement_identity).hash) as {metadata_file_id:number|null} | undefined;
  return Boolean(link && artworkLinkOwnsTrackedPath(identity(intent),intent.destination_path,link.metadata_file_id));
}

function ownershipSnapshot(snapshot: string): string {
  const {links,file} = JSON.parse(snapshot);
  return JSON.stringify({links,file});
}

/** Caller owns writer admission. Persist intent BEFORE touching the old image;
 * acknowledge in the same transaction as source/link updates. Startup and the
 * command watchdog recover this journal before more disk commands can run. */
export class ArtworkMutationJournal {
  static hasPending(): boolean {
    return Boolean(db.prepare("SELECT 1 FROM ArtworkMutationJournal LIMIT 1").get());
  }

  private static get(id: string): Intent {
    const row = db.prepare("SELECT * FROM ArtworkMutationJournal WHERE id=?").get(id) as Intent | undefined;
    if (!row) throw new Error("Artwork replacement intent is missing");
    return row;
  }

  static prepare(scope: ArtworkIdentity, destination: string, staged: string): string {
    if (db.inTransaction) throw new Error("Artwork replacement intent must commit before file publication");
    if (db.prepare("SELECT 1 FROM FileMutationJournal WHERE source_path=? OR destination_path=? LIMIT 1").get(destination,destination)
      || db.prepare("SELECT 1 FROM LibraryCleanupJournal WHERE source_path=? LIMIT 1").get(destination)) {
      throw new Error("Recover pending file mutations at this artwork destination first");
    }
    if (path.resolve(destination) === path.resolve(staged) || path.dirname(destination) !== path.dirname(staged)) {
      throw new Error("Artwork staging must be a separate file beside its destination");
    }
    const replacement = artworkFileIdentity(staged);
    if (!replacement) throw new Error("Staged artwork is missing");
    const id = randomUUID();
    db.prepare(`INSERT INTO ArtworkMutationJournal
      (id,cover_entity,entity_id,cover_type,destination_path,staged_path,backup_path,original_identity,replacement_identity,database_snapshot)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,...artworkKey(scope),destination,staged,
      path.join(path.dirname(destination), `.discogenius-artwork-${id}.previous`),
      artworkFileIdentity(destination),replacement,databaseSnapshot(scope,destination));
    return id;
  }

  static publish(id: string): void {
    const intent = this.get(id);
    if (intent.phase !== "prepared" || databaseSnapshot(identity(intent),intent.destination_path) !== intent.database_snapshot
      || artworkFileIdentity(intent.destination_path) !== intent.original_identity
      || artworkFileIdentity(intent.staged_path) !== intent.replacement_identity) {
      throw new Error("Artwork or ownership changed before publication");
    }
    if (intent.original_identity) fs.linkSync(intent.destination_path,intent.backup_path);
    fs.renameSync(intent.staged_path,intent.destination_path);
  }

  static markCommitted(id: string): void {
    if (!db.inTransaction) throw new Error("Artwork acknowledgement requires the provenance transaction");
    const intent = this.get(id);
    if (artworkFileIdentity(intent.destination_path) !== intent.replacement_identity) throw new Error("Published artwork changed before commit");
    if (!hasCommittedLibraryLink(intent)) throw new Error("Artwork commit has no matching library link");
    if (db.prepare("UPDATE ArtworkMutationJournal SET phase='committed' WHERE id=? AND phase='prepared'").run(id).changes !== 1) {
      throw new Error("Artwork commit lost its intent");
    }
  }

  static recoverOneSync(id: string): void {
    try {
      const intent = this.get(id);
      const destination = artworkFileIdentity(intent.destination_path);
      const backup = artworkFileIdentity(intent.backup_path);
      const staged = artworkFileIdentity(intent.staged_path);
      // Inspect ALL paths before removing any evidence. Never resolve a conflict
      // by overwriting an image another app or the user has since replaced.
      if (staged && staged !== intent.replacement_identity) throw new Error("Artwork recovery staging file changed");
      if (backup && backup !== intent.original_identity) throw new Error("Artwork recovery backup changed");
      if (intent.phase === "prepared") {
        // Catalogue refresh may select a newer source after a worker dies.
        // Recover only this file mutation; never roll that newer selection back.
        if (ownershipSnapshot(databaseSnapshot(identity(intent),intent.destination_path)) !== ownershipSnapshot(intent.database_snapshot)) {
          throw new Error("Uncommitted artwork ownership changed");
        }
        if (destination !== intent.original_identity && destination !== intent.replacement_identity) {
          throw new Error("Artwork recovery destination changed");
        }
        if (destination === intent.replacement_identity) {
          if (intent.original_identity) {
            if (!backup) throw new Error("Previous artwork recovery copy is missing");
            fs.renameSync(intent.backup_path,intent.destination_path);
          } else fs.unlinkSync(intent.destination_path);
        }
      } else {
        if (destination !== intent.replacement_identity) throw new Error("Committed artwork destination changed");
        if (!hasCommittedLibraryLink(intent)) throw new Error("Committed artwork has no matching library link");
      }
      if (backup && fs.existsSync(intent.backup_path)) fs.unlinkSync(intent.backup_path);
      if (staged) fs.unlinkSync(intent.staged_path);
      db.prepare("DELETE FROM ArtworkMutationJournal WHERE id=?").run(id);
    } catch (error) {
      try { db.prepare("UPDATE ArtworkMutationJournal SET recovery_error=? WHERE id=?").run(error instanceof Error ? error.message : String(error),id); }
      catch { /* The unsettled intent still blocks disk commands if recording the error fails. */ }
      throw error;
    }
  }

  static async recoverPending(): Promise<string[]> {
    const rows = db.prepare("SELECT id FROM ArtworkMutationJournal ORDER BY created_at,id").all() as Array<{id:string}>;
    const errors: string[] = [];
    for (const {id} of rows) {
      try { await withSqliteWriteGate(() => this.recoverOneSync(id),"artwork:recovery"); }
      catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
      // Recovery may inspect a full-size image; let requests run between intents.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return errors;
  }
}
